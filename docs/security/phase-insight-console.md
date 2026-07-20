# Phase: Insight console compare / charts (#28)

## Scope

Wire the Insights section of the Cognito control plane (`apps/web`) so humans can run the same Workspace-scoped power tools agents use:

| UI action | REST (Bearer) | MCP equivalent |
|-----------|---------------|----------------|
| Compare two ready Statements | `POST /v1/statements/compare` | `compare_statements` |
| Category bar chart for one Statement | `GET /v1/statements/{id}/categories` | `get_category_breakdown` |
| Failed Analysis panel | `GET /v1/statements/{id}?detail=summary` | `get_statement` |

Results are identical in shape to MCP/REST for the caller’s Workspace — the UI is another thin client on the Statement seam, not a parallel data path.

## Auth and secrets

| Concern | Rule |
|---------|------|
| Browser session | Cognito access token in `sessionStorage` (unchanged from #27) |
| Insight API calls | `Authorization: Bearer <access_token>` only |
| Build-time env | `NEXT_PUBLIC_FINLENS_API_URL` + Cognito public ids only |
| Forbidden | Long-lived `X-Api-Key` / `NEXT_PUBLIC_FINLENS_API_KEY` (or any mint secret) in the static bundle |

Compare and categories are read-only power tools — they do not mint keys, store secrets, or introduce new env vars. The static export remains secret-free; operators still paste minted keys into MCP clients out of band.

## Same Workspace truth as agents

Statement pickers are filled from `GET /v1/statements` (Workspace list). Compare requires two ids that resolve under the authenticated `tenantId`; a foreign or missing id returns not found without leaking which side failed. Category charts use the same breakdown source (`summary` vs `extract`) as MCP. Failed rows surface `error.message` and `error.nextStep` from the summary view so operators see the same actionable guidance agents get (`ANALYSIS_FAILED` → re-upload / idempotency reuse).

## Threat model notes (this phase)

### No long-lived secrets in the insight UI

CloudFront still serves immutable static assets. Insight features only call APIs with the short-lived Cognito Bearer. Minted API keys never enter Insights state or the build.

### UI cannot escalate beyond Workspace

Picker options and power-tool requests share auth resolution with REST/MCP. Cross-Workspace statement ids remain opaque failures. Ask (`POST …/ask`) stays agent/quota-gated and is out of scope for this console phase.

### Failed Analysis is actionable, not silent

When status is `failed`, the console shows structured `error` including `nextStep`. Operators are directed to re-upload rather than retry a dead Analysis id without guidance.

### Advisory numbers

Compare deltas and category bars inherit Analysis/extract labeling — advisory spending mix, not an audit ledger (same caveat as `phase-power-tools.md`).

## Verification

```bash
npm run build -w @finlens/web
# Confirm out/ has no FINLENS_API_KEY / flk_ secrets from env
```

Manual (signed-in Workspace with ≥2 ready Statements):

1. Insights → Compare → pick A/B → income/expense/net deltas match `curl`/`compare_statements`
2. Insights → Category breakdown → bars match `GET …/categories` (check `source`)
3. Open a failed Statement (or Insights failed panel) → `Next step:` visible
4. Sign out → insight fetches fail with not signed in / 401

## Out of scope

- Natural-language Ask UI (`POST …/ask` / #26 quota surface)
- Full production deploy / CloudFront cutover (#29)
- React Query / charting libraries (v1 uses local state + CSS bars)
