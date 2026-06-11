import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { StatementRecord } from "@finlens/domain";
import type { StatementFileType } from "./file-validation";

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface CreateAndUploadParams {
  tenantId: string;
  fileBytes: Uint8Array;
  fileType: StatementFileType;
  bucket: string;
  tableName: string;
}

export interface CreateAndUploadResult {
  statementId: string;
  s3Key: string;
  record: StatementRecord;
}

function contentTypeFor(fileType: StatementFileType): string {
  return fileType === "csv" ? "text/csv" : "application/pdf";
}

export async function createStatementAndUploadFile(
  params: CreateAndUploadParams,
): Promise<CreateAndUploadResult> {
  const statementId = randomUUID();
  const now = new Date().toISOString();
  const ext = params.fileType === "csv" ? "csv" : "pdf";
  const s3Key = `statements/${params.tenantId}/${statementId}.${ext}`;

  const record: StatementRecord = {
    tenantId: params.tenantId,
    statementId,
    status: "pending_upload",
    s3Key,
    sourceFormat: params.fileType,
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
      Body: params.fileBytes,
      ContentType: contentTypeFor(params.fileType),
    }),
  );

  return { statementId, s3Key, record };
}

/** @deprecated use createStatementAndUploadFile */
export async function createStatementAndUploadPdf(
  params: Omit<CreateAndUploadParams, "fileType" | "fileBytes"> & { pdfBytes: Uint8Array },
): Promise<CreateAndUploadResult> {
  return createStatementAndUploadFile({
    ...params,
    fileBytes: params.pdfBytes,
    fileType: "pdf",
  });
}
