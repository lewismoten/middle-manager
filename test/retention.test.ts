import { describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION } from '../server/config.ts';
import { capOutput, runRetention, TRUNCATION_NOTE } from '../server/retention.ts';
import { memoryDb, testConfig } from './helpers.ts';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function seed() {
  const db = memoryDb(testConfig({ plans: [{ id: 'p', name: 'P', provider: 'manual' }] }));
  const reading = db.prepare(
    `INSERT INTO plan_readings (plan_id, "window", used_pct, read_at) VALUES ('p', 'weekly', 10, ?)`,
  );
  reading.run(daysAgo(121));
  reading.run(daysAgo(119));
  const run = db.prepare('INSERT INTO runs (status, started_at, ended_at) VALUES (?, ?, ?)');
  run.run('done', daysAgo(100), daysAgo(95)); // old, finished: goes
  run.run('done', daysAgo(10), daysAgo(9)); // recent: stays
  run.run('running', daysAgo(200), null); // still running: stays however old
  db.prepare(
    "INSERT INTO jobs (name, schedule, kind, created_at) VALUES ('a', '* * * * *', 'collector', 'x'), ('b', '* * * * *', 'collector', 'x')",
  ).run();
  const jr = db.prepare('INSERT INTO job_runs (job_id, started_at, output) VALUES (?, ?, ?)');
  for (let i = 0; i < 55; i++) jr.run(1, daysAgo(i / 24), `run ${i}`);
  for (let i = 0; i < 3; i++) jr.run(2, daysAgo(i), 'x'.repeat(70 * 1024));
  const audit = db.prepare(
    "INSERT INTO audit (at, token_name, method, path, status) VALUES (?, 't', 'POST', '/x', 201)",
  );
  audit.run(daysAgo(31));
  audit.run(daysAgo(29));
  return db;
}

describe('retention', () => {
  it('deletes rows past their rules and caps job output', () => {
    const db = seed();
    const r = runRetention(db, DEFAULT_RETENTION, NOW);
    expect(r).toEqual({
      at: NOW.toISOString(),
      deleted: { plan_readings: 1, runs: 1, job_runs: 5, audit: 1 },
      truncated_job_outputs: 3,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM plan_readings').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT status FROM runs ORDER BY id').all()).toEqual([
      { status: 'done' },
      { status: 'running' },
    ]);
    // Job 1 keeps its newest 50 runs (run 0 is newest).
    const kept = db
      .prepare('SELECT output FROM job_runs WHERE job_id = 1 ORDER BY started_at DESC')
      .all() as {
      output: string;
    }[];
    expect(kept).toHaveLength(50);
    expect(kept[0]?.output).toBe('run 0');
    expect(kept[49]?.output).toBe('run 49');
    const big = db.prepare('SELECT output, truncated FROM job_runs WHERE job_id = 2').all() as {
      output: string;
      truncated: number;
    }[];
    for (const row of big) {
      expect(Buffer.byteLength(row.output)).toBeLessThanOrEqual(64 * 1024);
      expect(row.output.endsWith(TRUNCATION_NOTE)).toBe(true);
      expect(row.truncated).toBe(1);
    }
  });

  it('is idempotent', () => {
    const db = seed();
    runRetention(db, DEFAULT_RETENTION, NOW);
    const again = runRetention(db, DEFAULT_RETENTION, NOW);
    expect(again.deleted).toEqual({ plan_readings: 0, runs: 0, job_runs: 0, audit: 0 });
    expect(again.truncated_job_outputs).toBe(0);
  });

  it('follows the configured numbers', () => {
    const db = seed();
    const r = runRetention(
      db,
      {
        ...DEFAULT_RETENTION,
        plan_readings_days: 1,
        runs_days: 1,
        job_runs_per_job: 1,
        events_days: 1,
      },
      NOW,
    );
    expect(r.deleted).toEqual({ plan_readings: 2, runs: 2, job_runs: 56, audit: 2 });
  });

  it('caps output without splitting characters', () => {
    expect(capOutput('short', 1)).toEqual({ output: 'short', truncated: false });
    const capped = capOutput('é'.repeat(2000), 1);
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(capped.output)).toBeLessThanOrEqual(1024);
    expect(capped.output).not.toContain('�');
  });
});
