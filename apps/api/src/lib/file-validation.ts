export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_BEDROCK_BYTES = Math.floor(4.5 * 1024 * 1024);
export const MAX_CSV_TEXT_CHARS = 120_000;

export type StatementFileType = "pdf" | "csv";

export interface FileValidationError {
  code:
    | "INVALID_PDF"
    | "INVALID_CSV"
    | "ENCRYPTED_PDF"
    | "FILE_TOO_LARGE"
    | "FILE_TOO_LARGE_FOR_ANALYSIS"
    | "UNSUPPORTED_FILE_TYPE";
  message: string;
  nextStep: string;
}

export function detectFileType(filename: string | undefined, bytes: Uint8Array): StatementFileType | null {
  const lower = filename?.toLowerCase() ?? "";
  if (lower.endsWith(".csv")) {
    return "csv";
  }
  if (lower.endsWith(".pdf")) {
    return "pdf";
  }
  if (bytes.length >= 4 && new TextDecoder("ascii").decode(bytes.slice(0, 4)) === "%PDF") {
    return "pdf";
  }
  const sample = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 512));
  if (sample.includes(",") && sample.includes("\n")) {
    return "csv";
  }
  return null;
}

export function validateStatementBytes(
  bytes: Uint8Array,
  fileType: StatementFileType,
): FileValidationError | null {
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return {
      code: "FILE_TOO_LARGE",
      message: `File exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload limit`,
      nextStep: "Export a smaller statement file",
    };
  }

  if (fileType === "pdf") {
    return validatePdfBytes(bytes);
  }
  return validateCsvBytes(bytes);
}

export function validatePdfBytes(bytes: Uint8Array): FileValidationError | null {
  const header = new TextDecoder("ascii").decode(bytes.slice(0, 5));
  if (!header.startsWith("%PDF")) {
    return {
      code: "INVALID_PDF",
      message: "File is not a valid PDF",
      nextStep: "Upload a bank statement exported as PDF",
    };
  }

  const scan = new TextDecoder("latin1").decode(bytes.slice(0, Math.min(bytes.length, 8192)));
  if (/Encrypt/i.test(scan)) {
    return {
      code: "ENCRYPTED_PDF",
      message: "Password-protected PDFs are not supported",
      nextStep: "Export an unprotected PDF from your bank",
    };
  }

  return validateAnalysisSize(bytes);
}

export function validateCsvBytes(bytes: Uint8Array): FileValidationError | null {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!text.trim()) {
    return {
      code: "INVALID_CSV",
      message: "CSV file is empty",
      nextStep: "Export a CSV with transaction rows from your bank",
    };
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return {
      code: "INVALID_CSV",
      message: "CSV must include a header row and at least one data row",
      nextStep: "Export a full transaction CSV from your bank",
    };
  }

  if (!lines.some((line) => line.includes(","))) {
    return {
      code: "INVALID_CSV",
      message: "CSV does not look comma-separated",
      nextStep: "Use a standard CSV export (comma-separated columns)",
    };
  }

  return validateAnalysisSize(bytes);
}

function validateAnalysisSize(bytes: Uint8Array): FileValidationError | null {
  if (bytes.length > MAX_BEDROCK_BYTES) {
    return {
      code: "FILE_TOO_LARGE_FOR_ANALYSIS",
      message: "File exceeds Bedrock analysis size limit (~4.5 MB)",
      nextStep: "Export a shorter date range or fewer transactions",
    };
  }
  return null;
}

export function validateForBedrock(bytes: Uint8Array): FileValidationError | null {
  return validateAnalysisSize(bytes);
}

/** @deprecated use validateForBedrock */
export const validatePdfForBedrock = validateForBedrock;
