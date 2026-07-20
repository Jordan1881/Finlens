# DynamoDB with Workspace isolation in the primary key

Statements live in DynamoDB keyed `(tenantId, statementId)`, where `tenantId` is the Workspace id. DynamoDB over Postgres because every access pattern is a key lookup ("Statements for Workspace", "one Statement") and the serverless stack avoids connection pooling; pay-per-request fits scale-to-zero. Workspace isolation is enforced by the partition key itself, not by application-level filtering after a cross-tenant query.

API keys are stored separately as SHA-256 hashes in `ApiKeysTable` (`keyHash` → `tenantId`); plaintext keys are never persisted.

## Status

accepted

## Consequences

- Single-Statement reads use `GetItem` on `(tenantId, statementId)`. The `byStatementId` GSI was removed: every caller already has `tenantId`, and the GSI caused eventual-consistency 404s after create while moving Workspace isolation into an app-level `if` check.
- Ad-hoc relational queries (search, cross-Workspace analytics) are deliberately out of scope; adding them later means adding a projection, not bending this table.
