import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { hashApiKey } from "./api-key.ts";
import {
  API_KEYS_BY_TENANT_INDEX,
  listApiKeys,
  mintApiKey,
  resolveTenantIdForApiKey,
  revokeApiKey,
} from "./api-key-service.ts";
import type { CommandClient } from "./statement-service.ts";

function createMemoryStore(): {
  store: Map<string, Record<string, unknown>>;
  ddb: CommandClient;
} {
  const store = new Map<string, Record<string, unknown>>();

  const ddb: CommandClient = {
    async send(command: unknown) {
      if (command instanceof GetCommand) {
        const key = command.input.Key as { keyHash: string };
        return { Item: store.get(key.keyHash) };
      }

      if (command instanceof PutCommand) {
        const item = command.input.Item as {
          keyHash: string;
          keyId: string;
          tenantId: string;
        };
        if (
          command.input.ConditionExpression?.includes("attribute_not_exists") &&
          store.has(item.keyHash)
        ) {
          const err = new Error("Conditional check failed");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        store.set(item.keyHash, { ...item });
        return {};
      }

      if (command instanceof QueryCommand) {
        assert.equal(command.input.IndexName, API_KEYS_BY_TENANT_INDEX);
        const values = command.input.ExpressionAttributeValues as Record<string, string>;
        const tenantId = values[":tenantId"];
        const keyId = values[":keyId"];
        const items = [...store.values()].filter((row) => {
          if (row.tenantId !== tenantId) {
            return false;
          }
          if (keyId && row.keyId !== keyId) {
            return false;
          }
          return true;
        });
        const limit = command.input.Limit;
        return { Items: limit ? items.slice(0, limit) : items };
      }

      if (command instanceof UpdateCommand) {
        const key = command.input.Key as { keyHash: string };
        const existing = store.get(key.keyHash);
        if (!existing) {
          const err = new Error("Conditional check failed");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        const values = command.input.ExpressionAttributeValues as Record<string, string>;
        if (
          existing.tenantId !== values[":tenantId"] ||
          existing.keyId !== values[":keyId"]
        ) {
          const err = new Error("Conditional check failed");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        store.set(key.keyHash, { ...existing, status: values[":revoked"] });
        return {};
      }

      throw new Error(
        `Unexpected command: ${(command as { constructor?: { name?: string } }).constructor?.name}`,
      );
    },
  };

  return { store, ddb };
}

describe("api-key-service", () => {
  it("mints a key, stores only the hash, and resolves tenantId", async () => {
    const { store, ddb } = createMemoryStore();
    const minted = await mintApiKey("ws_alpha", { ddb, tableName: "ApiKeys" });

    assert.match(minted.apiKey, /^flk_/);
    assert.match(minted.keyId, /^key_[a-f0-9]{32}$/);
    assert.equal(minted.tenantId, "ws_alpha");
    assert.equal(minted.status, "active");
    assert.equal(minted.prefix, minted.apiKey.slice(0, 12));

    const stored = store.get(hashApiKey(minted.apiKey));
    assert.ok(stored);
    assert.equal(stored.tenantId, "ws_alpha");
    assert.equal(stored.keyId, minted.keyId);
    assert.equal(stored.status, "active");
    assert.equal(Object.values(stored).includes(minted.apiKey), false);

    const tenantId = await resolveTenantIdForApiKey(minted.apiKey, {
      ddb,
      tableName: "ApiKeys",
    });
    assert.equal(tenantId, "ws_alpha");
  });

  it("lists metadata only for the owning Workspace", async () => {
    const { ddb } = createMemoryStore();
    const a = await mintApiKey("ws_a", { ddb, tableName: "ApiKeys" });
    await mintApiKey("ws_b", { ddb, tableName: "ApiKeys" });

    const listed = await listApiKeys("ws_a", { ddb, tableName: "ApiKeys" });
    assert.equal(listed.count, 1);
    assert.equal(listed.keys[0]?.keyId, a.keyId);
    assert.equal(
      "apiKey" in (listed.keys[0] as object) || "keyHash" in (listed.keys[0] as object),
      false,
    );
  });

  it("revokes immediately so auth resolution fails", async () => {
    const { ddb } = createMemoryStore();
    const minted = await mintApiKey("ws_revoke", { ddb, tableName: "ApiKeys" });

    const revoked = await revokeApiKey("ws_revoke", minted.keyId, {
      ddb,
      tableName: "ApiKeys",
    });
    assert.deepEqual(revoked, { keyId: minted.keyId, revoked: true });

    const tenantId = await resolveTenantIdForApiKey(minted.apiKey, {
      ddb,
      tableName: "ApiKeys",
    });
    assert.equal(tenantId, null);

    const listed = await listApiKeys("ws_revoke", { ddb, tableName: "ApiKeys" });
    assert.equal(listed.keys[0]?.status, "revoked");
  });

  it("denies revoke and auth across Workspaces", async () => {
    const { store, ddb } = createMemoryStore();
    const minted = await mintApiKey("ws_owner", { ddb, tableName: "ApiKeys" });

    const crossRevoke = await revokeApiKey("ws_other", minted.keyId, {
      ddb,
      tableName: "ApiKeys",
    });
    assert.equal(crossRevoke, null);

    const stillActive = await resolveTenantIdForApiKey(minted.apiKey, {
      ddb,
      tableName: "ApiKeys",
    });
    assert.equal(stillActive, "ws_owner");

    // Legacy row without status still authenticates.
    store.set(hashApiKey("flk_legacy_key_value_xx"), {
      keyHash: hashApiKey("flk_legacy_key_value_xx"),
      tenantId: "ws_legacy",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(
      await resolveTenantIdForApiKey("flk_legacy_key_value_xx", {
        ddb,
        tableName: "ApiKeys",
      }),
      "ws_legacy",
    );

    assert.equal(
      await resolveTenantIdForApiKey("flk_unknown_secret_zzzz", {
        ddb,
        tableName: "ApiKeys",
      }),
      null,
    );
  });
});
