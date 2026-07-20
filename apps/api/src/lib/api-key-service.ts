import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import type {
  ApiKeyMetadata,
  ApiKeyRecord,
  ApiKeyStatus,
  ListApiKeysResponse,
  MintApiKeyResponse,
  RevokeApiKeyResponse,
} from "@finlens/domain";
import {
  apiKeyPrefix,
  generateApiKeyPlaintext,
  hashApiKey,
} from "./api-key.ts";
import type { CommandClient } from "./statement-service.ts";

export const API_KEYS_BY_TENANT_INDEX = "byTenant";

export interface ApiKeySeamDeps {
  ddb: CommandClient;
  tableName: string;
}

const defaultDdb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export function resolveApiKeySeamDeps(
  overrides?: Partial<ApiKeySeamDeps>,
): ApiKeySeamDeps {
  const tableName = overrides?.tableName ?? process.env.API_KEYS_TABLE;
  if (!tableName) {
    throw new Error("API_KEYS_TABLE is not configured");
  }
  return {
    ddb: overrides?.ddb ?? defaultDdb,
    tableName,
  };
}

function newKeyId(): string {
  return `key_${randomUUID().replace(/-/g, "")}`;
}

function isActiveStatus(status: unknown): boolean {
  // Legacy rows minted by CLI before status existed are treated as active.
  return status === undefined || status === null || status === "active";
}

function toMetadata(item: Record<string, unknown>): ApiKeyMetadata | null {
  const keyId = item.keyId;
  const tenantId = item.tenantId;
  const createdAt = item.createdAt;
  const prefix = item.prefix;
  const rawStatus = item.status;
  if (
    typeof keyId !== "string" ||
    typeof tenantId !== "string" ||
    typeof createdAt !== "string" ||
    typeof prefix !== "string"
  ) {
    return null;
  }

  const status: ApiKeyStatus =
    rawStatus === "revoked" ? "revoked" : isActiveStatus(rawStatus) ? "active" : "revoked";

  return { keyId, tenantId, createdAt, status, prefix };
}

/**
 * Resolve Workspace `tenantId` for a plaintext API key.
 * Returns null for missing, revoked, or malformed rows.
 */
export async function resolveTenantIdForApiKey(
  apiKey: string,
  deps?: Partial<ApiKeySeamDeps>,
): Promise<string | null> {
  const seam = resolveApiKeySeamDeps(deps);
  const keyHash = hashApiKey(apiKey);
  const result = (await seam.ddb.send(
    new GetCommand({
      TableName: seam.tableName,
      Key: { keyHash },
    }),
  )) as { Item?: Record<string, unknown> };

  const item = result.Item;
  if (!item) {
    return null;
  }

  if (!isActiveStatus(item.status)) {
    return null;
  }

  const tenantId = item.tenantId;
  return typeof tenantId === "string" && tenantId.length > 0 ? tenantId : null;
}

/** Mint a Workspace-scoped key. Plaintext returned once; only the hash is stored. */
export async function mintApiKey(
  tenantId: string,
  deps?: Partial<ApiKeySeamDeps>,
): Promise<MintApiKeyResponse> {
  if (!tenantId) {
    throw new Error("tenantId is required");
  }

  const seam = resolveApiKeySeamDeps(deps);
  const apiKey = generateApiKeyPlaintext();
  const keyHash = hashApiKey(apiKey);
  const keyId = newKeyId();
  const createdAt = new Date().toISOString();
  const prefix = apiKeyPrefix(apiKey);
  const status: ApiKeyStatus = "active";

  const record: ApiKeyRecord = {
    keyHash,
    keyId,
    tenantId,
    createdAt,
    status,
    prefix,
  };

  await seam.ddb.send(
    new PutCommand({
      TableName: seam.tableName,
      Item: record,
      ConditionExpression: "attribute_not_exists(keyHash)",
    }),
  );

  return {
    keyId,
    tenantId,
    createdAt,
    status,
    prefix,
    apiKey,
  };
}

/** List key metadata for a Workspace (no secrets / hashes). */
export async function listApiKeys(
  tenantId: string,
  deps?: Partial<ApiKeySeamDeps>,
): Promise<ListApiKeysResponse> {
  if (!tenantId) {
    throw new Error("tenantId is required");
  }

  const seam = resolveApiKeySeamDeps(deps);
  const result = (await seam.ddb.send(
    new QueryCommand({
      TableName: seam.tableName,
      IndexName: API_KEYS_BY_TENANT_INDEX,
      KeyConditionExpression: "tenantId = :tenantId",
      ExpressionAttributeValues: { ":tenantId": tenantId },
    }),
  )) as { Items?: Record<string, unknown>[] };

  const keys = (result.Items ?? [])
    .map(toMetadata)
    .filter((k): k is ApiKeyMetadata => k != null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return { keys, count: keys.length };
}

/**
 * Revoke a key by id within a Workspace. Soft-revoke (status=revoked) so
 * verification fails immediately while list still shows history.
 */
export async function revokeApiKey(
  tenantId: string,
  keyId: string,
  deps?: Partial<ApiKeySeamDeps>,
): Promise<RevokeApiKeyResponse | null> {
  if (!tenantId || !keyId) {
    throw new Error("tenantId and keyId are required");
  }

  const seam = resolveApiKeySeamDeps(deps);
  const listed = (await seam.ddb.send(
    new QueryCommand({
      TableName: seam.tableName,
      IndexName: API_KEYS_BY_TENANT_INDEX,
      KeyConditionExpression: "tenantId = :tenantId AND keyId = :keyId",
      ExpressionAttributeValues: {
        ":tenantId": tenantId,
        ":keyId": keyId,
      },
      Limit: 1,
    }),
  )) as { Items?: Record<string, unknown>[] };

  const item = listed.Items?.[0];
  if (!item || typeof item.keyHash !== "string") {
    return null;
  }

  // Cross-Workspace denial: GSI query already scoped by tenantId; double-check.
  if (item.tenantId !== tenantId) {
    return null;
  }

  await seam.ddb.send(
    new UpdateCommand({
      TableName: seam.tableName,
      Key: { keyHash: item.keyHash },
      UpdateExpression: "SET #status = :revoked",
      ConditionExpression: "tenantId = :tenantId AND keyId = :keyId",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":revoked": "revoked",
        ":tenantId": tenantId,
        ":keyId": keyId,
      },
    }),
  );

  return { keyId, revoked: true };
}
