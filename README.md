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
| [#4](https://github.com/Jordan1881/Finlens/issues/4) | Monorepo + CDK (in progress) |
| [#5](https://github.com/Jordan1881/Finlens/issues/5) | Web UI — SnowUI Figma (HITL) |

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

Start with [HITL issue #8 — AWS bootstrap](https://github.com/Jordan1881/Finance-MCP-Agent-UI/issues/8).
