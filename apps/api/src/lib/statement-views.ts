import type {
  StatementListItem,
  StatementRecord,
  StatementStatusResponse,
  StatementSummaryView,
  StructuredError,
} from "@finlens/domain";

/** Structured error for a failed analysis — shared by summary views. */
export function analysisFailedError(message: string): StructuredError {
  return {
    code: "ANALYSIS_FAILED",
    message,
    retryable: true,
    nextStep: "Call upload_statement again with the PDF or CSV",
  };
}

/** Map a DynamoDB Statement record to the list-item projection. */
export function toListItem(record: StatementRecord): StatementListItem {
  return {
    statementId: record.statementId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    month: record.financialSummary?.month ?? null,
    sourceFormat: record.sourceFormat,
  };
}

/** Map a Statement record to the summary view (MCP/REST default detail). */
export function toSummaryView(record: StatementRecord): StatementSummaryView {
  const view: StatementSummaryView = {
    statementId: record.statementId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };

  if (record.status === "failed" && record.errorMessage) {
    view.error = analysisFailedError(record.errorMessage);
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

/** Map a Statement record to the full status response. */
export function toFullStatusResponse(record: StatementRecord): StatementStatusResponse {
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
