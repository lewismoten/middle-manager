// JSON API client. Reads are open; the token (if any) is sent so private reads work later.

const TOKEN_KEY = 'mm.token';

export interface PublicConfig {
  version: string;
  site: { name: string; timezone: string };
  machines: { id: string; name: string; role: string | null }[];
  plans: { id: string; name: string; provider: string; windows: string[]; models: string[] }[];
  local_models: { id: string; name: string; kind: string }[];
  projects: { id: string; name: string; repo: string | null; default_branch: string | null }[];
  documents: { id: string; name: string; private: boolean }[];
  collectors: { id: string; kind: string }[];
  retention: Record<string, number>;
}

export interface Stats {
  version: string;
  db: {
    size_bytes: number;
    wal_bytes: number;
    page_count: number;
    page_size: number;
    schema_version: number;
    rows: Record<string, number>;
  };
  retention: Record<string, number>;
  last_retention: { at: string } | null;
}

export interface WhoAmI {
  token: { name: string; scopes: string[] } | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export async function api<T>(path: string, init: RequestInit = {}, token = getToken()): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(`/api/v1${path}`, { ...init, headers });
  const body = (await res.json().catch(() => null)) as
    (T & { error?: { code: string; message: string } }) | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'http_error',
      body?.error?.message ?? `HTTP ${res.status}`,
    );
  }
  return body as T;
}
