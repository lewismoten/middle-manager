import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createToken } from '../server/auth.ts';
import {
  endVanishedPids,
  endVanishedUnits,
  firstLine,
  getRun,
  listRuns,
  mergeDiscovered,
  parseFilters,
  patchRun,
  startRun,
  applyTokenTotals,
} from '../server/agents/runs.ts';
import { normalizeRepo } from '../server/agents/projects.ts';
import { syncConfig, type Db } from '../server/db/index.ts';
import { startServer, type Running } from '../server/server.ts';
import { memoryDb, testConfig } from './helpers.ts';

const T0 = new Date('2026-11-19T12:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function addTask(db: Db, shortName: string): number {
  const res = db
    .prepare(
      `INSERT INTO tasks (short_name, title, status, created_at, updated_at)
       VALUES (?, ?, 'doing', ?, ?)`,
    )
    .run(shortName, `Task ${shortName}`, T0.toISOString(), T0.toISOString());
  return Number(res.lastInsertRowid);
}

describe('runs store', () => {
  it.each([
    'https://GitHub.com/org/name.git',
    'https://github.com/org/name',
    'git@GitHub.com:org/name.git',
    'git@github.com:org/name',
    'org/name',
  ])('normalizes %s', (url) => {
    expect(normalizeRepo(url)).toBe('github.com/org/name');
  });

  it('reads the origin of a worktree on write and during backfill', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mm-runs-'));
    const config = testConfig({ projects: [{ id: 'game', name: 'Game', repo: 'org/name' }] });
    const db = memoryDb(config);
    try {
      execFileSync('git', ['init', '-q', cwd]);
      execFileSync('git', ['-C', cwd, 'remote', 'add', 'origin', 'git@github.com:org/name.git']);
      const { run } = startRun(db, { worktree: cwd });
      expect(run.project_id).toBe('game');
      db.prepare("UPDATE runs SET origin = NULL, project_id = 'default' WHERE id = ?").run(run.id);
      syncConfig(db, config);
      expect(getRun(db, run.id)).toMatchObject({
        origin: 'git@github.com:org/name.git',
        project_id: 'game',
      });
    } finally {
      db.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('backfills discovered runs when the project configuration changes', () => {
    const db = memoryDb();
    const discovered = mergeDiscovered(db, 'server-1', 'process-scan', [
      {
        pid: 42,
        command: 'codex',
        agent_kind: 'codex',
        started_at: null,
        origin: 'git@github.com:org/name.git',
      },
    ]);
    const id = discovered.ids.get(42)!;
    expect(getRun(db, id).project_id).toBeNull();
    const config = testConfig({ projects: [{ id: 'gamemaker', name: 'Game', repo: 'org/name' }] });
    syncConfig(db, config);
    syncConfig(db, config);
    expect(getRun(db, id).project_id).toBe('gamemaker');
    syncConfig(db, testConfig());
    expect(getRun(db, id).project_id).toBeNull();
    db.close();
  });

  it('starts a run with defaults and resolves a task by short name', () => {
    const db = memoryDb();
    const taskId = addTask(db, 'fix-login');
    const { run, merged, warnings } = startRun(
      db,
      {
        machine_id: 'server-1',
        agent_kind: 'codex',
        model: 'm1',
        task: 'fix-login',
        prompt: 'Line one\nmore',
      },
      T0,
    );
    expect(merged).toBe(false);
    expect(warnings).toEqual([]);
    expect(run).toMatchObject({
      status: 'running',
      role: 'agent',
      started_at: T0.toISOString(),
      task_id: taskId,
      source: 'api',
    });
  });

  it('keeps the run but warns about an unknown task', () => {
    const db = memoryDb();
    const r = startRun(db, { task: 'nope' }, T0);
    expect(r.run.task_id).toBeNull();
    expect(r.warnings[0]).toMatch(/No task "nope"/);
  });

  it('rejects unknown fields, bad enums and bad parents', () => {
    const db = memoryDb();
    expect(() => startRun(db, { modle: 'x' })).toThrow(/Unknown field/);
    expect(() => startRun(db, { role: 'boss' })).toThrow(/role must be one of/);
    expect(() => startRun(db, { tokens_in: -1 })).toThrow(/whole number/);
    expect(() => startRun(db, { parent_run_id: 99 })).toThrow(/does not exist/);
    expect(() => startRun(db, { started_at: 'yesterday' })).toThrow(/not a valid time/);
  });

  it('defaults a child to sub-agent', () => {
    const db = memoryDb();
    const parent = startRun(db, { role: 'orchestrator' }, T0).run;
    const child = startRun(db, { parent_run_id: parent.id }, T0).run;
    expect(child.role).toBe('sub-agent');
    expect(getRun(db, parent.id, T0).children.map((c) => c.id)).toEqual([child.id]);
  });

  it('PATCH updates tokens and ends the run', () => {
    const db = memoryDb();
    const { run } = startRun(db, {}, T0);
    patchRun(db, run.id, { tokens: { in: 10, out: 5, cache_read: 100 } }, at(1));
    const ended = patchRun(db, run.id, { status: 'done', summary: 'ok' }, at(10)).run;
    expect(ended).toMatchObject({
      tokens_in: 10,
      tokens_out: 5,
      tokens_cache_read: 100,
      status: 'done',
      ended_at: at(10).toISOString(),
    });
    const viaEnd = startRun(db, {}, T0).run;
    expect(patchRun(db, viaEnd.id, { end: true }, at(2)).run.status).toBe('done');
    expect(() => patchRun(db, 999, {})).toThrow(/No run 999/);
    expect(() => patchRun(db, run.id, { parent_run_id: run.id })).toThrow(/own parent/);
  });

  it('merges a reported run into a discovered process with the same machine and pid', () => {
    const db = memoryDb();
    mergeDiscovered(
      db,
      'server-1',
      'process-scan',
      [
        {
          pid: 4242,
          command: 'claude -p hi',
          agent_kind: 'claude-code',
          started_at: T0.toISOString(),
          branch: 'feature/x',
        },
      ],
      at(1),
    );
    const r = startRun(
      db,
      { machine_id: 'server-1', pid: 4242, model: 'opus', started_at: at(5).toISOString() },
      at(5),
    );
    expect(r.merged).toBe(true);
    expect(r.run).toMatchObject({
      model: 'opus',
      branch: 'feature/x',
      started_at: T0.toISOString(), // the process start time stays
      source: 'api+process-scan',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
  });

  it('collector merge never overwrites reported fields, links parents, and ends vanished pids', () => {
    const db = memoryDb();
    const reported = startRun(
      db,
      { machine_id: 'm', pid: 10, model: 'mine', branch: 'main' },
      T0,
    ).run;
    const res = mergeDiscovered(
      db,
      'm',
      'process-scan',
      [
        {
          pid: 10,
          command: 'codex exec x',
          agent_kind: 'codex',
          started_at: T0.toISOString(),
          model: 'other',
          branch: 'dev',
        },
        {
          pid: 11,
          command: 'claude -p y',
          agent_kind: 'claude-code',
          started_at: T0.toISOString(),
          parent_pid: 10,
        },
      ],
      at(1),
    );
    expect(res).toMatchObject({ inserted: 1, updated: 1 });
    const parent = getRun(db, reported.id, at(1));
    expect(parent).toMatchObject({ model: 'mine', branch: 'main', command: 'codex exec x' });
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]).toMatchObject({ role: 'sub-agent', pid: 11 });

    // Another machine's run with the same pid is not ours to end.
    startRun(db, { machine_id: 'other', pid: 11 }, T0);
    expect(endVanishedPids(db, 'm', new Map([[10, null]]), at(2))).toBe(1);
    const open = listRuns(db, { active: true }, at(2)).map((r) => [r.machine_id, r.pid]);
    expect(open.sort()).toEqual([
      ['m', 10],
      ['other', 11],
    ]);
  });

  it('recovers a stale discovered redirect prompt on the next scan', () => {
    const db = memoryDb();
    const worker = {
      pid: 41,
      unit: 'worker-review.service',
      command: 'codex exec',
      agent_kind: 'codex' as const,
      started_at: T0.toISOString(),
    };
    mergeDiscovered(db, 'm', 'systemd-workers', [{ ...worker, prompt: '2>' }], T0);
    expect(listRuns(db, {})[0]?.prompt_first_line).toBeNull();
    mergeDiscovered(
      db,
      'm',
      'systemd-workers',
      [{ ...worker, prompt: 'Review the release' }],
      at(1),
    );
    expect(listRuns(db, {})[0]?.prompt_first_line).toBe('Review the release');
  });

  it('treats a reused pid as a new process', () => {
    const db = memoryDb();
    mergeDiscovered(
      db,
      'm',
      'process-scan',
      [{ pid: 7, command: 'claude -p', agent_kind: 'claude-code', started_at: T0.toISOString() }],
      T0,
    );
    expect(endVanishedPids(db, 'm', new Map([[7, at(30).toISOString()]]), at(31))).toBe(1);
  });

  it('ends worker units that disappeared, only for the given prefix', () => {
    const db = memoryDb();
    mergeDiscovered(
      db,
      'm',
      'systemd-workers',
      [
        { pid: 1, unit: 'worker-a.service', command: 'a', agent_kind: 'other', started_at: null },
        { pid: 2, unit: 'other-b.service', command: 'b', agent_kind: 'other', started_at: null },
      ],
      T0,
    );
    expect(endVanishedUnits(db, 'm', 'worker-', new Set(), at(1))).toBe(1);
    expect(listRuns(db, { active: true }).map((r) => r.unit)).toEqual(['other-b.service']);
  });

  it('a failed unit closes its run', () => {
    const db = memoryDb();
    const d = {
      pid: 5,
      unit: 'worker-x.service',
      command: 'x',
      agent_kind: 'other' as const,
      started_at: T0.toISOString(),
    };
    mergeDiscovered(db, 'm', 'systemd-workers', [d], T0);
    mergeDiscovered(
      db,
      'm',
      'systemd-workers',
      [{ ...d, status: 'failed', ended_at: at(3).toISOString() }],
      at(4),
    );
    expect(listRuns(db, {})[0]).toMatchObject({ status: 'failed', ended_at: at(3).toISOString() });
  });

  it('token totals only grow', () => {
    const db = memoryDb();
    const { run } = startRun(db, { tokens_in: 500 }, T0);
    applyTokenTotals(
      db,
      run.id,
      { tokens_in: 100, tokens_out: 50, tokens_cache_read: 0, tokens_cache_write: 7 },
      { model: 'x', log_ref: 'codex:abc' },
    );
    expect(getRun(db, run.id)).toMatchObject({
      tokens_in: 500,
      tokens_out: 50,
      tokens_cache_write: 7,
      model: 'x',
      log_ref: 'codex:abc',
    });
  });

  it('lists with filters and finished-within window', () => {
    const db = memoryDb();
    const t = addTask(db, 'demo');
    startRun(
      db,
      { machine_id: 'a', model: 'small', role: 'review', task_id: t, project_id: 'p1' },
      T0,
    );
    const old = startRun(db, { machine_id: 'b', model: 'large' }, T0).run;
    patchRun(db, old.id, { status: 'failed' }, at(10));
    const ancient = startRun(db, { machine_id: 'b' }, T0).run;
    patchRun(db, ancient.id, { ended_at: at(-600).toISOString() }, at(1));

    const now = at(60);
    expect(listRuns(db, { active: true }, now)).toHaveLength(1);
    expect(listRuns(db, { finished_within_h: 2 }, now)).toHaveLength(2);
    expect(listRuns(db, {}, now)).toHaveLength(3);
    expect(listRuns(db, { model: 'small' }, now)).toHaveLength(1);
    expect(listRuns(db, { role: 'review', machine: 'a', project: 'p1' }, now)).toHaveLength(1);
    expect(listRuns(db, { task: 'demo' }, now)[0]?.task).toEqual({
      id: t,
      short_name: 'demo',
      title: 'Task demo',
    });
    expect(listRuns(db, { task: String(t) }, now)).toHaveLength(1);
    const live = listRuns(db, { active: true }, now)[0];
    expect(live?.duration_s).toBe(3600);
    expect(live).not.toHaveProperty('prompt');
  });

  it('parses filters and rejects bad ones', () => {
    expect(
      parseFilters(new URLSearchParams('active=1&machine=a&limit=5000&hours=6')),
    ).toMatchObject({
      active: true,
      machine: 'a',
      limit: 2000,
      finished_within_h: 6,
    });
    expect(() => parseFilters(new URLSearchParams('role=boss'))).toThrow(/role/);
    expect(() => parseFilters(new URLSearchParams('finished_within_h=-1'))).toThrow(/hours/);
  });

  it('firstLine skips blank lines and caps length', () => {
    expect(firstLine('\n\n  Fix the bug  \nthen more')).toBe('Fix the bug');
    expect(firstLine('x'.repeat(300))?.length).toBe(200);
    expect(firstLine(null)).toBeNull();
  });
});

describe('runs API', () => {
  let running: Running;
  let db: Db;
  let token: string;
  beforeAll(async () => {
    const config = testConfig({
      machines: [{ id: 'server-1', name: 'S1' }],
      projects: [{ id: 'gamemaker', name: 'Game', repo: 'org/name' }],
    });
    db = memoryDb(config);
    token = createToken(db, 'agent').token;
    running = await startServer({
      config,
      db,
      port: 0,
      host: '127.0.0.1',
      retention: false,
      agentCollectors: false,
    });
  });
  afterAll(async () => {
    await running.close();
    db.close();
  });

  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const res = await fetch(`${running.url}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('start, progress, end, read', async () => {
    const start = await call('POST', '/runs', {
      machine_id: 'server-1',
      agent_kind: 'claude-code',
      role: 'orchestrator',
      model: 'opus',
      prompt: 'Plan the sprint\nwith details',
      branch: 'feature/x',
    });
    expect(start.status).toBe(201);
    const id = start.body.id as number;
    expect(start.body).toMatchObject({
      status: 'running',
      prompt_first_line: 'Plan the sprint',
      merged: false,
    });

    const child = await call('POST', '/runs', {
      machine_id: 'server-1',
      parent_run_id: id,
      agent_kind: 'codex',
    });
    expect(child.body.role).toBe('sub-agent');

    const prog = await call('PATCH', `/runs/${id}`, { tokens_in: 1200, tokens_out: 300 });
    expect(prog.status).toBe(200);
    expect(prog.body).toMatchObject({ tokens_in: 1200, tokens_total: 1500 });

    const end = await call('PATCH', `/runs/${id}`, { status: 'done', summary: 'Shipped' });
    expect(end.body).toMatchObject({ status: 'done', summary: 'Shipped' });
    expect(end.body.ended_at).toBeTruthy();

    const list = await call('GET', '/runs?active=1', undefined, false);
    expect((list.body.runs as { id: number }[]).map((r) => r.id)).toEqual([child.body.id]);

    const finished = await call('GET', '/runs?finished=1');
    expect(finished.status).toBe(200);
    expect(finished.body.runs).toEqual([expect.objectContaining({ id })]);
    for (const query of ['status=bogus', 'finished=bogus', 'bogus=1']) {
      const rejected = await call('GET', '/runs?' + query);
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toMatchObject({ message: expect.any(String) });
    }
    const detail = await call('GET', `/runs/${id}`, undefined, false);
    expect(detail.body.prompt).toBe('Plan the sprint\nwith details');
    expect((detail.body.children as unknown[]).length).toBe(1);
  });

  it('merges by machine + pid with 200', async () => {
    mergeDiscovered(db, 'server-1', 'process-scan', [
      {
        pid: 999,
        command: 'codex exec go',
        agent_kind: 'codex',
        started_at: new Date().toISOString(),
      },
    ]);
    const r = await call('POST', '/runs', { machine_id: 'server-1', pid: 999, model: 'm' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ merged: true, source: 'api+process-scan', model: 'm' });
  });

  it('filters runs by the project matched from their origin', async () => {
    const matched = await call('POST', '/runs', { origin: 'git@github.com:org/name.git' });
    const other = await call('POST', '/runs', { origin: 'https://example.org/org/name' });
    expect(matched.body.project_id).toBe('gamemaker');
    expect(other.body.project_id).toBeNull();
    const list = await call('GET', '/runs?project=gamemaker');
    expect(list.body.runs).toEqual([expect.objectContaining({ id: matched.body.id })]);
    const changed = await call('PATCH', `/runs/${matched.body.id}`, {
      origin: 'git@github.com:other/name',
    });
    expect(changed.body.project_id).toBeNull();
  });

  it('needs a token to write and reports errors as {error}', async () => {
    expect((await call('POST', '/runs', {}, false)).status).toBe(401);
    const bad = await call('POST', '/runs', { role: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: { code: 'invalid' } });
    expect((await call('GET', '/runs/12345', undefined, false)).status).toBe(404);
    expect((await call('GET', '/runs/abc', undefined, false)).status).toBe(400);
    expect((await call('GET', '/runs?role=boss', undefined, false)).status).toBe(400);
  });

  it('scan with no agent collectors configured returns an empty list', async () => {
    const r = await call('POST', '/runs/scan', {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ collectors: [] });
  });
});
