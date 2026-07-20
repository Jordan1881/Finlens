import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { StructuredError } from "@finlens/domain";
import type { CommandClient } from "./statement-service.ts";
import { workspaceMetaKeys } from "./workspace-service.ts";

/** Default hard limits per Workspace (PRD #16 / issue #23). */
export const DEFAULT_QUOTA_LIMITS = {
  uploadsPerDay: 20,
  asksPerDay: 100,
  concurrentAnalyses: 2,
} as const;

export type QuotaKind = "uploads" | "asks";

export interface QuotaLimits {
  uploadsPerDay: number;
  asksPerDay: number;
  concurrentAnalyses: number;
}

export interface QuotaSeamDeps {
  ddb: CommandClient;
  workspacesTableName: string;
  statementsTableName: string;
  /** Override resolved limits (tests). */
  limits?: Partial<QuotaLimits>;
  /** Clock injection for day-boundary tests. */
  now?: () => Date;
}

const defaultDdb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export function resolveQuotaSeamDeps(overrides?: Partial<QuotaSeamDeps>): QuotaSeamDeps {
  const workspacesTableName =
    overrides?.workspacesTableName ?? process.env.WORKSPACES_TABLE;
  const statementsTableName =
    overrides?.statementsTableName ?? process.env.STATEMENTS_TABLE;
  if (!workspacesTableName) {
    throw new Error("WORKSPACES_TABLE is not configured");
  }
  if (!statementsTableName) {
    throw new Error("STATEMENTS_TABLE is not configured");
  }
  return {
    ddb: overrides?.ddb ?? defaultDdb,
    workspacesTableName,
    statementsTableName,
    limits: overrides?.limits,
    now: overrides?.now,
  };
}

export function isQuotaError(error: Pick<StructuredError, "code">): boolean {
  return error.code.startsWith("QUOTA_");
}

export function quotaDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function quotaCounterKeys(
  workspaceId: string,
  kind: QuotaKind,
  day: string,
): { pk: string; sk: string } {
  return {
    pk: `WORKSPACE#${workspaceId}`,
    sk: `QUOTA#${kind}#${day}`,
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envDefaultLimits(): QuotaLimits {
  return {
    uploadsPerDay: parsePositiveInt(
      process.env.QUOTA_UPLOADS_PER_DAY,
      DEFAULT_QUOTA_LIMITS.uploadsPerDay,
    ),
    asksPerDay: parsePositiveInt(
      process.env.QUOTA_ASKS_PER_DAY,
      DEFAULT_QUOTA_LIMITS.asksPerDay,
    ),
    concurrentAnalyses: parsePositiveInt(
      process.env.QUOTA_CONCURRENT_ANALYSES,
      DEFAULT_QUOTA_LIMITS.concurrentAnalyses,
    ),
  };
}

function limitsFromWorkspaceQuotas(
  quotas: Record<string, number> | undefined,
  base: QuotaLimits,
): QuotaLimits {
  if (!quotas) {
    return base;
  }
  const pick = (key: string, fallback: number): number => {
    const value = quotas[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : fallback;
  };
  return {
    uploadsPerDay: pick("uploadsPerDay", base.uploadsPerDay),
    asksPerDay: pick("asksPerDay", base.asksPerDay),
    concurrentAnalyses: pick("concurrentAnalyses", base.concurrentAnalyses),
  };
}

/** Resolve effective limits: env defaults ← Workspace META.quotas ← deps.limits. */
export async function resolveQuotaLimits(
  deps: QuotaSeamDeps,
  workspaceId: string,
): Promise<QuotaLimits> {
  const base = { ...envDefaultLimits(), ...deps.limits };
  const keys = workspaceMetaKeys(workspaceId);
  const result = (await deps.ddb.send(
    new GetCommand({
      TableName: deps.workspacesTableName,
      Key: keys,
    }),
  )) as { Item?: { quotas?: Record<string, number> } };

  const fromMeta = limitsFromWorkspaceQuotas(result.Item?.quotas, base);
  return { ...fromMeta, ...deps.limits };
}

function uploadsExceededError(limit: number): StructuredError {
  return {
    code: "QUOTA_UPLOADS_EXCEEDED",
    message: `Workspace upload quota exceeded (${limit} uploads per UTC day)`,
    retryable: true,
    nextStep:
      "Wait until the next UTC day before uploading again, or ask the Workspace owner to raise limits",
  };
}

function asksExceededError(limit: number): StructuredError {
  return {
    code: "QUOTA_ASKS_EXCEEDED",
    message: `Workspace ask quota exceeded (${limit} asks per UTC day)`,
    retryable: true,
    nextStep:
      "Wait until the next UTC day before asking again, or ask the Workspace owner to raise limits",
  };
}

function concurrentExceededError(limit: number): StructuredError {
  return {
    code: "QUOTA_CONCURRENT_ANALYSES_EXCEEDED",
    message: `Workspace concurrent Analysis quota exceeded (max ${limit} processing)`,
    retryable: true,
    nextStep:
      "Wait until in-flight Analyses finish (status ready or failed), then retry",
  };
}

function isConditionalFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { name?: string }).name === "ConditionalCheckFailedException";
}

/** TTL ~3 days after the quota day so counters do not linger forever. */
function quotaExpiresAtEpoch(day: string): number {
  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  return Math.floor(dayStart / 1000) + 3 * 24 * 60 * 60;
}

async function consumeDailyQuota(
  deps: QuotaSeamDeps,
  workspaceId: string,
  kind: QuotaKind,
  limit: number,
): Promise<boolean> {
  const now = deps.now?.() ?? new Date();
  const day = quotaDayKey(now);
  const keys = quotaCounterKeys(workspaceId, kind, day);

  try {
    await deps.ddb.send(
      new UpdateCommand({
        TableName: deps.workspacesTableName,
        Key: keys,
        UpdateExpression:
          "ADD #count :one SET entityType = :entityType, workspaceId = :workspaceId, quotaKind = :quotaKind, quotaDay = :quotaDay, expiresAt = :expiresAt",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: {
          ":one": 1,
          ":limit": limit,
          ":entityType": "quota",
          ":workspaceId": workspaceId,
          ":quotaKind": kind,
          ":quotaDay": day,
          ":expiresAt": quotaExpiresAtEpoch(day),
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailure(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Atomically consume one upload against the Workspace daily counter.
 * @returns null when allowed, StructuredError when over quota.
 */
export async function consumeUploadQuota(
  workspaceId: string,
  deps?: Partial<QuotaSeamDeps>,
): Promise<StructuredError | null> {
  const seam = resolveQuotaSeamDeps(deps);
  const limits = await resolveQuotaLimits(seam, workspaceId);
  const ok = await consumeDailyQuota(seam, workspaceId, "uploads", limits.uploadsPerDay);
  return ok ? null : uploadsExceededError(limits.uploadsPerDay);
}

/**
 * Atomically consume one ask against the Workspace daily counter.
 * Wired by ask_statement / POST /v1/statements/{id}/ask (#26).
 */
export async function consumeAskQuota(
  workspaceId: string,
  deps?: Partial<QuotaSeamDeps>,
): Promise<StructuredError | null> {
  const seam = resolveQuotaSeamDeps(deps);
  const limits = await resolveQuotaLimits(seam, workspaceId);
  const ok = await consumeDailyQuota(seam, workspaceId, "asks", limits.asksPerDay);
  return ok ? null : asksExceededError(limits.asksPerDay);
}

/**
 * Count Statements currently in `processing` for the Workspace.
 * Paginated Query + FilterExpression (status is not a key attribute).
 */
export async function countProcessingAnalyses(
  deps: QuotaSeamDeps,
  workspaceId: string,
): Promise<number> {
  let total = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = (await deps.ddb.send(
      new QueryCommand({
        TableName: deps.statementsTableName,
        KeyConditionExpression: "tenantId = :tenantId",
        FilterExpression: "#status = :processing",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":tenantId": workspaceId,
          ":processing": "processing",
        },
        Select: "COUNT",
        ExclusiveStartKey: exclusiveStartKey,
      }),
    )) as { Count?: number; LastEvaluatedKey?: Record<string, unknown> };

    total += result.Count ?? 0;
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return total;
}

/**
 * Deny when the Workspace already has `concurrentAnalyses` Statements in `processing`.
 * Does not reserve a slot — callers that start analysis must re-check after / use this
 * immediately before flipping status to processing.
 */
export async function checkConcurrentAnalysisQuota(
  workspaceId: string,
  deps?: Partial<QuotaSeamDeps>,
): Promise<StructuredError | null> {
  const seam = resolveQuotaSeamDeps(deps);
  const limits = await resolveQuotaLimits(seam, workspaceId);
  const active = await countProcessingAnalyses(seam, workspaceId);
  if (active >= limits.concurrentAnalyses) {
    return concurrentExceededError(limits.concurrentAnalyses);
  }
  return null;
}

/**
 * Upload gate: daily upload counter + concurrent Analysis capacity.
 * Call before creating a pending Statement (direct upload or presigned create).
 */
export async function enforceUploadQuotas(
  workspaceId: string,
  deps?: Partial<QuotaSeamDeps>,
): Promise<StructuredError | null> {
  const concurrent = await checkConcurrentAnalysisQuota(workspaceId, deps);
  if (concurrent) {
    return concurrent;
  }
  return consumeUploadQuota(workspaceId, deps);
}
