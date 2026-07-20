#!/usr/bin/env node
// Mint an API key for a tenant and store its SHA-256 hash in the ApiKeysTable.
// The plaintext key is printed once and never stored.
// Prefer the web UI or POST /v1/api-keys (Cognito Bearer) when available.
//
// Usage:
//   node scripts/create-api-key.mjs --table <ApiKeysTableName> --tenant <tenantId> [--region eu-west-1]
//
// Get the table name from the stack output:
//   aws cloudformation describe-stacks --stack-name FinlensDevStack \
//     --query "Stacks[0].Outputs[?OutputKey=='ApiKeysTableName'].OutputValue" --output text

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : undefined;
}

const table = arg("table");
const tenantId = arg("tenant");
const region = arg("region") ?? "eu-west-1";

if (!table || !tenantId) {
  console.error("Usage: node scripts/create-api-key.mjs --table <ApiKeysTableName> --tenant <tenantId> [--region eu-west-1]");
  process.exit(1);
}

const apiKey = `flk_${randomBytes(24).toString("base64url")}`;
const keyHash = createHash("sha256").update(apiKey).digest("hex");
const keyId = `key_${randomUUID().replace(/-/g, "")}`;
const createdAt = new Date().toISOString();
const prefix = apiKey.slice(0, 12);

const ddb = new DynamoDBClient({ region });
await ddb.send(
  new PutItemCommand({
    TableName: table,
    Item: {
      keyHash: { S: keyHash },
      keyId: { S: keyId },
      tenantId: { S: tenantId },
      createdAt: { S: createdAt },
      status: { S: "active" },
      prefix: { S: prefix },
    },
    ConditionExpression: "attribute_not_exists(keyHash)",
  }),
);

console.log(`Tenant:  ${tenantId}`);
console.log(`Key id:  ${keyId}`);
console.log(`API key: ${apiKey}`);
console.log("Store it now — the plaintext is not recoverable from the table.");
