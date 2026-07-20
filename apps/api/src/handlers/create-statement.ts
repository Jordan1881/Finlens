import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { CreateStatementResponse } from "@finlens/domain";
import { badRequest, json, unauthorized } from "../lib/http";
import { resolveTenantId } from "../lib/auth";
import { buildPendingStatement, sourceFormatForContentType } from "../lib/statement-record";
import {
  putPendingStatement,
  resolveStatementSeamDeps,
} from "../lib/statement-service";

const s3 = new S3Client({});
const UPLOAD_EXPIRY_SECONDS = 900;
const ALLOWED_TYPES = new Set(["application/pdf", "text/csv"]);

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const tenantId = await resolveTenantId(event);
  if (!tenantId) {
    return unauthorized("Missing or invalid X-Api-Key");
  }

  let contentType = "application/pdf";
  if (event.body) {
    try {
      const body = JSON.parse(event.body) as { contentType?: string };
      if (body.contentType) {
        if (!ALLOWED_TYPES.has(body.contentType)) {
          return badRequest(
            "UNSUPPORTED_FILE_TYPE",
            "Only application/pdf and text/csv uploads are supported",
            "Set contentType to application/pdf or text/csv",
          );
        }
        contentType = body.contentType;
      }
    } catch {
      return badRequest(
        "INVALID_REQUEST",
        "Invalid JSON body",
        'Send {} or { "contentType": "application/pdf" } or text/csv',
      );
    }
  }

  const sourceFormat = sourceFormatForContentType(contentType);
  if (!sourceFormat) {
    return badRequest(
      "UNSUPPORTED_FILE_TYPE",
      "Only application/pdf and text/csv uploads are supported",
      "Set contentType to application/pdf or text/csv",
    );
  }

  let deps;
  try {
    deps = resolveStatementSeamDeps();
  } catch {
    return json(500, { error: "Server misconfigured" });
  }

  const { statementId, s3Key, record } = buildPendingStatement({
    tenantId,
    sourceFormat,
  });

  await putPendingStatement(deps, record);

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: deps.bucketName,
      Key: s3Key,
      ContentType: contentType,
    }),
    { expiresIn: UPLOAD_EXPIRY_SECONDS },
  );

  const response: CreateStatementResponse = {
    statementId,
    uploadUrl,
    expiresIn: UPLOAD_EXPIRY_SECONDS,
    s3Key,
  };

  return json(201, response);
}
