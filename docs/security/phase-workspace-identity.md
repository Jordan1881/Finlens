# Phase: Workspace identity + Cognito web session

## Scope

Humans authenticate to the web control plane with Cognito Hosted UI (authorization code + PKCE). Access tokens are stored in `sessionStorage` (not a long-lived `NEXT_PUBLIC` API key). First Cognito login auto-creates a personal **Workspace**; subsequent REST/MCP Cognito calls resolve `tenantId` = that Workspace id via membership. MCP/agent API-key auth remains supported and unchanged in shape (`X-Api-Key` → `tenantId`).

## Data model (single table)

`WorkspacesTable` uses a single-table design:

| pk | sk | entity | purpose |
|----|----|--------|---------|
| `USER#<cognitoSub>` | `MEMBERSHIP` | membership | Cognito user → `workspaceId` (+ role) |
| `WORKSPACE#<workspaceId>` | `META` | workspace | Workspace record (`name`, `ownerSub`, `createdAt`) |

Create path is an atomic `TransactWrite` (membership + meta) with `attribute_not_exists(pk)`; concurrent first-login races re-read membership.

**Hooks (not implemented here):**

- `#23` quotas — see `docs/security/phase-quotas.md` (daily counters + concurrent `processing`)
- Multi-member invites — add `WORKSPACE#<id>` / `MEMBER#<sub>` rows without changing Statement keys

API key mint/revoke for Workspace owners is `#21` — see `docs/security/phase-api-keys.md`.
Control plane UI (Statements, keys, MCP setup) is `#27` — see `docs/security/phase-control-plane-ui.md`.

## Threat model notes (this phase)

### No public API key in the web bundle

`NEXT_PUBLIC_FINLENS_API_KEY` is removed. Browser builds may only embed non-secret Cognito identifiers (`NEXT_PUBLIC_COGNITO_*`) and the API URL. Tokens live in memory/`sessionStorage` for the browser session.

### Workspace isolation

Statements remain keyed `(tenantId, statementId)` where `tenantId` is the Workspace id. Cognito callers never use `sub` as `tenantId` after this phase — membership maps `sub` → `workspaceId` first. Cross-Workspace Statement access still returns **not found** (see statement seam security note), not a cross-tenant leak.

### Authz denial shape

Invalid/missing Bearer or API key → `401 UNAUTHORIZED`. Wrong Workspace / unknown statementId → `404` (existence not confirmed across Workspaces).

### Cognito app client callbacks

Operators must register Allowed callback / sign-out URLs on the Cognito app client for:

- `http://localhost:3000/auth/callback` and `http://localhost:3000/` (local)
- `https://<CloudFront domain>/auth/callback` and `https://<CloudFront domain>/` (deployed web)

The same public client id used for MCP OAuth PKCE is reused for the SPA (no client secret in the browser).

## Verification

```bash
npm test -w @finlens/api
# includes workspace-service tests (create, idempotent resolve, race, isolation)
```

Manual web login (after deploy + Cognito callback URLs):

1. Open CloudFront `WebUrl` or `npm run dev -w @finlens/web` with Cognito env set
2. Sign in → first API call creates personal Workspace
3. Upload/list statements; confirm MCP still works with `X-Api-Key`

## Out of scope

- Quotas (`#23`)
- Refresh-token silent renew (re-login when access token expires)
- Prod CORS lock already present; browser still needs valid Cognito token
