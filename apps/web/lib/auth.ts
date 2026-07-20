/** Cognito Hosted UI PKCE helpers for the static web control plane. */

const STORAGE_PREFIX = "finlens.auth.";

export type AuthTokens = {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  expiresAt: number;
};

function storageKey(name: string): string {
  return `${STORAGE_PREFIX}${name}`;
}

function requireConfig() {
  const userPoolId = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID ?? "";
  const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "";
  const domain = process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? "";
  const region = process.env.NEXT_PUBLIC_COGNITO_REGION ?? "eu-west-1";
  if (!userPoolId || !clientId || !domain) {
    throw new Error(
      "Cognito is not configured. Set NEXT_PUBLIC_COGNITO_USER_POOL_ID, NEXT_PUBLIC_COGNITO_CLIENT_ID, and NEXT_PUBLIC_COGNITO_DOMAIN.",
    );
  }
  return { userPoolId, clientId, domain, region };
}

export function isCognitoConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID &&
      process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID &&
      process.env.NEXT_PUBLIC_COGNITO_DOMAIN,
  );
}

export function cognitoHostedUiBase(): string {
  const { domain, region } = requireConfig();
  return `https://${domain}.auth.${region}.amazoncognito.com`;
}

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 1) {
    binary += String.fromCharCode(view[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function challengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

export function redirectUri(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return `${window.location.origin}/auth/callback`;
}

export function readTokens(): AuthTokens | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = sessionStorage.getItem(storageKey("tokens"));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as AuthTokens;
    if (!parsed.accessToken || typeof parsed.expiresAt !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeTokens(tokens: AuthTokens): void {
  sessionStorage.setItem(storageKey("tokens"), JSON.stringify(tokens));
}

export function clearTokens(): void {
  sessionStorage.removeItem(storageKey("tokens"));
  sessionStorage.removeItem(storageKey("pkce"));
}

export function getAccessToken(): string | null {
  const tokens = readTokens();
  if (!tokens) {
    return null;
  }
  // Refresh skew: treat as expired 60s early
  if (Date.now() >= tokens.expiresAt - 60_000) {
    return null;
  }
  return tokens.accessToken;
}

export function isAuthenticated(): boolean {
  return getAccessToken() != null;
}

type PkceSession = {
  verifier: string;
  state: string;
};

function writePkce(session: PkceSession): void {
  sessionStorage.setItem(storageKey("pkce"), JSON.stringify(session));
}

function readPkce(): PkceSession | null {
  try {
    const raw = sessionStorage.getItem(storageKey("pkce"));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as PkceSession;
  } catch {
    return null;
  }
}

/** Start Cognito Hosted UI login (authorization code + PKCE). */
export async function beginLogin(): Promise<void> {
  const { clientId } = requireConfig();
  const verifier = randomVerifier();
  const state = randomVerifier();
  const codeChallenge = await challengeS256(verifier);
  writePkce({ verifier, state });

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: "openid email",
    redirect_uri: redirectUri(),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  window.location.assign(`${cognitoHostedUiBase()}/oauth2/authorize?${params.toString()}`);
}

export async function completeLoginFromCallback(url: URL): Promise<AuthTokens> {
  const { clientId } = requireConfig();
  const error = url.searchParams.get("error");
  if (error) {
    throw new Error(url.searchParams.get("error_description") ?? error);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const pkce = readPkce();
  if (!code || !state || !pkce || state !== pkce.state) {
    throw new Error("Invalid OAuth callback (missing code/state or PKCE mismatch)");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri(),
    code_verifier: pkce.verifier,
  });

  const response = await fetch(`${cognitoHostedUiBase()}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `Token exchange failed (${response.status})`);
  }

  const json = JSON.parse(text) as {
    access_token?: string;
    id_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!json.access_token || !json.expires_in) {
    throw new Error("Token response missing access_token");
  }

  const tokens: AuthTokens = {
    accessToken: json.access_token,
    idToken: json.id_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  writeTokens(tokens);
  sessionStorage.removeItem(storageKey("pkce"));
  return tokens;
}

export function beginLogout(): void {
  clearTokens();
  if (!isCognitoConfigured()) {
    window.location.assign("/");
    return;
  }
  const { clientId } = requireConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    logout_uri: window.location.origin + "/",
  });
  window.location.assign(`${cognitoHostedUiBase()}/logout?${params.toString()}`);
}
