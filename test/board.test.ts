import { createToken } from '../server/auth.ts';
import { startServer } from '../server/server.ts';
import { testConfig } from './helpers.ts';
import { test, expect } from 'vitest';
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
