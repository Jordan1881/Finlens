import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_UPLOAD_BYTES,
  detectFileType,
  validateStatementBytes,
} from "./file-validation.ts";

describe("Statement file validation", () => {
  it("detects PDF from magic bytes", () => {
    const bytes = new TextEncoder().encode("%PDF-1.4\nrest");
    assert.equal(detectFileType(undefined, bytes), "pdf");
  });

  it("detects CSV from filename", () => {
    const bytes = new TextEncoder().encode("a,b\n1,2\n");
    assert.equal(detectFileType("statement.csv", bytes), "csv");
  });

  it("rejects encrypted PDFs", () => {
    const bytes = new TextEncoder().encode("%PDF-1.4\n/Encrypt 1 0 R\n");
    const error = validateStatementBytes(bytes, "pdf");
    assert.equal(error?.code, "ENCRYPTED_PDF");
  });

  it("rejects oversized uploads", () => {
    const bytes = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    bytes.set(new TextEncoder().encode("%PDF-"), 0);
    const error = validateStatementBytes(bytes, "pdf");
    assert.equal(error?.code, "FILE_TOO_LARGE");
  });
});
