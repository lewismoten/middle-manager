// Retention (SPEC 1.4): every table that grows has a rule, enforced daily.

import type { RetentionConfig } from './config.ts';
import type { Db } from './db/index.ts';

export interface RetentionResult {
  at: string;
  deleted: {
    plan_readings: number;
    runs: number;
    job_runs: number;
    audit: number;
  };
  truncated_job_outputs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function cutoff(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

export const TRUNCATION_NOTE = '\n[output truncated]';

/** Caps a job's output to `kb` kilobytes (UTF-8), keeping the start. */
export function capOutput(output: string, kb: number): { output: string; truncated: boolean } {
  const limit = kb * 1024;
  const buf = Buffer.from(output, 'utf8');
  if (buf.length <= limit) return { output, truncated: false };
  const keep = Math.max(0, limit - Buffer.byteLength(TRUNCATION_NOTE));
  // Cutting a Buffer can split a multi-byte character; toString replaces the fragment, so trim it.
  const head = buf.subarray(0, keep).toString('utf8').replace(/�+$/, '');
  return { output: head + TRUNCATION_NOTE, truncated: true };
}

/**
 * Deletes rows past their retention and caps oversized job output.
 * - plan_readings older than plan_readings_days (by read_at)
 * - finished runs that ended more than runs_days ago (running rows are kept)
 * - job_runs beyond the newest job_runs_per_job for each job
 * - audit rows older than events_days
 * - job_runs.output longer than job_output_kb is cut and marked truncated
 */
export function runRetention(db: Db, r: RetentionConfig, now = new Date()): RetentionResult {
  const result: RetentionResult = {
    at: now.toISOString(),
    deleted: { plan_readings: 0, runs: 0, job_runs: 0, audit: 0 },
    truncated_job_outputs: 0,
  };
  db.exec('BEGIN');
  try {
    result.deleted.plan_readings = Number(
      db
        .prepare('DELETE FROM plan_readings WHERE read_at < ?')
        .run(cutoff(now, r.plan_readings_days)).changes,
    );
    result.deleted.runs = Number(
      db
        .prepare('DELETE FROM runs WHERE ended_at IS NOT NULL AND ended_at < ?')
        .run(cutoff(now, r.runs_days)).changes,
    );
    result.deleted.job_runs = Number(
      db
        .prepare(
          `DELETE FROM job_runs WHERE id IN (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY started_at DESC, id DESC) AS n
               FROM job_runs
             ) WHERE n > ?
           )`,
        )
        .run(r.job_runs_per_job).changes,
    );
    result.deleted.audit = Number(
      db.prepare('DELETE FROM audit WHERE at < ?').run(cutoff(now, r.events_days)).changes,
    );
    const limit = r.job_output_kb * 1024;
    const big = db
      .prepare('SELECT id, output FROM job_runs WHERE length(CAST(output AS BLOB)) > ?')
      .all(limit) as { id: number; output: string }[];
    const update = db.prepare('UPDATE job_runs SET output = ?, truncated = 1 WHERE id = ?');
    for (const row of big) {
      update.run(capOutput(row.output, r.job_output_kb).output, row.id);
      result.truncated_job_outputs++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return result;
}

/** Runs retention now and then once a day. Returns a stop function. */
export function scheduleRetention(
  db: Db,
  r: RetentionConfig,
  onResult: (res: RetentionResult) => void,
  onError: (err: unknown) => void,
): () => void {
  const tick = () => {
    try {
      onResult(runRetention(db, r));
    } catch (err) {
      onError(err);
    }
  };
  tick();
  const timer = setInterval(tick, DAY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
