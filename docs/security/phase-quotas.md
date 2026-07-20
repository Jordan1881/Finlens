# Phase: Per-Workspace quotas

## Scope

Hard per-Workspace cost bounds so runaway agents cannot burn Bedrock budget unnoticed:

| Limit | Default | Counter / source of truth |
|-------|---------|---------------------------|
| Uploads / UTC day | **20** | DynamoDB `WorkspacesTable` item `WORKSPACE#<id>` / `QUOTA#uploads#YYYY-MM-DD` (`count`, TTL `expiresAt`) |
| Asks / UTC day | **100** | Same table, `QUOTA#asks#YYYY-MM-DD` (enforced by `ask_statement` / `POST .../ask` via `consumeAskQuota`) |
| Concurrent Analyses | **2** | Count of Statements with `status = processing` for that Workspace |

Optional overrides: Workspace `META.quotas` (`uploadsPerDay`, `asksPerDay`, `concurrentAnalyses`) and env `QUOTA_UPLOADS_PER_DAY` / `QUOTA_ASKS_PER_DAY` / `QUOTA_CONCURRENT_ANALYSES`.

Enforcement lives in `apps/api/src/lib/quota-service.ts`. Upload paths (REST direct + presigned create, MCP `upload_statement` via the Statement seam) call `enforceUploadQuotas` before creating a pending Statement. Analysis start (`on-s3-upload`) re-checks concurrent capacity before flipping to `processing` / starting Step Functions; over-quota marks the Statement `failed` with an agent-readable message (no Bedrock invoke).

## Threat model notes (this phase)

### Quotas are a cost control, not authz

Passing a quota check does not grant cross-Workspace access. Isolation remains `(tenantId, statementId)` keying. Quota counters are partitioned by `workspaceId` (= `tenantId`); a caller cannot increment or read another Workspace’s counters without already being authenticated as that Workspace.

### Denial shape is agent-readable

Over-quota returns **HTTP 429** on REST with `{ error: { code, message, retryable, nextStep } }` (`tooManyRequests` in `http.ts`). MCP surfaces the same `StructuredError` object inside the tool error payload (no separate HTTP status on Streamable HTTP tool results). Codes:

- `QUOTA_UPLOADS_EXCEEDED`
- `QUOTA_ASKS_EXCEEDED`
- `QUOTA_CONCURRENT_ANALYSES_EXCEEDED`

`retryable: true` — agents should wait (next UTC day, or until processing Analyses finish).

### Concurrent race window

Concurrent capacity is derived from live `processing` rows (Query + filter). Two near-simultaneous S3 events can both observe `count < limit` before either writes `processing`. Upload-time checks reduce agent retries; analysis-start checks are the Bedrock backstop. Acceptable for v1 defaults (~2); tighten with a conditional counter lease if abuse appears.

### Daily counters are atomic

Upload/ask increments use DynamoDB `UpdateItem` `ADD` with `ConditionExpression` so the limit cannot be exceeded under concurrency. Failed conditional checks map to 429, not 5xx.

### Do not bypass on misconfiguration

If `WORKSPACES_TABLE` / `STATEMENTS_TABLE` are missing, handlers fail closed (500 / throw) rather than silently skipping quotas.

## Verification

```bash
npm test -w @finlens/api
# quota-service.test.ts + Statement seam quota denials in statement-service.test.ts
```

## Out of scope

- Paid tiers / billing (#16)
- Per-key quotas (limits are Workspace-scoped)
- Perfect serialization of concurrent Analysis starts
