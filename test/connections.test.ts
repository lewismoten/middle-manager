import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createToken } from '../server/auth.ts';
import {
  checkCredentials,
  checkLocalModel,
  checkSessions,
  localConnections,
  modelNames,
  planConnection,
  probeUrl,
} from '../server/connections/checks.ts';
import { insertReadings } from '../server/plans/store.ts';
import { startServer, type Running } from '../server/server.ts';
import { memoryDb, testConfig } from './helpers.ts';

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const SECRET = 'sk-ant-oat-SYNTHETIC-must-never-appear';

let dir: string;
/** A port that was just free: nothing listens there. */
let closedUrl: string;
beforeAll(async () => {
  const tmp = createServer();
  await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
  closedUrl = `http://127.0.0.1:${(tmp.address() as AddressInfo).port}`;
  await new Promise<void>((r) => tmp.close(() => r()));
  dir = mkdtempSync(path.join(tmpdir(), 'mm-conn-'));
  writeFileSync(
    path.join(dir, 'creds.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: SECRET, expiresAt: NOW + 3600_000 } }),
  );
  writeFileSync(
    path.join(dir, 'expired.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: SECRET, expiresAt: NOW - 7200_000 } }),
  );
  writeFileSync(path.join(dir, 'broken.json'), '{');
  const day = path.join(dir, 'sessions', '2026', '11', '19');
  mkdirSync(day, { recursive: true });
  const log = path.join(day, 'rollout.jsonl');
  writeFileSync(log, '{}\n');
  utimesSync(log, new Date(NOW - 3 * 3600_000), new Date(NOW - 3 * 3600_000));
  mkdirSync(path.join(dir, 'empty-sessions'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('plan source checks', () => {
  it('reads the Claude login state without returning the token', () => {
    const ok = checkCredentials(path.join(dir, 'creds.json'), NOW);
    expect(ok.status).toBe('ok');
    expect(ok.detail).toBe('logged in; the access token renews in 1 h');
    expect(checkCredentials(path.join(dir, 'expired.json'), NOW)).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('expired 2 h ago'),
    });
    expect(checkCredentials(path.join(dir, 'broken.json'), NOW).status).toBe('down');
    expect(checkCredentials(path.join(dir, 'none.json'), NOW).detail).toContain('not found');
    expect(checkCredentials(undefined, NOW).status).toBe('down');
    for (const f of ['creds.json', 'expired.json'])
      expect(JSON.stringify(checkCredentials(path.join(dir, f), NOW))).not.toContain(SECRET);
  });

  it('finds the newest Codex session log', () => {
    expect(checkSessions(path.join(dir, 'sessions'), NOW)).toEqual({
      label: 'Codex session logs',
      status: 'ok',
      detail: 'newest session log 3 h ago',
    });
    expect(checkSessions(path.join(dir, 'empty-sessions'), NOW).status).toBe('warn');
    expect(checkSessions(path.join(dir, 'missing'), NOW).status).toBe('down');
  });

  it('combines source checks with reading freshness', () => {
    const config = testConfig({
      plans: [
        {
          id: 'c',
          name: 'C',
          provider: 'anthropic-oauth',
          credentials: path.join(dir, 'creds.json'),
          windows: ['weekly', 'five_hour'],
        },
        {
          id: 'x',
          name: 'X',
          provider: 'codex-sessions',
          sessions_dir: path.join(dir, 'sessions'),
        },
        { id: 'm', name: 'M', provider: 'manual' },
      ],
    });
    const db = memoryDb(config);
    const at = (h: number) => new Date(NOW - h * 3600_000).toISOString();
    insertReadings(db, [
      {
        plan_id: 'c',
        window: 'weekly',
        used_pct: 40,
        resets_at: null,
        read_at: at(0.5),
        machine_id: null,
        how: 'oauth-usage',
      },
      {
        plan_id: 'c',
        window: 'five_hour',
        used_pct: 10,
        resets_at: null,
        read_at: at(0.2),
        machine_id: null,
        how: 'oauth-usage',
      },
      {
        plan_id: 'x',
        window: 'weekly',
        used_pct: 20,
        resets_at: null,
        read_at: at(30),
        machine_id: null,
        how: 'codex-log',
      },
    ]);
    const [c, x, m] = config.plans.map((p) => planConnection(db, p, { now: NOW }));
    expect(c).toMatchObject({ status: 'ok', last_reading_at: at(0.2) });
    expect(c!.readings.map((r) => [r.window, r.stale])).toEqual([
      ['weekly', false],
      ['five_hour', false],
    ]);
    expect(c!.path).toBeUndefined(); // not signed in
    expect(x).toMatchObject({ status: 'warn', summary: 'Last weekly reading 30 h ago (stale)' });
    expect(m).toMatchObject({
      status: 'manual',
      last_reading_at: null,
      summary: 'Readings arrive through the API, the CLI or a CSV import.',
    });
    expect(planConnection(db, config.plans[0]!, { now: NOW, signedIn: true }).path).toBe(
      path.join(dir, 'creds.json'),
    );
  });
});

describe('local model checks', () => {
  it('builds probe URLs and reads model lists', () => {
    expect(probeUrl({ url: 'http://h:11434/', kind: 'ollama' })).toBe('http://h:11434/api/tags');
    expect(probeUrl({ url: 'http://h:8080', kind: 'openai' })).toBe('http://h:8080/v1/models');
    expect(probeUrl({ url: 'http://h:8080/v1', kind: 'openai' })).toBe('http://h:8080/v1/models');
    expect(modelNames('ollama', { models: [{ name: 'a:7b' }, { model: 'b' }, {}] })).toEqual([
      'a:7b',
      'b',
    ]);
    expect(modelNames('openai', { data: [{ id: 'm1' }] })).toEqual(['m1']);
    expect(modelNames('openai', { nope: 1 })).toBeNull();
  });

  let srv: Server;
  let base: string;
  let hits = 0;
  beforeAll(async () => {
    srv = createServer((req, res) => {
      hits++;
      if (req.url === '/api/tags') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ models: [{ name: 'tiny:1b' }, { name: 'mid:8b' }] }));
      } else if (req.url === '/v1/models') {
        res.statusCode = 401;
        res.end('{}');
      } else if (req.url === '/slow/v1/models') {
        setTimeout(() => res.end('{}'), 500);
      } else {
        res.end('not json');
      }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => srv.close(() => r())));

  it('reports reachable, refused, unauthorized, slow and odd endpoints', async () => {
    const m = (url: string, kind: 'ollama' | 'openai') => ({ id: 'l', name: 'L', url, kind });
    expect(await checkLocalModel(m(base, 'ollama'))).toMatchObject({
      status: 'ok',
      summary: 'Reachable; 2 models',
      models: ['tiny:1b', 'mid:8b'],
    });
    expect(await checkLocalModel(m(base, 'openai'))).toMatchObject({
      status: 'down',
      summary: 'Answered HTTP 401 (needs a key)',
    });
    expect(await checkLocalModel(m(`${base}/slow`, 'openai'), { timeoutMs: 100 })).toMatchObject({
      status: 'down',
      summary: 'No answer within 0.1 s',
      latency_ms: null,
    });
    expect((await checkLocalModel(m(`${base}/odd`, 'ollama'))).summary).toBe(
      'Reachable, but the reply is not an Ollama model list',
    );
    expect(await checkLocalModel(m(closedUrl, 'openai'))).toMatchObject({
      status: 'down',
      summary: 'Connection refused (is it running?)',
    });
    expect((await checkLocalModel(m('http://127.0.0.1:9', 'openai'))).summary).toBe(
      'Port is blocked for HTTP clients; use another port',
    );
  });

  it('caches checks and remembers the last success', async () => {
    const config = testConfig({
      local_models: [{ id: 'o', name: 'O', url: base, kind: 'ollama' }],
    });
    let t = NOW;
    const now = () => t;
    hits = 0;
    const [a] = await localConnections(config, { now });
    expect(a).toMatchObject({ status: 'ok', last_ok_at: new Date(NOW).toISOString() });
    expect(a!.url).toBeUndefined();
    await localConnections(config, { now });
    expect(hits).toBe(1);
    t += 1000;
    await localConnections(config, { now, refresh: true }); // too soon to force
    expect(hits).toBe(1);
    t += 2000;
    const [b] = await localConnections(config, { now, refresh: true, signedIn: true });
    expect(hits).toBe(2);
    expect(b!.url).toBe(base);
  });
});

describe('connections API', () => {
  let running: Running;
  let token: string;
  beforeAll(async () => {
    const config = testConfig({
      plans: [
        {
          id: 'c',
          name: 'C',
          provider: 'anthropic-oauth',
          credentials: path.join(dir, 'creds.json'),
        },
      ],
      local_models: [{ id: 'dead', name: 'Dead', url: 'http://127.0.0.1:9', kind: 'openai' }],
    });
    const db = memoryDb(config);
    token = createToken(db, 'r', ['write']).token;
    running = await startServer({
      config,
      db,
      port: 0,
      host: '127.0.0.1',
      retention: false,
      agentCollectors: false,
      schedules: false,
      log: () => {},
    });
  });
  afterAll(() => running.close());

  it('returns plans and local models, with paths and URLs only when signed in', async () => {
    const anon = await (await fetch(`${running.url}/api/v1/connections`)).text();
    expect(anon).not.toContain(SECRET);
    expect(anon).not.toContain(dir);
    expect(anon).not.toContain('127.0.0.1:9');
    const body = JSON.parse(anon) as {
      plans: { id: string; status: string }[];
      local_models: { id: string; status: string }[];
    };
    expect(body.plans[0]).toMatchObject({ id: 'c', status: 'warn' }); // no readings yet
    expect(body.local_models[0]).toMatchObject({ id: 'dead', status: 'down' });
    const signed = await (
      await fetch(`${running.url}/api/v1/connections`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).text();
    expect(signed).toContain('creds.json');
    expect(signed).toContain('127.0.0.1:9');
    expect(signed).not.toContain(SECRET);
  });
});
