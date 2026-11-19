// POST /api/v1/collectors/:id/run and `middle-manager import <id>` run every kind of collector
// through one dispatcher (runCollectorById). Each collector reads synthetic fixtures; nothing
// touches the real host.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CollectorEnv } from '../server/agents/collect.ts';
import type { GitInfo, ProcInfo } from '../server/agents/process-scan.ts';
import { SessionTail } from '../server/agents/tokens.ts';
import { createToken } from '../server/auth.ts';
import { runCli } from '../server/cli.ts';
import type { Db } from '../server/db/index.ts';
import type { CollectorHooks } from '../server/schedules/collectors.ts';
import type { ExternalJob, MirrorEnv } from '../server/schedules/mirror.ts';
import { startServer, type Running } from '../server/server.ts';
import { memoryDb, testConfig } from './helpers.ts';

const NOW = new Date('2026-11-19T13:00:00.000Z');
const WRITE = 'mm_test-collectors-token';

const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** Writes every fixture under `dir` and returns the config's collectors and plans. */
function fixtures(dir: string) {
  // Claude credentials (fake token; the fetch below never leaves the process).
  const credentials = path.join(dir, 'credentials.json');
  writeFileSync(
    credentials,
    JSON.stringify({ claudeAiOauth: { accessToken: 'fake-token', expiresAt: 4102444800000 } }),
  );
  // Codex session log with a rate_limits event.
  const day = path.join(dir, 'codex', '2026', '11', '19');
  mkdirSync(day, { recursive: true });
  writeFileSync(
    path.join(day, 'rollout-a.jsonl'),
    jsonl({
      timestamp: '2026-11-19T12:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 9, window_minutes: 300, resets_in_seconds: 3600 },
          secondary: { used_percent: 22, window_minutes: 10080, resets_in_seconds: 86400 },
        },
      },
    }),
  );
  // CSV of earlier readings.
  const csv = path.join(dir, 'readings.csv');
  writeFileSync(
    csv,
    'time,source,machine,window,used_pct,resets_at,how\n' +
      '2026-11-19T10:00:00Z,claude,m1,weekly,30,2026-11-23T10:00:00Z,csv\n',
  );
  // A Hermes kanban board.
  const boards = path.join(dir, 'boards');
  mkdirSync(path.join(boards, 'alpha'), { recursive: true });
  const board = new DatabaseSync(path.join(boards, 'alpha', 'kanban.db'));
  board.exec("CREATE TABLE tasks(id,name,status); INSERT INTO tasks VALUES(1,'First card','todo')");
  board.close();
  // Hermes cron jobs.
  const cron = path.join(dir, 'jobs.json');
  writeFileSync(
    cron,
    JSON.stringify({
      jobs: [
        {
          id: 'a1',
          name: 'Digest',
          schedule: { kind: 'cron', expr: '0 * * * *' },
          enabled: true,
        },
      ],
    }),
  );
  const sessionDirs = { claude_dir: path.join(dir, 'claude'), codex_dir: path.join(dir, 'codex') };
  return {
    machines: [{ id: 'server-1', name: 'Server' }],
    plans: [
      {
        id: 'claude',
        name: 'Claude',
        provider: 'anthropic-oauth',
        credentials,
        windows: ['weekly', 'five_hour'],
      },
      {
        id: 'codex',
        name: 'Codex',
        provider: 'codex-sessions',
        sessions_dir: path.join(dir, 'codex'),
        windows: ['weekly', 'five_hour'],
      },
    ],
    collectors: [
      { id: 'csv', kind: 'csv-import', path: csv },
      { id: 'hermes-kanban', kind: 'hermes-kanban', path: boards },
      { id: 'workers', kind: 'systemd-workers', prefix: 'worker-', ...sessionDirs },
      { id: 'processes', kind: 'process-scan', match: ['codex exec', 'claude -p'], ...sessionDirs },
      { id: 'tokens', kind: 'session-tokens', ...sessionDirs },
      { id: 'hermes-cron', kind: 'hermes-cron', path: cron },
      { id: 'timers', kind: 'systemd-timers', prefix: 'backup-' },
    ],
  };
}

function hooks(): CollectorHooks {
  const fetch = (async () =>
    new Response(
      JSON.stringify({
        seven_day: { utilization: 41, resets_at: '2026-11-23T15:00:00Z' },
        five_hour: { utilization: 12, resets_at: '2026-11-19T15:00:00Z' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof globalThis.fetch;
  const procs: ProcInfo[] = [
    {
      pid: 4321,
      ppid: 1,
      argv: ['codex', 'exec', '--model', 'model-a', 'ship it'],
      command: 'codex exec --model model-a ship it',
      cwd: '/work/repo',
      started_at: '2026-11-19T12:00:00.000Z',
    },
  ];
  const agents: CollectorEnv = {
    listProcesses: async () => procs,
    listUnits: async () => [
      {
        unit: 'worker-beta.service',
        active_state: 'active',
        sub_state: 'running',
        main_pid: 5000,
        cwd: '/work/repo',
        command: '/usr/bin/claude -p review',
        started_at: '2026-11-19T12:10:00.000Z',
        ended_at: null,
        description: 'beta',
      },
    ],
    git: async (): Promise<GitInfo> => ({ branch: 'main', origin: null, worktree: '/work/repo' }),
    tail: new SessionTail(),
    now: () => NOW,
  };
  const timer: ExternalJob = {
    external_id: 'backup-nightly.timer',
    name: 'backup-nightly',
    schedule: 'daily',
    timezone: null,
    command: '/usr/bin/backup',
    enabled: true,
    last_run_at: null,
    last_status: null,
    next_run_at: null,
  };
  const mirror: MirrorEnv = {
    readFile: (p) => readFileSync(p, 'utf8'),
    timers: async () => [timer],
    now: () => NOW,
  };
  return { agents, mirror, plans: { fetch, now: NOW, machineId: 'server-1' } };
}

describe('POST /collectors/:id/run', () => {
  let dir: string;
  let running: Running;
  let db: Db;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'mm-collectors-'));
    const config = testConfig(fixtures(dir));
    db = memoryDb(config);
    createToken(db, 'writer', ['write'], NOW, WRITE);
    running = await startServer({
      config,
      db,
      port: 0,
      host: '127.0.0.1',
      retention: false,
      agentCollectors: false,
      schedules: false,
      collectorHooks: hooks(),
    });
  });
  afterAll(async () => {
    await running.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(id: string, token: string | null = WRITE) {
    const res = await fetch(`${running.url}/api/v1/collectors/${id}/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: '{}',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

  it.each([
    ['claude', { kind: 'anthropic-oauth', added: 2 }],
    ['codex', { kind: 'codex-sessions', added: 2 }],
    ['csv', { kind: 'csv-import', added: 1 }],
    ['hermes-kanban', { kind: 'hermes-kanban', boards: 1, cards: 1 }],
    ['workers', { kind: 'systemd-workers', inserted: 1 }],
    ['processes', { kind: 'process-scan', inserted: 1 }],
    ['tokens', { kind: 'session-tokens', tokens_updated: 0 }],
    ['hermes-cron', { kind: 'hermes-cron', jobs: 1 }],
    ['timers', { kind: 'systemd-timers', jobs: 1 }],
  ])('runs %s', async (id, expected) => {
    const res = await run(id);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(res.body).toMatchObject({ id, ok: true, ...expected });
  });

  it('stored what each collector found', () => {
    expect(count("SELECT count(*) n FROM plan_readings WHERE plan_id='claude'")).toBe(3);
    expect(count("SELECT count(*) n FROM plan_readings WHERE plan_id='codex'")).toBe(2);
    expect(count("SELECT count(*) n FROM tasks WHERE external_ref LIKE 'hermes-kanban:%'")).toBe(1);
    expect(count('SELECT count(*) n FROM runs')).toBe(2);
    expect(count('SELECT count(*) n FROM external_jobs')).toBe(2);
  });

  it('answers 404 for an unknown id and 401 without a token', async () => {
    const res = await run('nope');
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/No collector "nope".*hermes-cron/);
    expect((await run('claude', null)).status).toBe(401);
  });
});

describe('middle-manager import <id>', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mm-import-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('runs board, mirror and agent collectors, not just plan collectors', async () => {
    const f = fixtures(dir);
    const cfg = path.join(dir, 'mm.yaml');
    // Only collectors that need no host access: the CLI uses the real host hooks.
    const collectors = f.collectors.filter((c) =>
      ['csv', 'hermes-kanban', 'hermes-cron', 'tokens'].includes(c.id),
    );
    writeFileSync(
      cfg,
      JSON.stringify({
        site: { name: 'T' },
        database: { path: path.join(dir, 'cli.db') },
        machines: f.machines,
        plans: [{ id: 'claude', name: 'Claude', provider: 'manual' }],
        collectors,
      }),
    );
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    const cli = (id: string) => runCli(['import', id, '--config', cfg], out);

    expect(await cli('hermes-kanban')).toBe(0);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ kind: 'hermes-kanban', boards: 1, cards: 1 });
    expect(await cli('hermes-cron')).toBe(0);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ kind: 'hermes-cron', ok: true, jobs: 1 });
    expect(await cli('tokens')).toBe(0);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ kind: 'session-tokens', ok: true });
    expect(await cli('csv')).toBe(0);
    expect(lines.at(-1)).toContain('added 1');

    expect(await cli('zzz')).toBe(2);
    expect(lines.at(-1)).toMatch(/No collector "zzz"\. Collectors: .*hermes-kanban.*hermes-cron/);
  });
});
