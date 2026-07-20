# DynamoDB with tenant isolation in the primary key

Statements live in DynamoDB keyed `(tenantId, statementId)`. DynamoDB over Postgres because every access pattern is a key lookup ("statements for tenant", "one statement") and the serverless stack avoids connection pooling; pay-per-request fits scale-to-zero. Tenant isolation is meant to be enforced by the partition key itself, not by application-level filtering.

## Status

accepted — with a known deviation to fix

## Consequences

- The `byStatementId` GSI turned out to be a leftover: every caller already has `tenantId`, so single-statement reads should be `GetItem` on the primary key. The GSI adds cost, eventual-consistency 404s after create, and moves tenant isolation into an app-level `if` check. Decision: remove the GSI and switch reads to `GetItem`.
- Ad-hoc relational queries (search, cross-tenant analytics) are deliberately out of scope; adding them later means adding a projection, not bending this table.
