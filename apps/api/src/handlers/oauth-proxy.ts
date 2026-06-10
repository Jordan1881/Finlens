import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

const CURSOR_CALLBACK = "cursor://anysphere.cursor-mcp/oauth/callback";

function apiBaseUrl(): string {
  return process.env.API_PUBLIC_URL ?? "";
}

function cognitoBaseUrl(): string {
  const domain = process.env.COGNITO_DOMAIN;
  const region = process.env.COGNITO_REGION ?? "eu-west-1";
  if (!domain) {
    return "";
  }
  return `https://${domain}.auth.${region}.amazoncognito.com`;
}

function cognitoClientId(): string {
  return process.env.COGNITO_CLIENT_ID ?? "";
}

function encodeCursorState(cursorState: string): string {
  return Buffer.from(JSON.stringify({ cs: cursorState }), "utf8").toString("base64url");
}

function decodeCursorState(encoded: string): string | null {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { cs?: string };
    return typeof parsed.cs === "string" ? parsed.cs : null;
  } catch {
    return null;
  }
}

function redirect(location: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 302,
    headers: { location },
    body: "",
  };
}

function htmlPage(title: string, body: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`,
  };
}

export async function authorizeHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const base = cognitoBaseUrl();
  const clientId = cognitoClientId();
  const apiUrl = apiBaseUrl();
  const params = event.queryStringParameters ?? {};

  if (!base || !clientId || !apiUrl) {
    return htmlPage("Finlens", "<p>OAuth is not configured.</p>");
  }

  const scope = params.scope ?? "openid email";
  const state = params.state;
  const codeChallenge = params.code_challenge;
  const codeChallengeMethod = params.code_challenge_method ?? "S256";
  const responseType = params.response_type ?? "code";

  if (!state || !codeChallenge) {
    return htmlPage("Finlens", "<p>Missing OAuth state or PKCE challenge.</p>");
  }

  const cognitoCallback = `${apiUrl}/oauth/callback`;
  const cognitoState = encodeCursorState(state);

  const query = new URLSearchParams({
    client_id: clientId,
    response_type: responseType,
    scope: scope.replace(/\+/g, " "),
    redirect_uri: cognitoCallback,
    state: cognitoState,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
  });

  return redirect(`${base}/oauth2/authorize?${query.toString()}`);
}

export async function callbackHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const params = event.queryStringParameters ?? {};
  const code = params.code;
  const encodedState = params.state;
  const error = params.error;
  const errorDescription = params.error_description;

  if (error) {
    return htmlPage(
      "Finlens sign-in failed",
      `<p>${errorDescription ?? error}</p><p>Close this tab and try Connect again in Cursor.</p>`,
    );
  }

  if (!code || !encodedState) {
    return htmlPage("Finlens", "<p>Missing authorization code.</p>");
  }

  const cursorState = decodeCursorState(encodedState);
  if (!cursorState) {
    return htmlPage("Finlens", "<p>Invalid OAuth state.</p>");
  }

  const cursorUrl = `${CURSOR_CALLBACK}?${new URLSearchParams({ code, state: cursorState }).toString()}`;

  return htmlPage(
    "Finlens — return to Cursor",
    `<p>Sign-in succeeded.</p>
     <p><a id="open" href="${cursorUrl}">Open Cursor</a></p>
     <script>document.getElementById("open").click();</script>
     <p>If Cursor did not open, click the link above.</p>`,
  );
}

export async function tokenHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const base = cognitoBaseUrl();
  const clientId = cognitoClientId();
  const apiUrl = apiBaseUrl();

  if (!base || !clientId || !apiUrl || !event.body) {
    return {
      statusCode: 400,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "invalid_request" }),
    };
  }

  const contentType = event.headers["content-type"] ?? event.headers["Content-Type"] ?? "";
  const bodyParams = contentType.includes("application/json")
    ? (JSON.parse(event.body) as Record<string, string>)
    : Object.fromEntries(new URLSearchParams(event.body));

  const cognitoBody = new URLSearchParams({
    grant_type: bodyParams.grant_type ?? "authorization_code",
    client_id: bodyParams.client_id ?? clientId,
    code: bodyParams.code ?? "",
    redirect_uri: `${apiUrl}/oauth/callback`,
    code_verifier: bodyParams.code_verifier ?? "",
  });

  const response = await fetch(`${base}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: cognitoBody.toString(),
  });

  const text = await response.text();
  return {
    statusCode: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
      "access-control-allow-origin": "*",
    },
    body: text,
  };
}
