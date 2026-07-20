import type {
  AskStatementResponse,
  CategoryBreakdownItem,
  CategoryBreakdownResponse,
  CategoryDiff,
  CompareStatementsResponse,
  ExtractedTransaction,
  FinancialSummary,
  StatementCompareSide,
  StatementRecord,
  StructuredError,
} from "@finlens/domain";
import {
  ASK_EXTRACT_MAX_CHARS,
  ASK_EXTRACT_MAX_TRANSACTIONS,
  questionLikelyNeedsExtract,
  runAskCompletion,
  type AskModelClient,
  createBedrockAskClient,
} from "./bedrock-ask.ts";
import { consumeAskQuota, type QuotaSeamDeps } from "./quota-service.ts";
import {
  fetchStatementRecord,
  hydrateTransactionExtract,
  resolveStatementSeamDeps,
  type StatementSeamDeps,
} from "./statement-service.ts";

function notReadyError(statementId: string, status: string): StructuredError {
  return {
    code: "STATEMENT_NOT_READY",
    message: `Statement ${statementId} is not ready for analysis tools (status=${status})`,
    retryable: status === "processing" || status === "uploaded" || status === "pending_upload",
    nextStep:
      status === "failed"
        ? "Re-upload the statement, then retry when status is ready"
        : "Poll get_statement until status is ready, then retry",
  };
}

function missingSummaryError(statementId: string): StructuredError {
  return {
    code: "ANALYSIS_INCOMPLETE",
    message: `Statement ${statementId} has no financialSummary`,
    retryable: true,
    nextStep: "Wait for Analysis to finish or re-upload the statement",
  };
}

function toCompareSide(record: StatementRecord): StatementCompareSide {
  const summary = record.financialSummary!;
  return {
    statementId: record.statementId,
    month: summary.month,
    currency: summary.currency,
    totalIncome: summary.totalIncome,
    totalExpenses: summary.totalExpenses,
    netBalance: summary.netBalance,
    topCategories: summary.topCategories,
  };
}

/** Prefer extract rollup when present so category tools improve without renaming. */
export function buildCategoryBreakdown(
  record: StatementRecord,
): CategoryBreakdownResponse | StructuredError {
  if (record.status !== "ready") {
    return notReadyError(record.statementId, record.status);
  }

  const summary = record.financialSummary;
  if (!summary) {
    return missingSummaryError(record.statementId);
  }

  const extract = record.transactionExtract;
  if (extract && extract.length > 0) {
    const categories = rollupCategoriesFromExtract(extract);
    return {
      statementId: record.statementId,
      status: record.status,
      currency: summary.currency,
      month: summary.month,
      source: "extract",
      categories,
      totalCategorized: categories.reduce((sum, c) => sum + c.amount, 0),
    };
  }

  const categories = withShares(summary.topCategories);
  return {
    statementId: record.statementId,
    status: record.status,
    currency: summary.currency,
    month: summary.month,
    source: "summary",
    categories,
    totalCategorized: categories.reduce((sum, c) => sum + c.amount, 0),
  };
}

function rollupCategoriesFromExtract(
  transactions: ExtractedTransaction[],
): CategoryBreakdownItem[] {
  const totals = new Map<string, number>();
  for (const tx of transactions) {
    if (tx.type !== "expense") {
      continue;
    }
    const category = (tx.category?.trim() || "uncategorized").toLowerCase();
    totals.set(category, (totals.get(category) ?? 0) + tx.amount);
  }

  const rows = [...totals.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  return withShares(rows);
}

function withShares(
  rows: Array<{ category: string; amount: number }>,
): CategoryBreakdownItem[] {
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  return rows.map((r) => ({
    category: r.category,
    amount: r.amount,
    ...(total > 0 ? { share: r.amount / total } : {}),
  }));
}

export function diffCategories(
  a: Array<{ category: string; amount: number }>,
  b: Array<{ category: string; amount: number }>,
): CategoryDiff[] {
  const mapA = new Map(a.map((c) => [c.category.toLowerCase(), c.amount]));
  const mapB = new Map(b.map((c) => [c.category.toLowerCase(), c.amount]));
  const names = new Set([...mapA.keys(), ...mapB.keys()]);
  const diffs: CategoryDiff[] = [];
  for (const name of names) {
    const amountA = mapA.get(name) ?? 0;
    const amountB = mapB.get(name) ?? 0;
    diffs.push({
      category: name,
      amountA,
      amountB,
      delta: amountB - amountA,
    });
  }
  return diffs.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

/** Category lists for compare — extract rollup when both sides have extracts. */
function categoriesForCompare(record: StatementRecord): Array<{ category: string; amount: number }> {
  if (record.transactionExtract && record.transactionExtract.length > 0) {
    return rollupCategoriesFromExtract(record.transactionExtract).map(({ category, amount }) => ({
      category,
      amount,
    }));
  }
  return record.financialSummary?.topCategories ?? [];
}

export function buildCompareResult(
  recordA: StatementRecord,
  recordB: StatementRecord,
): CompareStatementsResponse | StructuredError {
  if (recordA.status !== "ready") {
    return notReadyError(recordA.statementId, recordA.status);
  }
  if (recordB.status !== "ready") {
    return notReadyError(recordB.statementId, recordB.status);
  }
  if (!recordA.financialSummary) {
    return missingSummaryError(recordA.statementId);
  }
  if (!recordB.financialSummary) {
    return missingSummaryError(recordB.statementId);
  }

  const a = toCompareSide(recordA);
  const b = toCompareSide(recordB);
  return {
    a,
    b,
    deltas: {
      totalIncome: b.totalIncome - a.totalIncome,
      totalExpenses: b.totalExpenses - a.totalExpenses,
      netBalance: b.netBalance - a.netBalance,
      categories: diffCategories(categoriesForCompare(recordA), categoriesForCompare(recordB)),
    },
  };
}

function truncateExtractJson(transactions: ExtractedTransaction[]): string {
  const capped = transactions.slice(0, ASK_EXTRACT_MAX_TRANSACTIONS);
  let json = JSON.stringify(capped);
  if (json.length > ASK_EXTRACT_MAX_CHARS) {
    json = `${json.slice(0, ASK_EXTRACT_MAX_CHARS)}…[truncated]`;
  }
  return json;
}

function summaryJson(summary: FinancialSummary): string {
  return JSON.stringify({
    currency: summary.currency,
    month: summary.month,
    totalIncome: summary.totalIncome,
    totalExpenses: summary.totalExpenses,
    netBalance: summary.netBalance,
    topCategories: summary.topCategories,
  });
}

export interface PowerToolDeps extends StatementSeamDeps {
  /** Ask quota — required for ask_statement in production. */
  askQuota?: QuotaSeamDeps;
  askModel?: AskModelClient;
}

export async function getCategoryBreakdownWith(
  deps: StatementSeamDeps,
  tenantId: string,
  statementId: string,
): Promise<CategoryBreakdownResponse | StructuredError | null> {
  const record = await fetchStatementRecord(deps, tenantId, statementId);
  if (!record) {
    return null;
  }

  let working = record;
  if (
    record.status === "ready" &&
    !record.transactionExtract &&
    record.transactionExtractS3Key
  ) {
    working = await hydrateTransactionExtract(deps, record);
  }

  return buildCategoryBreakdown(working);
}

export async function compareStatementsWith(
  deps: StatementSeamDeps,
  tenantId: string,
  statementIdA: string,
  statementIdB: string,
): Promise<CompareStatementsResponse | StructuredError | null> {
  if (statementIdA === statementIdB) {
    return {
      code: "INVALID_REQUEST",
      message: "statementIdA and statementIdB must be different",
      retryable: false,
      nextStep: "Pass two distinct statementIds from the same Workspace",
    };
  }

  const [recordA, recordB] = await Promise.all([
    fetchStatementRecord(deps, tenantId, statementIdA),
    fetchStatementRecord(deps, tenantId, statementIdB),
  ]);

  // Either missing (or cross-tenant) → not found; do not leak which id failed.
  if (!recordA || !recordB) {
    return null;
  }

  let a = recordA;
  let b = recordB;
  if (a.status === "ready" && !a.transactionExtract && a.transactionExtractS3Key) {
    a = await hydrateTransactionExtract(deps, a);
  }
  if (b.status === "ready" && !b.transactionExtract && b.transactionExtractS3Key) {
    b = await hydrateTransactionExtract(deps, b);
  }

  return buildCompareResult(a, b);
}

export async function askStatementWith(
  deps: PowerToolDeps,
  tenantId: string,
  statementId: string,
  question: string,
): Promise<AskStatementResponse | StructuredError | null> {
  const trimmed = question.trim();
  if (!trimmed) {
    return {
      code: "INVALID_REQUEST",
      message: "question is required",
      retryable: false,
      nextStep: "Provide a non-empty natural-language question about the statement",
    };
  }

  const record = await fetchStatementRecord(deps, tenantId, statementId);
  if (!record) {
    return null;
  }
  if (record.status !== "ready") {
    return notReadyError(statementId, record.status);
  }
  if (!record.financialSummary) {
    return missingSummaryError(statementId);
  }

  if (deps.askQuota) {
    const quotaError = await consumeAskQuota(tenantId, deps.askQuota);
    if (quotaError) {
      return quotaError;
    }
  }

  // Start from stored summary+insights; hydrate extract only when the question needs line items.
  let extractJson: string | undefined;
  if (questionLikelyNeedsExtract(trimmed)) {
    let working = record;
    if (!working.transactionExtract && working.transactionExtractS3Key) {
      working = await hydrateTransactionExtract(deps, working);
    }
    if (working.transactionExtract && working.transactionExtract.length > 0) {
      extractJson = truncateExtractJson(working.transactionExtract);
    }
  }

  const client = deps.askModel ?? createBedrockAskClient();
  try {
    const answer = await runAskCompletion(client, {
      question: trimmed,
      summaryJson: summaryJson(record.financialSummary),
      insights: record.spendingInsights ?? [],
      ...(extractJson ? { extractJson } : {}),
    });

    return {
      statementId,
      question: trimmed,
      answer,
      contextUsed: extractJson ? "summary+extract" : "summary",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ask model failed";
    return {
      code: "ASK_FAILED",
      message,
      retryable: true,
      nextStep: "Retry ask_statement shortly; if it keeps failing, try a narrower question",
    };
  }
}

function powerToolDepsFromEnv(): PowerToolDeps {
  const base = resolveStatementSeamDeps();
  return {
    ...base,
    ...(base.quota ? { askQuota: base.quota } : {}),
  };
}

/** Production entry points — Workspace tenantId only. */
export async function getCategoryBreakdown(
  tenantId: string,
  statementId: string,
): Promise<CategoryBreakdownResponse | StructuredError | null> {
  return getCategoryBreakdownWith(powerToolDepsFromEnv(), tenantId, statementId);
}

export async function compareStatements(
  tenantId: string,
  statementIdA: string,
  statementIdB: string,
): Promise<CompareStatementsResponse | StructuredError | null> {
  return compareStatementsWith(powerToolDepsFromEnv(), tenantId, statementIdA, statementIdB);
}

export async function askStatement(
  tenantId: string,
  statementId: string,
  question: string,
): Promise<AskStatementResponse | StructuredError | null> {
  return askStatementWith(powerToolDepsFromEnv(), tenantId, statementId, question);
}
