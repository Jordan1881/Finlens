# DynamoDB with Workspace isolation in the primary key

Statements live in DynamoDB keyed `(tenantId, statementId)`, where `tenantId` is the Workspace id. DynamoDB over Postgres because every access pattern is a key lookup ("Statements for Workspace", "one Statement") and the serverless stack avoids connection pooling; pay-per-request fits scale-to-zero. Workspace isolation is enforced by the partition key itself, not by application-level filtering after a cross-tenant query.

API keys are stored separately as SHA-256 hashes in `ApiKeysTable` (`keyHash` → `tenantId`, plus `keyId` / `status` / `prefix`; GSI `byTenant` for list/revoke). Plaintext keys are never persisted. The shared dev shortcut (`DEV_API_KEY`) is compared with a timing-safe equality check. Cognito users resolve to a Workspace via `WorkspacesTable` (see ADR 0004); `tenantId` is always the Workspace id. See `docs/security/phase-api-keys.md`.

## Status

accepted

## Consequences

- Single-Statement reads use `GetItem` on `(tenantId, statementId)`. The `byStatementId` GSI was removed: every caller already has `tenantId`, and the GSI caused eventual-consistency 404s after create while moving Workspace isolation into an app-level `if` check.
- Ad-hoc relational queries (search, cross-Workspace analytics) are deliberately out of scope; adding them later means adding a projection, not bending this table.
