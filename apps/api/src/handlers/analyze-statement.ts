import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { FinancialSummary } from "@finlens/domain";
import { analyzeStatementPdf } from "../lib/bedrock-analyze";
import { validatePdfForBedrock } from "../lib/pdf-validation";

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface AnalyzeInput {
  tenantId: string;
  statementId: string;
  bucket: string;
  key: string;
}

async function markFailed(tenantId: string, statementId: string, message: string) {
  const tableName = process.env.STATEMENTS_TABLE;
  if (!tableName) {
    return;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { tenantId, statementId },
      UpdateExpression: "SET #status = :status, updatedAt = :updatedAt, errorMessage = :errorMessage",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "failed",
        ":updatedAt": new Date().toISOString(),
        ":errorMessage": message.slice(0, 500),
      },
    }),
  );
}

export async function handler(input: AnalyzeInput): Promise<{ ok: boolean }> {
  const tableName = process.env.STATEMENTS_TABLE;
  if (!tableName) {
    throw new Error("STATEMENTS_TABLE is not configured");
  }

  const { tenantId, statementId, bucket, key } = input;

  try {
    const object = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );

    const body = await object.Body?.transformToByteArray();
    if (!body) {
      throw new Error("Empty PDF object in S3");
    }

    const bedrockSizeError = validatePdfForBedrock(body);
    if (bedrockSizeError) {
      throw new Error(bedrockSizeError.message);
    }

    const analysis = await analyzeStatementPdf(body);

    const financialSummary: FinancialSummary = {
      currency: analysis.currency,
      month: analysis.month,
      totalIncome: analysis.totalIncome,
      totalExpenses: analysis.totalExpenses,
      netBalance: analysis.netBalance,
      topCategories: analysis.topCategories,
    };

    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { tenantId, statementId },
        UpdateExpression:
          "SET #status = :status, updatedAt = :updatedAt, financialSummary = :financialSummary, spendingInsights = :spendingInsights REMOVE errorMessage",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "ready",
          ":updatedAt": new Date().toISOString(),
          ":financialSummary": financialSummary,
          ":spendingInsights": analysis.spendingInsights,
        },
      }),
    );

    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analysis failed";
    console.error("Analyze failed", { tenantId, statementId, message });
    await markFailed(tenantId, statementId, message);
    throw error;
  }
}
