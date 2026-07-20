import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { CommandClient } from "./statement-service.ts";
import {
  getMembership,
  getWorkspaceRecord,
  resolveOrCreatePersonalWorkspace,
  userMembershipKeys,
  workspaceMetaKeys,
} from "./workspace-service.ts";

function createMemoryStore(): {
  store: Map<string, Record<string, unknown>>;
  ddb: CommandClient;
} {
  const store = new Map<string, Record<string, unknown>>();

  const ddb: CommandClient = {
    async send(command: unknown) {
      if (command instanceof GetCommand) {
        const key = command.input.Key as { pk: string; sk: string };
        const item = store.get(`${key.pk}#${key.sk}`);
        return { Item: item };
      }

      if (command instanceof TransactWriteCommand) {
        const items = command.input.TransactItems ?? [];
        for (const entry of items) {
          const put = entry.Put;
          if (!put?.Item) {
            continue;
          }
          const item = put.Item as { pk: string; sk: string };
          const mapKey = `${item.pk}#${item.sk}`;
          if (put.ConditionExpression?.includes("attribute_not_exists") && store.has(mapKey)) {
            const err = new Error("Conditional check failed");
            err.name = "TransactionCanceledException";
            throw err;
          }
        }
        for (const entry of items) {
          const put = entry.Put;
          if (!put?.Item) {
            continue;
          }
          const item = put.Item as { pk: string; sk: string };
          store.set(`${item.pk}#${item.sk}`, { ...item });
        }
        return {};
      }

      throw new Error(`Unexpected command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
    },
  };

  return { store, ddb };
}

describe("workspace-service", () => {
  it("creates a personal workspace on first resolve", async () => {
    const { store, ddb } = createMemoryStore();
    const workspaceId = await resolveOrCreatePersonalWorkspace("sub-1", {
      ddb,
      tableName: "Workspaces",
    });

    assert.match(workspaceId, /^ws_[a-f0-9]{32}$/);
    const memberKeys = userMembershipKeys("sub-1");
    const membership = store.get(`${memberKeys.pk}#${memberKeys.sk}`);
    assert.equal(membership?.workspaceId, workspaceId);
    assert.equal(membership?.role, "owner");

    const metaKeys = workspaceMetaKeys(workspaceId);
    const meta = store.get(`${metaKeys.pk}#${metaKeys.sk}`);
    assert.equal(meta?.ownerSub, "sub-1");
    assert.equal(meta?.name, "Personal");
  });

  it("returns the same workspaceId on subsequent resolve", async () => {
    const { ddb } = createMemoryStore();
    const first = await resolveOrCreatePersonalWorkspace("sub-2", {
      ddb,
      tableName: "Workspaces",
    });
    const second = await resolveOrCreatePersonalWorkspace("sub-2", {
      ddb,
      tableName: "Workspaces",
    });
    assert.equal(first, second);
  });

  it("handles create race by re-reading membership", async () => {
    const { store, ddb } = createMemoryStore();
    const memberKeys = userMembershipKeys("sub-race");
    store.set(`${memberKeys.pk}#${memberKeys.sk}`, {
      ...memberKeys,
      entityType: "membership",
      cognitoSub: "sub-race",
      workspaceId: "ws_existing",
      role: "owner",
      createdAt: "2026-07-20T00:00:00.000Z",
    });

    // Force the create path to attempt TransactWrite by clearing Get once — simulate
    // lost race: Get misses, Transact fails, second Get finds winner.
    let gets = 0;
    const racingDdb: CommandClient = {
      async send(command: unknown) {
        if (command instanceof GetCommand) {
          gets += 1;
          if (gets === 1) {
            return { Item: undefined };
          }
        }
        return ddb.send(command);
      },
    };

    const workspaceId = await resolveOrCreatePersonalWorkspace("sub-race", {
      ddb: racingDdb,
      tableName: "Workspaces",
    });
    assert.equal(workspaceId, "ws_existing");
  });

  it("getMembership and getWorkspaceRecord round-trip", async () => {
    const { ddb } = createMemoryStore();
    const workspaceId = await resolveOrCreatePersonalWorkspace("sub-3", {
      ddb,
      tableName: "Workspaces",
    });
    const membership = await getMembership({ ddb, tableName: "Workspaces" }, "sub-3");
    assert.equal(membership?.workspaceId, workspaceId);
    const record = await getWorkspaceRecord({ ddb, tableName: "Workspaces" }, workspaceId);
    assert.equal(record?.ownerSub, "sub-3");
  });

  it("isolates different Cognito users into different Workspaces", async () => {
    const { ddb } = createMemoryStore();
    const a = await resolveOrCreatePersonalWorkspace("sub-a", {
      ddb,
      tableName: "Workspaces",
    });
    const b = await resolveOrCreatePersonalWorkspace("sub-b", {
      ddb,
      tableName: "Workspaces",
    });
    assert.notEqual(a, b);
  });
});
