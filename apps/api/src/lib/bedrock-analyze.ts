import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import {
  ANALYSIS_CSV_PREFIX,
  ANALYSIS_SYSTEM_PROMPT,
  ANALYSIS_USER_PROMPT,
  parseAnalysisJson,
  type AnalysisResult,
} from "./analysis-prompt";
import { MAX_CSV_TEXT_CHARS } from "./file-validation";
import type { StatementFileType } from "./file-validation";

const bedrock = new BedrockRuntimeClient({});

function modelIdFor(fileType: StatementFileType): string {
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

async function converse(content: ContentBlock[], modelId: string): Promise<AnalysisResult> {
  const response = await bedrock.send(
    new ConverseCommand({
      modelId,
      system: [{ text: ANALYSIS_SYSTEM_PROMPT }],
      messages: [{ role: "user", content }],
      inferenceConfig: {
        maxTokens: 4096,
        temperature: 0.1,
      },
    }),
  );

  const textBlock = response.output?.message?.content?.find((block) => "text" in block);
  if (!textBlock || !("text" in textBlock) || !textBlock.text) {
    throw new Error("Empty response from Bedrock");
  }

  return parseAnalysisJson(textBlock.text);
}

export async function analyzeStatementPdf(pdfBytes: Uint8Array): Promise<AnalysisResult> {
  return converse(
    [
      {
        document: {
          format: "pdf",
          name: "bank-statement",
          source: { bytes: pdfBytes },
        },
      },
      { text: ANALYSIS_USER_PROMPT },
    ],
    modelIdFor("pdf"),
  );
}

export async function analyzeStatementCsv(csvBytes: Uint8Array): Promise<AnalysisResult> {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(csvBytes);
  if (text.length > MAX_CSV_TEXT_CHARS) {
    text = `${text.slice(0, MAX_CSV_TEXT_CHARS)}\n...[truncated]`;
  }

  return converse(
    [{ text: `${ANALYSIS_CSV_PREFIX}${text}\n\n${ANALYSIS_USER_PROMPT}` }],
    modelIdFor("csv"),
  );
}

export async function analyzeStatementFile(
  bytes: Uint8Array,
  fileType: StatementFileType,
): Promise<AnalysisResult> {
  return fileType === "csv" ? analyzeStatementCsv(bytes) : analyzeStatementPdf(bytes);
}
