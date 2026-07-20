import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandOutput,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import {
  ANALYSIS_CSV_PREFIX,
  ANALYSIS_SYSTEM_PROMPT,
  ANALYSIS_TOOL_INPUT_SCHEMA,
  ANALYSIS_TOOL_NAME,
  ANALYSIS_USER_PROMPT,
  coerceAnalysisResult,
  parseAnalysisJson,
  type AnalysisResult,
} from "./analysis-prompt";
import { modelIdFor } from "./bedrock-model";
import { MAX_CSV_TEXT_CHARS, type StatementFileType } from "./file-validation";

const bedrock = new BedrockRuntimeClient({});

const analysisToolConfig: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: ANALYSIS_TOOL_NAME,
        description: "Report structured bank statement analysis for Finlens.",
        inputSchema: {
          json: ANALYSIS_TOOL_INPUT_SCHEMA as unknown as DocumentType,
        },
      },
    },
  ],
  toolChoice: { tool: { name: ANALYSIS_TOOL_NAME } },
};

function analysisFromConverse(response: ConverseCommandOutput): AnalysisResult {
  const content = response.output?.message?.content ?? [];
  for (const block of content) {
    if ("toolUse" in block && block.toolUse?.name === ANALYSIS_TOOL_NAME) {
      return coerceAnalysisResult(block.toolUse.input);
    }
  }

  const textBlock = content.find((block) => "text" in block);
  if (!textBlock || !("text" in textBlock) || !textBlock.text) {
    throw new Error("Empty response from Bedrock");
  }

  return parseAnalysisJson(textBlock.text);
}

async function converse(content: ContentBlock[], modelId: string): Promise<AnalysisResult> {
  const response = await bedrock.send(
    new ConverseCommand({
      modelId,
      system: [{ text: ANALYSIS_SYSTEM_PROMPT }],
      messages: [{ role: "user", content }],
      inferenceConfig: {
        // Higher budget so line-item extracts fit alongside summary + insights.
        maxTokens: 8192,
        temperature: 0.1,
      },
      toolConfig: analysisToolConfig,
    }),
  );

  try {
    return analysisFromConverse(response);
  } catch (firstError) {
    // One repair pass: ask the model to emit the tool again with valid JSON only.
    const assistantContent = response.output?.message?.content;
    if (!assistantContent?.length) {
      throw firstError;
    }

    const retry = await bedrock.send(
      new ConverseCommand({
        modelId,
        system: [{ text: ANALYSIS_SYSTEM_PROMPT }],
        messages: [
          { role: "user", content },
          { role: "assistant", content: assistantContent },
          {
            role: "user",
            content: [
              {
                text: `The previous analysis was invalid JSON (${
                  firstError instanceof Error ? firstError.message : String(firstError)
                }). Call ${ANALYSIS_TOOL_NAME} again with valid escaped JSON only.`,
              },
            ],
          },
        ],
        inferenceConfig: {
          maxTokens: 8192,
          temperature: 0,
        },
        toolConfig: analysisToolConfig,
      }),
    );

    return analysisFromConverse(retry);
  }
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
