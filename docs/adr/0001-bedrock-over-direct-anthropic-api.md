# Bedrock over the direct Anthropic API

Statement analysis calls Claude through Amazon Bedrock rather than the Anthropic API. Two reasons: (1) auth is the Lambda's IAM role — no Anthropic API key to store, rotate, or leak, and no Secrets Manager wiring; (2) data residency — statement bytes are bank data and never leave the AWS account or `eu-west-1`.

## Status

accepted

## Consequences

- Model availability lags the direct API and the invoke interface is clunkier; `bedrockModelId` (PDF) and optional `bedrockModelIdCsv` are injected via CDK context so model upgrades stay a config change. CSVs use a cheaper text model when configured.
- Swapping to the direct API later would touch the analyze Lambda and secret management, not the pipeline shape.
