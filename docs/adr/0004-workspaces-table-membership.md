# WorkspacesTable single-table keys for Cognito membership

Workspace identity is stored in one DynamoDB table (`WorkspacesTable`) so Cognito `sub` → Workspace resolution is a single `GetItem`, and first-login create can be an atomic transaction without a second table join.

Keys:

- `USER#<cognitoSub>` / `MEMBERSHIP` — membership (`workspaceId`, `role`)
- `WORKSPACE#<workspaceId>` / `META` — Workspace record

`tenantId` on Statements and API keys remains the Workspace id (`workspaceId`). Cognito JWTs are never used directly as `tenantId` after membership resolution.

## Status

accepted

## Consequences

- Extending to multi-member Workspaces adds `WORKSPACE#<id>` / `MEMBER#<sub>` items without migrating Statement rows.
- Quotas (#23) and key-mint (#21) attach to `workspaceId` / META; they do not require a new partition scheme.
- Existing API keys that already store a `tenantId` continue to work; minting new keys should use Workspace ids.
