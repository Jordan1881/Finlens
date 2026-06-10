import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { DirectUploadResponse } from "@finlens/domain";
import { badRequest, json, unauthorized } from "../lib/http";
import { validatePdfBytes } from "../lib/pdf-validation";
import { createStatementAndUploadPdf } from "../lib/statements";
import { resolveTenantId } from "../lib/auth";

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const tenantId = resolveTenantId(event);
  if (!tenantId) {
    return unauthorized("Missing or invalid X-Api-Key");
  }

  const bucket = process.env.STATEMENTS_BUCKET;
  const tableName = process.env.STATEMENTS_TABLE;
  if (!bucket || !tableName) {
    return json(500, {
      error: {
        code: "SERVER_MISCONFIGURED",
        message: "Server misconfigured",
        retryable: true,
        nextStep: "Retry later",
      },
    });
  }

  if (!event.body) {
    return badRequest("INVALID_REQUEST", "Request body is required", "Send JSON with base64 and filename fields");
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
      return badRequest("INVALID_REQUEST", "base64 field is required", "Encode the PDF as base64 in the request body");
    }
    base64 = body.base64;
    filename = body.filename;
  } catch {
    return badRequest("INVALID_REQUEST", "Invalid JSON body", "Send { \"base64\": \"...\", \"filename\": \"statement.pdf\" }");
  }

  if (filename && !filename.toLowerCase().endsWith(".pdf")) {
    return badRequest("INVALID_PDF", "Filename must end with .pdf", "Use a .pdf filename");
  }

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = Uint8Array.from(Buffer.from(base64, "base64"));
  } catch {
    return badRequest("INVALID_REQUEST", "Invalid base64 encoding", "Provide valid base64-encoded PDF bytes");
  }

  const validationError = validatePdfBytes(pdfBytes);
  if (validationError) {
    return badRequest(validationError.code, validationError.message, validationError.nextStep);
  }

  const { statementId, s3Key } = await createStatementAndUploadPdf({
    tenantId,
    pdfBytes,
    bucket,
    tableName,
  });

  const response: DirectUploadResponse = {
    statementId,
    s3Key,
    status: "pending_upload",
  };

  return json(201, response);
}
