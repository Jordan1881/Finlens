import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeTransactions,
  parseAnalysisJson,
} from "./analysis-prompt.ts";
import {
  MAX_INLINE_EXTRACT_BYTES,
  serializeTransactionExtract,
  shouldStoreExtractInline,
  statementExpiresAt,
  transactionExtractS3Key,
} from "./transaction-extract.ts";

describe("analysis prompt parse", () => {
  it("parses summary fields and normalizes transactions", () => {
    const result = parseAnalysisJson(`{
      "currency": "ILS",
      "month": "2026-06",
      "totalIncome": 100,
      "totalExpenses": 40,
      "netBalance": 60,
      "topCategories": [{ "category": "food", "amount": 40 }],
      "spendingInsights": ["ok"],
      "transactions": [
        { "date": "2026-06-01", "description": "Salary", "amount": 100, "type": "income" },
        { "date": "2026-06-02", "description": "Cafe", "amount": -20, "type": "expense", "category": "food" },
        { "date": "bad", "description": "x", "amount": 1, "type": "transfer" }
      ]
    }`);

    assert.equal(result.currency, "ILS");
    assert.equal(result.transactions.length, 2);
    assert.equal(result.transactions[1]?.amount, 20);
    assert.equal(result.transactions[1]?.category, "food");
  });

  it("defaults missing transactions to empty array", () => {
    const result = parseAnalysisJson(`{
      "currency": "USD",
      "month": null,
      "totalIncome": 0,
      "totalExpenses": 0,
      "netBalance": 0,
      "topCategories": [],
      "spendingInsights": ["none"]
    }`);
    assert.deepEqual(result.transactions, []);
  });

  it("repairs trailing commas and markdown fences", () => {
    const result = parseAnalysisJson(`\`\`\`json
{
  "currency": "ILS",
  "month": "2026-05",
  "totalIncome": 10,
  "totalExpenses": 3,
  "netBalance": 7,
  "topCategories": [{ "category": "food", "amount": 3, }],
  "spendingInsights": ["ok",],
  "transactions": [],
}
\`\`\``);
    assert.equal(result.currency, "ILS");
    assert.equal(result.totalIncome, 10);
    assert.deepEqual(result.transactions, []);
  });

  it("normalizeTransactions drops invalid rows", () => {
    assert.deepEqual(
      normalizeTransactions([
        { date: "2026-01-01", description: "ok", amount: 1, type: "expense" },
        null,
        { date: "", description: "x", amount: 1, type: "expense" },
      ]),
      [{ date: "2026-01-01", description: "ok", amount: 1, type: "expense" }],
    );
  });
});

describe("transaction extract storage helpers", () => {
  it("builds tenant-scoped extract S3 key", () => {
    assert.equal(
      transactionExtractS3Key("ws-1", "stmt-9"),
      "statements/ws-1/stmt-9.extract.json",
    );
  });

  it("keeps modest extracts inline and overflows large ones", () => {
    const small = [{ date: "2026-01-01", description: "a", amount: 1, type: "expense" as const }];
    assert.equal(shouldStoreExtractInline(small), true);

    const fatDescription = "x".repeat(2_000);
    const large = Array.from({ length: 150 }, (_, i) => ({
      date: "2026-01-01",
      description: `${fatDescription}-${i}`,
      amount: i,
      type: "expense" as const,
    }));
    const bytes = Buffer.byteLength(serializeTransactionExtract(large), "utf8");
    assert.ok(bytes > MAX_INLINE_EXTRACT_BYTES);
    assert.equal(shouldStoreExtractInline(large), false);
  });

  it("statementExpiresAt is ~90 days ahead", () => {
    const now = Date.parse("2026-07-20T00:00:00.000Z");
    const expires = statementExpiresAt(now);
    assert.equal(expires, Math.floor(now / 1000) + 90 * 24 * 60 * 60);
  });
});
