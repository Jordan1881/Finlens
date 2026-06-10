# Finlens

Remote MCP product for bank statement PDF analysis on AWS.

Upload a monthly bank PDF → async Bedrock analysis → structured financial summary + narrative spending insights. Exposed via **remote MCP** and a **Next.js web UI**.

## Status

Active development in this repo. Track work via [GitHub Issues](https://github.com/Jordan1881/Finlens/issues).

| Issue | Track |
|-------|--------|
| [#1](https://github.com/Jordan1881/Finlens/issues/1) | PRD |
| [#2](https://github.com/Jordan1881/Finlens/issues/2) | **Start here** — AWS bootstrap (HITL) |
| [#3](https://github.com/Jordan1881/Finlens/issues/3) | Bedrock + region (HITL) |
| [#6](https://github.com/Jordan1881/Finlens/issues/6) | MCP v1 epic (grill decisions) |
| [#7–#11](https://github.com/Jordan1881/Finlens/issues/7) | MCP REST + `/mcp` (implemented locally — deploy) |
| [#12](https://github.com/Jordan1881/Finlens/issues/12) | **[HITL] Cognito OAuth** — you'll do this next |
| [#13](https://github.com/Jordan1881/Finlens/issues/13) | OAuth on `/mcp` (after #12) |

## Architecture (v1)

- **MCP**: Remote HTTP on AWS (Streamable HTTP)
- **Auth**: API keys (v1) → Cognito (v2)
- **Storage**: S3 (PDFs) + DynamoDB (metadata & analysis)
- **Compute**: Lambda + Step Functions + Bedrock Claude
- **UI**: Next.js on AWS Amplify
- **IaC**: AWS CDK (TypeScript)
- **Environments**: dev + prod
- **Region**: `eu-west-1` v1 (Amplify not yet in `il-central-1`)

## Design

- [SnowUI Design System](https://www.figma.com/design/PIcIocu0vcBS8biHwWyc2b/SnowUI-Design-System--Community-?node-id=60755-3905)
- [Dashboard layout reference](https://www.figma.com/design/ik7CMptQeecUUQZxc0EEhh/Dashboard-Design-System--Community-?node-id=913-3655)

## Monorepo layout (planned)

```
apps/web/          Next.js (Amplify)
apps/api/          API Gateway + Lambda (REST + MCP)
packages/domain/   PDF pipeline, analysis schema
packages/mcp/      MCP tool definitions
infra/             AWS CDK
```

## MCP tools (v1)

- `upload_statement`
- `get_statement_status`
- `get_financial_summary`
- `get_spending_insights`

## Development

## Development

AWS bootstrap: [issue #2](https://github.com/Jordan1881/Finlens/issues/2). Deploy dev stack:

```bash
cd "/Users/jordan/Desktop/AI Project/Finlens"
npm install
cd infra
npx cdk deploy FinlensDevStack --profile finlens
```

### Test upload API (after deploy)

Dev API key (from stack output `DevApiKey`): `finlens-dev-local-key`

```bash
# Create upload slot
curl -s -X POST "$API_URL/v1/statements" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: finlens-dev-local-key" \
  -d '{}' | jq

# Upload PDF to presigned URL from response.uploadUrl
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/pdf" \
  --data-binary @statement.pdf

# Poll status
curl -s "$API_URL/v1/statements/$STATEMENT_ID" \
  -H "X-Api-Key: finlens-dev-local-key" | jq
```
