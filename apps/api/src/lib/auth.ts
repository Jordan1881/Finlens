import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { getBearerToken, verifyAccessToken } from "./cognito-auth";

export function resolveTenantId(event: APIGatewayProxyEventV2): string | null {
  const apiKey = event.headers["x-api-key"] ?? event.headers["X-Api-Key"];
  const devKey = process.env.DEV_API_KEY;

  if (!apiKey || !devKey || apiKey !== devKey) {
    return null;
  }

  return "dev";
}

export async function resolveTenantIdFromBearer(
  event: APIGatewayProxyEventV2,
): Promise<string | null> {
  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const token = getBearerToken(authHeader);
  if (!token) {
    return null;
  }
  return verifyAccessToken(token);
}

export async function resolveTenantIdForMcp(
  event: APIGatewayProxyEventV2,
): Promise<string | null> {
  const fromBearer = await resolveTenantIdFromBearer(event);
  if (fromBearer) {
    return fromBearer;
  }
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
        message: "Valid Cognito access token required",
        retryable: false,
        nextStep: "Sign in through Cursor MCP OAuth",
      },
    }),
  };
}
