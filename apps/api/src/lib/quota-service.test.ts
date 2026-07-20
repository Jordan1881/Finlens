import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { CommandClient } from "./statement-service.ts";
import {
  checkConcurrentAnalysisQuota,
  consumeAskQuota,
  consumeUploadQuota,
  DEFAULT_QUOTA_LIMITS,
  enforceUploadQuotas,
  isQuotaError,
  quotaCounterKeys,
  quotaDayKey,
  resolveQuotaLimits,
  type QuotaSeamDeps,
} from "./quota-service.ts";
import { workspaceMetaKeys } from "./workspace-service.ts";

type StoreItem = Record<string, unknown> & { pk?: string; sk?: string };

function createQuotaMemory(seed: StoreItem[] = []): {
  store: Map<string, StoreItem>;
  ddb: CommandClient;
  deps: QuotaSeamDeps;
} {
  const store = new Map<string, StoreItem>();
  for (const item of seed) {
    if (typeof item.pk === "string" && typeof item.sk === "string") {
      store.set(`${item.pk}#${item.sk}`, { ...item });
    }
  }

  const ddb: CommandClient = {
    async send(command: unknown) {
      if (command instanceof GetCommand) {
        const key = command.input.Key as { pk: string; sk: string };
        return { Item: store.get(`${key.pk}#${key.sk}`) };
      }

      if (command instanceof QueryCommand) {
        const values = command.input.ExpressionAttributeValues as {
          ":tenantId": string;
          ":processing"?: string;
        };
        const tenantId = values[":tenantId"];
        const filterProcessing = values[":processing"] === "processing";
        let count = 0;
        for (const item of store.values()) {
          if (item.tenantId !== tenantId) {
            continue;
          }
          if (filterProcessing && item.status !== "processing") {
            continue;
          }
          count += 1;
        }
        return { Count: count };
      }

      if (command instanceof UpdateCommand) {
        const key = command.input.Key as { pk: string; sk: string };
        const mapKey = `${key.pk}#${key.sk}`;
        const existing = store.get(mapKey) ?? { ...key };
        const names = (command.input.ExpressionAttributeNames ?? {}) as Record<string, string>;
        const values = (command.input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
        const condition = command.input.ConditionExpression as string | undefined;

        const countName = names["#count"] ?? "count";
        const currentCount =
          typeof existing[countName] === "number" ? (existing[countName] as number) : undefined;

        if (condition?.includes("attribute_not_exists(#count) OR #count < :limit")) {
          const limit = values[":limit"] as number;
          if (currentCount !== undefined && currentCount >= limit) {
            const err = new Error("Conditional check failed");
            err.name = "ConditionalCheckFailedException";
            throw err;
          }
        }

        const next: StoreItem = { ...existing, pk: key.pk, sk: key.sk };
        if (values[":one"] === 1) {
          next[countName] = (currentCount ?? 0) + 1;
        }
        if (values[":entityType"] !== undefined) {
          next.entityType = values[":entityType"];
        }
        if (values[":workspaceId"] !== undefined) {
          next.workspaceId = values[":workspaceId"];
        }
        if (values[":quotaKind"] !== undefined) {
          next.quotaKind = values[":quotaKind"];
        }
        if (values[":quotaDay"] !== undefined) {
          next.quotaDay = values[":quotaDay"];
        }
        if (values[":expiresAt"] !== undefined) {
          next.expiresAt = values[":expiresAt"];
        }
        store.set(mapKey, next);
        return {};
      }

      throw new Error(
        `Unexpected command: ${(command as { constructor?: { name?: string } }).constructor?.name}`,
      );
    },
  };

  const deps: QuotaSeamDeps = {
    ddb,
    workspacesTableName: "Workspaces",
    statementsTableName: "Statements",
    now: () => new Date("2026-07-21T12:00:00.000Z"),
  };

  return { store, ddb, deps };
}

describe("quota-service helpers", () => {
  it("uses UTC day keys and stable counter sort keys", () => {
    assert.equal(quotaDayKey(new Date("2026-07-21T23:30:00.000Z")), "2026-07-21");
    assert.deepEqual(quotaCounterKeys("ws_1", "uploads", "2026-07-21"), {
      pk: "WORKSPACE#ws_1",
      sk: "QUOTA#uploads#2026-07-21",
    });
    assert.equal(isQuotaError({ code: "QUOTA_UPLOADS_EXCEEDED" }), true);
    assert.equal(isQuotaError({ code: "UNSUPPORTED_FILE_TYPE" }), false);
  });

  it("defaults match PRD (~20 / ~100 / ~2)", () => {
    assert.equal(DEFAULT_QUOTA_LIMITS.uploadsPerDay, 20);
    assert.equal(DEFAULT_QUOTA_LIMITS.asksPerDay, 100);
    assert.equal(DEFAULT_QUOTA_LIMITS.concurrentAnalyses, 2);
  });
});

describe("daily upload / ask counters", () => {
  it("allows uploads up to the limit then returns structured denial", async () => {
    const { deps, store } = createQuotaMemory();
    deps.limits = { uploadsPerDay: 2 };

    assert.equal(await consumeUploadQuota("ws_a", deps), null);
    assert.equal(await consumeUploadQuota("ws_a", deps), null);

    const denied = await consumeUploadQuota("ws_a", deps);
    assert.ok(denied);
    assert.equal(denied.code, "QUOTA_UPLOADS_EXCEEDED");
    assert.equal(denied.retryable, true);
    assert.match(denied.nextStep, /UTC day/i);

    const keys = quotaCounterKeys("ws_a", "uploads", "2026-07-21");
    assert.equal(store.get(`${keys.pk}#${keys.sk}`)?.count, 2);
  });

  it("ask counter is independent of uploads", async () => {
    const { deps } = createQuotaMemory();
    deps.limits = { asksPerDay: 1, uploadsPerDay: 5 };

    assert.equal(await consumeAskQuota("ws_a", deps), null);
    const denied = await consumeAskQuota("ws_a", deps);
    assert.equal(denied?.code, "QUOTA_ASKS_EXCEEDED");

    // Uploads still available
    assert.equal(await consumeUploadQuota("ws_a", deps), null);
  });

  it("isolates counters per Workspace", async () => {
    const { deps } = createQuotaMemory();
    deps.limits = { uploadsPerDay: 1 };

    assert.equal(await consumeUploadQuota("ws_a", deps), null);
    assert.equal(await consumeUploadQuota("ws_b", deps), null);
    assert.equal((await consumeUploadQuota("ws_a", deps))?.code, "QUOTA_UPLOADS_EXCEEDED");
  });

  it("honors Workspace META.quotas overrides", async () => {
    const meta = workspaceMetaKeys("ws_custom");
    const { deps } = createQuotaMemory([
      {
        ...meta,
        entityType: "workspace",
        workspaceId: "ws_custom",
        name: "Custom",
        ownerSub: "sub",
        createdAt: "2026-07-01T00:00:00.000Z",
        quotas: { uploadsPerDay: 1 },
      },
    ]);

    const limits = await resolveQuotaLimits(deps, "ws_custom");
    assert.equal(limits.uploadsPerDay, 1);

    assert.equal(await consumeUploadQuota("ws_custom", deps), null);
    assert.equal((await consumeUploadQuota("ws_custom", deps))?.code, "QUOTA_UPLOADS_EXCEEDED");
  });
});

describe("concurrent Analysis quota", () => {
  it("denies when processing count is at the limit", async () => {
    const { deps } = createQuotaMemory([
      {
        pk: "ignored",
        sk: "ignored",
        tenantId: "ws_a",
        statementId: "s1",
        status: "processing",
      },
      {
        pk: "ignored2",
        sk: "ignored2",
        tenantId: "ws_a",
        statementId: "s2",
        status: "processing",
      },
      {
        pk: "ignored3",
        sk: "ignored3",
        tenantId: "ws_a",
        statementId: "s3",
        status: "ready",
      },
    ]);
    deps.limits = { concurrentAnalyses: 2 };

    const denied = await checkConcurrentAnalysisQuota("ws_a", deps);
    assert.equal(denied?.code, "QUOTA_CONCURRENT_ANALYSES_EXCEEDED");
    assert.match(denied?.nextStep ?? "", /in-flight/i);
  });

  it("allows when under the concurrent limit", async () => {
    const { deps } = createQuotaMemory([
      {
        pk: "a",
        sk: "a",
        tenantId: "ws_a",
        statementId: "s1",
        status: "processing",
      },
    ]);
    deps.limits = { concurrentAnalyses: 2 };

    assert.equal(await checkConcurrentAnalysisQuota("ws_a", deps), null);
  });

  it("enforceUploadQuotas checks concurrent before consuming an upload", async () => {
    const { deps, store } = createQuotaMemory([
      {
        pk: "a",
        sk: "a",
        tenantId: "ws_a",
        statementId: "s1",
        status: "processing",
      },
      {
        pk: "b",
        sk: "b",
        tenantId: "ws_a",
        statementId: "s2",
        status: "processing",
      },
    ]);
    deps.limits = { concurrentAnalyses: 2, uploadsPerDay: 20 };

    const denied = await enforceUploadQuotas("ws_a", deps);
    assert.equal(denied?.code, "QUOTA_CONCURRENT_ANALYSES_EXCEEDED");

    // Upload counter must not have been incremented when concurrent denied first
    const keys = quotaCounterKeys("ws_a", "uploads", "2026-07-21");
    assert.equal(store.has(`${keys.pk}#${keys.sk}`), false);
  });
});
