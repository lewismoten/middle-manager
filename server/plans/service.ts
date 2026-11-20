// Plan views for the API and the CLI: pacing per plan, past weeks, and running collectors.

import { readFileSync } from 'node:fs';
import { expandHome, type Config, type PlanConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { collectPlan, hostMachineId, type CollectOptions } from './collectors.ts';
import { MAX_CSV_BYTES, readingsFromCsv } from './csv.ts';
import {
  analyse,
  currentWindow,
  HOUR_MS,
  pace,
  pastWeeks,
  roundTo,
  STALE_AFTER_H,
  suggestedModel,
  type Mode,
  type PastWeek,
  type Reading,
} from './pacing.ts';
import {
  insertReadings,
  latestReading,
  parseReading,
  ReadingError,
  type NewReading,
  type StoredReading,
} from './store.ts';

const isoOf = (t: number) => new Date(t).toISOString();

export interface WeeklyPace {
  /** False when the newest reset seen is already past: waiting for a reading after the reset. */
  current: boolean;
  start: string;
  reset_at: string;
  target_empty_at: string;
  used_pct: number;
  even_pace_pct: number;
  hours_left: number;
  /** % per hour over the last 24 h of readings, and where that span starts. */
  rate_24h: number;
  rate_24h_since: string;
  /** Used + mode rate x hours left, capped at 100. */
  projected_pct: number;
  unused_pct: number;
  /** When the mode rate would reach 100%, if before the reset. */
  runs_out_at: string | null;
  mode: Mode;
  rate_pct_per_h: number;
  rate_basis_h: 3 | 24;
  need_pct_per_h: number;
  ratio: number | null;
  suggested_model: string | null;
  last_reading_at: string;
  reading_age_h: number;
  stale: boolean;
  readings: number;
}

export interface PlanPace {
  plan: string;
  name: string;
  provider: PlanConfig['provider'];
  empty_buffer_hours: number;
  models: string[];
  weekly: WeeklyPace | null;
  five_hour: StoredReading | null;
}

/** Weekly readings that belong to the current window, fetched the way currentWindow picks them. */
function windowReadings(db: Db, planId: string, now: number): Reading[] {
  const nowIso = isoOf(now);
  const pick = db.prepare(
    `SELECT MAX(resets_at) AS end FROM plan_readings
      WHERE plan_id = ? AND "window" = 'weekly' AND resets_at IS NOT NULL AND resets_at > ?`,
  );
  let end = (pick.get(planId, nowIso) as { end: string | null }).end;
  end ??= (pick.get(planId, '') as { end: string | null }).end;
  if (!end) return [];
  const t = new Date(end).getTime();
  return db
    .prepare(
      `SELECT read_at, used_pct, resets_at, machine_id, how FROM plan_readings
        WHERE plan_id = ? AND "window" = 'weekly' AND resets_at > ? AND resets_at < ?`,
    )
    .all(planId, isoOf(t - 3 * HOUR_MS), isoOf(t + 3 * HOUR_MS)) as unknown as Reading[];
}

export function planPace(db: Db, config: Config, plan: PlanConfig, now = Date.now()): PlanPace {
  const out: PlanPace = {
    plan: plan.id,
    name: plan.name,
    provider: plan.provider,
    empty_buffer_hours: plan.empty_buffer_hours,
    models: config.models[plan.id] ?? [],
    weekly: null,
    five_hour: plan.windows.includes('five_hour') ? latestReading(db, plan.id, 'five_hour') : null,
  };
  const w = currentWindow(windowReadings(db, plan.id, now), now);
  if (!w || !w.points.length) return out;
  const a = analyse(w, now);
  const p = pace(a, now, plan.empty_buffer_hours);
  const projected = roundTo(p.projected, 1);
  out.weekly = {
    current: a.end > now,
    start: isoOf(a.start),
    reset_at: isoOf(a.end),
    target_empty_at: isoOf(p.target_empty_at),
    used_pct: a.used,
    even_pace_pct: roundTo(a.pace, 1),
    hours_left: roundTo(a.left_h, 2),
    rate_24h: roundTo(a.rate, 3),
    rate_24h_since: isoOf(a.since),
    projected_pct: projected,
    unused_pct: roundTo(Math.min(100, Math.max(0, 100 - projected)), 1),
    runs_out_at: p.hit === null ? null : isoOf(p.hit),
    mode: p.mode,
    rate_pct_per_h: roundTo(p.rate, 3),
    rate_basis_h: p.rate_basis_h,
    need_pct_per_h: roundTo(p.need, 3),
    ratio: p.ratio === null ? null : roundTo(p.ratio, 2),
    suggested_model: suggestedModel(p.mode, out.models),
    last_reading_at: isoOf(a.last_t),
    reading_age_h: roundTo(a.stale_h, 1),
    stale: a.stale_h > STALE_AFTER_H,
    readings: a.points.length,
  };
  return out;
}

export function allPace(db: Db, config: Config, now = Date.now()) {
  return {
    generated: isoOf(now),
    plans: config.plans.map((p) => planPace(db, config, p, now)),
  };
}

export function planPastWeeks(db: Db, planId: string, now = Date.now(), limit = 20): PastWeek[] {
  const rows = db
    .prepare(
      `SELECT read_at, used_pct, resets_at FROM plan_readings
        WHERE plan_id = ? AND "window" = 'weekly' AND resets_at IS NOT NULL AND resets_at <= ?`,
    )
    .all(planId, isoOf(now + 3 * HOUR_MS)) as unknown as Reading[];
  return pastWeeks(rows, now).slice(0, limit);
}

export function planSummaries(db: Db, config: Config, now = Date.now()) {
  return config.plans.map((p) => {
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM plan_readings WHERE plan_id = ?')
      .get(p.id) as { n: number };
    return {
      id: p.id,
      name: p.name,
      provider: p.provider,
      windows: p.windows,
      empty_buffer_hours: p.empty_buffer_hours,
      models: config.models[p.id] ?? [],
      readings: Number(count.n),
      latest: Object.fromEntries(p.windows.map((w) => [w, latestReading(db, p.id, w)])),
      past_weeks: planPastWeeks(db, p.id, now),
    };
  });
}

// ---- Collectors: plan ids, "csv-import", or configured collectors of kind csv-import ----

export type CollectorTarget =
  | { kind: 'plan'; id: string; plan: PlanConfig }
  | { kind: 'csv-import'; id: string; path?: string; map: Record<string, string> };

export function resolveCollector(config: Config, id: string): CollectorTarget | null {
  const plan = config.plans.find((p) => p.id === id);
  if (plan) return { kind: 'plan', id, plan };
  const c = config.collectors.find((x) => x.id === id && x.kind === 'csv-import');
  if (c) {
    const map =
      c.map && typeof c.map === 'object' && !Array.isArray(c.map)
        ? Object.fromEntries(Object.entries(c.map).map(([k, v]) => [k, String(v)]))
        : {};
    return { kind: 'csv-import', id, path: typeof c.path === 'string' ? c.path : undefined, map };
  }
  if (id === 'csv-import') return { kind: 'csv-import', id, map: {} };
  return null;
}

export function planCollectorIds(config: Config): string[] {
  return [
    ...config.plans.map((p) => p.id),
    ...config.collectors.filter((c) => c.kind === 'csv-import').map((c) => c.id),
    'csv-import',
  ];
}

export interface CollectorInput {
  /** CSV text (API or CLI). */
  csv?: string;
  /** CSV file to read (CLI only; the API never reads a path it was sent). */
  file?: string;
  map?: Record<string, string>;
  /** A manual reading for a plan. */
  reading?: unknown;
}

export interface CollectorResult {
  collector: string;
  kind: string;
  added: number;
  skipped: number;
  readings: NewReading[];
  notes: string[];
}

export class CollectorInputError extends Error {}

export function importCsvText(
  db: Db,
  config: Config,
  text: string,
  map: Record<string, string> = {},
) {
  const parsed = readingsFromCsv(
    text,
    config.plans.map((p) => p.id),
    map,
  );
  const stored = insertReadings(db, parsed.readings);
  return { parsed, stored };
}

export async function runCollector(
  db: Db,
  config: Config,
  target: CollectorTarget,
  input: CollectorInput = {},
  opts: CollectOptions = {},
): Promise<CollectorResult> {
  const machineId = opts.machineId === undefined ? hostMachineId(config) : opts.machineId;
  const notes: string[] = [];
  if (target.kind === 'csv-import') {
    let text = input.csv;
    const file = input.file ?? target.path;
    if (text === undefined && file) {
      try {
        text = readFileSync(expandHome(file), 'utf8');
      } catch (err) {
        throw new CollectorInputError(
          `could not read the CSV file (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
        );
      }
    }
    if (text === undefined) {
      throw new CollectorInputError('csv-import needs CSV text ({"csv": "..."}) or --file <path>');
    }
    if (Buffer.byteLength(text) > MAX_CSV_BYTES) {
      throw new CollectorInputError('CSV is larger than 20 MB');
    }
    const { parsed, stored } = importCsvText(db, config, text, { ...target.map, ...input.map });
    const s = parsed.skipped;
    if (s.unknown_plan) notes.push(`${s.unknown_plan} rows for unknown plans (use a source map)`);
    if (s.other_window) notes.push(`${s.other_window} rows for other windows`);
    if (s.invalid) notes.push(`${s.invalid} invalid rows`, ...parsed.errors);
    return {
      collector: target.id,
      kind: 'csv-import',
      added: stored.added,
      skipped: stored.skipped + s.unknown_plan + s.other_window + s.invalid,
      readings: [],
      notes,
    };
  }
  const plan = target.plan;
  let readings: NewReading[];
  if (plan.provider === 'manual' || input.reading !== undefined) {
    if (input.reading === undefined) {
      throw new CollectorInputError(
        `plan ${plan.id} is manual: send a reading ({"window","used_pct","resets_at"})`,
      );
    }
    try {
      readings = [
        parseReading(input.reading, plan.id, {
          read_at: (opts.now ?? new Date()).toISOString(),
          how: 'manual',
          machine_id: machineId,
        }),
      ];
    } catch (err) {
      if (err instanceof ReadingError) throw new CollectorInputError(err.message);
      throw err;
    }
  } else {
    readings = await collectPlan(plan, { ...opts, machineId });
    if (!readings.length) notes.push('no reading found (nothing recent to read)');
  }
  const stored = insertReadings(db, readings);
  return {
    collector: target.id,
    kind: plan.provider,
    added: stored.added,
    skipped: stored.skipped,
    readings,
    notes,
  };
}
