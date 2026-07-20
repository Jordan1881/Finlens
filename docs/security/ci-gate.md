# CI security gate — interpret and remediate

CI (`.github/workflows/ci.yml`) runs three jobs on every pull request and on pushes to `main`. The **secret scan** and **dependency audit** jobs are the security gate: either failing blocks merge until fixed.

| Job | What it does | Fail policy |
| --- | --- | --- |
| `secret-scan` | [Gitleaks](https://github.com/gitleaks/gitleaks-action) scans the git history for hardcoded secrets | Any finding fails the job |
| `dependency-audit` | `node scripts/ci-dependency-audit.mjs` after `npm ci` | **High** or **critical** advisories fail, except documented GHSA allowlist entries |
| `cdk-synth` | Existing infra compile check | Synth errors fail (unchanged) |

## Secret scan failures

1. Open the failing `Secret scan (gitleaks)` job log and note the rule id, file, and commit.
2. **Treat the secret as compromised.** Rotate or revoke it in the provider (API key, token, password) before anything else.
3. Remove the secret from the working tree (use env vars / Secrets Manager / GitHub Actions secrets). Never “fix” by deleting only the latest commit if the value remains in history.
4. If the leak is already in git history, rewrite or purge that history (e.g. `git filter-repo`) **and** rotate — removal from `HEAD` alone is not enough.
5. False positives: add a narrowly scoped allowlist entry in a root `gitleaks.toml` (document why), or refactor the fixture so it is clearly not a live credential.

Local check (requires [gitleaks](https://github.com/gitleaks/gitleaks) installed):

```bash
gitleaks detect --source . --verbose
```

## Dependency audit failures

1. Run locally from the repo root:

   ```bash
   npm ci
   npm audit --audit-level=high
   ```

2. Read each high/critical advisory: affected package, fix version, and whether the path is reachable in Finlens (web app, API, CDK, transitive).
3. Prefer `npm audit fix` when the fix is non-breaking. For major bumps, upgrade in a dedicated PR and re-run tests / `npm run cdk:synth`.
4. Do **not** silence high/critical by deleting the job or lowering `--audit-level`. Temporary acceptances go in `scripts/ci-dependency-audit.mjs` **ALLOWLIST** (GHSA id + reason) and must be mentioned here.

Local check (matches CI):

```bash
npm ci
node scripts/ci-dependency-audit.mjs
```

### Current allowlist

| GHSA | Package | Why allowed |
|------|---------|-------------|
| `GHSA-3jxr-9vmj-r5cp` | `brace-expansion` (bundled in `aws-cdk-lib`) | CDK ships it `inBundle`; npm overrides cannot replace it. Synth/deploy-only; revisit when CDK republishes ≥5.0.7 |

Moderate and low findings still appear in `npm audit` output; they are informational until the fail level is tightened later.

## Related

- Phase security note: [phase-ci-gate.md](./phase-ci-gate.md)
