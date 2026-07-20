import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { WorkspaceMemberRole } from "@finlens/domain";
import { timingSafeStringEqual } from "./api-key";
import { resolveTenantIdForApiKey } from "./api-key-service";
import { getBearerToken, verifyAccessToken } from "./cognito-auth";
import {
  getMembership,
  resolveOrCreatePersonalWorkspace,
  resolveWorkspaceSeamDeps,
} from "./workspace-service";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export type BearerWorkspaceContext = {
  tenantId: string;
  cognitoSub: string;
  role: WorkspaceMemberRole;
};

/** Resolve Workspace id (`tenantId`) from API key only (timing-safe DEV shortcut + hashed keys). */
export async function resolveTenantIdFromApiKey(
  event: APIGatewayProxyEventV2,
): Promise<string | null> {
  const apiKey = event.headers["x-api-key"] ?? event.headers["X-Api-Key"];
  if (!apiKey) {
    return null;
  }

  const devKey = process.env.DEV_API_KEY;
  if (devKey && timingSafeStringEqual(apiKey, devKey)) {
    return "dev";
  }

  if (!process.env.API_KEYS_TABLE) {
    return null;
  }

  return resolveTenantIdForApiKey(apiKey);
}

/**
 * Cognito access token → Workspace id.
 * First successful login auto-creates a personal Workspace.
 */
export async function resolveTenantIdFromBearer(
  event: APIGatewayProxyEventV2,
): Promise<string | null> {
  const ctx = await resolveBearerWorkspaceContext(event);
  return ctx?.tenantId ?? null;
}

/**
 * Cognito Bearer → Workspace context (for owner-gated control-plane ops like API keys).
 * Does not fall back to API-key auth.
 */
export async function resolveBearerWorkspaceContext(
  event: APIGatewayProxyEventV2,
): Promise<BearerWorkspaceContext | null> {
  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const token = getBearerToken(authHeader);
  if (!token) {
    return null;
  }

  const cognitoSub = await verifyAccessToken(token);
  if (!cognitoSub) {
    return null;
  }

  try {
    const tenantId = await resolveOrCreatePersonalWorkspace(cognitoSub);
    const membership = await getMembership(
      resolveWorkspaceSeamDeps({ ddb }),
      cognitoSub,
    );
    if (!membership || membership.workspaceId !== tenantId) {
      return null;
    }
    return {
      tenantId,
      cognitoSub,
      role: membership.role,
    };
  } catch {
    return null;
  }
}

/** Bearer Cognito + Workspace owner role (API key mint/list/revoke). */
export async function resolveWorkspaceOwnerFromBearer(
  event: APIGatewayProxyEventV2,
): Promise<BearerWorkspaceContext | null> {
  const ctx = await resolveBearerWorkspaceContext(event);
  if (!ctx || ctx.role !== "owner") {
    return null;
  }
  return ctx;
}

/**
 * REST / web: Cognito Bearer (PKCE) preferred, then API key (agents / MCP).
 * `tenantId` is always the Workspace id.
 */
export async function resolveTenantId(event: APIGatewayProxyEventV2): Promise<string | null> {
  const fromBearer = await resolveTenantIdFromBearer(event);
  if (fromBearer) {
    return fromBearer;
  }
  return resolveTenantIdFromApiKey(event);
}

/** MCP: same hybrid auth as REST — Bearer → Workspace, else API key. */
export async function resolveTenantIdForMcp(
  event: APIGatewayProxyEventV2,
): Promise<string | null> {
  return resolveTenantId(event);
}

export function mcpUnauthorized(apiUrl: string): APIGatewayProxyResultV2 {
  const metadataUrl = `${apiUrl}/.well-known/oauth-protected-resource`;
  return {
    statusCode: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
    },
    body: JSON.stringify({
      error: {
        code: "UNAUTHORIZED",
        message: "Valid Cognito access token or API key required",
        retryable: false,
        nextStep: "Sign in through Cursor MCP OAuth or provide X-Api-Key",
      },
    }),
  };
}
