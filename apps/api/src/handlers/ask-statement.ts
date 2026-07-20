import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import {
  badRequest,
  json,
  notFound,
  structuredError,
  tooManyRequests,
  unauthorized,
} from "../lib/http";
import { isQuotaError } from "../lib/quota-service";
import { askStatement } from "../lib/statement-power-tools";
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

  if (!event.body) {
    return badRequest(
      "INVALID_REQUEST",
      "Request body is required",
      'Send JSON { "question": "..." }',
    );
  }

  let question: string | undefined;
  try {
    const body = JSON.parse(
      event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body,
    ) as { question?: string };
    question = body.question;
  } catch {
    return badRequest(
      "INVALID_REQUEST",
      "Invalid JSON body",
      'Send { "question": "What were my top expenses?" }',
    );
  }

  if (!question || !question.trim()) {
    return badRequest(
      "INVALID_REQUEST",
      "question is required",
      "Provide a non-empty natural-language question about the statement",
    );
  }

  const result = await askStatement(tenantId, statementId, question);
  if (!result) {
    return notFound("Statement not found");
  }
  if ("code" in result) {
    if (isQuotaError(result)) {
      return tooManyRequests(result.code, result.message, result.nextStep, result.retryable);
    }
    const status =
      result.code === "STATEMENT_NOT_READY"
        ? 409
        : result.code === "ASK_FAILED"
          ? 502
          : 400;
    return structuredError(status, result.code, result.message, result.retryable, result.nextStep);
  }

  return json(200, result);
}
