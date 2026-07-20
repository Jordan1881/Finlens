# Phase: Agent power tools (#26)

## Scope

Read-only agent tools on the Statement seam for Workspace members:

| Tool / REST | Behavior |
|-------------|----------|
| `compare_statements` / `POST /v1/statements/compare` | Diff income, expenses, net, and categories for two ready `statementId`s |
| `get_category_breakdown` / `GET /v1/statements/{id}/categories` | Spending mix from extract rollup when present, else `financialSummary.topCategories` |
| `ask_statement` / `POST /v1/statements/{id}/ask` | Natural-language Q&A starting from summary + insights; hydrates `transactionExtract` when the question needs line items; consumes daily ask quota |

Tool **names stay stable** as extracts improve — richer category/compare/ask context is an implementation detail (`source` / `contextUsed` fields), not a new MCP surface.

## Threat model notes (this phase)

### Cross-Workspace access is key-based denial

All power tools load Statements via the seam with `(tenantId, statementId)` where `tenantId` is the authenticated Workspace. A guessed foreign `statementId` returns **not found** (MCP tool error / HTTP 404) — same shape as core get/delete. Compare requires **both** ids under the caller’s Workspace; one miss fails the whole call without revealing which id was foreign.

### Ask is a cost surface — quota before Bedrock

`ask_statement` calls `consumeAskQuota` after validating the Statement is ready, then invokes Bedrock with a capped context (summary always; extract truncated when needed). Over-quota returns `QUOTA_ASKS_EXCEEDED` (HTTP 429 / MCP structured error). Failed model calls after quota consume still count (cost control preferred over refunds). Compare and category breakdown are pure reads — no ask quota.

### Extract stays off the default path

Category and compare prefer extract only when already stored (inline or hydrated from the tenant-prefixed S3 key). Ask attaches extract only for line-item-style questions (`questionLikelyNeedsExtract`). Agents should still default `get_statement` to `detail=summary`; power tools avoid dumping full extracts unless needed.

### Model output is advisory

Ask answers and category labels are model- or Analysis-derived, not a verified ledger. Do not treat them as audit-grade bookkeeping. Prompts instruct the model to refuse invention when context is insufficient.

### Adapters stay thin

REST and MCP only resolve auth (`tenantId`) and map transport. Comparison, category rollup, ask orchestration, and quota live in `statement-power-tools.ts` / `quota-service.ts` so Surfaces cannot drift.

## Out of scope

- Insight charts / compare UI (#28)
- Changing MCP tool names when extract quality improves
- Per-API-key ask quotas (limits remain Workspace-scoped)

## Verification

```bash
npm test -w @finlens/api
# statement-power-tools.test.ts — compare/categories fixtures, cross-tenant denials, mocked Bedrock ask + quota
```
