import type { StatementFileType } from "./file-validation";

/** Resolve Bedrock model id for a Statement file type (CSV can use a cheaper model). */
export function modelIdFor(fileType: StatementFileType): string {
  const baseModelId = process.env.BEDROCK_MODEL_ID;
  if (!baseModelId) {
    throw new Error("BEDROCK_MODEL_ID is not configured");
  }
  // CSVs are plain-text extraction; a smaller model handles them at a fraction of the cost
  if (fileType === "csv" && process.env.BEDROCK_MODEL_ID_CSV) {
    return process.env.BEDROCK_MODEL_ID_CSV;
  }
  return baseModelId;
}
