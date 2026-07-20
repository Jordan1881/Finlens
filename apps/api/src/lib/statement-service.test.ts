import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StatementRecord } from "@finlens/domain";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { buildPendingStatement, sourceFormatForContentType } from "./statement-record.ts";
import {
  createStatementAndUploadFile,
  deleteStatementWith,
  getStatementWith,
  listStatementsWith,
  putPendingStatement,
  uploadStatementWith,
  type CommandClient,
  type StatementSeamDeps,
} from "./statement-service.ts";
import {
  analysisFailedError,
  toFullStatusResponse,
  toListItem,
  toSummaryView,
} from "./statement-views.ts";
import { serializeTransactionExtract } from "./transaction-extract.ts";
import { quotaCounterKeys, type QuotaSeamDeps } from "./quota-service.ts";

const NOW = "2026-07-20T12:00:00.000Z";

function baseRecord(overrides: Partial<StatementRecord> = {}): StatementRecord {
  return {
    tenantId: "tenant-a",
    statementId: "stmt-1",
    status: "pending_upload",
    s3Key: "statements/tenant-a/stmt-1.pdf",
    sourceFormat: "pdf",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("Statement view / lifecycle mapping", () => {
  it("maps pending_upload without financial fields", () => {
    const view = toSummaryView(baseRecord({ status: "pending_upload" }));
    assert.equal(view.status, "pending_upload");
    assert.equal(view.totalIncome, undefined);
    assert.equal(view.error, undefined);
  });

  it("maps processing without financial fields", () => {
    const view = toSummaryView(baseRecord({ status: "processing" }));
    assert.equal(view.status, "processing");
    assert.equal(view.currency, undefined);
  });

  it("maps ready summary with top categories capped at 3", () => {
    const view = toSummaryView(
      baseRecord({
        status: "ready",
        financialSummary: {
          currency: "ILS",
          month: "2026-06",
          totalIncome: 100,
          totalExpenses: 40,
          netBalance: 60,
          topCategories: [
            { category: "a", amount: 1 },
            { category: "b", amount: 2 },
            { category: "c", amount: 3 },
            { category: "d", amount: 4 },
          ],
        },
        spendingInsights: ["cut dining"],
        transactionExtract: [
          { date: "2026-06-01", description: "Cafe", amount: 40, type: "expense" },
        ],
      }),
    );
    assert.equal(view.status, "ready");
    assert.equal(view.currency, "ILS");
    assert.equal(view.topCategories?.length, 3);
    assert.deepEqual(view.spendingInsights, ["cut dining"]);
    assert.equal("transactionExtract" in view, false);
  });

  it("maps failed summary to structured ANALYSIS_FAILED error", () => {
    const view = toSummaryView(
      baseRecord({ status: "failed", errorMessage: "Bedrock timeout" }),
    );
    assert.deepEqual(view.error, analysisFailedError("Bedrock timeout"));
  });

  it("full status includes financialSummary and extract only when ready", () => {
    const extract = [
      { date: "2026-06-01", description: "Salary", amount: 100, type: "income" as const },
    ];
    const ready = toFullStatusResponse(
      baseRecord({
        status: "ready",
        financialSummary: {
          currency: "USD",
          month: null,
          totalIncome: 1,
          totalExpenses: 1,
          netBalance: 0,
          topCategories: [],
        },
        transactionExtract: extract,
      }),
    );
    assert.ok(ready.financialSummary);
    assert.deepEqual(ready.transactionExtract, extract);

    const failed = toFullStatusResponse(
      baseRecord({ status: "failed", errorMessage: "parse error" }),
    );
    assert.equal(failed.financialSummary, undefined);
    assert.equal(failed.transactionExtract, undefined);
    assert.equal(failed.errorMessage, "parse error");
  });

  it("full status returns S3 pointer when extract not hydrated", () => {
    const ready = toFullStatusResponse(
      baseRecord({
        status: "ready",
        financialSummary: {
          currency: "ILS",
          month: "2026-06",
          totalIncome: 0,
          totalExpenses: 0,
          netBalance: 0,
          topCategories: [],
        },
        transactionExtractS3Key: "statements/tenant-a/stmt-1.extract.json",
      }),
    );
    assert.equal(ready.transactionExtractS3Key, "statements/tenant-a/stmt-1.extract.json");
    assert.equal(ready.transactionExtract, undefined);
  });

  it("list item projects month from financialSummary", () => {
    const item = toListItem(
      baseRecord({
        status: "ready",
        financialSummary: {
          currency: "ILS",
          month: "2026-01",
          totalIncome: 0,
          totalExpenses: 0,
          netBalance: 0,
          topCategories: [],
        },
      }),
    );
    assert.equal(item.month, "2026-01");
    assert.equal(item.sourceFormat, "pdf");
  });
});

describe("Pending Statement record builder", () => {
  it("builds pending_upload with tenant-scoped S3 key", () => {
    const { record, s3Key } = buildPendingStatement({
      tenantId: "ws-1",
      sourceFormat: "csv",
      statementId: "fixed-id",
      now: NOW,
    });
    assert.equal(record.status, "pending_upload");
    assert.equal(record.tenantId, "ws-1");
    assert.equal(record.sourceFormat, "csv");
    assert.equal(s3Key, "statements/ws-1/fixed-id.csv");
  });

  it("maps content types to source formats", () => {
    assert.equal(sourceFormatForContentType("application/pdf"), "pdf");
    assert.equal(sourceFormatForContentType("text/csv"), "csv");
    assert.equal(sourceFormatForContentType("image/png"), null);
  });
});

type SentCommand = { name: string; input: Record<string, unknown> };

function createMemoryDeps(seed: StatementRecord[] = []): {
  deps: StatementSeamDeps;
  sent: SentCommand[];
  store: Map<string, StatementRecord>;
  objects: Map<string, string>;
} {
  const store = new Map<string, StatementRecord>();
  for (const record of seed) {
    store.set(`${record.tenantId}#${record.statementId}`, record);
  }
  const objects = new Map<string, string>();
  const sent: SentCommand[] = [];

  const ddb: CommandClient = {
    async send(command: unknown) {
      const cmd = command as { constructor: { name: string }; input: Record<string, unknown> };
      sent.push({ name: cmd.constructor.name, input: cmd.input });

      if (command instanceof GetCommand) {
        const key = cmd.input.Key as { tenantId: string; statementId: string };
        return { Item: store.get(`${key.tenantId}#${key.statementId}`) };
      }
      if (command instanceof QueryCommand) {
        const values = cmd.input.ExpressionAttributeValues as { ":tenantId": string };
        const tenantId = values[":tenantId"];
        const items = [...store.values()]
          .filter((r) => r.tenantId === tenantId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return { Items: items.slice(0, (cmd.input.Limit as number) ?? 20) };
      }
      if (command instanceof PutCommand) {
        const item = cmd.input.Item as StatementRecord;
        store.set(`${item.tenantId}#${item.statementId}`, item);
        return {};
      }
      if (command instanceof DeleteCommand) {
        const key = cmd.input.Key as { tenantId: string; statementId: string };
        store.delete(`${key.tenantId}#${key.statementId}`);
        return {};
      }
      throw new Error(`Unexpected DDB command: ${cmd.constructor.name}`);
    },
  };

  const s3: CommandClient = {
    async send(command: unknown) {
      const cmd = command as { constructor: { name: string }; input: Record<string, unknown> };
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      if (command instanceof PutObjectCommand) {
        const key = cmd.input.Key as string;
        const body = cmd.input.Body;
        objects.set(
          key,
          typeof body === "string" ? body : Buffer.from(body as Uint8Array).toString("utf8"),
        );
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const key = cmd.input.Key as string;
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
      if (command instanceof DeleteObjectCommand) {
        objects.delete(cmd.input.Key as string);
        return {};
      }
      throw new Error(`Unexpected S3 command: ${cmd.constructor.name}`);
    },
  };

  return {
    deps: {
      ddb,
      s3,
      tableName: "Statements",
      bucketName: "bucket",
    },
    sent,
    store,
    objects,
  };
}

describe("Statement seam authz (tenant isolation)", () => {
  it("getStatement returns null for wrong tenantId (not found, no leak)", async () => {
    const record = baseRecord({ tenantId: "tenant-a", statementId: "stmt-1" });
    const { deps } = createMemoryDeps([record]);

    const result = await getStatementWith(deps, "tenant-b", "stmt-1", "summary");
    assert.equal(result, null);
  });

  it("deleteStatement returns null for wrong tenantId and does not delete", async () => {
    const record = baseRecord({ tenantId: "tenant-a", statementId: "stmt-1" });
    const { deps, store, sent } = createMemoryDeps([record]);

    const result = await deleteStatementWith(deps, "tenant-b", "stmt-1");
    assert.equal(result, null);
    assert.ok(store.has("tenant-a#stmt-1"));
    assert.ok(!sent.some((c) => c.name === "DeleteCommand"));
  });

  it("listStatements only returns the caller's tenant rows", async () => {
    const { deps } = createMemoryDeps([
      baseRecord({ tenantId: "tenant-a", statementId: "a1", createdAt: "2026-07-01T00:00:00.000Z" }),
      baseRecord({ tenantId: "tenant-b", statementId: "b1", createdAt: "2026-07-02T00:00:00.000Z" }),
    ]);

    const listed = await listStatementsWith(deps, "tenant-a");
    assert.equal(listed.count, 1);
    assert.equal(listed.statements[0]?.statementId, "a1");
  });
});

describe("Statement seam lifecycle operations", () => {
  it("putPendingStatement writes pending_upload via shared builder", async () => {
    const { deps, store } = createMemoryDeps();
    const { record } = buildPendingStatement({
      tenantId: "tenant-a",
      sourceFormat: "pdf",
      statementId: "new-1",
      now: NOW,
    });

    await putPendingStatement(deps, record);
    assert.equal(store.get("tenant-a#new-1")?.status, "pending_upload");
  });

  it("createStatementAndUploadFile puts DDB then S3", async () => {
    const { deps, sent, store } = createMemoryDeps();
    const bytes = new TextEncoder().encode("%PDF-1.4\n");

    const result = await createStatementAndUploadFile(deps, {
      tenantId: "tenant-a",
      fileBytes: bytes,
      fileType: "pdf",
    });

    assert.equal(result.record.status, "pending_upload");
    assert.ok(store.has(`tenant-a#${result.statementId}`));
    assert.ok(sent.some((c) => c.name === "PutCommand"));
    assert.ok(sent.some((c) => c.name === "PutObjectCommand"));
  });

  it("deleteStatement removes S3 object then DDB row for owning tenant", async () => {
    const record = baseRecord();
    const { deps, store, sent } = createMemoryDeps([record]);

    const result = await deleteStatementWith(deps, "tenant-a", "stmt-1");
    assert.deepEqual(result, { statementId: "stmt-1", deleted: true });
    assert.ok(!store.has("tenant-a#stmt-1"));
    assert.ok(sent.some((c) => c.name === "DeleteObjectCommand"));
    assert.ok(sent.some((c) => c.name === "DeleteCommand"));
  });

  it("deleteStatement also removes overflow extract object", async () => {
    const extractKey = "statements/tenant-a/stmt-1.extract.json";
    const record = baseRecord({
      status: "ready",
      transactionExtractS3Key: extractKey,
    });
    const { deps, objects, sent } = createMemoryDeps([record]);
    objects.set(extractKey, serializeTransactionExtract([]));

    await deleteStatementWith(deps, "tenant-a", "stmt-1");
    assert.equal(objects.has(extractKey), false);
    const deletes = sent.filter((c) => c.name === "DeleteObjectCommand");
    assert.equal(deletes.length, 2);
  });

  it("getStatement summary vs full for ready record with inline extract", async () => {
    const extract = [
      { date: "2026-06-01", description: "food", amount: 5, type: "expense" as const },
    ];
    const record = baseRecord({
      status: "ready",
      financialSummary: {
        currency: "ILS",
        month: "2026-06",
        totalIncome: 10,
        totalExpenses: 5,
        netBalance: 5,
        topCategories: [{ category: "food", amount: 5 }],
      },
      transactionExtract: extract,
    });
    const { deps } = createMemoryDeps([record]);

    const summary = await getStatementWith(deps, "tenant-a", "stmt-1", "summary");
    assert.ok(summary);
    assert.equal("totalIncome" in summary && summary.totalIncome, 10);
    assert.equal("financialSummary" in summary, false);
    assert.equal("transactionExtract" in summary, false);

    const full = await getStatementWith(deps, "tenant-a", "stmt-1", "full");
    assert.ok(full && "financialSummary" in full);
    assert.equal(full.financialSummary?.currency, "ILS");
    assert.deepEqual(full.transactionExtract, extract);
  });

  it("getStatement full hydrates extract from S3 pointer", async () => {
    const extractKey = "statements/tenant-a/stmt-1.extract.json";
    const extract = [
      { date: "2026-06-02", description: "Bus", amount: 12, type: "expense" as const },
    ];
    const record = baseRecord({
      status: "ready",
      financialSummary: {
        currency: "ILS",
        month: "2026-06",
        totalIncome: 0,
        totalExpenses: 12,
        netBalance: -12,
        topCategories: [],
      },
      transactionExtractS3Key: extractKey,
    });
    const { deps, objects } = createMemoryDeps([record]);
    objects.set(extractKey, serializeTransactionExtract(extract));

    const summary = await getStatementWith(deps, "tenant-a", "stmt-1", "summary");
    assert.ok(summary);
    assert.equal("transactionExtract" in summary, false);

    const full = await getStatementWith(deps, "tenant-a", "stmt-1", "full");
    assert.ok(full && "transactionExtract" in full);
    assert.deepEqual(full.transactionExtract, extract);
    assert.equal(full.transactionExtractS3Key, undefined);
  });
});

function createQuotaAwareUploadDeps(options: {
  uploadLimit?: number;
  concurrentLimit?: number;
  processingCount?: number;
}): {
  deps: StatementSeamDeps;
  quotaStore: Map<string, Record<string, unknown>>;
} {
  const { deps, store: statementStore } = createMemoryDeps();
  const quotaStore = new Map<string, Record<string, unknown>>();

  for (let i = 0; i < (options.processingCount ?? 0); i += 1) {
    const record = baseRecord({
      tenantId: "tenant-a",
      statementId: `proc-${i}`,
      status: "processing",
    });
    statementStore.set(`${record.tenantId}#${record.statementId}`, record);
  }

  const quotaDdb: CommandClient = {
    async send(command: unknown) {
      if (command instanceof GetCommand) {
        const key = command.input.Key as { pk: string; sk: string };
        return { Item: quotaStore.get(`${key.pk}#${key.sk}`) };
      }
      if (command instanceof QueryCommand) {
        const values = command.input.ExpressionAttributeValues as {
          ":tenantId": string;
          ":processing"?: string;
        };
        let count = 0;
        for (const item of statementStore.values()) {
          if (item.tenantId !== values[":tenantId"]) {
            continue;
          }
          if (values[":processing"] === "processing" && item.status !== "processing") {
            continue;
          }
          count += 1;
        }
        return { Count: count };
      }
      if (command instanceof UpdateCommand) {
        const key = command.input.Key as { pk: string; sk: string };
        const mapKey = `${key.pk}#${key.sk}`;
        const existing = quotaStore.get(mapKey) ?? { ...key };
        const values = (command.input.ExpressionAttributeValues ?? {}) as Record<
          string,
          unknown
        >;
        const condition = command.input.ConditionExpression as string | undefined;
        const currentCount =
          typeof existing.count === "number" ? (existing.count as number) : undefined;
        if (condition?.includes("attribute_not_exists(#count) OR #count < :limit")) {
          const limit = values[":limit"] as number;
          if (currentCount !== undefined && currentCount >= limit) {
            const err = new Error("Conditional check failed");
            err.name = "ConditionalCheckFailedException";
            throw err;
          }
        }
        quotaStore.set(mapKey, {
          ...existing,
          pk: key.pk,
          sk: key.sk,
          count: (currentCount ?? 0) + 1,
          expiresAt: values[":expiresAt"],
        });
        return {};
      }
      // Statement DDB path (Put/Get/…)
      return deps.ddb.send(command);
    },
  };

  // Route statement + quota through one client: statement commands hit statement store.
  const combinedDdb: CommandClient = {
    async send(command: unknown) {
      if (
        command instanceof UpdateCommand ||
        (command instanceof GetCommand &&
          typeof (command.input.Key as { pk?: string })?.pk === "string") ||
        (command instanceof QueryCommand &&
          Boolean(
            (command.input.ExpressionAttributeValues as { ":processing"?: string })?.[
              ":processing"
            ],
          ))
      ) {
        return quotaDdb.send(command);
      }
      return deps.ddb.send(command);
    },
  };

  const quota: QuotaSeamDeps = {
    ddb: combinedDdb,
    workspacesTableName: "Workspaces",
    statementsTableName: "Statements",
    limits: {
      uploadsPerDay: options.uploadLimit ?? 20,
      concurrentAnalyses: options.concurrentLimit ?? 2,
    },
    now: () => new Date("2026-07-21T12:00:00.000Z"),
  };

  return {
    deps: {
      ...deps,
      ddb: combinedDdb,
      quota,
    },
    quotaStore,
  };
}

describe("Statement seam quota denials", () => {
  const minimalPdf = new TextEncoder().encode("%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

  it("uploadStatementWith returns QUOTA_UPLOADS_EXCEEDED when daily limit hit", async () => {
    const { deps, quotaStore } = createQuotaAwareUploadDeps({ uploadLimit: 1 });

    const first = await uploadStatementWith(deps, "tenant-a", minimalPdf, "a.pdf");
    assert.equal("code" in first, false);

    const second = await uploadStatementWith(deps, "tenant-a", minimalPdf, "b.pdf");
    assert.ok("code" in second);
    assert.equal(second.code, "QUOTA_UPLOADS_EXCEEDED");
    assert.equal(second.retryable, true);
    assert.ok(second.nextStep.length > 0);

    const keys = quotaCounterKeys("tenant-a", "uploads", "2026-07-21");
    assert.equal(quotaStore.get(`${keys.pk}#${keys.sk}`)?.count, 1);
  });

  it("uploadStatementWith returns QUOTA_CONCURRENT_ANALYSES_EXCEEDED when at capacity", async () => {
    const { deps } = createQuotaAwareUploadDeps({
      concurrentLimit: 2,
      processingCount: 2,
      uploadLimit: 20,
    });

    const result = await uploadStatementWith(deps, "tenant-a", minimalPdf, "a.pdf");
    assert.ok("code" in result);
    assert.equal(result.code, "QUOTA_CONCURRENT_ANALYSES_EXCEEDED");
    assert.equal(result.retryable, true);
  });
});
