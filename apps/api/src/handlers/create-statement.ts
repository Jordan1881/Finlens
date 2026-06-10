import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { CreateStatementResponse, StatementRecord } from "@finlens/domain";
import { badRequest, json, unauthorized } from "../lib/http";
import { resolveTenantId } from "../lib/auth";

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const UPLOAD_EXPIRY_SECONDS = 900;

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
    return json(500, { error: "Server misconfigured" });
  }

  let contentType = "application/pdf";
  if (event.body) {
    try {
      const body = JSON.parse(event.body) as { contentType?: string };
      if (body.contentType && !body.contentType.startsWith("application/pdf")) {
        return badRequest(
          "INVALID_PDF",
          "Only application/pdf uploads are supported",
          "Set contentType to application/pdf",
        );
      }
      if (body.contentType) {
        contentType = body.contentType;
      }
    } catch {
      return badRequest("INVALID_REQUEST", "Invalid JSON body", "Send {} or { \"contentType\": \"application/pdf\" }");
    }
  }

  const statementId = randomUUID();
  const now = new Date().toISOString();
  const s3Key = `statements/${tenantId}/${statementId}.pdf`;

  const record: StatementRecord = {
    tenantId,
    statementId,
    status: "pending_upload",
    s3Key,
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: record,
      ConditionExpression: "attribute_not_exists(statementId)",
    }),
  );

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucket,
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
