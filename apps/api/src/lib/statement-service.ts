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
  ListStatementsResponse,
  StatementRecord,
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

const LIST_LIMIT = 20;

/** Minimal command sender — lets tests inject fakes without AWS SDK. */
export interface CommandClient {
  send(command: unknown): Promise<unknown>;
}

export interface StatementSeamDeps {
  ddb: CommandClient;
  s3: CommandClient;
  tableName: string;
  bucketName: string;
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
  return {
    ddb: defaultDdb,
    s3: defaultS3,
    tableName: envTableName(),
    bucketName: envBucketName(),
  };
}

async function fetchStatementRecord(
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

/** Load S3-backed extract into the record for detail=full (Workspace-scoped key). */
async function hydrateTransactionExtract(
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

export async function createStatementAndUploadFile(
  deps: StatementSeamDeps,
  params: {
    tenantId: string;
    fileBytes: Uint8Array;
    fileType: StatementFileType;
  },
): Promise<{ statementId: string; s3Key: string; record: StatementRecord }> {
  const { statementId, s3Key, record } = buildPendingStatement({
    tenantId: params.tenantId,
    sourceFormat: params.fileType,
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
): Promise<ListStatementsResponse> {
  const result = (await deps.ddb.send(
    new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "tenantId = :tenantId",
      ExpressionAttributeValues: { ":tenantId": tenantId },
      ScanIndexForward: false,
      Limit: LIST_LIMIT,
    }),
  )) as { Items?: StatementRecord[] };

  const statements = (result.Items ?? []).map(toListItem);
  return { statements, count: statements.length };
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
  filename?: string,
): Promise<DirectUploadResponse | StructuredError> {
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

  const { statementId, s3Key } = await createStatementAndUploadFile(deps, {
    tenantId,
    fileBytes,
    fileType,
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
export async function listStatements(tenantId: string): Promise<ListStatementsResponse> {
  return listStatementsWith(defaultDeps(), tenantId);
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
  filename?: string,
): Promise<DirectUploadResponse | StructuredError> {
  return uploadStatementWith(defaultDeps(), tenantId, fileBytes, filename);
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
