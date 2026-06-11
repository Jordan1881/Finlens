export type StatementStatus =
  | "pending_upload"
  | "uploaded"
  | "processing"
  | "ready"
  | "failed";

export interface FinancialSummary {
  currency: string;
  month: string | null;
  totalIncome: number;
  totalExpenses: number;
  netBalance: number;
  topCategories: Array<{ category: string; amount: number }>;
}

export interface StatementRecord {
  tenantId: string;
  statementId: string;
  status: StatementStatus;
  s3Key: string;
  sourceFormat?: "pdf" | "csv";
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
  financialSummary?: FinancialSummary;
  spendingInsights?: string[];
}

export interface CreateStatementResponse {
  statementId: string;
  uploadUrl: string;
  expiresIn: number;
  s3Key: string;
}

export interface DirectUploadResponse {
  statementId: string;
  s3Key: string;
  status: StatementStatus;
}

export interface StatementStatusResponse {
  statementId: string;
  status: StatementStatus;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
  financialSummary?: FinancialSummary;
  spendingInsights?: string[];
}

export interface StatementSummaryView {
  statementId: string;
  status: StatementStatus;
  createdAt: string;
  updatedAt: string;
  currency?: string;
  month?: string | null;
  totalIncome?: number;
  totalExpenses?: number;
  netBalance?: number;
  topCategories?: Array<{ category: string; amount: number }>;
  spendingInsights?: string[];
  error?: StructuredError;
}

export interface StatementListItem {
  statementId: string;
  status: StatementStatus;
  createdAt: string;
  updatedAt: string;
  month: string | null;
  sourceFormat?: "pdf" | "csv";
}

export interface ListStatementsResponse {
  statements: StatementListItem[];
  count: number;
}

export interface DeleteStatementResponse {
  statementId: string;
  deleted: true;
}

export interface StructuredError {
  code: string;
  message: string;
  retryable: boolean;
  nextStep: string;
}
