import { ExecutionAlreadyExists, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { S3Event, S3Handler } from "aws-lambda";
import { checkConcurrentAnalysisQuota } from "../lib/quota-service";

const sfn = new SFNClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const KEY_PATTERN = /^statements\/([^/]+)\/([^/]+)\.(pdf|csv)$/;

export const handler: S3Handler = async (event: S3Event) => {
  const stateMachineArn = process.env.STATE_MACHINE_ARN;
  const tableName = process.env.STATEMENTS_TABLE;
  if (!stateMachineArn || !tableName) {
    throw new Error("Missing STATE_MACHINE_ARN or STATEMENTS_TABLE");
  }

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const match = KEY_PATTERN.exec(key);
    if (!match) {
      continue;
    }

    const [, tenantId, statementId] = match;
    const now = new Date().toISOString();

    const existing = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { tenantId, statementId },
      }),
    );

    if (!existing.Item) {
      console.warn("No matching statement record for", key);
      continue;
    }

    const currentStatus = existing.Item.status as string | undefined;

    // Duplicate S3 events for an already-processing row should still attempt StartExecution
    // (idempotent via execution name) without re-checking quotas.
    if (currentStatus !== "processing") {
      // Concurrent gate: `processing` counts toward the Workspace limit (#23).
      // Deny here so we do not start Bedrock when at capacity.
      const quotaError = await checkConcurrentAnalysisQuota(tenantId);
      if (quotaError) {
        try {
          await ddb.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { tenantId, statementId },
              UpdateExpression:
                "SET #status = :failed, updatedAt = :updatedAt, errorMessage = :errorMessage",
              ConditionExpression:
                "#status <> :ready AND #status <> :failed AND #status <> :processing",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":failed": "failed",
                ":ready": "ready",
                ":processing": "processing",
                ":updatedAt": now,
                ":errorMessage": `${quotaError.code}: ${quotaError.message}. ${quotaError.nextStep}`,
              },
            }),
          );
        } catch (error) {
          // Condition failed → row already moved; ignore.
          if (
            !error ||
            typeof error !== "object" ||
            (error as { name?: string }).name !== "ConditionalCheckFailedException"
          ) {
            throw error;
          }
        }
        console.warn("Concurrent analysis quota exceeded; statement marked failed", {
          tenantId,
          statementId,
          code: quotaError.code,
        });
        continue;
      }
    }

    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { tenantId, statementId },
        UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "processing",
          ":updatedAt": now,
        },
      }),
    );

    try {
      // Naming the execution after the statement makes duplicate S3 events a no-op:
      // Step Functions rejects a second execution with the same name for 90 days.
      await sfn.send(
        new StartExecutionCommand({
          stateMachineArn,
          name: statementId,
          input: JSON.stringify({ tenantId, statementId, bucket, key }),
        }),
      );
    } catch (error) {
      if (error instanceof ExecutionAlreadyExists) {
        console.warn("Analysis already started for", statementId);
        continue;
      }
      throw error;
    }
  }
};
