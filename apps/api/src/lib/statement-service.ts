import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  DirectUploadResponse,
  ListStatementsResponse,
  StatementListItem,
  StatementRecord,
  StatementStatusResponse,
  StatementSummaryView,
} from "@finlens/domain";
import type { StructuredError } from "@finlens/domain";
import {
  detectFileType,
  validateStatementBytes,
  type StatementFileType,
} from "./file-validation";
import { createStatementAndUploadFile } from "./statements";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const LIST_LIMIT = 20;

function tableName(): string {
  const name = process.env.STATEMENTS_TABLE;
  if (!name) {
    throw new Error("STATEMENTS_TABLE is not configured");
  }
  return name;
}

function bucketName(): string {
  const name = process.env.STATEMENTS_BUCKET;
  if (!name) {
    throw new Error("STATEMENTS_BUCKET is not configured");
  }
  return name;
}

function toSummaryView(record: StatementRecord): StatementSummaryView {
  const view: StatementSummaryView = {
    statementId: record.statementId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };

  if (record.status === "failed" && record.errorMessage) {
    view.error = {
      code: "ANALYSIS_FAILED",
      message: record.errorMessage,
      retryable: true,
      nextStep: "Call upload_statement again with the PDF or CSV",
    };
  }

  if (record.status === "ready" && record.financialSummary) {
    const summary = record.financialSummary;
    view.currency = summary.currency;
    view.month = summary.month;
    view.totalIncome = summary.totalIncome;
    view.totalExpenses = summary.totalExpenses;
    view.netBalance = summary.netBalance;
    view.topCategories = summary.topCategories.slice(0, 3);
    view.spendingInsights = record.spendingInsights;
  }

  return view;
}

async function fetchStatementRecord(
  tenantId: string,
  statementId: string,
): Promise<StatementRecord | null> {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName(),
      Key: { tenantId, statementId },
    }),
  );

  const record = result.Item as StatementRecord | undefined;
  return record ?? null;
}

export async function listStatements(tenantId: string): Promise<ListStatementsResponse> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: "tenantId = :tenantId",
      ExpressionAttributeValues: { ":tenantId": tenantId },
      ScanIndexForward: false,
      Limit: LIST_LIMIT,
    }),
  );

  const statements: StatementListItem[] = ((result.Items ?? []) as StatementRecord[]).map(
    (record) => ({
      statementId: record.statementId,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      month: record.financialSummary?.month ?? null,
      sourceFormat: record.sourceFormat,
    }),
  );

  return { statements, count: statements.length };
}

export async function getStatement(
  tenantId: string,
  statementId: string,
  detail: "summary" | "full" = "summary",
): Promise<StatementSummaryView | StatementStatusResponse | null> {
  const record = await fetchStatementRecord(tenantId, statementId);
  if (!record) {
    return null;
  }

  if (detail === "summary") {
    return toSummaryView(record);
  }

  const response: StatementStatusResponse = {
    statementId: record.statementId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    errorMessage: record.errorMessage,
  };

  if (record.status === "ready") {
    response.financialSummary = record.financialSummary;
    response.spendingInsights = record.spendingInsights;
  }

  return response;
}

export async function uploadStatement(
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

  const { statementId, s3Key } = await createStatementAndUploadFile({
    tenantId,
    fileBytes,
    fileType,
    bucket: bucketName(),
    tableName: tableName(),
  });

  return {
    statementId,
    s3Key,
    status: "pending_upload",
  };
}

export async function deleteStatement(
  tenantId: string,
  statementId: string,
): Promise<{ statementId: string; deleted: true } | null> {
  const record = await fetchStatementRecord(tenantId, statementId);
  if (!record) {
    return null;
  }

  if (record.s3Key) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucketName(),
        Key: record.s3Key,
      }),
    );
  }

  await ddb.send(
    new DeleteCommand({
      TableName: tableName(),
      Key: { tenantId, statementId },
    }),
  );

  return { statementId, deleted: true };
}
