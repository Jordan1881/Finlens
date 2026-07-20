# Phase: Reactive control plane UI (#27)

## Scope

Ship a Cognito-authenticated static SPA (Next.js `output: "export"`) where Workspace members manage Statements, view light insights, mint/revoke API keys, and copy-paste Cursor MCP setup. Upload/list/delete/poll use the same REST Statement seam agents use (`Authorization: Bearer`), so the human console reflects Workspace truth.

## Auth and secrets

| Concern | Rule |
|---------|------|
| Browser session | Cognito Hosted UI + PKCE; access token in `sessionStorage` |
| API calls from UI | `Authorization: Bearer <access_token>` only |
| Agent / MCP auth | Operator-minted `X-Api-Key` pasted into Cursor (or similar) out of band |
| Build-time env | `NEXT_PUBLIC_FINLENS_API_URL` + Cognito public ids only |
| Forbidden | `NEXT_PUBLIC_FINLENS_API_KEY` or any long-lived API secret in the web bundle |

Minted plaintext keys appear only in the one-time UI reveal (and optionally in a config snippet the operator copies while that reveal is open). They are never written into `NEXT_PUBLIC_*`, source, or the static export.

## Same Workspace data as agents

Statements list/get/upload/delete hit `/v1/statements*` with the Cognito Bearer token. Auth resolves `tenantId` via Workspace membership (same as API-key callers). List supports `limit` / `nextToken` so the dashboard can page the same newest-first feed MCP `list_statements` sees. Insights for v1 are summary cards from ready Statements (deep compare/charts are #28).

## MCP setup helper

The MCP panel shows:

1. Endpoint URL derived from `NEXT_PUBLIC_FINLENS_API_URL` (`…/mcp`)
2. A Cursor `mcpServers` JSON template with a **placeholder** for `X-Api-Key`
3. Copy actions and instructions to mint a key under **API keys**, then paste it into the client config

The key is never baked into the build; the operator pastes it after mint.

## Threat model notes (this phase)

### No long-lived secrets in the static bundle

CloudFront serves immutable static assets. Anything in `NEXT_PUBLIC_*` is world-readable. Only non-secret Cognito client identifiers and the API base URL are embedded. Session tokens stay in `sessionStorage` for the browser tab session.

### Operator-held MCP keys

Agent credentials are Workspace-scoped hashes at rest (#21). The control plane’s job is to mint once and help the operator place the secret in their MCP client — not to persist or redistribute it via the web origin.

### UI cannot escalate beyond Workspace

All control-plane fetches use the same auth resolution as REST. Cross-Workspace Statement ids still return not found. API key mint/list/revoke remain Cognito owner-gated and reject `X-Api-Key`.

### Static export surface

No Next.js server routes or server-side secrets. Auth callback is a client page that exchanges the code at Cognito’s token endpoint. Failed or expired sessions force re-login (silent refresh is out of scope).

## Verification

```bash
npm run build -w @finlens/web
# Confirm out/ has no FINLENS_API_KEY string and no flk_ secrets from env
```

Manual (after deploy + Cognito callbacks):

1. Sign in → Dashboard / Statements show Workspace uploads
2. Upload PDF/CSV → list updates; poll until ready
3. Delete → row gone for both UI and `curl -H "X-Api-Key: …" …/v1/statements`
4. API keys → mint → copy → paste into MCP config from **MCP setup**
5. Revoke → MCP calls fail with `401`

## Out of scope

- Compare / charts insight console (#28)
- React Query (acceptable later; v1 uses local state + polling)
- Silent Cognito refresh-token renew
- Multi-member invite UX
