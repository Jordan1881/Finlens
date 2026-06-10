export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_BEDROCK_PDF_BYTES = Math.floor(4.5 * 1024 * 1024);

export interface PdfValidationFailure {
  code: "INVALID_PDF" | "ENCRYPTED_PDF" | "FILE_TOO_LARGE" | "PDF_TOO_LARGE";
  message: string;
  nextStep: string;
}

export function validatePdfBytes(bytes: Uint8Array): PdfValidationFailure | null {
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return {
      code: "FILE_TOO_LARGE",
      message: `PDF exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload limit`,
      nextStep: "Export a smaller PDF or split the statement",
    };
  }

  if (bytes.length < 5) {
    return {
      code: "INVALID_PDF",
      message: "File is not a valid PDF",
      nextStep: "Upload a bank statement exported as PDF",
    };
  }

  const header = Buffer.from(bytes.subarray(0, 5)).toString("ascii");
  if (!header.startsWith("%PDF")) {
    return {
      code: "INVALID_PDF",
      message: "File is not a valid PDF",
      nextStep: "Upload a bank statement exported as PDF",
    };
  }

  const sample = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 8192))).toString("latin1");
  if (sample.includes("/Encrypt")) {
    return {
      code: "ENCRYPTED_PDF",
      message: "Password-protected PDFs are not supported",
      nextStep: "Export an unprotected PDF from your bank",
    };
  }

  return null;
}

export function validatePdfForBedrock(bytes: Uint8Array): PdfValidationFailure | null {
  if (bytes.length > MAX_BEDROCK_PDF_BYTES) {
    return {
      code: "PDF_TOO_LARGE",
      message: "PDF exceeds Bedrock analysis size limit (~4.5 MB)",
      nextStep: "Upload a shorter statement export or contact support",
    };
  }
  return null;
}
