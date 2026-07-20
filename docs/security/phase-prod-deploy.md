# Security note — phase: Prod stack deploy

**Ticket:** #29 (parent PRD #16)  
**Status:** stack hardened + deploy gate on `feat/production-upgrade` (live AWS deploy is an operator step)

## What this phase protects

Production (`FinlensProdStack`, `stage: "prod"`) is treated as a separate hard environment from dev:

1. **No shared `DEV_API_KEY`** — Lambda env for prod never receives the context `devApiKey` shortcut. Auth is Cognito Bearer (web) or per-Workspace hashed API keys (`X-Api-Key`). Synth-time assertion fails closed if `DEV_API_KEY` appears in the prod env map.
2. **CORS locked to CloudFront** — HTTP API `corsPreflight.allowOrigins` is only `https://<WebDistributionDomain>` for prod (dev remains `*` for local/agent experimentation).
3. **Deploy gate** — `npm run deploy:prod` (infra) runs `infra/scripts/check-prod-prereqs.mjs` first and **exits non-zero** unless prerequisite security docs and source invariants hold. Optional `--verify-synth` inspects `cdk.out` for `DEV_API_KEY` / wildcard CORS.

## Prerequisite gate (blocked until green)

| Ticket | Doc | Control |
|--------|-----|---------|
| #18 | `phase-ci-gate.md`, `ci-gate.md` | Secrets + dependency audit floor |
| #19 | `phase-statement-data-floor.md` | KMS, access logs, 90-day retention, SNS alarms |
| #20 | `phase-workspace-identity.md` | Cognito web session; no public API key in web bundle |
| #21 | `phase-api-keys.md` | Per-Workspace mint/revoke (hashed) |
| #23 | `phase-quotas.md` | Upload/ask/concurrent Analysis bounds |
| #29 | `phase-prod-deploy.md` (this file) | Prod path + deploy gate |

## Deploy checklist (operator)

Do **not** treat synth success as “prod is live.” Actual `cdk deploy FinlensProdStack` needs an approved AWS profile and explicit operator intent.

```bash
# 1) Gate (docs + source invariants)
cd infra && npm run check:prod

# 2) Synth prod only (no AWS mutation)
npx cdk synth FinlensProdStack
npm run check:prod -- --verify-synth

# 3) Build web with prod Cognito + API placeholders, then deploy
#    Pass opsAlertEmail so SNS can notify on pipeline/DLQ alarms (#19).
#    After first deploy, register Cognito callback/sign-out URLs for the prod WebUrl.
npx cdk deploy FinlensProdStack \
  -c opsAlertEmail=ops@example.com \
  --profile <prod-capable-profile>
```

Post-deploy Cognito (same pool as context today unless you split pools later):

- `https://<prod-WebUrl>/auth/callback` and `https://<prod-WebUrl>/` as Allowed callback / sign-out URLs
- Confirm SNS email subscription for `opsAlertEmail`

Root convenience: `npm run cdk:deploy:prod` → runs the same gated infra script.

## Residual risk (out of scope for this phase)

- **No live deploy in CI** — the gate blocks *unsafe* deploys; it does not prove the account contains a healthy prod stack. First prod cutover still needs human approval and smoke tests.
- **Shared Cognito context** — `cdk.json` currently points both stacks at the same user pool/client. Callback URL sprawl and cross-env user confusion remain until a dedicated prod pool (or app client) is introduced.
- **CORS is browser-only** — locking origins does not stop non-browser clients (MCP/curl) with a stolen API key; key revoke + quotas remain the primary agent controls.
- **Retain-on-delete** — prod resources use `RemovalPolicy.RETAIN`; accidental stack delete still leaves data/buckets that must be cleaned up deliberately.
- **Bedrock / prompt injection / tenant logic bugs** — unchanged; covered by earlier phases and ongoing review, not by this deploy gate.

## Policy summary

| Control | Fail when |
| --- | --- |
| Prereq security docs | Any required `docs/security/phase-*.md` missing |
| `DEV_API_KEY` in prod | Present in Lambda env map or synth template |
| Prod CORS | Wildcard `*` or not bound to CloudFront domain |
| `deploy:prod` | Gate script exits non-zero before `cdk deploy` |
