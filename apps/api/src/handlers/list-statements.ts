import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { json, unauthorized } from "../lib/http";
import { listStatements } from "../lib/statement-service";
import { resolveTenantId } from "../lib/auth";

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const tenantId = await resolveTenantId(event);
  if (!tenantId) {
    return unauthorized("Missing or invalid Authorization Bearer or X-Api-Key");
  }

  const data = await listStatements(tenantId);
  return json(200, data);
}
