# Bedrock over the direct Anthropic API

Statement analysis calls Claude through Amazon Bedrock rather than the Anthropic API. Two reasons: (1) auth is the Lambda's IAM role — no Anthropic API key to store, rotate, or leak, and no Secrets Manager wiring; (2) data residency — statement bytes are bank data and never leave the AWS account or `eu-west-1`.

## Consequences

- Model availability lags the direct API and the invoke interface is clunkier; `bedrockModelId` is injected via CDK context to keep model upgrades a config change.
- Swapping to the direct API later would touch the analyze Lambda and secret management, not the pipeline shape.
