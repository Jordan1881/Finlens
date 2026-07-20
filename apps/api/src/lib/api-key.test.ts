import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  apiKeyPrefix,
  generateApiKeyPlaintext,
  hashApiKey,
  timingSafeStringEqual,
} from "./api-key.ts";

describe("Workspace API key helpers", () => {
  it("hashes keys with SHA-256 hex for ApiKeysTable lookup", () => {
    assert.equal(
      hashApiKey("flk_test_key"),
      "3b638bb4a63898d139c443cde53a3214549b87c08938f8d9369b7c1e4dc93404",
    );
  });

  it("compares keys in constant time and rejects length mismatches", () => {
    assert.equal(timingSafeStringEqual("abc", "abc"), true);
    assert.equal(timingSafeStringEqual("abc", "abd"), false);
    assert.equal(timingSafeStringEqual("abc", "ab"), false);
  });

  it("mints flk_ plaintext and a non-secret prefix", () => {
    const key = generateApiKeyPlaintext();
    assert.match(key, /^flk_[A-Za-z0-9_-]+$/);
    assert.equal(apiKeyPrefix(key), key.slice(0, 12));
  });
});
