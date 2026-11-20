// Plan views for the API and the CLI: pacing per plan, past weeks, and running collectors.

import { readFileSync } from 'node:fs';
import { expandHome, type Config, type PlanConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { collectPlan, hostMachineId, type CollectOptions } from './collectors.ts';
import { MAX_CSV_BYTES, readingsFromCsv } from './csv.ts';
import {
  analyse,
  currentWindow,
  findWindow,
  planWindows,
  windowStats,
  type PlanWindow,
  HOUR_MS,
  pace,
  pastWeeks,
  roundTo,
  shortProjection,
  STALE_AFTER_H,
  suggestedModel,
  type Mode,
  type PastWeek,
  type Reading,
  type ShortProjection,
  type ShortReason,
  type ShortWindowH,
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

/** A projection at the rate over the last 1 or 2 hours (reported only; the mode never uses it). */
export interface ShortProjectionView {
  window_h: ShortWindowH;
  /** % per hour; null when the readings do not cover enough of the window (see reason). */
  rate_pct_per_h: number | null;
  /** The two readings the rate is measured between. */
  since: string | null;
  until: string | null;
  covered_h: number;
  projected_pct: number | null;
  /** When the plan reaches 100% at this rate, if before the reset. */
  runs_out_at: string | null;
  reason: ShortReason | null;
  reason_text: string | null;
}

export function shortProjectionView(s: ShortProjection): ShortProjectionView {
  return {
    window_h: s.window_h,
    rate_pct_per_h: s.rate === null ? null : roundTo(s.rate, 3),
    since: s.since === null ? null : isoOf(s.since),
    until: s.until === null ? null : isoOf(s.until),
    covered_h: roundTo(s.covered_h, 2),
    projected_pct: s.projected === null ? null : roundTo(s.projected, 1),
    runs_out_at: s.hit === null ? null : isoOf(s.hit),
    reason: s.reason,
    reason_text: s.reason_text,
  };
}

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
  /** Projection at the rate over the last 1 h of readings. */
  projection_1h: ShortProjectionView;
  /** Projection at the rate over the last 2 h of readings. */
  projection_2h: ShortProjectionView;
}

export interface PlanPace {
  plan: string;
  name: string;
  provider: PlanConfig['provider'];
  empty_buffer_hours: number;
  /** Length of the weekly window in hours. */
  window_hours: number;
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
    window_hours: plan.window_hours,
    models: config.models[plan.id] ?? [],
    weekly: null,
    five_hour: plan.windows.includes('five_hour') ? latestReading(db, plan.id, 'five_hour') : null,
  };
  const w = currentWindow(windowReadings(db, plan.id, now), now, plan.window_hours * HOUR_MS);
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
    projection_1h: shortProjectionView(shortProjection(a, now, 1)),
    projection_2h: shortProjectionView(shortProjection(a, now, 2)),
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

// ---- Windows: the current and past weekly windows of a plan ----

export interface WindowView {
  /** The window's reset time, ISO; use it to fetch the window's readings. */
  id: string;
  current: boolean;
  start: string;
  reset_at: string;
  length_h: number;
  readings: number;
  first_reading_at: string;
  last_reading_at: string;
  /** Used % at the newest reading (so far, for the current window). */
  final_pct: number;
  peak_pct: number;
  ran_out: boolean;
  ran_out_at: string | null;
  unused_pct: number;
  unused_h: number;
  locked_out_h: number | null;
  target_empty_at: string;
  target_gap_pct: number;
  ran_out_early_h: number | null;
  mean_vs_even_pct: number | null;
  mean_abs_vs_even_pct: number | null;
  partial: boolean;
}

const round = (v: number | null, d: number) => (v === null ? null : roundTo(v, d));

export function windowView(w: PlanWindow, emptyBufferHours: number): WindowView {
  const s = windowStats(w, emptyBufferHours);
  return {
    id: w.id,
    current: w.current,
    start: isoOf(w.start),
    reset_at: isoOf(w.end),
    length_h: roundTo(w.length_h, 2),
    readings: w.points.length,
    first_reading_at: isoOf((w.points[0] as { t: number }).t),
    last_reading_at: isoOf((w.points[w.points.length - 1] as { t: number }).t),
    final_pct: w.final,
    peak_pct: w.peak,
    ran_out: w.ran_out_at !== null,
    ran_out_at: w.ran_out_at === null ? null : isoOf(w.ran_out_at),
    unused_pct: roundTo(s.unused_pct, 1),
    unused_h: roundTo(s.unused_h, 1),
    locked_out_h: round(s.locked_out_h, 1),
    target_empty_at: isoOf(s.target_empty_at),
    target_gap_pct: roundTo(s.target_gap_pct, 1),
    ran_out_early_h: round(s.ran_out_early_h, 1),
    mean_vs_even_pct: round(s.mean_vs_even_pct, 1),
    mean_abs_vs_even_pct: round(s.mean_abs_vs_even_pct, 1),
    partial: w.partial,
  };
}

/** All weekly windows of a plan from its stored readings, newest first. */
export function windowsOf(db: Db, plan: PlanConfig, now = Date.now()): PlanWindow[] {
  const rows = db
    .prepare(
      `SELECT read_at, used_pct, resets_at, machine_id, how FROM plan_readings
        WHERE plan_id = ? AND "window" = 'weekly' AND resets_at IS NOT NULL`,
    )
    .all(plan.id) as unknown as Reading[];
  return planWindows(rows, now, plan.window_hours * HOUR_MS);
}

export function planWindowList(
  db: Db,
  plan: PlanConfig,
  opts: { now?: number; limit?: number; includeCurrent?: boolean } = {},
) {
  const all = windowsOf(db, plan, opts.now);
  const list = all.filter((w) => opts.includeCurrent !== false || !w.current);
  return {
    plan: plan.id,
    window_hours: plan.window_hours,
    empty_buffer_hours: plan.empty_buffer_hours,
    windows: list.slice(0, opts.limit ?? 52).map((w) => windowView(w, plan.empty_buffer_hours)),
  };
}

/** One window and its readings, by reset time (within the same-reset tolerance) or "current". */
export function planWindowDetail(db: Db, plan: PlanConfig, which: string, now = Date.now()) {
  const all = windowsOf(db, plan, now);
  const w =
    which === 'current'
      ? (all.find((x) => x.current) ?? null)
      : findWindow(all, new Date(which).getTime());
  if (!w) return null;
  return {
    plan: plan.id,
    window_hours: plan.window_hours,
    window: windowView(w, plan.empty_buffer_hours),
    readings: w.points.map((p) => ({
      read_at: isoOf(p.t),
      used_pct: p.used,
      machine_id: p.machine || null,
      how: p.how || null,
    })),
  };
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
