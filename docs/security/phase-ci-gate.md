# Security note — phase: CI security gate

**Ticket:** #18 (parent PRD #16)  
**Status:** implemented on `feat/production-upgrade`

## What this gate protects

This phase adds an automated **merge-blocking** floor on pull requests and `main`:

1. **Secret scanning (Gitleaks)** — reduces the chance that API keys, tokens, or passwords land in the default branch history via a PR. Catches many accidental commits of `.env` values, cloud credentials, and common token formats before merge.
2. **Dependency audit (`npm audit --audit-level=high`)** — fails the build when the lockfile graph contains **high** or **critical** npm advisories, so known severe supply-chain issues cannot merge unnoticed.

Together with existing `cdk synth`, agents and humans get a consistent security floor before code merges.

## Residual risk (out of scope for this gate)

- **Moderate/low npm advisories** do not fail CI; they can still be exploitable in context.
- **Unreachable or mis-scored advisories** — `npm audit` is advisory metadata, not a runtime exploit proof; false confidence and false positives both occur.
- **Secrets already in history** before the gate, or introduced outside PRs (force-push to unprotected refs, compromised maintainer machine).
- **Non-npm ecosystems** and binary/vendor artifacts not covered by `npm audit`.
- **Logic bugs, IAM misconfig, tenant isolation, Bedrock prompt injection** — not scanned here; later tickets (e.g. auth hardening, runtime controls) address those.
- **Gitleaks rule coverage** — novel or obfuscated secrets may evade detection; rotation and least-privilege credentials remain required.

## Policy summary

| Control | Fail when |
| --- | --- |
| Gitleaks | Any finding |
| `npm audit` | Severity ≥ high |

Remediation runbook: [ci-gate.md](./ci-gate.md).
