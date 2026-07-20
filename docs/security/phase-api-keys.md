# Phase: Per-workspace API keys (mint / revoke)

## Scope

Workspace owners mint agent/MCP API keys from the web control plane (or `POST /v1/api-keys` with a Cognito Bearer token). Plaintext is shown **once** at mint time. Only the SHA-256 hash is stored in `ApiKeysTable`, keyed by `keyHash`, with `tenantId` = Workspace id. Revoking sets `status=revoked`; verification fails immediately. The web SPA never embeds a long-lived API key in env or the bundle.

## Data model

`ApiKeysTable`:

| Attribute | Role |
|-----------|------|
| `keyHash` (PK) | SHA-256 hex of plaintext |
| `keyId` | Opaque id for revoke / list (`key_…`) |
| `tenantId` | Workspace id |
| `createdAt` | ISO timestamp |
| `status` | `active` \| `revoked` |
| `prefix` | Non-secret display prefix (`flk_…` first 12 chars) |

GSI `byTenant`: `tenantId` (PK) + `keyId` (SK) for Workspace-scoped list/revoke.

Legacy rows without `status` / `keyId` still authenticate if present (CLI pre-`#21`); they are not listed via the GSI until reminted.

## Auth flows

| Client | Credential | Resolves to |
|--------|------------|-------------|
| Web control plane | Cognito `Authorization: Bearer` | Workspace via membership; mint/list/revoke require **owner** |
| MCP / agents / curl | `X-Api-Key: flk_…` | `tenantId` from hashed lookup (active only) |
| Dev shortcut | `DEV_API_KEY` (timing-safe compare) | tenant `dev` |

Mint/list/revoke endpoints **do not** accept `X-Api-Key` — keys cannot mint more keys.

## Threat model notes (this phase)

### Plaintext never stored

Hash-at-rest only. Logs and list APIs must not echo the secret. UI shows the secret in a one-time reveal; operators copy it into MCP config out of band.

### Timing-safe verification

`DEV_API_KEY` uses constant-time string equality. Table keys are looked up by preimage-resistant SHA-256 hash (no online string compare of secrets). Revoked keys return the same auth failure shape as unknown keys (`null` → `401`).

### Workspace isolation

Auth always binds the caller to one Workspace `tenantId`. Revoke is conditioned on `(tenantId, keyId)` so a caller cannot revoke another Workspace’s key by guessing `keyId`. Cross-Workspace revoke returns not found.

### Immediate invalidation

Soft-revoke (`status=revoked`) keeps audit metadata in list views while `resolveTenantIdForApiKey` rejects the hash on the next request (no cache of API keys in Lambdas).

### No public API key in the web bundle

Unchanged from workspace-identity: browser builds use Cognito PKCE only. Minted secrets are operator-held for MCP/agents.

## REST surface

```http
POST   /v1/api-keys              Authorization: Bearer <cognito>
GET    /v1/api-keys              Authorization: Bearer <cognito>
DELETE /v1/api-keys/{keyId}      Authorization: Bearer <cognito>
```

`POST` response includes `apiKey` (plaintext) once. `GET` returns metadata only (`keyId`, `prefix`, `status`, `createdAt`, `tenantId`).

## Verification

```bash
npm test -w @finlens/api
# includes api-key-service tests (mint, list isolation, revoke denial, auth denial)
```

Manual (after deploy):

1. Sign in to the web UI → **API keys** → Mint key → copy secret
2. `curl -H "X-Api-Key: $KEY" "$API_URL/v1/statements"`
3. Revoke in UI → same curl returns `401`

## Out of scope

- Key rotation / expiry policies
- Per-key scopes / least-privilege tool grants
- Multi-member invite UX (`#20` hooks only)
- Quotas (`#23`)
