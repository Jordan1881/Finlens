# Phase: Harden core MCP/REST tools (#25)

## Scope

Production-grade consistency for the four Statement tools across MCP and REST: **upload**, **get** (`summary`|`full`), **list** (pagination, status filter, accurate `sourceFormat`), and **delete**. Builds on the shared Statement seam (#22), Workspace identity (#20), API keys (#21), and quotas (#23).

## Threat model notes (this phase)

### List cursor must stay Workspace-bound

List pagination uses DynamoDB `ExclusiveStartKey` encoded as an opaque `nextToken`. Decoded cursors are rejected unless `tenantId` matches the authenticated Workspace. Do not accept raw DynamoDB keys from clients without this check — a crafted cursor must not become a cross-tenant read.

### Newest-first GSI keeps partition isolation

`byTenantCreatedAt` (PK `tenantId`, SK `createdAt`) exists only to order list results by time. The partition key remains the Workspace id, so isolation stays key-based. This is intentionally unlike the removed `byStatementId` GSI (ADR 0003), which broke isolation into an app-level filter.

### Upload idempotency is tenant-scoped and time-bounded

Content SHA-256 and optional `Idempotency-Key` / `idempotency_key` reuse an existing Statement only when found under the **same** `tenantId` within a **24h** window (newest-first GSI scan). Replays do not re-charge upload quota and do not write a second S3 object. Analysis start remains idempotent via Step Functions `ExecutionAlreadyExists` (`on-s3-upload`).

### Authz and quota still gate every write

Upload (and list/get/delete) resolve `tenantId` via API key or Cognito Workspace membership before any seam call. Direct upload still runs `enforceUploadQuotas` before creating a **new** Statement; idempotent replays skip quota consumption. Cross-tenant get/delete continue to return not found (no existence leak).

### Detail levels and extract

`detail=full` may hydrate `transactionExtract` from S3; `summary` never returns extract. Agents and REST clients should default to summary to limit sensitive line-item exposure.

### Structured errors

Seam and adapters return `{ code, message, retryable, nextStep }` on validation, quota, cursor, and auth failures. Failed analysis surfaces the same structured `error` on both summary and full get. Prefer actionable `nextStep` over opaque messages.

## Out of scope

- Ask / compare tools (#26)
- Changing Statement primary key design (still `tenantId` + `statementId`)

## Verification

```bash
npm test -w @finlens/api
```

Seam tests cover pagination cursors, status filter, content-hash / Idempotency-Key replay, and tenant isolation with injected DDB/S3 fakes.
