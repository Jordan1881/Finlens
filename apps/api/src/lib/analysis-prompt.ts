import type { ExtractedTransaction } from "@finlens/domain";

export const ANALYSIS_SYSTEM_PROMPT = `You are Finlens, a bank statement analysis assistant.
Read the uploaded bank statement (PDF or CSV) and extract structured financial data.
The statement may be in Hebrew or English.
Respond with JSON only — no markdown, no explanation outside the JSON object.
Escape all quotes inside strings. Never use trailing commas.`;

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

/** Tool name forced via Bedrock Converse toolChoice for structured analysis output. */
export const ANALYSIS_TOOL_NAME = "report_statement_analysis";

/** JSON Schema for the analysis tool input (Bedrock toolUse). */
export const ANALYSIS_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    currency: { type: "string", description: "ISO 4217 code (e.g. ILS, USD)" },
    month: {
      type: "string",
      description: 'YYYY-MM, or empty string "" if unclear',
    },
    totalIncome: { type: "number" },
    totalExpenses: { type: "number" },
    netBalance: { type: "number" },
    topCategories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string" },
          amount: { type: "number" },
        },
        required: ["category", "amount"],
        additionalProperties: false,
      },
    },
    spendingInsights: {
      type: "array",
      items: { type: "string" },
    },
    transactions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          description: { type: "string" },
          amount: { type: "number" },
          type: { type: "string", enum: ["income", "expense"] },
          category: { type: "string" },
        },
        required: ["date", "description", "amount", "type"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "currency",
    "month",
    "totalIncome",
    "totalExpenses",
    "netBalance",
    "topCategories",
    "spendingInsights",
    "transactions",
  ],
  additionalProperties: false,
} as const;

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

/** Strip markdown fences and isolate the outermost `{...}` object. */
export function extractJsonObject(raw: string): string | null {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fence?.[1]) {
    text = fence[1].trim();
  }

  if (text.startsWith("{")) {
    return sliceBalancedObject(text);
  }

  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }
  return sliceBalancedObject(text.slice(start));
}

function sliceBalancedObject(text: string): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(0, i + 1);
      }
    }
  }
  return null;
}

/** Best-effort fixes for common model JSON mistakes (trailing commas). */
export function repairJsonText(jsonText: string): string {
  return jsonText.replace(/,\s*([}\]])/g, "$1");
}

export function coerceAnalysisResult(parsed: unknown): AnalysisResult {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Model JSON missing required fields");
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.currency !== "string" || !row.currency.trim()) {
    throw new Error("Model JSON missing required fields");
  }
  if (!Array.isArray(row.spendingInsights)) {
    throw new Error("Model JSON missing required fields");
  }

  return {
    currency: row.currency.trim(),
    month:
      typeof row.month === "string" && row.month.trim() && row.month.trim().toLowerCase() !== "null"
        ? row.month.trim()
        : null,
    totalIncome: typeof row.totalIncome === "number" && Number.isFinite(row.totalIncome) ? row.totalIncome : 0,
    totalExpenses:
      typeof row.totalExpenses === "number" && Number.isFinite(row.totalExpenses) ? row.totalExpenses : 0,
    netBalance: typeof row.netBalance === "number" && Number.isFinite(row.netBalance) ? row.netBalance : 0,
    topCategories: Array.isArray(row.topCategories)
      ? row.topCategories.filter(
          (c): c is { category: string; amount: number } =>
            !!c &&
            typeof c === "object" &&
            typeof (c as { category?: unknown }).category === "string" &&
            typeof (c as { amount?: unknown }).amount === "number",
        )
      : [],
    spendingInsights: row.spendingInsights.filter((s): s is string => typeof s === "string"),
    transactions: normalizeTransactions(row.transactions),
  };
}

export function parseAnalysisJson(raw: string): AnalysisResult {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    throw new Error("Model response did not contain JSON");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    parsed = JSON.parse(repairJsonText(jsonText));
  }

  return coerceAnalysisResult(parsed);
}
