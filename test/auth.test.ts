import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createToken,
  hashToken,
  listTokens,
  parseScopes,
  revokeToken,
  verifyToken,
} from '../server/auth.ts';
import type { Db } from '../server/db/index.ts';
import type { Route } from '../server/http/app.ts';
import { startServer, type Running } from '../server/server.ts';
import { memoryDb, testConfig } from './helpers.ts';

describe('tokens', () => {
  it('stores only the SHA-256 hash', () => {
    const db = memoryDb();
    const { token, info } = createToken(db, 'laptop');
    expect(token).toMatch(/^mm_[A-Za-z0-9_-]{43}$/);
    expect(info.scopes).toEqual(['write']);
    const row = db.prepare('SELECT hash FROM tokens').get() as { hash: string };
    expect(row.hash).toBe(hashToken(token));
    expect(JSON.stringify(db.prepare('SELECT * FROM tokens').all())).not.toContain(token);
  });

  it('refuses a second live token with the same name, allows it after revoke', () => {
    const db = memoryDb();
    createToken(db, 'agent-lead');
    expect(() => createToken(db, 'agent-lead')).toThrow(/already exists/);
    expect(revokeToken(db, 'agent-lead')).toBe(true);
    expect(revokeToken(db, 'agent-lead')).toBe(false);
    expect(() => createToken(db, 'agent-lead')).not.toThrow();
    expect(listTokens(db).map((t) => [t.name, t.revoked_at === null])).toEqual([
      ['agent-lead', true],
      ['agent-lead', false],
    ]);
  });

  it('validates names and scopes', () => {
    const db = memoryDb();
    expect(() => createToken(db, 'bad name')).toThrow(/must be letters/);
    expect(parseScopes('write, jobs:shell,write')).toEqual(['write', 'jobs:shell']);
    expect(() => parseScopes('root')).toThrow(/Unknown scope "root"/);
  });

  it('verifies live tokens and records last use', () => {
    const db = memoryDb();
    const { token } = createToken(db, 'x');
    const at = new Date('2026-01-02T03:04:05.000Z');
    expect(verifyToken(db, token, at)?.last_used_at).toBe(at.toISOString());
    expect(verifyToken(db, token + 'x')).toBeNull();
    revokeToken(db, 'x');
    expect(verifyToken(db, token)).toBeNull();
  });

  it('parses bearer headers', () => {
    expect(bearer('Bearer abc')).toBe('abc');
    expect(bearer('bearer abc ')).toBe('abc');
    expect(bearer('Basic abc')).toBeNull();
    expect(bearer(undefined)).toBeNull();
  });
});

describe('auth middleware over HTTP', () => {
  let db: Db;
  let app: Running;
  let token: string;
  let shellToken: string;

  const echo: Route[] = [
    { method: 'POST', path: '/echo', handler: ({ token: t }) => ({ by: t?.name }) },
    { method: 'POST', path: '/shell', scope: 'jobs:shell', handler: () => ({ ok: true }) },
  ];

  beforeAll(async () => {
    const config = testConfig();
    db = memoryDb(config);
    token = createToken(db, 'writer').token;
    shellToken = createToken(db, 'shell', ['write', 'jobs:shell']).token;
    app = await startServer({
      config,
      db,
      host: '127.0.0.1',
      port: 0,
      extraRoutes: echo,
      retention: false,
      webRoot: '/nonexistent',
      log: () => {},
    });
  });
  afterAll(async () => {
    await app.close();
    db.close();
  });

  const call = (method: string, p: string, auth?: string) =>
    fetch(`${app.url}/api/v1${p}`, {
      method,
      headers: auth ? { authorization: `Bearer ${auth}` } : {},
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = async (res: Response): Promise<any> => res.json();
  const auditRows = () =>
    db.prepare('SELECT token_name, method, path, status FROM audit ORDER BY id').all();

  it('reads are open', async () => {
    const res = await call('GET', '/health');
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true });
    const pub = await json(await call('GET', '/config/public'));
    expect(pub.site.name).toBe('Test fleet');
    const stats = await json(await call('GET', '/stats'));
    expect(stats.db.rows.tokens).toBe(2);
    expect(stats.db.path).toBeUndefined();
  });

  it('a write without a token gets 401 JSON and an audit row', async () => {
    db.exec('DELETE FROM audit');
    const res = await call('POST', '/echo');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect((await json(res)).error.code).toBe('unauthorized');
    expect(auditRows()).toEqual([
      { token_name: null, method: 'POST', path: '/api/v1/echo', status: 401 },
    ]);
  });

  it('a write with a token succeeds and is audited under its name', async () => {
    db.exec('DELETE FROM audit');
    const res = await call('POST', '/echo', token);
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({ by: 'writer' });
    expect(auditRows()).toEqual([
      { token_name: 'writer', method: 'POST', path: '/api/v1/echo', status: 201 },
    ]);
  });

  it('a revoked token is refused', async () => {
    const { token: t } = createToken(db, 'temp');
    expect((await call('POST', '/echo', t)).status).toBe(201);
    revokeToken(db, 'temp');
    const res = await call('POST', '/echo', t);
    expect(res.status).toBe(401);
    expect((await json(res)).error.message).toMatch(/revoked/);
  });

  it('scoped routes need the scope', async () => {
    const res = await call('POST', '/shell', token);
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('forbidden');
    expect((await call('POST', '/shell', shellToken)).status).toBe(201);
  });

  it('whoami reports the token behind a read', async () => {
    expect(await json(await call('GET', '/auth/whoami'))).toEqual({ token: null });
    expect(await json(await call('GET', '/auth/whoami', token))).toEqual({
      token: { name: 'writer', scopes: ['write'] },
    });
  });

  it('unknown routes and wrong methods return JSON errors', async () => {
    const a = await call('GET', '/nope');
    expect(a.status).toBe(404);
    expect(await json(a)).toEqual({
      error: { code: 'not_found', message: 'No API route GET /api/v1/nope' },
    });
    const b = await call('DELETE', '/health', token);
    expect(b.status).toBe(405);
    expect((await json(b)).error.code).toBe('method_not_allowed');
  });

  it('says when the UI is not built', async () => {
    const res = await fetch(`${app.url}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/npm run build/);
  });
});
