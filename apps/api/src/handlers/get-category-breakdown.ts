import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { json, notFound, structuredError, unauthorized } from "../lib/http";
import { getCategoryBreakdown } from "../lib/statement-power-tools";
import { resolveTenantId } from "../lib/auth";

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const tenantId = await resolveTenantId(event);
  if (!tenantId) {
    return unauthorized("Missing or invalid Authorization Bearer or X-Api-Key");
  }

  const statementId = event.pathParameters?.statementId;
  if (!statementId) {
    return notFound("Statement not found");
  }

  const result = await getCategoryBreakdown(tenantId, statementId);
  if (!result) {
    return notFound("Statement not found");
  }
  if ("code" in result) {
    const status = result.code === "STATEMENT_NOT_READY" ? 409 : 400;
    return structuredError(status, result.code, result.message, result.retryable, result.nextStep);
  }

  return json(200, result);
}
