import type { ExtractedTransaction } from "@finlens/domain";

export const ANALYSIS_SYSTEM_PROMPT = `You are Finlens, a bank statement analysis assistant.
Read the uploaded bank statement (PDF or CSV) and extract structured financial data.
The statement may be in Hebrew or English.
Respond with JSON only — no markdown, no explanation outside the JSON object.`;

export const ANALYSIS_USER_PROMPT = `Analyze this bank statement and return a JSON object with exactly these fields:
{
  "currency": "ISO 4217 code (e.g. ILS, USD)",
  "month": "YYYY-MM or null if unclear",
  "totalIncome": number,
  "totalExpenses": number,
  "netBalance": number,
  "topCategories": [{ "category": string, "amount": number }],
  "spendingInsights": [string],
  "transactions": [{
    "date": "YYYY-MM-DD when possible, else as printed",
    "description": string,
    "amount": number,
    "type": "income" | "expense",
    "category": string (optional)
  }]
}

Rules:
- totalExpenses should be a positive number representing total outflows.
- topCategories: up to 5 spending categories with amounts.
- spendingInsights: 3-5 short narrative bullets about spending patterns (same language as the statement when possible).
- transactions: one entry per statement line item (income and expense). amount is always a positive number; use type to distinguish direction. category optional; prefer short English or statement-language labels.
- Use 0 for unknown numeric fields; use null only for month when truly unknown.
- If the statement has no parseable line items, return "transactions": [].`;

export const ANALYSIS_CSV_PREFIX = `The following CSV is a bank statement export. Parse rows and infer totals:\n\n`;

export interface AnalysisResult {
  currency: string;
  month: string | null;
  totalIncome: number;
  totalExpenses: number;
  netBalance: number;
  topCategories: Array<{ category: string; amount: number }>;
  spendingInsights: string[];
  transactions: ExtractedTransaction[];
}

export function normalizeTransactions(raw: unknown): ExtractedTransaction[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const out: ExtractedTransaction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    if (typeof row.date !== "string" || !row.date.trim()) {
      continue;
    }
    if (typeof row.description !== "string" || !row.description.trim()) {
      continue;
    }
    if (typeof row.amount !== "number" || !Number.isFinite(row.amount)) {
      continue;
    }
    if (row.type !== "income" && row.type !== "expense") {
      continue;
    }

    const normalized: ExtractedTransaction = {
      date: row.date.trim(),
      description: row.description.trim(),
      amount: Math.abs(row.amount),
      type: row.type,
    };
    if (typeof row.category === "string" && row.category.trim()) {
      normalized.category = row.category.trim();
    }
    out.push(normalized);
  }
  return out;
}

export function parseAnalysisJson(raw: string): AnalysisResult {
  const trimmed = raw.trim();
  const jsonText =
    trimmed.startsWith("{") ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) {
    throw new Error("Model response did not contain JSON");
  }

  const parsed = JSON.parse(jsonText) as AnalysisResult;
  if (!parsed.currency || !Array.isArray(parsed.spendingInsights)) {
    throw new Error("Model JSON missing required fields");
  }

  return {
    ...parsed,
    transactions: normalizeTransactions(parsed.transactions),
  };
}
