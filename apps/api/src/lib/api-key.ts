import { createHash, timingSafeEqual } from "node:crypto";

/** SHA-256 hex digest used as ApiKeysTable partition key. */
export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/** Constant-time string compare for API key equality checks. */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
