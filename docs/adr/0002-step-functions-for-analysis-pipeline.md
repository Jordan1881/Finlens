# Step Functions wraps the analysis pipeline

Analysis must be async (Bedrock on a PDF exceeds API Gateway's 30s limit), so upload decouples from analysis via S3 events. The pipeline runs inside a Step Functions state machine rather than a direct async Lambda invoke or SQS, as deliberate scaffolding: the pipeline is expected to grow into stages (parse → analyze → persist/notify), and Step Functions provides per-stage retries and an execution-history console when it does.

## Status

accepted

## Consequences

- The analyze task retries transient Bedrock/Lambda errors (`ThrottlingException`, `ServiceUnavailableException`, `InternalServerException`, `ModelTimeoutException`, `Lambda.TooManyRequestsException`) up to 3 times with exponential backoff, on top of LambdaInvoke's built-in service-error retries.
- On unrecoverable failure, a Catch path updates the Statement row to `failed` with `errorMessage` before Fail. AnalyzeStatement rethrows instead of marking failed itself so retryable errors stay retryable.
- Pipeline timeout is 20 minutes to cover multiple analyze attempts (5 min Lambda timeout each) plus backoff.
- OnS3Upload names each execution after `statementId` so duplicate S3 events are no-ops (`ExecutionAlreadyExists`). Async invoke failures land in an SQS DLQ with a CloudWatch alarm; pipeline Failures have a separate alarm.
- Known simpler alternatives (async invoke alone, SQS + DLQ only) were rejected to avoid re-platforming when stages are added.
