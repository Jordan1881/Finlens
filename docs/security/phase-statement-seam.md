# Phase: Unify Statement seam (REST + MCP)

## Scope

REST handlers and the MCP server share one Statement application seam (`apps/api/src/lib/statement-service.ts`) for list, get (summary/full), direct upload, and delete. Presigned create uses the same pending-record builder and `putPendingStatement` helper. HTTP/MCP adapters stay thin: auth + transport mapping only.

## Threat model notes (this phase)

### Tenant isolation is key-based

Statement rows are keyed `(tenantId, statementId)`. Seam reads and deletes always include the authenticated Workspace `tenantId` in the DynamoDB key. A caller who knows another Workspace’s `statementId` still gets **not found** (`null` → HTTP 404 / MCP error), not a cross-tenant hit. Surfaces must not add alternate lookup paths (e.g. statementId-only GSI) without an explicit security review.

### Surfaces must not invent private Statement state

REST and MCP must not maintain their own Statement status machines, caches of analysis results, or parallel “shadow” records. All lifecycle transitions for create/list/get/delete go through the seam (and downstream analysis pipeline for status updates). Drift between MCP and REST was the failure mode this phase removes.

### Authz denial shape

Cross-tenant and missing resources are indistinguishable at the API: both return not found. Do not return 403 with “wrong tenant” messaging — that would confirm existence across Workspaces.

### Out of scope (later phases)

- Power-tool / elevated agent capabilities beyond compare/categories/ask (see `phase-power-tools.md`)

## Verification

Seam tests (`apps/api/src/lib/statement-service.test.ts`) cover lifecycle view mapping and tenant-isolation denials with injected fake DDB/S3 clients (no live AWS).

```bash
npm test -w @finlens/api
```
