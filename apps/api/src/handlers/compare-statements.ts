import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { badRequest, json, notFound, structuredError, unauthorized } from "../lib/http";
import { compareStatements } from "../lib/statement-power-tools";
import { resolveTenantId } from "../lib/auth";

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const tenantId = await resolveTenantId(event);
  if (!tenantId) {
    return unauthorized("Missing or invalid Authorization Bearer or X-Api-Key");
  }

  if (!event.body) {
    return badRequest(
      "INVALID_REQUEST",
      "Request body is required",
      'Send JSON { "statementIdA": "...", "statementIdB": "..." }',
    );
  }

  let statementIdA: string | undefined;
  let statementIdB: string | undefined;
  try {
    const body = JSON.parse(
      event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body,
    ) as { statementIdA?: string; statementIdB?: string };
    statementIdA = body.statementIdA;
    statementIdB = body.statementIdB;
  } catch {
    return badRequest(
      "INVALID_REQUEST",
      "Invalid JSON body",
      'Send { "statementIdA": "...", "statementIdB": "..." }',
    );
  }

  if (!statementIdA || !statementIdB) {
    return badRequest(
      "INVALID_REQUEST",
      "statementIdA and statementIdB are required",
      "Pass two statementIds from list_statements / GET /v1/statements",
    );
  }

  const result = await compareStatements(tenantId, statementIdA, statementIdB);
  if (!result) {
    return notFound("Statement not found");
  }
  if ("code" in result) {
    const status = result.code === "STATEMENT_NOT_READY" ? 409 : 400;
    return structuredError(status, result.code, result.message, result.retryable, result.nextStep);
  }

  return json(200, result);
}
