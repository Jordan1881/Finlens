import type { StructuredError } from "@finlens/domain";
import type { APIGatewayProxyResultV2 } from "aws-lambda";

export function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
    body: JSON.stringify(body),
  };
}

export function structuredError(
  statusCode: number,
  code: string,
  message: string,
  retryable: boolean,
  nextStep: string,
): APIGatewayProxyResultV2 {
  const error: StructuredError = { code, message, retryable, nextStep };
  return json(statusCode, { error });
}

export function badRequest(
  code: string,
  message: string,
  nextStep: string,
): APIGatewayProxyResultV2 {
  return structuredError(400, code, message, false, nextStep);
}

export function unauthorized(message = "Unauthorized"): APIGatewayProxyResultV2 {
  return structuredError(401, "UNAUTHORIZED", message, false, "Provide a valid X-Api-Key header");
}

export function notFound(message: string): APIGatewayProxyResultV2 {
  return structuredError(404, "NOT_FOUND", message, false, "Check the statementId or upload a new statement");
}
