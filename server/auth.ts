// API tokens: created by the CLI, shown once, stored only as SHA-256 hashes.

import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './db/index.ts';

/**
 * write: ordinary API writes (readings, tasks, runs, collector jobs).
 * jobs:shell: create or edit shell jobs (SPEC 9).
 * admin: manage tokens from the UI.
 */
export const SCOPES = ['write', 'jobs:shell', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];
export const DEFAULT_SCOPES: Scope[] = ['write'];

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN_PREFIX = 'mm_';

export interface TokenInfo {
  id: number;
  name: string;
  scopes: Scope[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface TokenRow {
  id: number;
  name: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export class TokenError extends Error {}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function toInfo(r: TokenRow): TokenInfo {
  return {
    id: r.id,
    name: r.name,
    scopes: JSON.parse(r.scopes) as Scope[],
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    revoked_at: r.revoked_at,
  };
}

export function parseScopes(input: string | undefined): Scope[] {
  if (!input) return [...DEFAULT_SCOPES];
  const scopes = [
    ...new Set(
      input
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  for (const s of scopes) {
    if (!SCOPES.includes(s as Scope)) {
      throw new TokenError(`Unknown scope "${s}". Scopes: ${SCOPES.join(', ')}`);
    }
  }
  if (scopes.length === 0) throw new TokenError('At least one scope is needed');
  return scopes as Scope[];
}

/** Creates a token. Returns the plain token, which is never stored and cannot be shown again. */
export function createToken(
  db: Db,
  name: string,
  scopes: Scope[] = DEFAULT_SCOPES,
  now = new Date(),
  plain = TOKEN_PREFIX + randomBytes(32).toString('base64url'),
): { token: string; info: TokenInfo } {
  if (!NAME_RE.test(name)) {
    throw new TokenError(
      `Token name "${name}" must be letters, digits, ".", "_" or "-" (max 64), e.g. laptop or agent-lead`,
    );
  }
  const live = db.prepare('SELECT 1 FROM tokens WHERE name = ? AND revoked_at IS NULL').get(name);
  if (live) throw new TokenError(`A live token named "${name}" already exists; revoke it first`);
  const res = db
    .prepare('INSERT INTO tokens (name, hash, scopes, created_at) VALUES (?, ?, ?, ?)')
    .run(name, hashToken(plain), JSON.stringify(scopes), now.toISOString());
  const row = db
    .prepare('SELECT * FROM tokens WHERE id = ?')
    .get(res.lastInsertRowid) as unknown as TokenRow;
  return { token: plain, info: toInfo(row) };
}

export function listTokens(db: Db, includeRevoked = true): TokenInfo[] {
  const sql = includeRevoked
    ? 'SELECT * FROM tokens ORDER BY revoked_at IS NOT NULL, name, id'
    : 'SELECT * FROM tokens WHERE revoked_at IS NULL ORDER BY name';
  return (db.prepare(sql).all() as unknown as TokenRow[]).map(toInfo);
}

/** Revokes the live token with this name. Returns false when there is none. */
export function revokeToken(db: Db, name: string, now = new Date()): boolean {
  const res = db
    .prepare('UPDATE tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL')
    .run(now.toISOString(), name);
  return Number(res.changes) > 0;
}

/** Looks up a live token by its plain value and records its use. */
export function verifyToken(db: Db, plain: string, now = new Date()): TokenInfo | null {
  if (!plain) return null;
  const row = db
    .prepare('SELECT * FROM tokens WHERE hash = ? AND revoked_at IS NULL')
    .get(hashToken(plain)) as unknown as TokenRow | undefined;
  if (!row) return null;
  db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  return toInfo({ ...row, last_used_at: now.toISOString() });
}

/** Extracts the token from an `Authorization: Bearer <token>` header. */
export function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1] ?? null;
}
