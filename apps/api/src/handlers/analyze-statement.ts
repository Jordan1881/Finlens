import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { FinancialSummary } from "@finlens/domain";
import { analyzeStatementFile } from "../lib/bedrock-analyze";
import { validateForBedrock, type StatementFileType } from "../lib/file-validation";

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface AnalyzeInput {
  tenantId: string;
  statementId: string;
  bucket: string;
  key: string;
}

function fileTypeFromKey(key: string): StatementFileType {
  return key.toLowerCase().endsWith(".csv") ? "csv" : "pdf";
}

export async function handler(input: AnalyzeInput): Promise<{ ok: boolean }> {
  const tableName = process.env.STATEMENTS_TABLE;
  if (!tableName) {
    throw new Error("STATEMENTS_TABLE is not configured");
  }

  const { tenantId, statementId, bucket, key } = input;
  const fileType = fileTypeFromKey(key);

  try {
    const object = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );

    const body = await object.Body?.transformToByteArray();
    if (!body) {
      throw new Error("Empty statement file in S3");
    }

    const bedrockSizeError = validateForBedrock(body);
    if (bedrockSizeError) {
      throw new Error(bedrockSizeError.message);
    }

    const analysis = await analyzeStatementFile(body, fileType);

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
    // The Step Functions catch path owns marking the row failed — rethrow so
    // retryable errors stay retryable instead of flipping the row to failed early.
    const message = error instanceof Error ? error.message : "Analysis failed";
    console.error("Analyze failed", { tenantId, statementId, message });
    throw error;
  }
}
