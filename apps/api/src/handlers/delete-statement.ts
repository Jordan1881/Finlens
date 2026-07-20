import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { json, notFound, unauthorized } from "../lib/http";
import { deleteStatement } from "../lib/statement-service";
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

  const result = await deleteStatement(tenantId, statementId);
  if (!result) {
    return notFound("Statement not found");
  }

  return json(200, result);
}
