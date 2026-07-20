import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { json, notFound, unauthorized } from "../lib/http";
import { getStatement } from "../lib/statement-service";
import { resolveTenantId } from "../lib/auth";

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const tenantId = await resolveTenantId(event);
  if (!tenantId) {
    return unauthorized("Missing or invalid Authorization Bearer or X-Api-Key");
  }

  const statementId = event.pathParameters?.statementId;
  const detail = event.queryStringParameters?.detail === "full" ? "full" : "summary";

  if (!statementId) {
    return notFound("Statement not found");
  }

  const data = await getStatement(tenantId, statementId, detail);
  if (!data) {
    return notFound("Statement not found");
  }

  return json(200, data);
}
