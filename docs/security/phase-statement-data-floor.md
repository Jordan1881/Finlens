# Phase: Statement data floor

Security controls shipped for Finlens statement storage and ops visibility (GitHub #19).

## What this phase covers

| Control | Implementation |
|---------|----------------|
| Encryption at rest | Customer-managed KMS key (`StatementsKey`, alias `finlens-{stage}-statements`) with SSE-KMS on `StatementsBucket`. Bucket keys enabled to reduce KMS request cost. Analyze/upload Lambdas receive encrypt/decrypt via CDK `grantPut` / `grantRead`. |
| Access logging | Dedicated `StatementsAccessLogsBucket` receives S3 server access logs for statement objects (`statements-access/` prefix). This is the audit path for object-level access; CloudTrail data events for S3 are a follow-up if deeper API-level audit is required. |
| 90-day retention | S3 lifecycle rule expires statement objects after 90 days. DynamoDB `StatementsTable` TTL attribute `expiresAt` (epoch seconds) is enabled on the table. Application writes of `expiresAt` on create are set in `putPendingStatement` (statement data-access seam on this branch) to the same 90-day horizon so metadata does not outlive objects indefinitely. |
| Ops alerting | SNS topic `finlens-{stage}-ops-alerts` receives CloudWatch alarm actions for pipeline failures and OnS3Upload DLQ depth. Optional CDK context `opsAlertEmail` adds an email subscription (must be confirmed in the inbox after deploy). |

## Deploy notes

```bash
# Email alerts (subscription pending until confirmed)
npx cdk deploy FinlensDevStack -c opsAlertEmail=ops@example.com --profile finlens
```

Omitting `opsAlertEmail` still creates the topic and wires alarms; subscribe later via console/CLI and confirm the email.

## Explicit follow-ups (out of scope)

- **Auth-failure alarm:** `UNAUTHORIZED` is returned in HTTP JSON bodies but is not reliably present as a CloudWatch Logs line today. A cheap metric filter would need a dedicated log line (or API Gateway access-log metric) first — deferred.
- **CloudTrail data events** for S3/KMS: server access logs cover object access patterns; data-event trails add cost and are not enabled in this phase.
- **Backfill `expiresAt`:** Rows created before this change have no TTL attribute and will not auto-expire until updated or deleted.
- **KMS key policy tightening:** Default key policy + Lambda grants are sufficient for this phase; least-privilege key policy refinement can wait until prod hardening.

## Residual risks

- Existing objects encrypted with SSE-S3 before deploy remain readable; new default is SSE-KMS. Re-encrypt-in-place is not performed.
- SNS email is best-effort until the subscription is confirmed; silent drop of alerts is possible if unconfirmed.
- S3 lifecycle and DynamoDB TTL are eventually consistent; deletion may lag the 90-day mark by hours.
