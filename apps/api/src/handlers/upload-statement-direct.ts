import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { badRequest, json, structuredError, tooManyRequests, unauthorized } from "../lib/http";
import { isQuotaError } from "../lib/quota-service";
import { uploadStatement } from "../lib/statement-service";
import { resolveTenantId } from "../lib/auth";

function headerValue(
  headers: APIGatewayProxyEventV2["headers"],
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value) {
      return value;
    }
  }
  return undefined;
}

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
      "Send JSON with base64 and filename fields",
    );
  }

  let base64: string;
  let filename: string | undefined;
  try {
    const body = JSON.parse(
      event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body,
    ) as { base64?: string; filename?: string };
    if (!body.base64) {
      return badRequest(
        "INVALID_REQUEST",
        "base64 field is required",
        "Encode the statement file as base64 in the request body",
      );
    }
    base64 = body.base64;
    filename = body.filename;
  } catch {
    return badRequest(
      "INVALID_REQUEST",
      "Invalid JSON body",
      'Send { "base64": "...", "filename": "statement.pdf" } or .csv',
    );
  }

  let fileBytes: Uint8Array;
  try {
    fileBytes = Uint8Array.from(Buffer.from(base64, "base64"));
  } catch {
    return badRequest(
      "INVALID_REQUEST",
      "Invalid base64 encoding",
      "Provide valid base64-encoded file bytes",
    );
  }

  const idempotencyKey = headerValue(event.headers, "Idempotency-Key");
  const result = await uploadStatement(tenantId, fileBytes, {
    filename,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  if ("code" in result) {
    if (isQuotaError(result)) {
      return tooManyRequests(result.code, result.message, result.nextStep, result.retryable);
    }
    return structuredError(400, result.code, result.message, result.retryable, result.nextStep);
  }

  return json(result.idempotentReplay ? 200 : 201, result);
}
