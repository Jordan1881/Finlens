import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { resolveWorkspaceOwnerFromBearer } from "../lib/auth";
import { listApiKeys, mintApiKey, revokeApiKey } from "../lib/api-key-service";
import { json, notFound, unauthorized } from "../lib/http";

/**
 * Cognito-only Workspace owner control plane for API keys.
 * POST /v1/api-keys — mint (plaintext once)
 * GET  /v1/api-keys — list metadata
 * DELETE /v1/api-keys/{keyId} — revoke
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const owner = await resolveWorkspaceOwnerFromBearer(event);
  if (!owner) {
    return unauthorized(
      "Cognito access token required (Workspace owner). API keys cannot mint or revoke keys.",
    );
  }

  const method = event.requestContext.http.method.toUpperCase();
  const keyId = event.pathParameters?.keyId;

  if (method === "POST" && !keyId) {
    const minted = await mintApiKey(owner.tenantId);
    return json(201, minted);
  }

  if (method === "GET" && !keyId) {
    const data = await listApiKeys(owner.tenantId);
    return json(200, data);
  }

  if (method === "DELETE" && keyId) {
    const revoked = await revokeApiKey(owner.tenantId, keyId);
    if (!revoked) {
      return notFound("API key not found", "Check the keyId or mint a new key");
    }
    return json(200, revoked);
  }

  return json(405, {
    error: {
      code: "METHOD_NOT_ALLOWED",
      message: `Unsupported method ${method} for API keys`,
      retryable: false,
      nextStep: "Use POST/GET /v1/api-keys or DELETE /v1/api-keys/{keyId}",
    },
  });
}
