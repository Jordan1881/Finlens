import { randomUUID } from "node:crypto";
import type { StatementRecord } from "@finlens/domain";
import type { StatementFileType } from "./file-validation.ts";

export interface BuildPendingStatementParams {
  tenantId: string;
  sourceFormat: StatementFileType;
  statementId?: string;
  now?: string;
  contentHash?: string;
  idempotencyKey?: string;
}

export interface PendingStatementParts {
  statementId: string;
  s3Key: string;
  record: StatementRecord;
}

/** Build a pending_upload Statement record + S3 key (no I/O). Shared by direct upload and presigned create. */
export function buildPendingStatement(
  params: BuildPendingStatementParams,
): PendingStatementParts {
  const statementId = params.statementId ?? randomUUID();
  const now = params.now ?? new Date().toISOString();
  const ext = params.sourceFormat === "csv" ? "csv" : "pdf";
  const s3Key = `statements/${params.tenantId}/${statementId}.${ext}`;

  const record: StatementRecord = {
    tenantId: params.tenantId,
    statementId,
    status: "pending_upload",
    s3Key,
    sourceFormat: params.sourceFormat,
    createdAt: now,
    updatedAt: now,
    ...(params.contentHash ? { contentHash: params.contentHash } : {}),
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
  };

  return { statementId, s3Key, record };
}

export function contentTypeFor(fileType: StatementFileType): string {
  return fileType === "csv" ? "text/csv" : "application/pdf";
}

export function sourceFormatForContentType(
  contentType: string,
): StatementFileType | null {
  if (contentType === "text/csv") return "csv";
  if (contentType === "application/pdf") return "pdf";
  return null;
}
