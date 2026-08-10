# Finlens

Finlens is a remote MCP product for bank statement analysis on AWS. Upload a monthly bank **PDF or CSV** (Hebrew or English), run async Bedrock analysis, and get structured financial summaries plus narrative spending insights — via **REST**, **remote MCP**, or the **web dashboard**.

## Live (dev)

| Surface | URL |
|---------|-----|
| Web UI | https://d1l5l6otiduz0x.cloudfront.net |
| REST / MCP API | https://xaq0zzwnv7.execute-api.eu-west-1.amazonaws.com |
| MCP endpoint | https://xaq0zzwnv7.execute-api.eu-west-1.amazonaws.com/mcp |

Auth uses header `X-Api-Key` for MCP/agents, or `Authorization: Bearer` (Cognito access token) for the web control plane. API keys are stored as SHA-256 hashes in the ApiKeysTable, mapped to a Workspace `tenantId`. Workspace owners mint/revoke keys in the web UI (**API keys**) or via `POST`/`GET`/`DELETE /v1/api-keys` with Cognito Bearer — plaintext is shown once at mint. The **MCP setup** panel copies a Cursor config template with the API URL and a key placeholder (paste the minted secret; never bake a key into the web build). Operators can still use `node scripts/create-api-key.mjs --table <ApiKeysTableName> --tenant <tenantId>`. In dev, the shared `finlens-dev-local-key` shortcut (stack output `DevApiKey`, tenant `dev`) also works for API/MCP. The web SPA never embeds an API key; it uses Cognito Hosted UI + PKCE.

## Features

- Upload bank statements as **PDF** or **CSV**
- Async pipeline: S3 → Step Functions → Lambda → **Amazon Bedrock** (Claude)
- REST API for create, list, get, upload, and **delete**
- Remote **MCP** (Streamable HTTP) with four tools
- Next.js dashboard (SnowUI-inspired layout)
- Multi-tenant metadata in DynamoDB (`tenantId` = Workspace id from API key or Cognito membership)

## Architecture

```mermaid
flowchart TB
  subgraph clients["Clients"]
    WEB["Web UI<br/>(Next.js static)"]
    MCP["Cursor / MCP clients"]
    CLI["curl / integrations"]
  end

  subgraph edge["Edge & API"]
    CF["CloudFront"]
    WEBS3["S3 — web assets"]
    APIGW["API Gateway<br/>HTTP API"]
  end

  subgraph api["Lambda handlers"]
    REST["REST handlers<br/>CRUD + upload"]
    MCPL["MCP server"]
    OAUTH["OAuth proxy + metadata"]
  end

  subgraph data["Data"]
    STMTS3["S3 — statements<br/>.pdf / .csv"]
    DDB["DynamoDB<br/>statements + api keys + workspaces"]
  end

  subgraph async["Async analysis"]
    S3EVT["S3 event"]
    ONUP["OnS3Upload λ"]
    SFN["Step Functions"]
    ANALYZE["AnalyzeStatement λ"]
    BR["Amazon Bedrock<br/>Claude Sonnet"]
  end

  subgraph auth["Auth (optional)"]
    COG["Amazon Cognito"]
  end

  WEB --> CF --> WEBS3
  WEB --> APIGW
  MCP --> APIGW
  CLI --> APIGW

  APIGW --> REST
  APIGW --> MCPL
  APIGW --> OAUTH
  OAUTH --> COG

  REST --> STMTS3
  REST --> DDB
  MCPL --> STMTS3
  MCPL --> DDB

  STMTS3 --> S3EVT --> ONUP --> SFN --> ANALYZE
  ANALYZE --> STMTS3
  ANALYZE --> DDB
  ANALYZE --> BR
  ONUP --> DDB
```

### AWS services

<p align="center">
  <img src="docs/assets/aws/CloudFront.png" alt="Amazon CloudFront" width="48" />
  &nbsp;
  <img src="docs/assets/aws/S3.png" alt="Amazon S3" width="48" />
  &nbsp;
  <img src="docs/assets/aws/APIGateway.png" alt="Amazon API Gateway" width="48" />
  &nbsp;
  <img src="docs/assets/aws/Lambda.png" alt="AWS Lambda" width="48" />
  &nbsp;
  <img src="docs/assets/aws/DynamoDB.png" alt="Amazon DynamoDB" width="48" />
  &nbsp;
  <img src="docs/assets/aws/StepFunctions.png" alt="AWS Step Functions" width="48" />
  &nbsp;
  <img src="docs/assets/aws/Bedrock.png" alt="Amazon Bedrock" width="48" />
  &nbsp;
  <img src="docs/assets/aws/Cognito.png" alt="Amazon Cognito" width="48" />
</p>

Icons from [awslabs/aws-icons-for-plantuml](https://github.com/awslabs/aws-icons-for-plantuml) (Apache-2.0).

| Service | Role in Finlens |
|---------|-----------------|
| **Amazon CloudFront** | CDN for the static Next.js dashboard |
| **Amazon S3** | Private buckets for statement files (`.pdf`, `.csv`) and exported web assets |
| **Amazon API Gateway (HTTP API)** | Single HTTPS entry for REST, MCP, and OAuth routes |
| **AWS Lambda** | REST handlers, MCP server, OAuth bridge, S3 trigger, Bedrock analysis |
| **Amazon DynamoDB** | Statement records (status, summaries, insights) and API key hashes |
| **AWS Step Functions** | Wraps the analyze Lambda: retries transient Bedrock/Lambda errors with exponential backoff, and on unrecoverable failure marks the statement row `failed` in DynamoDB |
| **Amazon Bedrock** | Claude model for PDF document + CSV text analysis |
| **Amazon Cognito** | User pool + Google IdP for MCP OAuth (alongside dev API key) |

**Region:** `eu-west-1` · **IaC:** AWS CDK (TypeScript) · **Account:** see `infra/cdk.json`

### Upload → analysis flow

1. Client uploads via `POST /v1/statements/upload` (base64) or presigned `POST /v1/statements`.
2. File lands in S3 under `statements/{tenantId}/{statementId}.{pdf|csv}`.
3. S3 `OBJECT_CREATED` invokes **OnS3Upload** Lambda → marks row `processing` → starts Step Functions.
4. **AnalyzeStatement** Lambda reads the file, calls Bedrock, writes `financialSummary` + `spendingInsights`, sets status `ready` (or `failed`). Step Functions retries transient errors (Bedrock throttling/timeouts, Lambda service errors) up to 3 times with exponential backoff; if the task still fails — including crashes or timeouts the Lambda can't catch itself — a catch step writes status `failed` + `errorMessage` to the row before the execution fails.
5. Client polls `GET /v1/statements/{id}?detail=summary` or uses MCP `get_statement`.

## Monorepo layout

```
apps/
  api/           Lambda handlers (REST, MCP, OAuth, pipeline)
  web/           Next.js static dashboard (CloudFront)
packages/
  domain/        Shared TypeScript types
  mcp/           MCP tool names + agent instructions
infra/           AWS CDK stack (`FinlensDevStack` / `FinlensProdStack`)
```

## REST API (v1)

All statement routes accept `Authorization: Bearer` (Cognito) or `X-Api-Key` (agents/MCP). MCP prefers the same hybrid resolution. API key mint/list/revoke require Cognito Bearer (Workspace owner) only.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/statements` | Create statement + presigned upload URL |
| `POST` | `/v1/statements/upload` | Direct upload (JSON `{ base64, filename }`; optional `Idempotency-Key`) |
| `GET` | `/v1/statements` | List statements (`limit`, `nextToken`, `status`) |
| `GET` | `/v1/statements/{id}?detail=summary\|full` | Get status / analysis |
| `DELETE` | `/v1/statements/{id}` | Delete statement + S3 object |
| `POST` | `/v1/api-keys` | Mint key (Cognito; plaintext once) |
| `GET` | `/v1/api-keys` | List key metadata (Cognito) |
| `DELETE` | `/v1/api-keys/{keyId}` | Revoke key (Cognito) |

### Example

```bash
export API_URL=https://xaq0zzwnv7.execute-api.eu-west-1.amazonaws.com
export API_KEY=finlens-dev-local-key

# Mint a Workspace key (Cognito access token from web login)
curl -s -X POST "$API_URL/v1/api-keys" \
  -H "Authorization: Bearer $COGNITO_ACCESS_TOKEN" | jq
# → save .apiKey now; list/revoke never return it again

# List
curl -s "$API_URL/v1/statements" -H "X-Api-Key: $API_KEY" | jq

# Upload PDF or CSV (base64)
curl -s -X POST "$API_URL/v1/statements/upload" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{"base64":"...","filename":"statement.csv"}' | jq

# Poll summary
curl -s "$API_URL/v1/statements/$STATEMENT_ID?detail=summary" \
  -H "X-Api-Key: $API_KEY" | jq

# Delete
curl -s -X DELETE "$API_URL/v1/statements/$STATEMENT_ID" \
  -H "X-Api-Key: $API_KEY" | jq
```

## MCP tools

| Tool | Description |
|------|-------------|
| `upload_statement` | Upload PDF/CSV as base64 + filename (optional `idempotency_key`) |
| `get_statement` | Poll status and summary (`detail=summary\|full`) |
| `list_statements` | List uploads newest-first (`limit`, `nextToken`, `status`) |
| `delete_statement` | Permanently delete a statement |

### Cursor config (dev)

```json
{
  "mcpServers": {
    "finlens": {
      "url": "https://xaq0zzwnv7.execute-api.eu-west-1.amazonaws.com/mcp",
      "headers": {
        "X-Api-Key": "finlens-dev-local-key"
      }
    }
  }
}
```

## Design references

- [SnowUI Design System](https://www.figma.com/design/PIcIocu0vcBS8biHwWyc2b/SnowUI-Design-System--Community-?node-id=60755-3905)
- [Dashboard layout reference](https://www.figma.com/design/ik7CMptQeecUUQZxc0EEhh/Dashboard-Design-System--Community-?node-id=913-3655)

## Development

**Requirements:** Node.js ≥ 20, AWS CLI, CDK bootstrap in `eu-west-1`.

```bash
git clone https://github.com/Jordan1881/Finlens.git
cd Finlens
npm install

# Build web + deploy dev stack (from infra/)
cd infra
npm run deploy:dev
# or: npx cdk deploy FinlensDevStack --profile finlens
```

Optional CDK context for ops email alerts (issue #19):

```bash
# Confirm the SNS subscription email after first deploy
npx cdk deploy FinlensDevStack -c opsAlertEmail=ops@example.com --profile finlens
```

If `opsAlertEmail` is omitted, the ops SNS topic and alarm actions are still created; add a subscription later and confirm it in email.

Web build env (injected by `deploy:dev` — Cognito IDs only, no API key):

```bash
NEXT_PUBLIC_FINLENS_API_URL=https://<api-id>.execute-api.eu-west-1.amazonaws.com
NEXT_PUBLIC_COGNITO_USER_POOL_ID=eu-west-1_…
NEXT_PUBLIC_COGNITO_CLIENT_ID=…
NEXT_PUBLIC_COGNITO_DOMAIN=…
NEXT_PUBLIC_COGNITO_REGION=eu-west-1
```

Copy `apps/web/.env.production.example` for local static builds / `next dev`. Register Cognito callback URLs for `http://localhost:3000/auth/callback` and the CloudFront origin (see `docs/security/phase-workspace-identity.md`).

### Production deploy (`FinlensProdStack`)

Prod is gated: no shared `DEV_API_KEY`, CORS allowlist is the prod CloudFront origin only, and `deploy:prod` refuses to run until security-phase docs (#18–#21, #23, #29) and source invariants pass. Details: [`docs/security/phase-prod-deploy.md`](docs/security/phase-prod-deploy.md).

```bash
# Prerequisites gate (docs + no DEV_API_KEY / CloudFront CORS invariants)
npm run cdk:check:prod

# Synth only (safe — no AWS mutation)
cd infra && npx cdk synth FinlensProdStack
npm run check:prod -- --verify-synth

# Live deploy — operator approval + working AWS profile required
# 1. Pass opsAlertEmail and confirm the SNS subscription email
# 2. After deploy, add Cognito callback/sign-out URLs for the prod WebUrl:
#      https://<prod-WebUrl>/auth/callback
#      https://<prod-WebUrl>/
npx cdk deploy FinlensProdStack \
  -c opsAlertEmail=ops@example.com \
  --profile <prod-capable-profile>
# or (runs the same gate first): npm run cdk:deploy:prod
```

Prod does **not** emit a `DevApiKey` stack output. Mint Workspace keys via the web control plane or `POST /v1/api-keys` after Cognito login.

### Useful scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Build all workspaces |
| `npm run cdk:synth` | Synthesize CloudFormation |
| `npm run cdk:deploy:dev` | Build web + deploy `FinlensDevStack` |
| `npm run cdk:check:prod` | Prod deploy prerequisite gate (#29) |
| `npm run cdk:deploy:prod` | Gate + deploy `FinlensProdStack` |

Stack outputs include `ApiUrl`, `WebUrl`, `McpUrl`, `StatementsBucketName`, `StatementsTableName`, `WorkspacesTableName`, Cognito ids, and (dev only) `DevApiKey`.

## License

Private / all rights reserved unless otherwise noted in the repository.

![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/Jordan1881/Finlens?utm_source=oss&utm_medium=github&utm_campaign=Jordan1881%2FFinlens&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)
