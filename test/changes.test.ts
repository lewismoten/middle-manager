import { expect, test } from 'vitest';
import type { Changes } from '../shared/changes.ts';
import { startServer } from '../server/server.ts';
import { testConfig } from './helpers.ts';

test('visit changes use an exclusive event cutoff and an inclusive plan baseline', async () => {
  const app = await startServer({
    config: testConfig({ plans: [{ id: 'p', name: 'Plan', provider: 'manual' }] }),
    port: 0,
    retention: false,
    agentCollectors: false,
    schedules: false,
  });
  const db = app.state.db;
  const before = '2024-01-01T11:59:59.999Z';
  const since = '2024-01-01T12:00:00.000Z';
  const after = '2024-01-01T12:00:00.001Z';
  try {
    for (const [i, at] of [before, since, after].entries()) {
      db.prepare("INSERT INTO tasks(id,title,created_at,updated_at) VALUES(?,'Card',?,?)").run(
        i + 1,
        before,
        at,
      );
      db.prepare("INSERT INTO task_events(task_id,kind,at,data_json) VALUES(?,'status',?,?)").run(
        i + 1,
        at,
        JSON.stringify({ from: 'todo', to: 'doing' }),
      );
      db.prepare(
        "INSERT INTO jobs(id,name,kind,schedule,created_at) VALUES(?,?,'collector','@daily',?)",
      ).run(i + 1, 'Job ' + i, before);
      db.prepare('INSERT INTO job_runs(job_id,started_at,ended_at,exit_code) VALUES(?,?,?,1)').run(
        i + 1,
        before,
        at,
      );
      db.prepare("INSERT INTO runs(status,started_at,ended_at) VALUES('done',?,?)").run(before, at);
      db.prepare(
        "INSERT INTO plan_readings(plan_id,window,read_at,used_pct) VALUES('p','weekly',?,?)",
      ).run(at, i * 4);
    }
    db.prepare("INSERT INTO task_events(task_id,kind,at,data_json) VALUES(1,'status',?,?)").run(
      after,
      JSON.stringify({ from: null, to: 'todo' }),
    );
    db.prepare('INSERT INTO job_runs(job_id,started_at,ended_at,exit_code) VALUES(2,?,?,1)').run(
      after,
      after,
    );
    for (let i = 0; i < 21; i++)
      db.prepare("INSERT INTO runs(status,started_at,ended_at) VALUES('failed',?,?)").run(
        before,
        after,
      );
    const url = app.url + '/api/v1/changes';
    for (const query of ['', '?since=yesterday'])
      expect((await fetch(url + query)).status).toBe(400);
    const changes = (await (await fetch(url + '?since=' + since)).json()) as Changes;
    expect(changes.cards).toEqual({ total: 1, items: [{ id: 3, title: 'Card', moved_at: after }] });
    expect(changes.jobs).toEqual({
      total: 1,
      items: [{ id: 3, name: 'Job 2', failing_since: after }],
    });
    expect(changes.runs.total).toBe(22);
    expect(changes.runs.items).toHaveLength(20);
    expect(changes.runs.items.every((r) => r.ended_at === after)).toBe(true);
    expect(changes.plans.items).toMatchObject([{ previous_pct: 4, used_pct: 8 }]);
  } finally {
    await app.close();
  }
});
