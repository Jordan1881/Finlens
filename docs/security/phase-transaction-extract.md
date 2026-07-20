# Phase: Transaction extract on analyze

Security controls and residual risks for persisting a structured transaction extract when Analysis completes (GitHub #24). Ask/compare tools (#26) are out of scope for this phase.

## What this phase covers

| Control | Implementation |
|---------|----------------|
| Workspace scope | Extract is attached to the Statement row keyed `(tenantId, statementId)`, or written to S3 under `statements/{tenantId}/{statementId}.extract.json`. Same tenant prefix and seam authz as the source PDF/CSV. |
| Statement data controls | Extract inherits Statement lifecycle: delete removes the inline field (via row delete) and any overflow S3 object; 90-day `expiresAt` is written on Analysis completion (same horizon as create); S3 objects remain under the statements bucket (KMS + lifecycle from #19). |
| API surface minimization | `detail=summary` never returns the full extract. `detail=full` returns hydrated `transactionExtract` (or `transactionExtractS3Key` if hydration cannot load the object). |
| Size safety | Prefer DynamoDB inline storage up to a modest byte cap; overflow to tenant-prefixed S3 so Statement items stay under DynamoDB’s 400KB limit. |

## Threat model notes

### Extract is Statement-private data

Line items (payees, amounts, dates) are as sensitive as the source statement. Do not expose extract via list endpoints, logs, or metrics. Analyze failure logs continue to omit payload content.

### No cross-tenant pointer abuse

Overflow keys always include `tenantId` from the authenticated Analysis input / Statement key. Get/delete go through the Statement seam with `tenantId` in the DynamoDB key; a guessed `statementId` from another Workspace still yields not found.

### Model output trust boundary

The extract is model-produced structured data, not a verified ledger. Downstream tools must treat categories/types as advisory. Malformed model rows are dropped during normalize; Analysis can still reach `ready` with an empty `transactions` array.

## Explicit follow-ups (out of scope)

- Ask / compare / category tools that *consume* the extract (#26)
- Redacting merchant PII from extracts for export
- Separate KMS key or retention for extract objects vs source files

## Residual risks

- Large statements may truncate in the model response (`maxTokens`); extract may be incomplete while totals still look coherent.
- If an overflow S3 object is missing but the pointer remains, full detail returns the pointer without line items until re-analysis.
- Rows analyzed before this phase have no extract; clients must tolerate absence.
