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
  "spendingInsights": [string]
}

Rules:
- totalExpenses should be a positive number representing total outflows.
- topCategories: up to 5 spending categories with amounts.
- spendingInsights: 3-5 short narrative bullets about spending patterns (same language as the statement when possible).
- Use 0 for unknown numeric fields; use null only for month when truly unknown.`;

export const ANALYSIS_CSV_PREFIX = `The following CSV is a bank statement export. Parse rows and infer totals:\n\n`;

export interface AnalysisResult {
  currency: string;
  month: string | null;
  totalIncome: number;
  totalExpenses: number;
  netBalance: number;
  topCategories: Array<{ category: string; amount: number }>;
  spendingInsights: string[];
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

  return parsed;
}
