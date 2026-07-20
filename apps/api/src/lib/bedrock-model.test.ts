import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { modelIdFor } from "./bedrock-model.ts";

describe("Statement Bedrock model routing", () => {
  const original = {
    BEDROCK_MODEL_ID: process.env.BEDROCK_MODEL_ID,
    BEDROCK_MODEL_ID_CSV: process.env.BEDROCK_MODEL_ID_CSV,
  };

  afterEach(() => {
    if (original.BEDROCK_MODEL_ID === undefined) {
      delete process.env.BEDROCK_MODEL_ID;
    } else {
      process.env.BEDROCK_MODEL_ID = original.BEDROCK_MODEL_ID;
    }
    if (original.BEDROCK_MODEL_ID_CSV === undefined) {
      delete process.env.BEDROCK_MODEL_ID_CSV;
    } else {
      process.env.BEDROCK_MODEL_ID_CSV = original.BEDROCK_MODEL_ID_CSV;
    }
  });

  it("routes CSV Statements to the CSV model when configured", () => {
    process.env.BEDROCK_MODEL_ID = "sonnet";
    process.env.BEDROCK_MODEL_ID_CSV = "haiku";
    assert.equal(modelIdFor("csv"), "haiku");
    assert.equal(modelIdFor("pdf"), "sonnet");
  });

  it("falls back to the base model for CSV when no CSV model is set", () => {
    process.env.BEDROCK_MODEL_ID = "sonnet";
    delete process.env.BEDROCK_MODEL_ID_CSV;
    assert.equal(modelIdFor("csv"), "sonnet");
  });
});
