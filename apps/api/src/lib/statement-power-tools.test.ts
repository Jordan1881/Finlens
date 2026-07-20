import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StatementRecord } from "@finlens/domain";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { AskModelClient } from "./bedrock-ask.ts";
import { questionLikelyNeedsExtract } from "./bedrock-ask.ts";
import { quotaCounterKeys, type QuotaSeamDeps } from "./quota-service.ts";
import {
  askStatementWith,
  buildCategoryBreakdown,
  buildCompareResult,
  compareStatementsWith,
  getCategoryBreakdownWith,
  type PowerToolDeps,
} from "./statement-power-tools.ts";
import type { CommandClient, StatementSeamDeps } from "./statement-service.ts";
import { serializeTransactionExtract } from "./transaction-extract.ts";

const NOW = "2026-07-20T12:00:00.000Z";

function readyRecord(overrides: Partial<StatementRecord> = {}): StatementRecord {
  return {
    tenantId: "tenant-a",
    statementId: "stmt-1",
    status: "ready",
    s3Key: "statements/tenant-a/stmt-1.pdf",
    sourceFormat: "pdf",
    createdAt: NOW,
    updatedAt: NOW,
    financialSummary: {
      currency: "ILS",
      month: "2026-05",
      totalIncome: 10000,
      totalExpenses: 4000,
      netBalance: 6000,
      topCategories: [
        { category: "food", amount: 2000 },
        { category: "rent", amount: 1500 },
      ],
    },
    spendingInsights: ["Dining is high"],
    ...overrides,
  };
}

function createMemoryDeps(seed: StatementRecord[] = []): {
  deps: StatementSeamDeps;
  store: Map<string, StatementRecord>;
  objects: Map<string, string>;
} {
  const store = new Map<string, StatementRecord>();
  for (const record of seed) {
    store.set(`${record.tenantId}#${record.statementId}`, record);
  }
  const objects = new Map<string, string>();

  const ddb: CommandClient = {
    async send(command: unknown) {
      if (command instanceof GetCommand) {
        const key = command.input.Key as { tenantId: string; statementId: string };
        return { Item: store.get(`${key.tenantId}#${key.statementId}`) };
      }
      throw new Error(
        `Unexpected DDB command: ${(command as { constructor: { name: string } }).constructor.name}`,
      );
    },
  };

  const s3: CommandClient = {
    async send(command: unknown) {
      if (command instanceof GetObjectCommand) {
        const key = command.input.Key as string;
        const raw = objects.get(key);
        if (raw === undefined) {
          throw new Error(`Missing S3 object: ${key}`);
        }
        return {
          Body: {
            transformToString: async () => raw,
          },
        };
      }
      throw new Error(
        `Unexpected S3 command: ${(command as { constructor: { name: string } }).constructor.name}`,
      );
    },
  };

  return {
    deps: { ddb, s3, tableName: "Statements", bucketName: "bucket" },
    store,
    objects,
  };
}

function createAskQuotaMemory(limit = 100): QuotaSeamDeps {
  const store = new Map<string, Record<string, unknown>>();
  const ddb: CommandClient = {
    async send(command: unknown) {
      if (command instanceof GetCommand) {
        const key = command.input.Key as { pk: string; sk: string };
        return { Item: store.get(`${key.pk}#${key.sk}`) };
      }
      if (command instanceof UpdateCommand) {
        const key = command.input.Key as { pk: string; sk: string };
        const mapKey = `${key.pk}#${key.sk}`;
        const existing = store.get(mapKey) ?? { ...key };
        const values = (command.input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
        const condition = command.input.ConditionExpression as string | undefined;
        const currentCount =
          typeof existing.count === "number" ? (existing.count as number) : undefined;
        if (condition?.includes("#count < :limit")) {
          const lim = values[":limit"] as number;
          if (currentCount !== undefined && currentCount >= lim) {
            const err = new Error("Conditional check failed");
            err.name = "ConditionalCheckFailedException";
            throw err;
          }
        }
        store.set(mapKey, {
          ...existing,
          pk: key.pk,
          sk: key.sk,
          count: (currentCount ?? 0) + 1,
        });
        return {};
      }
      throw new Error("unexpected");
    },
  };
  return {
    ddb,
    workspacesTableName: "Workspaces",
    statementsTableName: "Statements",
    limits: { asksPerDay: limit },
    now: () => new Date("2026-07-21T12:00:00.000Z"),
  };
}

describe("category breakdown", () => {
  it("uses summary topCategories when extract is absent", () => {
    const result = buildCategoryBreakdown(readyRecord());
    assert.ok(!("code" in result));
    assert.equal(result.source, "summary");
    assert.equal(result.categories.length, 2);
    assert.equal(result.categories[0]?.category, "food");
    assert.ok(result.categories[0]?.share !== undefined);
  });

  it("rolls up expense categories from extract without renaming the tool", () => {
    const result = buildCategoryBreakdown(
      readyRecord({
        transactionExtract: [
          { date: "2026-05-01", description: "Cafe", amount: 40, type: "expense", category: "Food" },
          { date: "2026-05-02", description: "Market", amount: 60, type: "expense", category: "food" },
          { date: "2026-05-03", description: "Pay", amount: 1000, type: "income", category: "salary" },
          { date: "2026-05-04", description: "Bus", amount: 20, type: "expense" },
        ],
      }),
    );
    assert.ok(!("code" in result));
    assert.equal(result.source, "extract");
    assert.equal(result.totalCategorized, 120);
    const food = result.categories.find((c) => c.category === "food");
    const uncategorized = result.categories.find((c) => c.category === "uncategorized");
    assert.equal(food?.amount, 100);
    assert.equal(uncategorized?.amount, 20);
  });

  it("hydrates S3 extract for breakdown and denies cross-tenant", async () => {
    const extractKey = "statements/tenant-a/stmt-1.extract.json";
    const { deps, objects } = createMemoryDeps([
      readyRecord({
        transactionExtractS3Key: extractKey,
      }),
      readyRecord({
        tenantId: "tenant-b",
        statementId: "other",
        financialSummary: {
          currency: "USD",
          month: "2026-01",
          totalIncome: 1,
          totalExpenses: 1,
          netBalance: 0,
          topCategories: [{ category: "x", amount: 1 }],
        },
      }),
    ]);
    objects.set(
      extractKey,
      serializeTransactionExtract([
        { date: "2026-05-01", description: "Rent", amount: 1500, type: "expense", category: "rent" },
      ]),
    );

    const ok = await getCategoryBreakdownWith(deps, "tenant-a", "stmt-1");
    assert.ok(ok && !("code" in ok));
    assert.equal(ok.source, "extract");
    assert.equal(ok.categories[0]?.category, "rent");

    assert.equal(await getCategoryBreakdownWith(deps, "tenant-a", "other"), null);
    assert.equal(await getCategoryBreakdownWith(deps, "tenant-b", "stmt-1"), null);
  });
});

describe("compare statements", () => {
  it("diffs income expense net and categories from stored Analysis", () => {
    const a = readyRecord({ statementId: "a" });
    const b = readyRecord({
      statementId: "b",
      financialSummary: {
        currency: "ILS",
        month: "2026-06",
        totalIncome: 11000,
        totalExpenses: 3500,
        netBalance: 7500,
        topCategories: [
          { category: "food", amount: 1200 },
          { category: "travel", amount: 800 },
        ],
      },
    });
    const result = buildCompareResult(a, b);
    assert.ok(!("code" in result));
    assert.equal(result.deltas.totalIncome, 1000);
    assert.equal(result.deltas.totalExpenses, -500);
    assert.equal(result.deltas.netBalance, 1500);
    const food = result.deltas.categories.find((c) => c.category === "food");
    assert.equal(food?.delta, -800);
  });

  it("prefers extract rollups for category diffs when present", () => {
    const a = readyRecord({
      statementId: "a",
      transactionExtract: [
        { date: "2026-05-01", description: "Cafe", amount: 100, type: "expense", category: "food" },
      ],
    });
    const b = readyRecord({
      statementId: "b",
      transactionExtract: [
        { date: "2026-06-01", description: "Cafe", amount: 250, type: "expense", category: "food" },
      ],
    });
    const result = buildCompareResult(a, b);
    assert.ok(!("code" in result));
    assert.equal(result.deltas.categories[0]?.delta, 150);
  });

  it("denies cross-Workspace ids and identical pair", async () => {
    const { deps } = createMemoryDeps([
      readyRecord({ statementId: "a" }),
      readyRecord({ statementId: "b", tenantId: "tenant-b" }),
    ]);

    assert.equal(await compareStatementsWith(deps, "tenant-a", "a", "b"), null);

    const same = await compareStatementsWith(deps, "tenant-a", "a", "a");
    assert.ok(same && "code" in same);
    assert.equal(same.code, "INVALID_REQUEST");
  });

  it("compares two ready Workspace statements via seam get", async () => {
    const { deps } = createMemoryDeps([
      readyRecord({ statementId: "a" }),
      readyRecord({
        statementId: "b",
        financialSummary: {
          currency: "ILS",
          month: "2026-06",
          totalIncome: 9000,
          totalExpenses: 5000,
          netBalance: 4000,
          topCategories: [{ category: "food", amount: 3000 }],
        },
      }),
    ]);
    const result = await compareStatementsWith(deps, "tenant-a", "a", "b");
    assert.ok(result && !("code" in result));
    assert.equal(result.a.statementId, "a");
    assert.equal(result.b.statementId, "b");
    assert.equal(result.deltas.totalIncome, -1000);
  });
});

describe("ask_statement", () => {
  it("detects line-item questions for extract hydration", () => {
    assert.equal(questionLikelyNeedsExtract("What is my net balance?"), false);
    assert.equal(questionLikelyNeedsExtract("Which merchant did I spend at most?"), true);
  });

  it("answers from summary without extract for light questions", async () => {
    const { deps } = createMemoryDeps([readyRecord()]);
    let sawExtract = false;
    const askModel: AskModelClient = {
      async complete(_system, user) {
        sawExtract = user.includes("## Transaction extract");
        return "Net is 6000 ILS.";
      },
    };
    const result = await askStatementWith(
      { ...deps, askModel } satisfies PowerToolDeps,
      "tenant-a",
      "stmt-1",
      "What is my net balance?",
    );
    assert.ok(result && !("code" in result));
    assert.equal(result.contextUsed, "summary");
    assert.equal(sawExtract, false);
    assert.match(result.answer, /6000/);
  });

  it("hydrates extract for detail questions and consumes ask quota", async () => {
    const extractKey = "statements/tenant-a/stmt-1.extract.json";
    const { deps, objects } = createMemoryDeps([
      readyRecord({
        transactionExtractS3Key: extractKey,
      }),
    ]);
    objects.set(
      extractKey,
      serializeTransactionExtract([
        {
          date: "2026-05-01",
          description: "Cafe Aroma",
          amount: 42,
          type: "expense",
          category: "food",
        },
      ]),
    );

    const askQuota = createAskQuotaMemory(1);
    let prompt = "";
    const askModel: AskModelClient = {
      async complete(_system, user) {
        prompt = user;
        return "Cafe Aroma 42 ILS.";
      },
    };

    const result = await askStatementWith(
      { ...deps, askQuota, askModel },
      "tenant-a",
      "stmt-1",
      "Which merchant purchase was largest?",
    );
    assert.ok(result && !("code" in result));
    assert.equal(result.contextUsed, "summary+extract");
    assert.match(prompt, /Cafe Aroma/);

    const denied = await askStatementWith(
      { ...deps, askQuota, askModel },
      "tenant-a",
      "stmt-1",
      "What is my net?",
    );
    assert.ok(denied && "code" in denied);
    assert.equal(denied.code, "QUOTA_ASKS_EXCEEDED");

    const keys = quotaCounterKeys("tenant-a", "asks", "2026-07-21");
    // Counter was incremented once before denial on second call.
    assert.ok(keys);
  });

  it("returns null for cross-tenant statementId", async () => {
    const { deps } = createMemoryDeps([readyRecord()]);
    const askModel: AskModelClient = {
      async complete() {
        return "should not run";
      },
    };
    assert.equal(
      await askStatementWith({ ...deps, askModel }, "tenant-b", "stmt-1", "What is my net?"),
      null,
    );
  });
});
