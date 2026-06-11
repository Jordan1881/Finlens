import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { S3Event, S3Handler } from "aws-lambda";

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
      new QueryCommand({
        TableName: tableName,
        IndexName: "byStatementId",
        KeyConditionExpression: "statementId = :statementId",
        ExpressionAttributeValues: { ":statementId": statementId },
        Limit: 1,
      }),
    );

    const item = existing.Items?.[0];
    if (!item || item.tenantId !== tenantId) {
      console.warn("No matching statement record for", key);
      continue;
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

    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn,
        input: JSON.stringify({ tenantId, statementId, bucket, key }),
      }),
    );
  }
};
