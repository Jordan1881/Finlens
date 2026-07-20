import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  DirectUploadResponse,
  ListStatementsParams,
  ListStatementsResponse,
  StatementRecord,
  StatementStatus,
  StatementStatusResponse,
  StatementSummaryView,
  StructuredError,
} from "@finlens/domain";
import {
  detectFileType,
  validateStatementBytes,
  type StatementFileType,
} from "./file-validation.ts";
import {
  buildPendingStatement,
  contentTypeFor,
} from "./statement-record.ts";
import {
  toFullStatusResponse,
  toListItem,
  toSummaryView,
} from "./statement-views.ts";
import {
  parseTransactionExtractJson,
  statementExpiresAt,
} from "./transaction-extract.ts";
import {
  enforceUploadQuotas,
  type QuotaSeamDeps,
} from "./quota-service.ts";

export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_LIMIT = 50;
/** GSI: tenantId (PK) + createdAt (SK) — newest-first list without UUID ordering. */
export const BY_TENANT_CREATED_AT_INDEX = "byTenantCreatedAt";
/** Reuse uploads with the same content hash or Idempotency-Key within this window. */
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_SCAN_PAGE = 50;

const STATEMENT_STATUSES: ReadonlySet<string> = new Set([
  "pending_upload",
  "uploaded",
  "processing",
  "ready",
  "failed",
]);

/** Minimal command sender — lets tests inject fakes without AWS SDK. */
export interface CommandClient {
  send(command: unknown): Promise<unknown>;
}

export interface StatementSeamDeps {
  ddb: CommandClient;
  s3: CommandClient;
  tableName: string;
  bucketName: string;
  /**
   * When set, direct upload enforces per-Workspace quotas (#23).
   * Omitted in pure lifecycle unit tests; production resolves from env.
   */
  quota?: QuotaSeamDeps;
  /** Injectable clock for idempotency window tests. */
  now?: () => Date;
}

export interface UploadStatementOptions {
  filename?: string;
  /** REST Idempotency-Key / MCP idempotency_key — reused within the window. */
  idempotencyKey?: string;
}

function envTableName(): string {
  const name = process.env.STATEMENTS_TABLE;
  if (!name) {
    throw new Error("STATEMENTS_TABLE is not configured");
  }
  return name;
}

function envBucketName(): string {
  const name = process.env.STATEMENTS_BUCKET;
  if (!name) {
    throw new Error("STATEMENTS_BUCKET is not configured");
  }
  return name;
}

const defaultDdb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const defaultS3 = new S3Client({});

function defaultDeps(): StatementSeamDeps {
  const tableName = envTableName();
  const workspacesTable = process.env.WORKSPACES_TABLE;
  return {
    ddb: defaultDdb,
    s3: defaultS3,
    tableName,
    bucketName: envBucketName(),
    ...(workspacesTable
      ? {
          quota: {
            ddb: defaultDdb,
            workspacesTableName: workspacesTable,
            statementsTableName: tableName,
          },
        }
      : {}),
  };
}

function currentTime(deps: StatementSeamDeps): Date {
  return deps.now ? deps.now() : new Date();
}

export function contentHashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function clampListLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) {
    return LIST_DEFAULT_LIMIT;
  }
  return Math.min(LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

export function encodeListCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

export function decodeListCursor(
  token: string,
  tenantId: string,
): Record<string, unknown> | StructuredError {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.tenantId !== tenantId ||
      typeof parsed.statementId !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return {
        code: "INVALID_CURSOR",
        message: "List cursor is invalid or expired",
        retryable: false,
        nextStep: "Omit nextToken and start a fresh list_statements / GET /v1/statements",
      };
    }
    return parsed;
  } catch {
    return {
      code: "INVALID_CURSOR",
      message: "List cursor could not be decoded",
      retryable: false,
      nextStep: "Omit nextToken and start a fresh list_statements / GET /v1/statements",
    };
  }
}

function invalidStatusError(status: string): StructuredError {
  return {
    code: "INVALID_STATUS_FILTER",
    message: `Unknown status filter: ${status}`,
    retryable: false,
    nextStep:
      "Use status=pending_upload|uploaded|processing|ready|failed (or omit status)",
  };
}

/** Workspace-scoped Statement load — cross-tenant ids return null (no existence leak). */
export async function fetchStatementRecord(
  deps: StatementSeamDeps,
  tenantId: string,
  statementId: string,
): Promise<StatementRecord | null> {
  const result = (await deps.ddb.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: { tenantId, statementId },
    }),
  )) as { Item?: StatementRecord };

  return result.Item ?? null;
}

/** Persist a new pending Statement row (presigned create + direct upload). */
export async function putPendingStatement(
  deps: StatementSeamDeps,
  record: StatementRecord,
): Promise<void> {
  await deps.ddb.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: { ...record, expiresAt: statementExpiresAt() },
      ConditionExpression: "attribute_not_exists(statementId)",
    }),
  );
}

/** Load S3-backed extract into the record for detail=full / power tools (Workspace-scoped key). */
export async function hydrateTransactionExtract(
  deps: StatementSeamDeps,
  record: StatementRecord,
): Promise<StatementRecord> {
  if (record.transactionExtract || !record.transactionExtractS3Key) {
    return record;
  }

  const object = (await deps.s3.send(
    new GetObjectCommand({
      Bucket: deps.bucketName,
      Key: record.transactionExtractS3Key,
    }),
  )) as { Body?: { transformToString: (encoding?: string) => Promise<string> } };

  const raw = await object.Body?.transformToString("utf8");
  if (!raw) {
    return record;
  }

  return {
    ...record,
    transactionExtract: parseTransactionExtractJson(raw),
  };
}

/**
 * Find a recent Statement with matching contentHash and/or idempotencyKey.
 * Scans newest-first via byTenantCreatedAt within the idempotency window.
 */
export async function findRecentDuplicateUpload(
  deps: StatementSeamDeps,
  tenantId: string,
  params: { contentHash?: string; idempotencyKey?: string },
): Promise<StatementRecord | null> {
  const { contentHash, idempotencyKey } = params;
  if (!contentHash && !idempotencyKey) {
    return null;
  }

  const cutoff = new Date(currentTime(deps).getTime() - IDEMPOTENCY_WINDOW_MS).toISOString();
  let exclusiveStartKey: Record<string, unknown> | undefined;

  for (let page = 0; page < 3; page += 1) {
    const result = (await deps.ddb.send(
      new QueryCommand({
        TableName: deps.tableName,
        IndexName: BY_TENANT_CREATED_AT_INDEX,
        KeyConditionExpression: "tenantId = :tenantId",
        ExpressionAttributeValues: { ":tenantId": tenantId },
        ScanIndexForward: false,
        Limit: IDEMPOTENCY_SCAN_PAGE,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    )) as {
      Items?: StatementRecord[];
      LastEvaluatedKey?: Record<string, unknown>;
    };

    for (const item of result.Items ?? []) {
      if (item.createdAt < cutoff) {
        return null;
      }
      if (idempotencyKey && item.idempotencyKey === idempotencyKey) {
        return item;
      }
      if (contentHash && item.contentHash === contentHash) {
        return item;
      }
    }

    if (!result.LastEvaluatedKey) {
      return null;
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  }

  return null;
}

export async function createStatementAndUploadFile(
  deps: StatementSeamDeps,
  params: {
    tenantId: string;
    fileBytes: Uint8Array;
    fileType: StatementFileType;
    contentHash?: string;
    idempotencyKey?: string;
  },
): Promise<{ statementId: string; s3Key: string; record: StatementRecord }> {
  const { statementId, s3Key, record } = buildPendingStatement({
    tenantId: params.tenantId,
    sourceFormat: params.fileType,
    contentHash: params.contentHash,
    idempotencyKey: params.idempotencyKey,
  });

  await putPendingStatement(deps, record);

  await deps.s3.send(
    new PutObjectCommand({
      Bucket: deps.bucketName,
      Key: s3Key,
      Body: params.fileBytes,
      ContentType: contentTypeFor(params.fileType),
    }),
  );

  return { statementId, s3Key, record };
}

export async function listStatementsWith(
  deps: StatementSeamDeps,
  tenantId: string,
  params: ListStatementsParams = {},
): Promise<ListStatementsResponse | StructuredError> {
  const limit = clampListLimit(params.limit);

  if (params.status !== undefined && !STATEMENT_STATUSES.has(params.status)) {
    return invalidStatusError(params.status);
  }

  let exclusiveStartKey: Record<string, unknown> | undefined;
  if (params.nextToken) {
    const decoded = decodeListCursor(params.nextToken, tenantId);
    if ("code" in decoded) {
      return decoded as StructuredError;
    }
    exclusiveStartKey = decoded;
  }

  const expressionAttributeValues: Record<string, string> = {
    ":tenantId": tenantId,
  };
  const expressionAttributeNames: Record<string, string> = {};
  let filterExpression: string | undefined;

  if (params.status) {
    expressionAttributeValues[":status"] = params.status;
    expressionAttributeNames["#status"] = "status";
    filterExpression = "#status = :status";
  }

  const result = (await deps.ddb.send(
    new QueryCommand({
      TableName: deps.tableName,
      IndexName: BY_TENANT_CREATED_AT_INDEX,
      KeyConditionExpression: "tenantId = :tenantId",
      ExpressionAttributeValues: expressionAttributeValues,
      ...(Object.keys(expressionAttributeNames).length > 0
        ? { ExpressionAttributeNames: expressionAttributeNames }
        : {}),
      ...(filterExpression ? { FilterExpression: filterExpression } : {}),
      ScanIndexForward: false,
      Limit: limit,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }),
  )) as {
    Items?: StatementRecord[];
    LastEvaluatedKey?: Record<string, unknown>;
  };

  const statements = (result.Items ?? []).map(toListItem);
  const response: ListStatementsResponse = {
    statements,
    count: statements.length,
  };

  if (result.LastEvaluatedKey) {
    response.nextToken = encodeListCursor(result.LastEvaluatedKey);
  }

  return response;
}

export async function getStatementWith(
  deps: StatementSeamDeps,
  tenantId: string,
  statementId: string,
  detail: "summary" | "full" = "summary",
): Promise<StatementSummaryView | StatementStatusResponse | null> {
  const record = await fetchStatementRecord(deps, tenantId, statementId);
  // Wrong-tenant or missing key both yield null — never leak cross-tenant existence.
  if (!record) {
    return null;
  }

  if (detail === "summary") {
    return toSummaryView(record);
  }

  const hydrated = await hydrateTransactionExtract(deps, record);
  return toFullStatusResponse(hydrated);
}

export async function uploadStatementWith(
  deps: StatementSeamDeps,
  tenantId: string,
  fileBytes: Uint8Array,
  filenameOrOptions?: string | UploadStatementOptions,
): Promise<DirectUploadResponse | StructuredError> {
  const options: UploadStatementOptions =
    typeof filenameOrOptions === "string"
      ? { filename: filenameOrOptions }
      : (filenameOrOptions ?? {});
  const { filename, idempotencyKey } = options;

  const fileType: StatementFileType | null = detectFileType(filename, fileBytes);
  if (!fileType) {
    return {
      code: "UNSUPPORTED_FILE_TYPE",
      message: "Only PDF and CSV bank statements are supported",
      retryable: false,
      nextStep: "Upload a .pdf or .csv file exported from your bank",
    };
  }

  const validationError = validateStatementBytes(fileBytes, fileType);
  if (validationError) {
    return {
      code: validationError.code,
      message: validationError.message,
      retryable: false,
      nextStep: validationError.nextStep,
    };
  }

  const contentHash = contentHashOf(fileBytes);
  const duplicate = await findRecentDuplicateUpload(deps, tenantId, {
    contentHash,
    idempotencyKey,
  });
  if (duplicate) {
    return {
      statementId: duplicate.statementId,
      s3Key: duplicate.s3Key,
      status: duplicate.status,
      idempotentReplay: true,
    };
  }

  if (deps.quota) {
    const quotaError = await enforceUploadQuotas(tenantId, deps.quota);
    if (quotaError) {
      return quotaError;
    }
  }

  const { statementId, s3Key } = await createStatementAndUploadFile(deps, {
    tenantId,
    fileBytes,
    fileType,
    contentHash,
    idempotencyKey,
  });

  return {
    statementId,
    s3Key,
    status: "pending_upload",
  };
}

export async function deleteStatementWith(
  deps: StatementSeamDeps,
  tenantId: string,
  statementId: string,
): Promise<{ statementId: string; deleted: true } | null> {
  const record = await fetchStatementRecord(deps, tenantId, statementId);
  if (!record) {
    return null;
  }

  if (record.s3Key) {
    await deps.s3.send(
      new DeleteObjectCommand({
        Bucket: deps.bucketName,
        Key: record.s3Key,
      }),
    );
  }

  if (record.transactionExtractS3Key) {
    await deps.s3.send(
      new DeleteObjectCommand({
        Bucket: deps.bucketName,
        Key: record.transactionExtractS3Key,
      }),
    );
  }

  await deps.ddb.send(
    new DeleteCommand({
      TableName: deps.tableName,
      Key: { tenantId, statementId },
    }),
  );

  return { statementId, deleted: true };
}

/** Production entry points — resolve env + default AWS clients. */
export async function listStatements(
  tenantId: string,
  params: ListStatementsParams = {},
): Promise<ListStatementsResponse | StructuredError> {
  return listStatementsWith(defaultDeps(), tenantId, params);
}

export async function getStatement(
  tenantId: string,
  statementId: string,
  detail: "summary" | "full" = "summary",
): Promise<StatementSummaryView | StatementStatusResponse | null> {
  return getStatementWith(defaultDeps(), tenantId, statementId, detail);
}

export async function uploadStatement(
  tenantId: string,
  fileBytes: Uint8Array,
  filenameOrOptions?: string | UploadStatementOptions,
): Promise<DirectUploadResponse | StructuredError> {
  return uploadStatementWith(defaultDeps(), tenantId, fileBytes, filenameOrOptions);
}

export async function deleteStatement(
  tenantId: string,
  statementId: string,
): Promise<{ statementId: string; deleted: true } | null> {
  return deleteStatementWith(defaultDeps(), tenantId, statementId);
}

/** Resolve default seam deps from env (for handlers that need putPendingStatement / create). */
export function resolveStatementSeamDeps(): StatementSeamDeps {
  return defaultDeps();
}

export function isStatementStatus(value: string): value is StatementStatus {
  return STATEMENT_STATUSES.has(value);
}
