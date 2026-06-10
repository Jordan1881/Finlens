export const FINLENS_MCP_TOOLS = [
  "upload_statement",
  "get_statement_status",
  "get_financial_summary",
  "get_spending_insights",
] as const;

export type FinlensMcpTool = (typeof FINLENS_MCP_TOOLS)[number];
