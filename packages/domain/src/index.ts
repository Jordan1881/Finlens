export type StatementStatus = "pending_upload" | "uploaded" | "processing" | "ready" | "failed";

export interface FinancialSummary {
  currency: string;
  month: string | null;
  totalIncome: number;
  totalExpenses: number;
  netBalance: number;
  topCategories: Array<{ category: string; amount: number }>;
}
