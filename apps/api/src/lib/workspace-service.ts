import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import type { WorkspaceMembership, WorkspaceRecord } from "@finlens/domain";
import type { CommandClient } from "./statement-service.ts";

export interface WorkspaceSeamDeps {
  ddb: CommandClient;
  tableName: string;
}

const defaultDdb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export function resolveWorkspaceSeamDeps(
  overrides?: Partial<WorkspaceSeamDeps>,
): WorkspaceSeamDeps {
  const tableName = overrides?.tableName ?? process.env.WORKSPACES_TABLE;
  if (!tableName) {
    throw new Error("WORKSPACES_TABLE is not configured");
  }
  return {
    ddb: overrides?.ddb ?? defaultDdb,
    tableName,
  };
}

export function userMembershipKeys(cognitoSub: string): { pk: string; sk: string } {
  return { pk: `USER#${cognitoSub}`, sk: "MEMBERSHIP" };
}

export function workspaceMetaKeys(workspaceId: string): { pk: string; sk: string } {
  return { pk: `WORKSPACE#${workspaceId}`, sk: "META" };
}

function newWorkspaceId(): string {
  return `ws_${randomUUID().replace(/-/g, "")}`;
}

function isConditionalFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { name?: string; CancellationReasons?: unknown[] };
  return (
    err.name === "ConditionalCheckFailedException" ||
    err.name === "TransactionCanceledException"
  );
}

/**
 * Resolve the Workspace for a Cognito user. First login creates a personal
 * Workspace and owner membership (atomic TransactWrite).
 *
 * Single-table keys (see docs/security/phase-workspace-identity.md):
 * - USER#<sub> / MEMBERSHIP → membership row
 * - WORKSPACE#<id> / META → workspace record
 *
 * Future (#21 key mint, multi-member): WORKSPACE#<id> / MEMBER#<sub>
 * Future (#23 quotas): optional fields on META (not enforced here).
 */
export async function resolveOrCreatePersonalWorkspace(
  cognitoSub: string,
  deps?: Partial<WorkspaceSeamDeps>,
): Promise<string> {
  if (!cognitoSub) {
    throw new Error("cognitoSub is required");
  }

  const seam = resolveWorkspaceSeamDeps(deps);
  const existing = await getMembership(seam, cognitoSub);
  if (existing) {
    return existing.workspaceId;
  }

  const workspaceId = newWorkspaceId();
  const createdAt = new Date().toISOString();
  const workspaceName = "Personal";

  const workspace: WorkspaceRecord = {
    workspaceId,
    name: workspaceName,
    ownerSub: cognitoSub,
    createdAt,
  };
  const membership: WorkspaceMembership = {
    cognitoSub,
    workspaceId,
    role: "owner",
    createdAt,
  };

  const metaKeys = workspaceMetaKeys(workspaceId);
  const memberKeys = userMembershipKeys(cognitoSub);

  try {
    await seam.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: seam.tableName,
              Item: {
                ...memberKeys,
                entityType: "membership",
                ...membership,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: seam.tableName,
              Item: {
                ...metaKeys,
                entityType: "workspace",
                ...workspace,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }),
    );
    return workspaceId;
  } catch (error) {
    if (!isConditionalFailure(error)) {
      throw error;
    }
    const raced = await getMembership(seam, cognitoSub);
    if (raced) {
      return raced.workspaceId;
    }
    throw error;
  }
}

export async function getMembership(
  deps: WorkspaceSeamDeps,
  cognitoSub: string,
): Promise<WorkspaceMembership | null> {
  const keys = userMembershipKeys(cognitoSub);
  const result = (await deps.ddb.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: keys,
    }),
  )) as { Item?: Record<string, unknown> };

  const item = result.Item;
  if (!item) {
    return null;
  }

  const workspaceId = item.workspaceId;
  const role = item.role;
  const createdAt = item.createdAt;
  if (
    typeof workspaceId !== "string" ||
    (role !== "owner" && role !== "member") ||
    typeof createdAt !== "string"
  ) {
    return null;
  }

  return {
    cognitoSub,
    workspaceId,
    role,
    createdAt,
  };
}

/** Lookup only — does not create. Used by tests and future invite flows. */
export async function getWorkspaceRecord(
  deps: WorkspaceSeamDeps,
  workspaceId: string,
): Promise<WorkspaceRecord | null> {
  const keys = workspaceMetaKeys(workspaceId);
  const result = (await deps.ddb.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: keys,
    }),
  )) as { Item?: Record<string, unknown> };

  const item = result.Item;
  if (!item) {
    return null;
  }

  const workspaceName = item.name;
  const ownerSub = item.ownerSub;
  const createdAt = item.createdAt;
  if (
    typeof workspaceName !== "string" ||
    typeof ownerSub !== "string" ||
    typeof createdAt !== "string"
  ) {
    return null;
  }

  return {
    workspaceId,
    name: workspaceName,
    ownerSub,
    createdAt,
  };
}
