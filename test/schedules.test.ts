import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createToken } from '../server/auth.ts';
import type { Db } from '../server/db/index.ts';
import { HttpError } from '../server/http/app.ts';
import { runnableCollectors } from '../server/schedules/collectors.ts';
import { checkSchedule, nextRun } from '../server/schedules/cron.ts';
import {
  insertJob,
  listJobRuns,
  parseJobInput,
  runStatus,
  viewJob,
  type JobRow,
} from '../server/schedules/jobs.ts';
import {
  buildTimerJobs,
  listExternal,
  listSystemdTimers,
  parseHermesCron,
  parseShowMulti,
  parseTimerList,
  replaceExternal,
  runMirror,
  serviceStatus,
  timerSchedule,
  type ExternalJob,
  type MirrorEnv,
} from '../server/schedules/mirror.ts';
import {
  INTERRUPTED_NOTE,
  keepNewestRuns,
  recoverInterrupted,
  Scheduler,
  TIMEOUT_EXIT,
} from '../server/schedules/scheduler.ts';
import { startServer, type Running } from '../server/server.ts';
import { memoryDb, testConfig } from './helpers.ts';

const T0 = new Date('2026-11-19T12:00:00.000Z');

// ---- Synthetic fixtures (shapes of the real files, made-up content) ----

const HERMES_JOBS = JSON.stringify({
  updated_at: '2026-11-19T11:00:00+00:00',
  jobs: [
    {
      id: 'a1',
      name: 'Hourly digest',
      prompt: 'SECRET PROMPT TEXT that must not be mirrored',
      model: 'model-x',
      schedule: { kind: 'cron', expr: '0 * * * *', display: '0 * * * *' },
      enabled: true,
      state: 'scheduled',
      last_run_at: '2026-11-19T11:00:00+00:00',
      last_status: 'ok',
      next_run_at: '2026-11-19T12:00:00+00:00',
    },
    {
      id: 'b2',
      name: 'Sync sample site',
      script: 'sync_sample.py --token=abc123def456',
      schedule: { kind: 'interval', minutes: 15, display: 'every 15m' },
      enabled: false,
      state: 'paused',
      last_status: 'error',
      next_run_at: '2026-11-01T00:00:00+00:00',
    },
    {
      id: 'c3',
      name: 'One-off reminder',
      prompt: 'x',
      schedule: {
        kind: 'once',
        run_at: '2026-11-23T19:00:00-05:00',
        display: 'once at 2026-11-23 19:00',
      },
      enabled: true,
      state: 'scheduled',
      next_run_at: '2026-11-24T00:00:00+00:00',
    },
    { name: 'no id, skipped' },
  ],
});

const TIMERS_JSON = JSON.stringify([
  {
    next: 1795163400000000,
    left: 1,
    last: 1795077000000000,
    passed: 1,
    unit: 'nightly-backup.timer',
    activates: 'nightly-backup.service',
  },
  { next: 0, left: 0, last: 0, passed: 0, unit: 'poll.timer', activates: 'poll.service' },
]);

const TIMERS_SHOW = `Id=nightly-backup.timer
Description=Nightly backup of sample data
Unit=nightly-backup.service
ActiveState=active
TimersCalendar={ OnCalendar=*-*-* 08:30:00 UTC ; next_elapse=@1795163400 }
NextElapseUSecRealtime=@1795163400
LastTriggerUSec=@1795077000

Id=poll.timer
Description=Poll for changes
Unit=poll.service
ActiveState=active
TimersMonotonic={ OnUnitInactiveUSec=2min ; next_elapse=1d 2h }
TimersMonotonic={ OnBootUSec=1min ; next_elapse=1min }
NextElapseUSecRealtime=
LastTriggerUSec=@1795114537
`;

const SERVICES_SHOW = `Id=nightly-backup.service
ActiveState=inactive
Result=success
ExecMainStatus=0
ExecMainStartTimestamp=@1795077000
ExecMainExitTimestamp=@1795077060
ExecStart={ path=/usr/bin/backup ; argv[]=/usr/bin/backup --password=hunter22 /srv/data ; ignore_errors=no ; start_time=[@1795077000] ; stop_time=[@1795077060] ; pid=1 ; code=exited ; status=0 }

Id=poll.service
ActiveState=failed
Result=exit-code
ExecMainStatus=1
ExecMainStartTimestamp=@1795114537
ExecMainExitTimestamp=@1795115079
ExecStart={ path=/bin/sh ; argv[]=/bin/sh poll.sh ; ignore_errors=no ; start_time=[@1] ; stop_time=[@2] ; pid=2 ; code=exited ; status=1 }
`;

function fakeExec(json: boolean) {
  const calls: string[][] = [];
  const exec = (_file: string, args: string[]) => {
    calls.push(args);
    if (args.includes('list-timers')) {
      if (!json) return Promise.reject(new Error('unknown option --output'));
      return Promise.resolve(TIMERS_JSON);
    }
    if (args.includes('list-units'))
      return Promise.resolve('nightly-backup.timer loaded active waiting x\npoll.timer loaded\n');
    if (args.some((a) => a.includes('TimersCalendar'))) return Promise.resolve(TIMERS_SHOW);
    return Promise.resolve(SERVICES_SHOW);
  };
  return { exec, calls };
}

// ---- cron ----

describe('cron expressions', () => {
  it('lists next runs in the job time zone', () => {
    const c = checkSchedule('0 9 * * 1', 'America/New_York', 2, T0);
    expect(c).toEqual({ ok: true, next: ['2026-11-23T14:00:00.000Z', '2026-11-30T14:00:00.000Z'] });
    expect(nextRun('@hourly', 'UTC', T0)).toBe('2026-11-19T13:00:00.000Z');
  });

  it('rejects bad expressions, seconds fields and empty input', () => {
    expect(checkSchedule('bad', 'UTC').ok).toBe(false);
    const secs = checkSchedule('*/5 * * * * *', 'UTC');
    expect(secs.ok).toBe(false);
    expect(secs.error).toMatch(/5 parts/);
    expect(checkSchedule('  ', 'UTC').error).toMatch(/required/);
    expect(nextRun('bad', 'UTC')).toBeNull();
  });

  it('accepts an expression that never fires again, with no next run', () => {
    expect(checkSchedule('0 0 30 2 *', 'UTC', 3, T0)).toEqual({ ok: true, next: [] });
  });
});

// ---- job validation ----

describe('job input', () => {
  const config = testConfig({
    collectors: [{ id: 'boards', kind: 'hermes-kanban', path: '/nowhere' }],
  });
  const ids = ['boards'];
  const err = (body: unknown, existing?: JobRow) => {
    try {
      parseJobInput(body, config, ids, existing);
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      return (e as HttpError).message;
    }
    return 'no error';
  };

  it('fills defaults for a collector job', () => {
    expect(
      parseJobInput(
        { name: ' Boards ', schedule: '*/15 * * * *', collector_id: 'boards' },
        config,
        ids,
      ),
    ).toEqual({
      name: 'Boards',
      schedule: '*/15 * * * *',
      timezone: null,
      kind: 'collector',
      command: null,
      collector_id: 'boards',
      enabled: true,
      timeout_s: 300,
      notify: null,
    });
  });

  it('explains each mistake', () => {
    expect(err({ schedule: '* * * * *' })).toMatch(/name is required/);
    expect(err({ name: 'x' })).toMatch(/schedule is required/);
    expect(err({ name: 'x', schedule: 'nope', collector_id: 'boards' })).toMatch(/^schedule:/);
    expect(
      err({ name: 'x', schedule: '@daily', timezone: 'Mars/Base', collector_id: 'boards' }),
    ).toMatch(/time zone/);
    expect(err({ name: 'x', schedule: '@daily', kind: 'python' })).toMatch(/kind must be/);
    expect(err({ name: 'x', schedule: '@daily', collector_id: 'zzz' })).toMatch(
      /Unknown collector "zzz". Collectors: boards/,
    );
    expect(err({ name: 'x', schedule: '@daily', kind: 'shell' })).toMatch(/need a command/);
    expect(
      err({ name: 'x', schedule: '@daily', kind: 'shell', command: 'true', timeout_s: 0 }),
    ).toMatch(/timeout_s/);
    expect(err({ name: 'x', schedule: '@daily', collector_id: 'boards', enabled: 'yes' })).toMatch(
      /enabled/,
    );
    expect(err({ name: 'x', schedule: '@daily', collector_id: 'boards', cmd: 'x' })).toMatch(
      /Unknown field/,
    );
    expect(err([1])).toMatch(/JSON object/);
  });

  it('merges a patch onto the existing job', () => {
    const db = memoryDb(config);
    const job = insertJob(
      db,
      parseJobInput({ name: 'B', schedule: '@daily', collector_id: 'boards' }, config, ids),
      'tester',
      T0,
    );
    const patched = parseJobInput({ enabled: false, timeout_s: 60 }, config, ids, job);
    expect(patched).toMatchObject({ name: 'B', schedule: '@daily', enabled: false, timeout_s: 60 });
    expect(() =>
      insertJob(
        db,
        parseJobInput({ name: 'b', schedule: '@daily', collector_id: 'boards' }, config, ids),
        null,
      ),
    ).toThrow(/exists/);
  });

  it('lists runnable collectors: non-manual plans and known kinds', () => {
    const cfg = testConfig({
      plans: [
        { id: 'p1', name: 'P1', provider: 'codex-sessions', sessions_dir: '/nowhere' },
        { id: 'p2', name: 'P2', provider: 'manual' },
      ],
      collectors: [
        { id: 'cron', kind: 'hermes-cron' },
        { id: 'odd', kind: 'something-else' },
      ],
    });
    expect(runnableCollectors(cfg)).toEqual([
      { id: 'p1', kind: 'codex-sessions' },
      { id: 'cron', kind: 'hermes-cron' },
    ]);
  });
});

// ---- mirror ----

describe('Hermes cron mirror', () => {
  it('reads cron, interval and one-off jobs without copying prompts or secrets', () => {
    const jobs = parseHermesCron(HERMES_JOBS);
    expect(jobs.map((j) => j.external_id)).toEqual(['a1', 'b2', 'c3']);
    expect(jobs[0]).toEqual({
      external_id: 'a1',
      name: 'Hourly digest',
      schedule: '0 * * * *',
      timezone: null,
      command: 'agent prompt · model-x',
      enabled: true,
      last_run_at: '2026-11-19T11:00:00.000Z',
      last_status: 'ok',
      next_run_at: '2026-11-19T12:00:00.000Z',
    });
    // Paused: disabled, and its stale next run is not shown as upcoming.
    expect(jobs[1]).toMatchObject({ schedule: 'every 15 min', enabled: false, next_run_at: null });
    expect(jobs[1]?.command).not.toContain('abc123def456');
    expect(jobs[2]?.schedule).toBe('once at 2026-11-23 19:00');
    const bare = parseHermesCron(
      '[{"id":"x","schedule":{"kind":"once","run_at":"2026-11-23T19:00:00-05:00"}}]',
    );
    expect(bare[0]?.schedule).toBe('once at 2026-11-24T00:00:00.000Z');
    expect(JSON.stringify(jobs)).not.toContain('SECRET PROMPT');
  });

  it('rejects files that are not a jobs list', () => {
    expect(() => parseHermesCron('{')).toThrow(/not valid JSON/);
    expect(() => parseHermesCron('{"x":1}')).toThrow(/no "jobs" list/);
    expect(parseHermesCron('[]')).toEqual([]);
  });
});

describe('systemd timer mirror', () => {
  it('parses show output with repeated keys', () => {
    const t = parseShowMulti(TIMERS_SHOW);
    expect([...t.keys()]).toEqual(['nightly-backup.timer', 'poll.timer']);
    expect(timerSchedule(t.get('poll.timer')!)).toBe('OnUnitInactiveSec=2min; OnBootSec=1min');
    expect(timerSchedule(t.get('nightly-backup.timer')!)).toBe('OnCalendar=*-*-* 08:30:00 UTC');
  });

  it('describes the service result', () => {
    const s = parseShowMulti(SERVICES_SHOW);
    expect(serviceStatus(s.get('nightly-backup.service'))).toBe('ok');
    expect(serviceStatus(s.get('poll.service'))).toBe('failed (exit 1)');
    expect(serviceStatus({ Id: ['x'], ActiveState: ['activating'] })).toBe('running');
    expect(serviceStatus({ Id: ['x'], ActiveState: ['inactive'] })).toBeNull();
    expect(serviceStatus(undefined)).toBeNull();
  });

  it('builds jobs from list-timers JSON and masks secrets in commands', async () => {
    const { exec, calls } = fakeExec(true);
    const jobs = await listSystemdTimers('user', [], exec);
    expect(calls.every((a) => a[0] === '--user')).toBe(true);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toEqual({
      external_id: 'nightly-backup.timer',
      name: 'Nightly backup of sample data',
      schedule: 'OnCalendar=*-*-* 08:30:00 UTC',
      timezone: null,
      command: '/usr/bin/backup --password=*** /srv/data',
      enabled: true,
      last_run_at: '2026-11-19T08:30:00.000Z',
      last_status: 'ok',
      next_run_at: '2026-11-20T08:30:00.000Z',
    });
    expect(jobs[1]).toMatchObject({ last_status: 'failed (exit 1)', next_run_at: null });
  });

  it('falls back to list-units on older systemd and filters by prefix', async () => {
    const { exec, calls } = fakeExec(false);
    const jobs = await listSystemdTimers('system', ['nightly-'], exec);
    expect(calls.some((a) => a.includes('--user'))).toBe(false);
    expect(jobs.map((j) => j.external_id)).toEqual(['nightly-backup.timer']);
    expect(jobs[0]?.next_run_at).toBe('2026-11-20T08:30:00.000Z'); // from NextElapseUSecRealtime
  });

  it('parses list-timers JSON', () => {
    expect(parseTimerList(TIMERS_JSON)[1]).toEqual({
      unit: 'poll.timer',
      next: null,
      activates: 'poll.service',
    });
    expect(
      buildTimerJobs([{ unit: 'x.timer', next: null, activates: null }], new Map(), new Map()),
    ).toEqual([
      {
        external_id: 'x.timer',
        name: 'x.timer',
        schedule: null,
        timezone: null,
        command: 'x.service',
        enabled: true,
        last_run_at: null,
        last_status: null,
        next_run_at: null,
      },
    ]);
  });
});

describe('external_jobs store', () => {
  const job = (id: string, name = id): ExternalJob => ({
    external_id: id,
    name,
    schedule: '@daily',
    timezone: null,
    command: null,
    enabled: true,
    last_run_at: null,
    last_status: null,
    next_run_at: null,
  });

  it('upserts by external id, never duplicates, and drops vanished jobs', () => {
    const db = memoryDb();
    expect(replaceExternal(db, 'src', 'm1', [job('a'), job('b'), job('a')], T0)).toEqual({
      jobs: 2,
      removed: 0,
    });
    expect(
      replaceExternal(db, 'src', 'm1', [job('a', 'A renamed')], new Date(T0.getTime() + 1000)),
    ).toEqual({ jobs: 1, removed: 1 });
    replaceExternal(db, 'other', null, [job('a')], T0);
    const rows = db
      .prepare('SELECT source, external_id, name FROM external_jobs ORDER BY source')
      .all();
    expect(rows).toEqual([
      { source: 'other', external_id: 'a', name: 'a' },
      { source: 'src', external_id: 'a', name: 'A renamed' },
    ]);
  });

  it('keeps the last rows when a read fails, and marks them stale later', async () => {
    const config = testConfig({
      collectors: [{ id: 'hc', kind: 'hermes-cron', path: '/x/jobs.json', every_s: 60 }],
    });
    const db = memoryDb(config);
    const env = (text: string | null, now: Date): MirrorEnv => ({
      readFile: () => {
        if (text === null) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
        return text;
      },
      timers: () => Promise.resolve([]),
      now: () => now,
    });
    const c = config.collectors[0]!;
    expect(await runMirror(db, config, c, env(HERMES_JOBS, T0))).toMatchObject({
      ok: true,
      jobs: 3,
    });
    const failed = await runMirror(db, config, c, env(null, T0));
    expect(failed).toEqual({
      id: 'hc',
      kind: 'hermes-cron',
      ok: false,
      error: 'could not read jobs.json (ENOENT)',
    });
    expect(listExternal(db, config, T0)).toHaveLength(3);
    expect(listExternal(db, config, T0)[0]).toMatchObject({ kind: 'hermes-cron', stale: false });
    const later = new Date(T0.getTime() + 10 * 60_000);
    expect(listExternal(db, config, later).every((j) => j.stale)).toBe(true);
  });
});

// ---- runner ----

function shellJob(db: Db, command: string, extra: Partial<JobRow> = {}): JobRow {
  const config = testConfig();
  return insertJob(
    db,
    {
      ...parseJobInput(
        { name: extra.name ?? command.slice(0, 40), schedule: '@daily', kind: 'shell', command },
        config,
        [],
      ),
      timeout_s: extra.timeout_s ?? 30,
    },
    null,
  );
}

describe('scheduler runs', () => {
  it('runs a shell job and records exit code, output and trigger', async () => {
    const config = testConfig();
    const db = memoryDb(config);
    const s = new Scheduler(db, config);
    const job = shellJob(db, 'echo hello; echo oops >&2; exit 3');
    const { run, done } = s.run(job, 'manual', 'laptop');
    expect(run.ended_at).toBeNull();
    expect(s.isRunning(job.id)).toBe(true);
    expect(() => s.run(job, 'manual', null)).toThrow(/already running/);
    const r = await done;
    expect(s.isRunning(job.id)).toBe(false);
    expect(r).toMatchObject({ exit_code: 3, trigger: 'manual', actor: 'laptop', truncated: 0 });
    expect(r.output).toContain('hello');
    expect(r.output).toContain('oops');
    expect(runStatus(r)).toBe('failed');
    const view = viewJob(db, config, job, false);
    expect(view.last_run).toMatchObject({ status: 'failed', exit_code: 3 });
    expect(view.failed_24h).toBe(1);
    expect(view.next_run_at).not.toBeNull();
  });

  it('stops a job at its timeout', async () => {
    const config = testConfig();
    const db = memoryDb(config);
    const s = new Scheduler(db, config, { killGraceMs: 200 });
    const job = shellJob(db, 'echo started; sleep 20', { timeout_s: 1 });
    const t = Date.now();
    const r = await s.run(job, 'manual', null).done;
    expect(Date.now() - t).toBeLessThan(5000);
    expect(r.exit_code).toBe(TIMEOUT_EXIT);
    expect(r.output).toMatch(/started\n[\s\S]*timed out after 1 s/);
  });

  it('caps output while it streams', async () => {
    const config = testConfig({ retention: { job_output_kb: 1 } });
    const db = memoryDb(config);
    const s = new Scheduler(db, config);
    const job = shellJob(db, 'yes abcdefgh | head -c 200000');
    const r = await s.run(job, 'schedule', null).done;
    expect(r.exit_code).toBe(0);
    expect(r.truncated).toBe(1);
    expect(Buffer.byteLength(r.output ?? '')).toBeLessThanOrEqual(1024);
    expect(r.output).toMatch(/\[output truncated\]$/);
  });

  it('runs collector jobs through the dispatcher and reports failures', async () => {
    const config = testConfig({ collectors: [{ id: 'hc', kind: 'hermes-cron' }] });
    const db = memoryDb(config);
    let calls = 0;
    const s = new Scheduler(db, config, {
      runCollector: (_db, _cfg, id) => {
        calls++;
        return id === 'hc'
          ? Promise.resolve({ ok: true, jobs: 2 })
          : Promise.reject(new Error('boom'));
      },
    });
    const job = insertJob(
      db,
      parseJobInput({ name: 'mirror', schedule: '@hourly', collector_id: 'hc' }, config, ['hc']),
      null,
    );
    const ok = await s.run(job, 'manual', null).done;
    expect(ok.exit_code).toBe(0);
    expect(JSON.parse(ok.output ?? '')).toEqual({ ok: true, jobs: 2 });
    const bad = await s.run({ ...job, collector_id: 'zz' }, 'manual', null).done;
    expect(bad).toMatchObject({ exit_code: 1, output: 'collector zz: boom' });
    expect(calls).toBe(2);
  });

  it('keeps the newest runs per job and closes interrupted runs', () => {
    const db = memoryDb();
    const job = shellJob(db, 'true');
    const ins = db.prepare(
      'INSERT INTO job_runs (job_id, started_at, ended_at, exit_code, output) VALUES (?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < 5; i++)
      ins.run(job.id, `2026-11-19T0${i}:00:00Z`, `2026-11-19T0${i}:01:00Z`, 0, '');
    ins.run(job.id, '2026-11-19T09:00:00Z', null, null, 'partial');
    expect(keepNewestRuns(db, job.id, 3)).toBe(3);
    expect(recoverInterrupted(db, T0)).toBe(1);
    const runs = listJobRuns(db, job.id);
    expect(runs).toHaveLength(3);
    expect(runs[0]).toMatchObject({ ended_at: T0.toISOString(), exit_code: null });
    expect(runs[0]?.output).toBe(`partial\n${INTERRUPTED_NOTE}`);
    expect(runStatus(runs[0]!)).toBe('interrupted');
  });

  it('arms timers for enabled jobs only and follows edits', () => {
    const config = testConfig();
    const db = memoryDb(config);
    const s = new Scheduler(db, config);
    const a = shellJob(db, 'true', { name: 'a' });
    const b = shellJob(db, 'true', { name: 'b' });
    db.prepare('UPDATE jobs SET enabled = 0 WHERE id = ?').run(b.id);
    s.start();
    expect(s.armed()).toEqual([a.id]);
    db.prepare('UPDATE jobs SET enabled = 1 WHERE id = ?').run(b.id);
    db.prepare('UPDATE jobs SET enabled = 0 WHERE id = ?').run(a.id);
    s.sync(b.id);
    s.sync(a.id);
    expect(s.armed()).toEqual([b.id]);
    return s.stop().then(() => expect(s.armed()).toEqual([]));
  });
});

// ---- API ----

describe('schedules API', () => {
  let running: Running;
  let dir: string;
  const WRITE = 'mm_test-write-token';
  const SHELL = 'mm_test-shell-token';

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'mm-sched-'));
    const jobsFile = path.join(dir, 'jobs.json');
    writeFileSync(jobsFile, HERMES_JOBS);
    const config = testConfig({
      site: { name: 'Test fleet', timezone: 'America/New_York' },
      collectors: [{ id: 'hermes-cron', kind: 'hermes-cron', path: jobsFile }],
    });
    const db = memoryDb(config);
    createToken(db, 'writer', ['write'], T0, WRITE);
    createToken(db, 'sheller', ['write', 'jobs:shell'], T0, SHELL);
    running = await startServer({
      config,
      db,
      port: 0,
      host: '127.0.0.1',
      retention: false,
      agentCollectors: false,
      schedules: false,
    });
  });
  afterAll(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(method: string, p: string, body?: unknown, token: string | null = WRITE) {
    const res = await fetch(`${running.url}/api/v1${p}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Loose on purpose: the assertions below check the shape.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  it('validates external job filters', async () => {
    for (const query of ['status=bogus', 'kind=bogus', 'bogus=1']) {
      expect((await call('GET', '/external-jobs?' + query)).status).toBe(400);
    }
    expect((await call('GET', '/external-jobs?status=running&kind=systemd-timers')).status).toBe(
      200,
    );
  });
  it('creates, lists, edits, runs and deletes jobs with the right scopes', async () => {
    let res = await call('GET', '/jobs', undefined, null);
    expect(res.status).toBe(200);
    expect(res.body.jobs).toEqual([]);
    expect(res.body.collectors).toEqual([{ id: 'hermes-cron', kind: 'hermes-cron' }]);
    expect(res.body.site_timezone).toBe('America/New_York');

    const collectorJob = {
      name: 'Mirror cron',
      schedule: '*/10 * * * *',
      collector_id: 'hermes-cron',
    };
    expect((await call('POST', '/jobs', collectorJob, null)).status).toBe(401);
    res = await call('POST', '/jobs', collectorJob);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Mirror cron',
      kind: 'collector',
      enabled: true,
      created_by: 'writer',
      effective_timezone: 'America/New_York',
      running: false,
      last_run: null,
    });
    const cid = res.body.id as number;

    const shell = { name: 'Say hi', schedule: '0 4 * * *', kind: 'shell', command: 'echo hi' };
    res = await call('POST', '/jobs', shell);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/jobs:shell/);
    res = await call('POST', '/jobs', shell, SHELL);
    expect(res.status).toBe(201);
    const sid = res.body.id as number;

    // Editing a shell job, or turning a collector job into one, needs the scope too.
    expect((await call('PATCH', `/jobs/${sid}`, { enabled: false })).status).toBe(403);
    expect((await call('PATCH', `/jobs/${cid}`, { kind: 'shell', command: 'id' })).status).toBe(
      403,
    );
    res = await call('PATCH', `/jobs/${cid}`, { enabled: false });
    expect(res.body).toMatchObject({ enabled: false, next_run_at: null });
    expect((await call('PATCH', `/jobs/${cid}`, { name: 'say hi' })).status).toBe(409);
    expect((await call('POST', '/jobs', { ...collectorJob, schedule: 'x' })).body.error.code).toBe(
      'invalid',
    );

    // Run now with a write token; ?wait=1 answers with the finished run.
    res = await call('POST', `/jobs/${sid}/run?wait=1`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      exit_code: 0,
      trigger: 'manual',
      actor: 'writer',
    });
    expect(res.body.output).toBe('hi\n');
    res = await call('POST', `/jobs/${cid}/run`);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('running');
    await new Promise((r) => setTimeout(r, 200));
    res = await call('GET', `/jobs/${cid}/runs`, undefined, null);
    expect(res.body.runs[0]).toMatchObject({ status: 'ok', trigger: 'manual' });
    expect(JSON.parse(res.body.runs[0].output)).toMatchObject({ ok: true, jobs: 3 });

    res = await call('GET', '/jobs', undefined, null);
    const say = res.body.jobs.find((j: { id: number }) => j.id === sid);
    expect(say.last_run).toMatchObject({ status: 'ok', exit_code: 0 });
    expect(typeof say.last_run.duration_s).toBe('number');
    expect(say.next_run_at).toMatch(/T09:00:00.000Z$/); // 04:00 New York in winter

    expect((await call('GET', '/jobs/999', undefined, null)).status).toBe(404);
    expect((await call('GET', '/jobs/abc', undefined, null)).status).toBe(400);
    expect((await call('DELETE', `/jobs/${sid}`)).status).toBe(403);
    expect((await call('DELETE', `/jobs/${sid}`, undefined, SHELL)).body).toEqual({ deleted: sid });
    expect((await call('DELETE', `/jobs/${cid}`)).status).toBe(200);
    expect((await call('GET', '/jobs', undefined, null)).body.jobs).toEqual([]);
  });

  it('previews a schedule', async () => {
    let res = await call(
      'GET',
      '/jobs/preview?schedule=0%209%20*%20*%201&timezone=UTC',
      undefined,
      null,
    );
    expect(res.body.ok).toBe(true);
    expect(res.body.next).toHaveLength(3);
    res = await call('GET', '/jobs/preview?schedule=nope', undefined, null);
    expect(res.body).toMatchObject({ ok: false, timezone: 'America/New_York' });
    res = await call('GET', '/jobs/preview?schedule=@daily&timezone=Mars/Base', undefined, null);
    expect(res.body.error).toMatch(/time zone/);
  });

  it('mirrors external schedulers on refresh, read-only', async () => {
    expect((await call('POST', '/external-jobs/refresh', {}, null)).status).toBe(401);
    let res = await call('POST', '/external-jobs/refresh', {});
    expect(res.body.collectors).toEqual([
      { id: 'hermes-cron', kind: 'hermes-cron', ok: true, jobs: 3, removed: 0 },
    ]);
    await call('POST', '/external-jobs/refresh', {});
    res = await call('GET', '/external-jobs', undefined, null);
    expect(res.body.jobs).toHaveLength(3);
    const filtered = await call('GET', '/external-jobs?kind=hermes-cron&status=error');
    expect(filtered.body.jobs).toMatchObject([{ name: 'Sync sample site' }]);
    const otherKind = await call('GET', '/external-jobs?kind=systemd-timers&status=error');
    expect(otherKind.body.jobs).toEqual([]);
    expect(res.body.jobs[0]).toMatchObject({ source: 'hermes-cron', stale: false });
    expect(JSON.stringify(res.body)).not.toContain('SECRET PROMPT');
    expect((await call('POST', '/external-jobs', {})).status).toBe(405);
  });
});
