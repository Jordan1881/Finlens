import { getAccessToken } from "./auth";

const API_URL = (process.env.NEXT_PUBLIC_FINLENS_API_URL ?? "").replace(/\/$/, "");

/** Public API base URL (no secrets). Empty when unset. */
export function getApiUrl(): string {
  return API_URL;
}

/** Remote MCP endpoint derived from the API base URL. */
export function getMcpUrl(): string {
  return API_URL ? `${API_URL}/mcp` : "";
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Not signed in");
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  if (!res.ok) {
    try {
      const body = JSON.parse(text) as { error?: { message?: string } };
      if (body.error?.message) {
        throw new Error(body.error.message);
      }
    } catch (error) {
      if (error instanceof Error && error.message !== text) {
        throw error;
      }
    }
    throw new Error(text || `Request failed (${res.status})`);
  }

  return JSON.parse(text) as T;
}

export function apiConfigured(): boolean {
  return Boolean(API_URL);
}
