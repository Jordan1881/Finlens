# Finlens

Remote MCP product for bank statement analysis on AWS. MCP-first by design: the agent-accessible tool surface is the product; REST is the substrate underneath and the web dashboard is a human-facing demo of the same pipeline.

## Language

**Statement**:
One uploaded bank statement file (PDF or CSV, Hebrew or English) and its lifecycle record.
_Avoid_: document, file, upload

**Workspace**:
The isolation unit that owns Statements and API keys. Cognito users are members of a Workspace. Identified by `tenantId` (the Workspace id) derived from an API key or Cognito JWT membership.
_Avoid_: user, account, customer (prefer Workspace for tenancy)

**Tenant**:
Synonym for the isolation boundary: in Finlens this is the **Workspace**. `tenantId` always identifies a Workspace.
_Avoid_: treating Tenant as a separate entity from Workspace

**Analysis**:
The Bedrock (Claude) output attached to a statement: a structured `financialSummary` plus narrative `spendingInsights`.
_Avoid_: report, summary (alone)

**Surface**:
One of the three thin adapters over the same domain logic: remote MCP, REST API, web dashboard.

## Relationships

- A **Workspace** owns many **Statements** and API keys
- Cognito users are **members** of a **Workspace**
- A **Statement** has exactly one **Analysis** (once status is `ready`)
- All three **Surfaces** read/write the same Statements; none has private state
- `tenantId` identifies the **Workspace** for isolation

## Statement lifecycle

`created → processing → ready | failed`

## Example dialogue

> **Dev:** "When a **Workspace** member uploads a **Statement**, does the REST response include the **Analysis**?"
> **Domain expert:** "No — analysis is async. The upload returns immediately; the client polls until the Statement is `ready`, then fetches the Analysis."

## Flagged ambiguities

- (none yet)
