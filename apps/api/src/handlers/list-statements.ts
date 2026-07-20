import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { ListStatementsParams, StatementStatus } from "@finlens/domain";
import { badRequest, json, unauthorized } from "../lib/http";
import { isStatementStatus, listStatements } from "../lib/statement-service";
import { resolveTenantId } from "../lib/auth";

function parseLimit(raw: string | undefined): number | undefined | "invalid" {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    return "invalid";
  }
  return n;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const tenantId = await resolveTenantId(event);
  if (!tenantId) {
    return unauthorized("Missing or invalid Authorization Bearer or X-Api-Key");
  }

  const qs = event.queryStringParameters ?? {};
  const limit = parseLimit(qs.limit);
  if (limit === "invalid") {
    return badRequest(
      "INVALID_LIMIT",
      "limit must be a positive integer",
      "Pass limit as an integer from 1 to 50 (default 20)",
    );
  }

  if (qs.status !== undefined && qs.status !== "" && !isStatementStatus(qs.status)) {
    return badRequest(
      "INVALID_STATUS_FILTER",
      `Unknown status filter: ${qs.status}`,
      "Use status=pending_upload|uploaded|processing|ready|failed (or omit status)",
    );
  }

  const params: ListStatementsParams = {
    ...(limit !== undefined ? { limit } : {}),
    ...(qs.nextToken ? { nextToken: qs.nextToken } : {}),
    ...(qs.status && isStatementStatus(qs.status)
      ? { status: qs.status as StatementStatus }
      : {}),
  };

  const data = await listStatements(tenantId, params);
  if ("code" in data) {
    return badRequest(data.code, data.message, data.nextStep);
  }

  return json(200, data);
}
