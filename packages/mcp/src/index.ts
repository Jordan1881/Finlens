export const FINLENS_MCP_TOOLS = [
  "upload_statement",
  "get_statement",
  "list_statements",
] as const;

export type FinlensMcpTool = (typeof FINLENS_MCP_TOOLS)[number];

export const FINLENS_MCP_INSTRUCTIONS = `Finlens analyzes bank statement PDFs (Hebrew or English).

Workflow:
1. upload_statement — send the PDF as base64 (read local files yourself; file_path is not available on the remote server)
2. get_statement — poll every ~15 seconds until status is ready or failed
3. list_statements — find recent uploads if you lost the statementId

Defaults:
- Use detail=summary unless the user needs every field
- Do not ask the user for API keys (auth is handled by MCP client config until OAuth is enabled)

When status is processing, wait and poll again. When failed, read error.nextStep and retry upload if retryable.`;
