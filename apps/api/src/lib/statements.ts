/**
 * Legacy helpers — prefer statement-service / statement-record.
 * Kept so any external import of createStatementAndUploadFile keeps working.
 */
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { StatementRecord } from "@finlens/domain";
import type { StatementFileType } from "./file-validation.ts";
import { createStatementAndUploadFile as createAndUploadWithDeps } from "./statement-service.ts";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

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

export async function createStatementAndUploadFile(
  params: CreateAndUploadParams,
): Promise<CreateAndUploadResult> {
  return createAndUploadWithDeps(
    {
      ddb,
      s3,
      tableName: params.tableName,
      bucketName: params.bucket,
    },
    {
      tenantId: params.tenantId,
      fileBytes: params.fileBytes,
      fileType: params.fileType,
    },
  );
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
