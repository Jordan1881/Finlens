# Step Functions wraps the analysis, even though it is a single task today

Analysis must be async (Bedrock on a PDF exceeds API Gateway's 30s limit), so upload decouples from analysis via S3 events. The pipeline runs inside a Step Functions state machine rather than a direct async Lambda invoke or SQS, as deliberate scaffolding: the pipeline is expected to grow into stages (parse → analyze → persist/notify), and Step Functions provides per-stage retries and an execution-history console when it does.

## Consequences

- Today the state machine has one task and no `addRetry`/`addCatch` — the README's "durable wrapper" phrasing overstates it until retry/catch are configured.
- Known simpler alternatives (async invoke, SQS + DLQ) were rejected to avoid re-platforming the pipeline when stages are added.
