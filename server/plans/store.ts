// plan_readings: validation, insert (with de-duplication) and queries.

import type { Db } from '../db/index.ts';
import { PLAN_WINDOWS } from '../config.ts';

export type PlanWindow = (typeof PLAN_WINDOWS)[number];

export interface NewReading {
  plan_id: string;
  window: PlanWindow;
  used_pct: number;
  resets_at: string | null;
  read_at: string;
  machine_id: string | null;
  how: string | null;
}

export interface StoredReading extends NewReading {
  id: number;
}

export class ReadingError extends Error {}

/** Parses an ISO 8601 time (with a zone) and returns it as UTC ISO text, or throws. */
export function isoTime(v: unknown, field: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    throw new ReadingError(`${field} must be an ISO 8601 time such as 2026-11-19T17:00:00Z`);
  }
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(v)) {
    throw new ReadingError(`${field} needs a time zone (Z or +hh:mm): "${v}"`);
  }
  const t = new Date(v);
  if (Number.isNaN(t.getTime())) throw new ReadingError(`${field} is not a valid time: "${v}"`);
  return t.toISOString();
}

const SHORT = /^[\w.:@-]{1,64}$/;

/** Validates one reading from the API or an import. `plan_id` is set by the caller. */
export function parseReading(
  raw: unknown,
  planId: string,
  defaults: { read_at: string; how: string; machine_id: string | null },
): NewReading {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReadingError('A reading must be an object');
  }
  const r = raw as Record<string, unknown>;
  const window = (r.window ?? 'weekly') as PlanWindow;
  if (!PLAN_WINDOWS.includes(window)) {
    throw new ReadingError(`window must be one of: ${PLAN_WINDOWS.join(', ')}`);
  }
  const used =
    typeof r.used_pct === 'string' && r.used_pct.trim() ? Number(r.used_pct) : r.used_pct;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) {
    throw new ReadingError('used_pct must be a number from 0 to 100');
  }
  const short = (v: unknown, field: string, dflt: string | null) => {
    if (v === undefined || v === null || v === '') return dflt;
    if (typeof v !== 'string' || !SHORT.test(v)) {
      throw new ReadingError(`${field} must be up to 64 letters, digits or . _ : @ -`);
    }
    return v;
  };
  return {
    plan_id: planId,
    window,
    used_pct: used,
    resets_at:
      r.resets_at === undefined || r.resets_at === null || r.resets_at === ''
        ? null
        : isoTime(r.resets_at, 'resets_at'),
    read_at:
      r.read_at === undefined || r.read_at === null || r.read_at === ''
        ? defaults.read_at
        : isoTime(r.read_at, 'read_at'),
    machine_id: short(r.machine_id ?? r.machine, 'machine_id', defaults.machine_id),
    how: short(r.how, 'how', defaults.how),
  };
}

/**
 * Inserts readings, skipping any that repeat an existing (plan, window, read_at, used_pct,
 * machine, how) row, so re-running a collector or re-importing a file does not duplicate history.
 * That is the reference burndown's point key: two reads at the same instant on the same machine
 * that disagree (or come from different tools) are both kept, as the reference keeps them.
 */
export function insertReadings(db: Db, readings: NewReading[]): { added: number; skipped: number } {
  const exists = db.prepare(
    `SELECT 1 FROM plan_readings WHERE plan_id = ? AND "window" = ? AND read_at = ?
       AND used_pct = ? AND machine_id IS ? AND how IS ? LIMIT 1`,
  );
  const insert = db.prepare(
    `INSERT INTO plan_readings (plan_id, "window", used_pct, resets_at, read_at, machine_id, how)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let added = 0;
  let skipped = 0;
  db.exec('BEGIN');
  try {
    for (const r of readings) {
      if (exists.get(r.plan_id, r.window, r.read_at, r.used_pct, r.machine_id, r.how)) {
        skipped++;
        continue;
      }
      insert.run(r.plan_id, r.window, r.used_pct, r.resets_at, r.read_at, r.machine_id, r.how);
      added++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { added, skipped };
}

/** Readings whose resets_at is within this of a window's reset belong to that window. */
const SAME_RESET_MS = 3 * 3600_000;

export function listReadings(
  db: Db,
  planId: string,
  opts: {
    since?: string;
    window?: string;
    limit?: number;
    /** Only readings of the window resetting at this time (resets_at within 3 h of it). */
    reset?: number;
    /** Thin the result to about this many readings (see downsample); never set for zoomed views. */
    maxPoints?: number;
  } = {},
): StoredReading[] {
  const where = ['plan_id = ?'];
  const args: (string | number)[] = [planId];
  if (opts.window) {
    where.push('"window" = ?');
    args.push(opts.window);
  }
  if (opts.since) {
    where.push('read_at >= ?');
    args.push(opts.since);
  }
  if (opts.reset !== undefined) {
    where.push('resets_at > ? AND resets_at < ?');
    args.push(
      new Date(opts.reset - SAME_RESET_MS).toISOString(),
      new Date(opts.reset + SAME_RESET_MS).toISOString(),
    );
  }
  args.push(opts.limit ?? 5000);
  const rows = db
    .prepare(
      `SELECT id, plan_id, "window", used_pct, resets_at, read_at, machine_id, how
         FROM plan_readings WHERE ${where.join(' AND ')}
        ORDER BY read_at DESC, id DESC LIMIT ?`,
    )
    .all(...args)
    .reverse() as unknown as StoredReading[];
  return opts.maxPoints ? downsample(rows, opts.maxPoints) : rows;
}

/**
 * Thins readings (oldest first) for a long chart: the span is cut into equal time buckets and
 * each keeps its highest reading and its newest one, so peaks and the shape survive. The first
 * and last readings are always kept. At most `max` readings come back (max >= 4).
 */
export function downsample<T extends { read_at: string; used_pct: number }>(
  rows: T[],
  max: number,
): T[] {
  if (rows.length <= max) return rows;
  const t = rows.map((r) => Date.parse(r.read_at));
  const t0 = t[0] as number;
  const span = (t[t.length - 1] as number) - t0;
  const buckets = Math.max(1, Math.floor((max - 2) / 2));
  const keep = new Uint8Array(rows.length);
  keep[0] = 1;
  keep[rows.length - 1] = 1;
  let i = 0;
  for (let b = 0; b < buckets && i < rows.length; b++) {
    const until = b === buckets - 1 ? Infinity : t0 + (span * (b + 1)) / buckets;
    let top = -1;
    let last = -1;
    for (; i < rows.length && (t[i] as number) < until; i++) {
      if (top < 0 || (rows[i] as T).used_pct > (rows[top] as T).used_pct) top = i;
      last = i;
    }
    if (top >= 0) keep[top] = 1;
    if (last >= 0) keep[last] = 1;
  }
  return rows.filter((_, k) => keep[k]);
}

export function latestReading(db: Db, planId: string, window: string): StoredReading | null {
  return (
    (db
      .prepare(
        `SELECT id, plan_id, "window", used_pct, resets_at, read_at, machine_id, how
           FROM plan_readings WHERE plan_id = ? AND "window" = ?
          ORDER BY read_at DESC, id DESC LIMIT 1`,
      )
      .get(planId, window) as unknown as StoredReading | undefined) ?? null
  );
}
