import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

/** Injectable ask model — tests mock this instead of hitting Bedrock. */
export interface AskModelClient {
  complete(system: string, user: string): Promise<string>;
}

const ASK_SYSTEM_PROMPT = `You are Finlens, a concise bank-statement Q&A assistant.
Answer only from the provided Analysis context (summary, insights, and optional transaction extract).
If the context is insufficient, say what is missing — do not invent transactions or amounts.
Respond in the same language as the question when possible.
Keep answers short (a few sentences or a small bullet list).`;

/** Cap extract payload so ask stays a light Bedrock call. */
export const ASK_EXTRACT_MAX_TRANSACTIONS = 80;
export const ASK_EXTRACT_MAX_CHARS = 12_000;

export function buildAskUserPrompt(params: {
  question: string;
  summaryJson: string;
  insights: string[];
  extractJson?: string;
}): string {
  const parts = [
    "## Financial summary",
    params.summaryJson,
    "",
    "## Spending insights",
    params.insights.length > 0 ? params.insights.map((i) => `- ${i}`).join("\n") : "(none)",
  ];

  if (params.extractJson) {
    parts.push("", "## Transaction extract (may be truncated)", params.extractJson);
  }

  parts.push("", "## Question", params.question);
  return parts.join("\n");
}

/** Heuristic: line-item questions benefit from extract without renaming the tool. */
export function questionLikelyNeedsExtract(question: string): boolean {
  return /transaction|merchant|line\s*item|purchase|spent\s+at|when\s+did|which\s+|list\s+|detail|specific|invoice|transfer|deposit|withdrawal|ATM|fee/i.test(
    question,
  );
}

function resolveAskModelId(): string {
  return process.env.BEDROCK_MODEL_ID_ASK ?? process.env.BEDROCK_MODEL_ID_CSV ?? process.env.BEDROCK_MODEL_ID ?? "";
}

export function createBedrockAskClient(): AskModelClient {
  const bedrock = new BedrockRuntimeClient({});
  return {
    async complete(system: string, user: string): Promise<string> {
      const modelId = resolveAskModelId();
      if (!modelId) {
        throw new Error("BEDROCK_MODEL_ID is not configured");
      }

      const response = await bedrock.send(
        new ConverseCommand({
          modelId,
          system: [{ text: system }],
          messages: [{ role: "user", content: [{ text: user }] }],
          inferenceConfig: {
            maxTokens: 1024,
            temperature: 0.2,
          },
        }),
      );

      const textBlock = response.output?.message?.content?.find((block) => "text" in block);
      if (!textBlock || !("text" in textBlock) || !textBlock.text) {
        throw new Error("Empty response from Bedrock");
      }
      return textBlock.text.trim();
    },
  };
}

export async function runAskCompletion(
  client: AskModelClient,
  params: {
    question: string;
    summaryJson: string;
    insights: string[];
    extractJson?: string;
  },
): Promise<string> {
  const user = buildAskUserPrompt(params);
  return client.complete(ASK_SYSTEM_PROMPT, user);
}
