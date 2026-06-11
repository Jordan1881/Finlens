import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { z } from "zod";
import { FINLENS_MCP_INSTRUCTIONS } from "@finlens/mcp";
import { mcpUnauthorized, resolveTenantIdForMcp } from "../lib/auth";
import { getStatement, deleteStatement, listStatements, uploadStatement } from "../lib/statement-service";

function toRequest(event: APIGatewayProxyEventV2): {
  request: Request;
  parsedBody?: unknown;
} {
  const domain = event.requestContext.domainName;
  const path = event.rawPath ?? event.requestContext.http.path;
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `https://${domain}${path}${query}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value) {
      headers.set(key, value);
    }
  }

  const method = event.requestContext.http.method;
  let body: string | undefined = event.body ?? undefined;
  if (body && event.isBase64Encoded) {
    body = Buffer.from(body, "base64").toString("utf8");
  }

  let parsedBody: unknown;
  if (body && method !== "GET" && method !== "HEAD") {
    try {
      parsedBody = JSON.parse(body);
    } catch {
      parsedBody = undefined;
    }
  }

  return {
    request: new Request(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
    }),
    parsedBody,
  };
}

async function toApiGatewayResult(response: Response): Promise<APIGatewayProxyResultV2> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    statusCode: response.status,
    headers,
    body: await response.text(),
  };
}

function toolError(code: string, message: string, retryable: boolean, nextStep: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: { code, message, retryable, nextStep } }, null, 2),
      },
    ],
    isError: true,
  };
}

function createMcpServer(tenantId: string): McpServer {
  const server = new McpServer(
    {
      name: "finlens",
      version: "0.1.0",
    },
    {
      instructions: FINLENS_MCP_INSTRUCTIONS,
      capabilities: { tools: {} },
    },
  );

  server.registerTool(
    "upload_statement",
    {
      description:
        "Upload a bank statement PDF or CSV for analysis. Use base64+filename (read local files yourself). Returns statementId for polling.",
      inputSchema: {
        base64: z.string().optional().describe("Base64-encoded PDF or CSV bytes"),
        filename: z
          .string()
          .optional()
          .describe("Original filename, must end with .pdf or .csv"),
        file_path: z
          .string()
          .optional()
          .describe("Not supported on remote server — read the file and pass base64 instead"),
      },
    },
    async ({ base64, filename, file_path }) => {
      if (file_path && !base64) {
        return toolError(
          "FILE_PATH_NOT_SUPPORTED",
          "Remote Finlens cannot read local file paths",
          false,
          "Read the file locally and pass it as base64 with filename",
        );
      }

      if (!base64) {
        return toolError(
          "INVALID_REQUEST",
          "base64 is required",
          false,
          "Read the PDF or CSV and provide base64 and filename",
        );
      }

      if (
        filename &&
        !filename.toLowerCase().endsWith(".pdf") &&
        !filename.toLowerCase().endsWith(".csv")
      ) {
        return toolError(
          "UNSUPPORTED_FILE_TYPE",
          "Filename must end with .pdf or .csv",
          false,
          "Use a .pdf or .csv filename",
        );
      }

      let fileBytes: Uint8Array;
      try {
        fileBytes = Uint8Array.from(Buffer.from(base64, "base64"));
      } catch {
        return toolError(
          "INVALID_REQUEST",
          "Invalid base64 encoding",
          false,
          "Provide valid base64-encoded file bytes",
        );
      }

      const result = await uploadStatement(tenantId, fileBytes, filename);
      if ("code" in result) {
        return toolError(result.code, result.message, result.retryable, result.nextStep);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                statementId: result.statementId,
                status: result.status,
                nextStep: "Poll get_statement every ~15s until ready or failed",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_statement",
    {
      description:
        "Get statement status and analysis. Poll every ~15s while processing. Use detail=summary (default) unless full data is needed.",
      inputSchema: {
        statementId: z.string().describe("Statement ID from upload_statement"),
        detail: z
          .enum(["summary", "full"])
          .optional()
          .describe("summary (default) or full payload"),
      },
    },
    async ({ statementId, detail }) => {
      const data = await getStatement(tenantId, statementId, detail ?? "summary");
      if (!data) {
        return toolError(
          "NOT_FOUND",
          "Statement not found",
          false,
          "Check statementId or upload a new statement",
        );
      }

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.registerTool(
    "list_statements",
    {
      description: "List up to 20 recent statement uploads for the current user, newest first.",
      inputSchema: {},
    },
    async () => {
      const data = await listStatements(tenantId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.registerTool(
    "delete_statement",
    {
      description: "Permanently delete a statement and its uploaded file.",
      inputSchema: {
        statementId: z.string().describe("Statement ID to delete"),
      },
    },
    async ({ statementId }) => {
      const result = await deleteStatement(tenantId, statementId);
      if (!result) {
        return toolError(
          "NOT_FOUND",
          "Statement not found",
          false,
          "Check statementId or list_statements",
        );
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  return server;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const apiPublicUrl = process.env.API_PUBLIC_URL ?? "";
  const tenantId = await resolveTenantIdForMcp(event);
  if (!tenantId) {
    return mcpUnauthorized(apiPublicUrl);
  }

  const method = event.requestContext.http.method;
  if (method === "GET") {
    const accept = event.headers.accept ?? event.headers.Accept ?? "";
    if (accept.includes("text/event-stream")) {
      return {
        statusCode: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          "access-control-allow-origin": "*",
        },
        body: ": finlens ok\n\n",
      };
    }
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: undefined,
  });
  const server = createMcpServer(tenantId);

  try {
    await server.connect(transport);
    const { request, parsedBody } = toRequest(event);
    const response = await transport.handleRequest(request, { parsedBody });
    const result = await toApiGatewayResult(response);
    await transport.close();
    await server.close();
    return result;
  } catch (error) {
    console.error("MCP handler error", error);
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      }),
    };
  }
}
