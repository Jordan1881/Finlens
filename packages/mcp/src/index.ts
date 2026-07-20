export const FINLENS_MCP_TOOLS = [
  "upload_statement",
  "get_statement",
  "list_statements",
  "delete_statement",
] as const;

export type FinlensMcpTool = (typeof FINLENS_MCP_TOOLS)[number];

export const FINLENS_MCP_INSTRUCTIONS = `Finlens analyzes bank statement PDFs and CSV exports (Hebrew or English).

Workflow:
1. upload_statement — send the file as base64 (read local files yourself; file_path is not available on the remote server). Optional idempotency_key (or identical bytes) reuses the same statementId within 24h.
2. get_statement — poll every ~15 seconds until status is ready or failed. Use detail=summary unless you need transactionExtract (detail=full only).
3. list_statements — find recent uploads (newest by createdAt). Optional limit, nextToken, status. Follow nextToken when present.
4. delete_statement — permanently remove a statement and its file

Supported formats: PDF (.pdf) and comma-separated bank exports (.csv).

Defaults:
- Use detail=summary unless the user needs every field
- Do not ask the user for API keys (auth is handled by MCP client config until OAuth is enabled)

When status is processing, wait and poll again. When failed, read error.nextStep and retry upload if retryable.`;
