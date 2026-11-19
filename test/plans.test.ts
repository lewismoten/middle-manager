import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createToken } from '../server/auth.ts';
import { runCli } from '../server/cli.ts';
import {
  collectAnthropicOauth,
  collectCodexSessions,
  CollectorError,
  hostMachineId,
  OAUTH_USAGE_URL,
} from '../server/plans/collectors.ts';
import { parseCsv, readingsFromCsv } from '../server/plans/csv.ts';
import { insertReadings, listReadings, parseReading } from '../server/plans/store.ts';
import { startServer, type Running } from '../server/server.ts';
import { memoryDb, testConfig } from './helpers.ts';

const SECRET = 'sk-ant-oat-synthetic-secret-value';
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mm-plans-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function credentials(extra: Record<string, unknown> = {}): string {
  const file = path.join(dir, `cred-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: SECRET, ...extra } }));
  return file;
}

function oauthPlan(file: string) {
  return testConfig({
    plans: [
      {
        id: 'claude',
        name: 'Claude',
        provider: 'anthropic-oauth',
        credentials: file,
        windows: ['weekly', 'five_hour'],
      },
    ],
  }).plans[0]!;
}

describe('anthropic-oauth collector', () => {
  it('sends the token only in the Authorization header and maps windows', async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: new Headers(init.headers) });
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 12, resets_at: '2026-11-19T20:00:00+00:00' },
          seven_day: { utilization: 41.5, resets_at: '2026-11-23T15:00:00.123+00:00' },
          seven_day_opus: { utilization: 3, resets_at: null },
        }),
      );
    }) as unknown as typeof fetch;
    const now = new Date('2026-11-19T18:00:00Z');
    const rows = await collectAnthropicOauth(oauthPlan(credentials()), {
      fetch: fake,
      now,
      machineId: 'server-1',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(OAUTH_USAGE_URL);
    expect(seen[0]!.headers.get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(seen[0]!.headers.get('anthropic-beta')).toBe('oauth-2025-04-20');
    expect(rows).toEqual([
      {
        plan_id: 'claude',
        window: 'weekly',
        used_pct: 41.5,
        resets_at: '2026-11-23T15:00:00.123Z',
        read_at: now.toISOString(),
        machine_id: 'server-1',
        how: 'oauth-usage',
      },
      expect.objectContaining({ window: 'five_hour', used_pct: 12 }),
    ]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it('never puts the token in an error', async () => {
    const refuse = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    const boom = (async () => {
      throw new TypeError(`fetch failed ${SECRET}`);
    }) as unknown as typeof fetch;
    for (const f of [refuse, boom]) {
      const err = await collectAnthropicOauth(oauthPlan(credentials()), { fetch: f }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CollectorError);
      expect(String((err as Error).message)).not.toContain(SECRET);
    }
    const expired = credentials({ expiresAt: Date.now() - 1000 });
    await expect(collectAnthropicOauth(oauthPlan(expired), { fetch: refuse })).rejects.toThrow(
      /expired/,
    );
    await expect(
      collectAnthropicOauth(oauthPlan(path.join(dir, 'missing.json')), { fetch: refuse }),
    ).rejects.toThrow(/not found/);
  });
});

describe('codex-sessions collector', () => {
  it('reads the newest rate_limits event from the last three days', () => {
    const sessions = path.join(dir, 'codex');
    const day = (d: string) => {
      const p = path.join(sessions, ...d.split('-'));
      mkdirSync(p, { recursive: true });
      return p;
    };
    const ev = (ts: string, weekly: number, five: number) =>
      JSON.stringify({
        timestamp: ts,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: five, window_minutes: 300, resets_at: 1795118400 },
            secondary: { used_percent: weekly, window_minutes: 10080, resets_in_seconds: 3600 },
          },
        },
      });
    writeFileSync(
      path.join(day('2026-11-19'), 'rollout-a.jsonl'),
      [
        ev('2026-11-19T10:00:00.000Z', 20, 5),
        '{"not json',
        ev('2026-11-19T12:00:00.000Z', 22, 9),
      ].join('\n'),
    );
    writeFileSync(
      path.join(day('2026-11-18'), 'rollout-b.jsonl'),
      ev('2026-11-18T23:00:00.000Z', 19, 50),
    );
    writeFileSync(
      path.join(day('2026-11-10'), 'old.jsonl'),
      ev('2026-11-25T00:00:00.000Z', 99, 99), // outside the 3-day folders: ignored
    );
    const plan = testConfig({
      plans: [
        {
          id: 'codex',
          name: 'Codex',
          provider: 'codex-sessions',
          sessions_dir: sessions,
          windows: ['weekly', 'five_hour'],
        },
      ],
    }).plans[0]!;
    const rows = collectCodexSessions(plan, { now: new Date('2026-11-19T13:00:00Z') });
    expect(rows.map((r) => [r.window, r.used_pct, r.read_at, r.resets_at, r.how])).toEqual([
      ['five_hour', 9, '2026-11-19T12:00:00.000Z', '2026-11-19T20:00:00.000Z', 'codex-log'],
      ['weekly', 22, '2026-11-19T12:00:00.000Z', '2026-11-19T13:00:00.000Z', 'codex-log'],
    ]);
    expect(collectCodexSessions(plan, { now: new Date('2026-12-30T00:00:00Z') })).toEqual([]);
  });
});

describe('readings', () => {
  it('validates and de-duplicates', () => {
    const d = { read_at: '2026-11-19T00:00:00.000Z', how: 'api', machine_id: null };
    expect(() => parseReading({ used_pct: 101 }, 'p', d)).toThrow(/0 to 100/);
    expect(() => parseReading({ used_pct: 1, window: 'monthly' }, 'p', d)).toThrow(/window/);
    expect(() => parseReading({ used_pct: 1, resets_at: '2026-11-19T10:00' }, 'p', d)).toThrow(
      /time zone/,
    );
    const r = parseReading({ used_pct: '4.5', resets_at: '2026-11-19T10:00:00-05:00' }, 'p', d);
    expect(r).toMatchObject({
      window: 'weekly',
      used_pct: 4.5,
      resets_at: '2026-11-19T15:00:00.000Z',
    });
    const config = testConfig({ plans: [{ id: 'p', name: 'P', provider: 'manual' }] });
    const db = memoryDb(config);
    expect(insertReadings(db, [r, r])).toEqual({ added: 1, skipped: 1 });
    expect(listReadings(db, 'p')).toHaveLength(1);
  });

  it('parses CSV with quotes and maps sources', () => {
    expect(parseCsv('a,"b,""c"""\r\n1,2\n')).toEqual([
      ['a', 'b,"c"'],
      ['1', '2'],
    ]);
    const csv = [
      'time,source,machine,window,used_pct,resets_at,how',
      '2026-11-19T10:00:00-05:00,claude,server-1,weekly,30,2026-11-23T10:00:00-05:00,oauth-usage',
      '2026-11-19T10:00:00-05:00,claude,server-1,weekly_opus,3,2026-11-23T10:00:00-05:00,oauth-usage',
      '2026-11-19T10:00:00-05:00,other,server-1,weekly,3,,x',
      'bad-time,claude,server-1,weekly,3,,x',
    ].join('\n');
    const out = readingsFromCsv(csv, ['plan-a'], { claude: 'plan-a' });
    expect(out.readings).toHaveLength(1);
    expect(out.readings[0]).toMatchObject({
      plan_id: 'plan-a',
      used_pct: 30,
      machine_id: 'server-1',
    });
    expect(out.skipped).toEqual({ unknown_plan: 1, other_window: 1, invalid: 1 });
  });

  it('picks the host machine from env, host name or the only machine', () => {
    const one = testConfig({ machines: [{ id: 'server-1', name: 'S' }] });
    const two = testConfig({
      machines: [
        { id: 'server-1', name: 'S' },
        { id: 'box', name: 'B' },
      ],
    });
    expect(hostMachineId(one, {}, 'anything')).toBe('server-1');
    expect(hostMachineId(two, {}, 'BOX.local')).toBe('box');
    expect(hostMachineId(two, {}, 'other')).toBeNull();
    expect(hostMachineId(two, { MM_MACHINE: 'x' }, 'box')).toBe('x');
  });
});

describe('plan API', () => {
  let running: Running;
  let token: string;
  const now = Date.now();
  const iso = (h: number) => new Date(now + h * 3600_000).toISOString();

  beforeAll(async () => {
    const config = testConfig({
      machines: [{ id: 'server-1', name: 'S' }],
      plans: [
        { id: 'plan-a', name: 'Plan A', provider: 'manual', windows: ['weekly', 'five_hour'] },
        { id: 'plan-b', name: 'Plan B', provider: 'manual' },
      ],
      models: { 'plan-a': ['small', 'large'] },
    });
    const db = memoryDb(config);
    token = createToken(db, 'test').token;
    running = await startServer({ config, db, port: 0, host: '127.0.0.1', retention: false });
  });
  afterAll(() => running.close());

  const call = (method: string, p: string, body?: unknown, auth = true) =>
    fetch(`${running.url}/api/v1${p}`, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('needs a token to post readings', async () => {
    const res = await call('POST', '/plans/plan-a/readings', { used_pct: 1 }, false);
    expect(res.status).toBe(401);
  });

  it('stores readings and paces the plan', async () => {
    const readings = [0, 1, 2, 3, 4, 5, 6].map((i) => ({
      used_pct: 10 + i * 2,
      read_at: iso(-12 + i * 2),
      resets_at: iso(80),
    }));
    let res = await call('POST', '/plans/plan-a/readings', { readings });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ added: 7, skipped: 0 });
    res = await call('POST', '/plans/plan-a/readings', {
      window: 'five_hour',
      used_pct: 33,
      resets_at: iso(2),
    });
    expect(res.status).toBe(201);

    res = await call('POST', '/plans/plan-a/readings', { used_pct: 'lots' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_request');
    expect((await call('POST', '/plans/nope/readings', { used_pct: 1 })).status).toBe(404);

    const pace = (await (await call('GET', '/plans/pace')).json()) as {
      plans: {
        plan: string;
        five_hour: { used_pct: number } | null;
        weekly: null | Record<string, unknown>;
      }[];
    };
    const a = pace.plans.find((p) => p.plan === 'plan-a')!;
    expect(a.five_hour?.used_pct).toBe(33);
    expect(a.weekly).toMatchObject({
      current: true,
      used_pct: 22,
      mode: 'steady',
      rate_basis_h: 3,
      rate_pct_per_h: 1,
      suggested_model: 'small',
      stale: false,
      readings: 7,
    });
    expect(pace.plans.find((p) => p.plan === 'plan-b')!.weekly).toBeNull();

    const list = (await (
      await call('GET', `/plans/plan-a/readings?window=weekly&since=${iso(-5)}`)
    ).json()) as {
      readings: { read_at: string; machine_id: string }[];
    };
    expect(list.readings.map((r) => r.read_at)).toEqual([iso(-4), iso(-2), iso(0)]);
    expect(list.readings[0]!.machine_id).toBe('server-1');

    const plans = (await (await call('GET', '/plans')).json()) as {
      plans: { id: string; readings: number; latest: Record<string, unknown> }[];
    };
    expect(plans.plans.map((p) => [p.id, p.readings])).toEqual([
      ['plan-a', 8],
      ['plan-b', 0],
    ]);
  });

  it('runs collectors by id', async () => {
    let res = await call('POST', '/collectors/plan-b/run', {
      reading: { used_pct: 5, resets_at: iso(100) },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, kind: 'manual', added: 1 });
    res = await call('POST', '/collectors/plan-b/run', {});
    expect(res.status).toBe(400);
    res = await call('POST', '/collectors/csv-import/run', {
      csv: `time,source,machine,window,used_pct,resets_at,how\n${iso(-30)},b,server-1,weekly,2,${iso(100)},x\n`,
      map: { b: 'plan-b' },
    });
    expect(await res.json()).toMatchObject({ added: 1, skipped: 0 });
    expect((await call('POST', '/collectors/nope/run', {})).status).toBe(404);
    expect((await call('POST', '/collectors/plan-b/run', {}, false)).status).toBe(401);
  });
});

describe('import CLI', () => {
  it('imports a CSV and a manual reading', async () => {
    const db = path.join(dir, 'cli.db');
    const cfg = path.join(dir, 'cli.yaml');
    writeFileSync(
      cfg,
      `site: { name: "T" }\ndatabase: { path: ${JSON.stringify(db)} }\nplans:\n  - { id: plan-a, name: A, provider: manual }\n`,
    );
    const csv = path.join(dir, 'r.csv');
    writeFileSync(
      csv,
      'time,source,machine,window,used_pct,resets_at,how\n2026-11-19T10:00:00Z,a,m1,weekly,30,2026-11-23T10:00:00Z,x\n',
    );
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    expect(
      await runCli(
        ['import', 'csv-import', '--file', csv, '--map', 'a=plan-a', '--config', cfg],
        out,
      ),
    ).toBe(0);
    expect(lines.join('\n')).toContain('added 1, skipped 0');
    expect(await runCli(['import', 'plan-a', '--used', '31', '--config', cfg], out)).toBe(0);
    expect(await runCli(['import', 'plan-a', '--config', cfg], out)).toBe(1);
    expect(await runCli(['import', 'zzz', '--config', cfg], out)).toBe(2);
    expect(lines.join('\n')).toMatch(/Collectors: plan-a, csv-import/);
  });
});
