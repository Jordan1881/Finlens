import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { hashApiKey, timingSafeStringEqual } from "./api-key";
import { getBearerToken, verifyAccessToken } from "./cognito-auth";
import { resolveOrCreatePersonalWorkspace } from "./workspace-service";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Resolve Workspace id (`tenantId`) from API key only. */
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

  const tableName = process.env.API_KEYS_TABLE;
  if (!tableName) {
    return null;
  }

  const keyHash = hashApiKey(apiKey);
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { keyHash },
    }),
  );

  const tenantId = result.Item?.tenantId;
  return typeof tenantId === "string" && tenantId.length > 0 ? tenantId : null;
}

/**
 * Cognito access token → Workspace id.
 * First successful login auto-creates a personal Workspace.
 */
export async function resolveTenantIdFromBearer(
  event: APIGatewayProxyEventV2,
): Promise<string | null> {
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
    return await resolveOrCreatePersonalWorkspace(cognitoSub);
  } catch {
    return null;
  }
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
