import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { ListStatementsResponse, StatementListItem, StatementRecord } from "@finlens/domain";
import { json, unauthorized } from "../lib/http";
import { resolveTenantId } from "../lib/auth";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const LIST_LIMIT = 20;

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const tenantId = resolveTenantId(event);
  if (!tenantId) {
    return unauthorized("Missing or invalid X-Api-Key");
  }

  const tableName = process.env.STATEMENTS_TABLE;
  if (!tableName) {
    return json(500, { error: { code: "SERVER_MISCONFIGURED", message: "Server misconfigured", retryable: true, nextStep: "Retry later" } });
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "tenantId = :tenantId",
      ExpressionAttributeValues: { ":tenantId": tenantId },
      ScanIndexForward: false,
      Limit: LIST_LIMIT,
    }),
  );

  const statements: StatementListItem[] = ((result.Items ?? []) as StatementRecord[]).map(
    (record) => ({
      statementId: record.statementId,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      month: record.financialSummary?.month ?? null,
    }),
  );

  const response: ListStatementsResponse = {
    statements,
    count: statements.length,
  };

  return json(200, response);
}
