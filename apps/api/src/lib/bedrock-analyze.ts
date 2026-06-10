import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import {
  ANALYSIS_SYSTEM_PROMPT,
  ANALYSIS_USER_PROMPT,
  parseAnalysisJson,
  type AnalysisResult,
} from "./analysis-prompt";

const bedrock = new BedrockRuntimeClient({});

export async function analyzeStatementPdf(pdfBytes: Uint8Array): Promise<AnalysisResult> {
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) {
    throw new Error("BEDROCK_MODEL_ID is not configured");
  }

  const content: ContentBlock[] = [
    {
      document: {
        format: "pdf",
        name: "bank-statement",
        source: { bytes: pdfBytes },
      },
    },
    { text: ANALYSIS_USER_PROMPT },
  ];

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
