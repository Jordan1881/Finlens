import type { ExtractedTransaction } from "@finlens/domain";

/** Prefer DynamoDB until serialized extract exceeds this (leave headroom under 400KB item limit). */
export const MAX_INLINE_EXTRACT_BYTES = 200 * 1024;

export function transactionExtractS3Key(tenantId: string, statementId: string): string {
  return `statements/${tenantId}/${statementId}.extract.json`;
}

export function serializeTransactionExtract(transactions: ExtractedTransaction[]): string {
  return JSON.stringify({ transactions });
}

export function parseTransactionExtractJson(raw: string): ExtractedTransaction[] {
  const parsed = JSON.parse(raw) as { transactions?: unknown };
  if (!Array.isArray(parsed.transactions)) {
    throw new Error("Extract object missing transactions array");
  }
  return parsed.transactions as ExtractedTransaction[];
}

export function shouldStoreExtractInline(transactions: ExtractedTransaction[]): boolean {
  const bytes = Buffer.byteLength(serializeTransactionExtract(transactions), "utf8");
  return bytes <= MAX_INLINE_EXTRACT_BYTES;
}

/** 90-day TTL horizon (epoch seconds), aligned with Statement data floor. */
export function statementExpiresAt(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000) + 90 * 24 * 60 * 60;
}
