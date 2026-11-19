// The HTTP layer: a small router, auth for writes, an audit row per write, JSON errors and
// static files for the built UI. No framework, on purpose (SPEC 2).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { bearer, verifyToken, type Scope, type TokenInfo } from '../auth.ts';
import { serveStatic } from './static.ts';
import type { CollectorHooks } from '../schedules/collectors.ts';

export const API_PREFIX = '/api/v1';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_BODY_BYTES = 1024 * 1024;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface AppState {
  db: Db;
  config: Config;
  version: string;
  startedAt: Date;
  /** Folder with the built UI (dist/web). */
  webRoot: string;
  /** Last result of the retention job, if it has run. */
  lastRetention?: unknown;
  /** Host access for POST /collectors/:id/run (tests swap in fixtures). */
  collectorHooks?: CollectorHooks;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  token: TokenInfo | null;
  state: AppState;
}

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path under /api/v1, with :params, e.g. /plans/:id/readings */
  path: string;
  handler: Handler;
  /** Extra scope needed beyond `write` (writes) or a token at all (reads). */
  scope?: Scope;
  /** Reads that need a token (private documents). */
  private?: boolean;
}

interface CompiledRoute extends Route {
  re: RegExp;
  keys: string[];
}

function compile(route: Route): CompiledRoute {
  const keys: string[] = [];
  const pattern = route.path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { ...route, re: new RegExp(`^${pattern}/?$`), keys };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(res, status, { error: { code, message } });
}

/** Reads and parses a JSON request body (max 1 MB). */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES)
      throw new HttpError(413, 'body_too_large', 'Request body is over 1 MB');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body is not valid JSON');
  }
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader(
    'content-security-policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
}

function applyCors(req: IncomingMessage, res: ServerResponse, origins: string[]): boolean {
  const origin = req.headers.origin;
  if (!origin || !origins.includes(origin)) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  return true;
}

function audit(
  state: AppState,
  token: TokenInfo | null,
  method: string,
  path: string,
  status: number,
) {
  try {
    state.db
      .prepare('INSERT INTO audit (at, token_name, method, path, status) VALUES (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), token?.name ?? null, method, path, status);
  } catch (err) {
    console.error('audit insert failed:', (err as Error).message);
  }
}

export function createApp(state: AppState, routes: Route[]) {
  const compiled = routes.map(compile);

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const isWrite = WRITE_METHODS.has(method);
    const sub = url.pathname.slice(API_PREFIX.length) || '/';
    const plain = bearer(req.headers.authorization);
    const token = plain ? verifyToken(state.db, plain) : null;

    if (isWrite) res.on('finish', () => audit(state, token, method, url.pathname, res.statusCode));

    if (isWrite && !token) {
      res.setHeader('www-authenticate', 'Bearer');
      const message = plain
        ? 'Token is not valid or has been revoked'
        : 'Writes need Authorization: Bearer <token> (create one with: middle-manager token create <name>)';
      return sendError(res, 401, 'unauthorized', message);
    }

    let pathMatched = false;
    for (const r of compiled) {
      const m = r.re.exec(sub);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      if (r.private && !token) {
        res.setHeader('www-authenticate', 'Bearer');
        return sendError(res, 401, 'unauthorized', 'This item is private; sign in with a token');
      }
      const needed: Scope | undefined = r.scope ?? (isWrite ? 'write' : undefined);
      if (needed && token && !token.scopes.includes(needed) && !token.scopes.includes('admin')) {
        return sendError(
          res,
          403,
          'forbidden',
          `Token "${token.name}" lacks the "${needed}" scope`,
        );
      }
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? '')));
      const body = await r.handler({ req, res, url, params, token, state });
      if (!res.headersSent) sendJson(res, isWrite && method === 'POST' ? 201 : 200, body ?? null);
      return;
    }
    if (pathMatched)
      return sendError(res, 405, 'method_not_allowed', `${method} is not allowed here`);
    return sendError(res, 404, 'not_found', `No API route ${method} ${url.pathname}`);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setSecurityHeaders(res);
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return sendError(res, 400, 'bad_url', 'Malformed URL');
    }
    try {
      if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
        const cors = applyCors(req, res, state.config.server.cors_origins);
        if (req.method === 'OPTIONS') {
          res.writeHead(cors ? 204 : 403);
          return void res.end();
        }
        return await handleApi(req, res, url);
      }
      if (url.pathname.startsWith('/api/')) {
        return sendError(res, 404, 'not_found', `Unknown API version in ${url.pathname}`);
      }
      return await serveStatic(req, res, url, state.webRoot);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
      console.error(`${req.method} ${url.pathname} failed:`, err);
      return sendError(res, 500, 'internal', 'Internal server error');
    }
  };
}
