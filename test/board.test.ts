import { createToken } from '../server/auth.ts';
import { startServer } from '../server/server.ts';
import { testConfig } from './helpers.ts';
import { test, expect, afterEach, describe, beforeEach } from 'vitest';
import { memoryDb } from './helpers.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardAge, projectOf } from '../web/src/pages/board-logic.ts';
import { importBoards } from '../server/board/import.ts';
test('imports multiple board schemas including WAL, preserves notes and stable identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'kanban-'));
  const db = memoryDb();
  const sources: DatabaseSync[] = [];
  try {
    for (const board of ['alpha', 'beta']) {
      const dir = join(root, board);
      mkdirSync(dir);
      const source = new DatabaseSync(join(dir, 'kanban.db'));
      sources.push(source);
      source.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
      source.exec(
        board === 'alpha'
          ? "CREATE TABLE cards(card_id,title,state,created_at); INSERT INTO cards VALUES(1,'First','in_progress',1700000000)"
          : "CREATE TABLE tasks(id,name,status);INSERT INTO tasks VALUES(1,'Second','todo')",
      );
    }
    expect(importBoards(db, root, { alpha: 'main' })).toEqual({ boards: 2, cards: 2 });
    const read = () => db.prepare('SELECT * FROM tasks ORDER BY external_ref').all();
    const before = read();
    expect(before[0]).toMatchObject({ external_ref: 'hermes-kanban:alpha:1', status: 'doing' });
    const fixture = {
      status: 'doing',
      source_created_at: '2023-11-14T22:13:20.000Z',
      status_since: null,
      project_id: 'main',
      external_ref: 'hermes-kanban:alpha:1',
    };
    expect(before[0]).toMatchObject(fixture);
    expect(projectOf(fixture)).toBe('main');
    expect(cardAge(fixture, 1700000000000 + 7 * 3600000)).toBe('age 7h');
    db.prepare(
      "INSERT INTO task_events(task_id,at,kind,data_json) VALUES(?,datetime('now'),'comment','{}')",
    ).run(before[0]!.id!);
    importBoards(db, root, { alpha: 'main' });
    expect(read()).toEqual(before);
    sources[0]!.exec("UPDATE cards SET state='done'");
    importBoards(db, root, { alpha: 'main' });
    expect(read()[0]).toMatchObject({ id: before[0]!.id, status: 'done' });
    expect(
      db
        .prepare('SELECT kind FROM task_events ORDER BY id')
        .all()
        .map((r) => r.kind),
    ).toEqual(['status', 'status', 'comment', 'status']);
  } finally {
    for (const source of sources) source.close();
    db.close();
    rmSync(root, { force: true, recursive: true });
  }
});

test('task HTTP contract combines filters, links runs and protects imported cards', async () => {
  const db = memoryDb();
  const config = testConfig();
  const token = createToken(db, 'writer').token;
  const app = await startServer({
    db,
    config,
    host: '127.0.0.1',
    port: 6163,
    retention: false,
    log: () => {},
  });
  const call = (path: string, method = 'GET', body?: unknown) =>
    fetch(app.url + '/api/v1' + path, {
      method,
      headers: method === 'GET' ? {} : { authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
  try {
    expect((await call('/tasks', 'POST', { title: '  ' })).status).toBe(400);
    const res = await call('/tasks', 'POST', {
      title: 'Test card',
      project_id: 'sample',
      assignee: 'worker',
      body: 'Match here',
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: number };
    const path = '/tasks/' + id;
    expect((await call(path, 'PATCH', { status: 'review' })).status).toBe(200);
    expect(
      await (await call('/tasks?project=sample&status=review&assignee=worker&q=MATCH')).json(),
    ).toMatchObject([{ id }]);
    expect(await (await call('/tasks?q=%25')).json()).toEqual([]);
    db.prepare(
      "INSERT INTO runs(task_id,started_at,branch) VALUES(?,datetime('now'),'sample-branch')",
    ).run(id);
    db.prepare("UPDATE tasks SET external_ref='hermes-kanban:sample:1' WHERE id=?").run(id);
    expect((await call(path, 'PATCH', { title: 'Updated' })).status).toBe(409);
    expect(
      (await call(path + '/events', 'POST', { kind: 'comment', data: { text: 'Local note' } }))
        .status,
    ).toBe(201);
    expect(await (await call(path)).json()).toMatchObject({
      id,
      title: 'Test card',
      runs: [{ branch: 'sample-branch' }],
      events: [{ kind: 'status' }, { kind: 'status', actor: 'writer' }, { kind: 'comment' }],
    });
    expect((await call('/tasks/9999')).status).toBe(404);
  } finally {
    await app.close();
    db.close();
  }
});

describe('agent task queue', () => {
  let db: ReturnType<typeof memoryDb>;
  let app: Awaited<ReturnType<typeof startServer>>;
  let url: string;
  beforeEach(async () => {
    db = memoryDb();
    app = await startServer({
      db,
      config: testConfig(),
      host: '127.0.0.1',
      port: 0,
      retention: false,
      log: () => {},
    });
    url = app.url + '/api/v1/tasks';
    const insert = db.prepare(
      "INSERT INTO tasks(title,status,priority,body,created_at,updated_at) VALUES('Work','todo',?,?,datetime('now'),datetime('now'))",
    );
    for (let i = 0; i < 8; i++)
      insert.run(i, i % 2 ? 'Preview\r\n' + 'x'.repeat(50000) : 'z'.repeat(50000));
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });
  const claim = (id: number, name: string, run?: number, query = '') =>
    fetch(url + '/' + id + '/claim' + query, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + createToken(db, name).token },
      body: run ? JSON.stringify({ run_id: run }) : undefined,
    });
  test('paginates long bodies with bounded first-line previews', async () => {
    const page = await (await fetch(url + '?limit=5')).text();
    expect(Buffer.byteLength(page)).toBeLessThan(20000);
    const rows = JSON.parse(page);
    expect(rows).toHaveLength(5);
    expect(rows[0].body_first_line).toBe('Preview');
    expect(rows[1].body_first_line).toBe('z'.repeat(256));
    expect(rows[0]).not.toHaveProperty('body');
    expect(await (await fetch(url + '?limit=2&offset=5')).json()).toMatchObject([
      { id: 3 },
      { id: 2 },
    ]);
  });
  test('rejects unknown query parameters', async () => {
    expect((await fetch(url + '?status=todo')).status).toBe(200);
    for (const path of ['?role=bogus', '?kind=bogus', '?status=bogus', '?bogus=1', '/next?bogus=1'])
      expect((await fetch(url + path)).status).toBe(400);
    expect((await claim(2, 'unknown-query', undefined, '?bogus=1')).status).toBe(400);
  });
  test('selects unblocked cards and commits exactly one concurrent claim with its run', async () => {
    db.exec(
      "INSERT INTO task_dependencies VALUES(1,2); INSERT INTO runs(started_at) VALUES(datetime('now'))",
    );
    expect((await fetch(url + '/next?project=absent')).status).toBe(204);
    expect(await (await fetch(url + '/next')).json()).toMatchObject({ id: 2 });
    expect((await claim(1, 'blocked')).status).toBe(409);
    const results = await Promise.all([claim(2, 'alpha', 1), claim(2, 'beta', 1)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const actor = results[0]!.status === 200 ? 'alpha' : 'beta';
    expect(await (await fetch(url + '/2')).json()).toMatchObject({
      claimed_by: actor,
      assignee: actor,
      status: 'doing',
      events: [{ actor, kind: 'status' }],
      runs: [{ id: 1, task_id: 2 }],
    });
    db.exec("UPDATE tasks SET status='done' WHERE id=2");
    expect(await (await fetch(url + '/next')).json()).toMatchObject({ id: 1 });
  });
});
