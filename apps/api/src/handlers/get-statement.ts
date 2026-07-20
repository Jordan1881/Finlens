import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type {
  FinancialSummary,
  StatementRecord,
  StatementStatusResponse,
  StatementSummaryView,
} from "@finlens/domain";
import { json, notFound, unauthorized } from "../lib/http";
import { resolveTenantId } from "../lib/auth";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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
      nextStep: "Upload the statement again with upload_statement",
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

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const tenantId = await resolveTenantId(event);
  if (!tenantId) {
    return unauthorized("Missing or invalid X-Api-Key");
  }

  const statementId = event.pathParameters?.statementId;
  const tableName = process.env.STATEMENTS_TABLE;
  const detail = event.queryStringParameters?.detail === "full" ? "full" : "summary";

  if (!statementId) {
    return notFound("Statement not found");
  }
  if (!tableName) {
    return json(500, {
      error: {
        code: "SERVER_MISCONFIGURED",
        message: "Server misconfigured",
        retryable: true,
        nextStep: "Retry later",
      },
    });
  }

  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { tenantId, statementId },
    }),
  );

  const record = result.Item as StatementRecord | undefined;
  if (!record) {
    return notFound("Statement not found");
  }

  if (detail === "summary") {
    return json(200, toSummaryView(record));
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

  if (record.status === "failed" && record.errorMessage) {
    return json(200, {
      ...response,
      error: {
        code: "ANALYSIS_FAILED",
        message: record.errorMessage,
        retryable: true,
        nextStep: "Upload the statement again with upload_statement",
      },
    });
  }

  return json(200, response);
}
