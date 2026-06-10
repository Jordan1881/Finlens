import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { StatementRecord } from "@finlens/domain";

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface CreateAndUploadParams {
  tenantId: string;
  pdfBytes: Uint8Array;
  bucket: string;
  tableName: string;
}

export interface CreateAndUploadResult {
  statementId: string;
  s3Key: string;
  record: StatementRecord;
}

export async function createStatementAndUploadPdf(
  params: CreateAndUploadParams,
): Promise<CreateAndUploadResult> {
  const statementId = randomUUID();
  const now = new Date().toISOString();
  const s3Key = `statements/${params.tenantId}/${statementId}.pdf`;

  const record: StatementRecord = {
    tenantId: params.tenantId,
    statementId,
    status: "pending_upload",
    s3Key,
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(
    new PutCommand({
      TableName: params.tableName,
      Item: record,
      ConditionExpression: "attribute_not_exists(statementId)",
    }),
  );

  await s3.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: s3Key,
      Body: params.pdfBytes,
      ContentType: "application/pdf",
    }),
  );

  return { statementId, s3Key, record };
}
