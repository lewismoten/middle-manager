// Read-only mirror of other schedulers (SPEC 5 external_jobs), so every scheduled thing shows on
// one page. Configured as collectors:
//   - { id: hermes-cron, kind: hermes-cron, path: ~/.hermes/cron/jobs.json, every_s?: 300 }
//   - { id: timers, kind: systemd-timers, scope?: user | system, prefix?: [backup-, ...], every_s? }
// Each import replaces that source's rows (upsert by external id, drop the ones that vanished), so
// re-reading never duplicates a job. A failed read keeps the last rows; their read_at shows the age.
// Nothing here can start, stop or edit the mirrored jobs.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { CollectorConfig, Config } from '../config.ts';
import { expandHome } from '../config.ts';
import type { Db } from '../db/index.ts';
import { collectorMachine } from '../agents/collect.ts';
import { redactSecrets } from '../agents/process-scan.ts';
import { parseExecStart, parseSystemdTime } from '../agents/systemd.ts';

export const MIRROR_KINDS = ['hermes-cron', 'systemd-timers'] as const;
export const DEFAULT_MIRROR_EVERY_S = 300;

export interface ExternalJob {
  external_id: string;
  name: string;
  schedule: string | null;
  timezone: string | null;
  command: string | null;
  enabled: boolean;
  last_run_at: string | null;
  last_status: string | null;
  next_run_at: string | null;
}

export interface MirrorReport {
  id: string;
  kind: string;
  ok: boolean;
  error?: string;
  jobs?: number;
  removed?: number;
}

const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

// ---- Hermes cron (jobs.json) ----

/**
 * Parses Hermes's cron/jobs.json ({ jobs: [...] } or a bare list). Prompts are not copied: the
 * page is readable by anyone on the network, so an agent job shows as "agent prompt" only.
 */
export function parseHermesCron(text: string): ExternalJob[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('jobs.json is not valid JSON');
  }
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { jobs?: unknown }).jobs)
      ? (data as { jobs: unknown[] }).jobs
      : null;
  if (!list) throw new Error('jobs.json has no "jobs" list');
  const out: ExternalJob[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const j = raw as Record<string, unknown>;
    const id = str(j.id) ?? (typeof j.id === 'number' ? String(j.id) : null);
    if (!id) continue;
    const s = (j.schedule && typeof j.schedule === 'object' ? j.schedule : {}) as Record<
      string,
      unknown
    >;
    let schedule: string | null = null;
    if (s.kind === 'cron') schedule = str(s.expr);
    else if (s.kind === 'interval' && typeof s.minutes === 'number')
      schedule = `every ${s.minutes} min`;
    // Hermes's own display ('once at 2026-11-23 19:00') reads better than an ISO time.
    else if (s.kind === 'once')
      schedule = str(s.display) ?? `once at ${iso(s.run_at) ?? str(s.run_at) ?? '?'}`;
    schedule ??= str(s.display) ?? str(j.schedule_display) ?? str(j.schedule);
    const state = str(j.state);
    const enabled = j.enabled !== false && state !== 'paused' && state !== 'completed';
    const script = str(j.script);
    const model = str(j.model);
    const command = script
      ? `script: ${redactSecrets(script)}`
      : `agent prompt${model ? ` · ${model}` : ''}`;
    let last_status = str(j.last_status);
    if (state === 'completed' && last_status === 'ok') last_status = 'ok (completed)';
    out.push({
      external_id: id,
      name: (str(j.name) ?? id).slice(0, 200),
      schedule,
      timezone: null,
      command,
      enabled,
      last_run_at: iso(j.last_run_at),
      last_status,
      next_run_at: enabled ? iso(j.next_run_at) : null,
    });
  }
  return out;
}

// ---- systemd timers ----

type Exec = (file: string, args: string[]) => Promise<string>;

const execText: Exec = async (file, args) => {
  const { stdout } = await promisify(execFile)(file, args, {
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
};

/** `systemctl show` output for several units: one map per block, repeated keys kept in order. */
export function parseShowMulti(text: string): Map<string, Record<string, string[]>> {
  const out = new Map<string, Record<string, string[]>>();
  for (const block of text.split(/\n\s*\n/)) {
    const p: Record<string, string[]> = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) (p[line.slice(0, i)] ??= []).push(line.slice(i + 1));
    }
    const id = p.Id?.[0];
    if (id) out.set(id, p);
  }
  return out;
}

/** "{ OnCalendar=*-*-* 03:30:00 UTC ; next_elapse=... }" -> "OnCalendar=*-*-* 03:30:00 UTC". */
export function timerSchedule(props: Record<string, string[]>): string | null {
  const parts: string[] = [];
  for (const key of ['TimersCalendar', 'TimersMonotonic']) {
    for (const v of props[key] ?? []) {
      const m = /^\{\s*([^=;]+)=([^;]*?)\s*;/.exec(v);
      // The unit file says OnBootSec=, systemctl shows OnBootUSec=.
      if (m?.[1] && m[2] !== undefined) parts.push(`${m[1].replace(/USec$/, 'Sec')}=${m[2]}`);
    }
  }
  return parts.length ? parts.join('; ') : null;
}

const first = (p: Record<string, string[]> | undefined, k: string) => p?.[k]?.[0];

/** The activated service's last result: running, ok, or "failed (exit 1)" and the like. */
export function serviceStatus(svc: Record<string, string[]> | undefined): string | null {
  if (!svc) return null;
  const state = first(svc, 'ActiveState');
  if (state === 'activating' || state === 'active' || state === 'reloading') {
    // A oneshot is "activating" while it runs; a long-lived service is "active".
    return 'running';
  }
  if (!parseSystemdTime(first(svc, 'ExecMainStartTimestamp'))) return null; // never ran
  const result = first(svc, 'Result');
  if (!result || result === 'success') return 'ok';
  const code = first(svc, 'ExecMainStatus');
  return result === 'exit-code' && code ? `failed (exit ${code})` : `failed (${result})`;
}

export interface ListedTimer {
  unit: string;
  next: string | null;
  activates: string | null;
}

/** `systemctl list-timers --output=json` (systemd 250+): times are microseconds since the epoch. */
export function parseTimerList(json: string): ListedTimer[] {
  const list = JSON.parse(json) as Record<string, unknown>[];
  return list
    .filter((t) => typeof t.unit === 'string')
    .map((t) => ({
      unit: t.unit as string,
      next: typeof t.next === 'number' && t.next > 0 ? new Date(t.next / 1000).toISOString() : null,
      activates: typeof t.activates === 'string' ? t.activates : null,
    }));
}

/** Combines the timer list with `show` output for the timers and the services they start. */
export function buildTimerJobs(
  listed: ListedTimer[],
  timers: Map<string, Record<string, string[]>>,
  services: Map<string, Record<string, string[]>>,
): ExternalJob[] {
  return listed.map((t): ExternalJob => {
    const tp = timers.get(t.unit);
    const serviceName = t.activates ?? first(tp, 'Unit') ?? t.unit.replace(/\.timer$/, '.service');
    const svc = services.get(serviceName);
    const command = parseExecStart(first(svc, 'ExecStart'));
    const enabled = (first(tp, 'ActiveState') ?? 'active') === 'active';
    return {
      external_id: t.unit,
      name: (first(tp, 'Description') || t.unit).slice(0, 200),
      schedule: tp ? timerSchedule(tp) : null,
      timezone: null,
      command: command ? redactSecrets(command).slice(0, 2000) : serviceName,
      enabled,
      last_run_at:
        parseSystemdTime(first(svc, 'ExecMainStartTimestamp')) ??
        parseSystemdTime(first(tp, 'LastTriggerUSec')),
      last_status: serviceStatus(svc),
      next_run_at: enabled
        ? (t.next ?? parseSystemdTime(first(tp, 'NextElapseUSecRealtime')))
        : null,
    };
  });
}

const TIMER_PROPS =
  'Id,Description,Unit,ActiveState,TimersCalendar,TimersMonotonic,NextElapseUSecRealtime,LastTriggerUSec';
const SERVICE_PROPS =
  'Id,ActiveState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,ExecStart';

export async function listSystemdTimers(
  scope: 'user' | 'system',
  prefixes: string[],
  exec: Exec = execText,
): Promise<ExternalJob[]> {
  const base = scope === 'user' ? ['--user', '--no-pager'] : ['--no-pager'];
  let listed: ListedTimer[];
  try {
    listed = parseTimerList(
      await exec('systemctl', [...base, 'list-timers', '--all', '--output=json']),
    );
  } catch {
    // Older systemd: no JSON for list-timers. Names only; next comes from `show`.
    const text = await exec('systemctl', [
      ...base,
      'list-units',
      '--all',
      '--plain',
      '--no-legend',
      '--type=timer',
    ]);
    listed = text
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0] ?? '')
      .filter((u) => u.endsWith('.timer'))
      .map((unit) => ({ unit, next: null, activates: null }));
  }
  if (prefixes.length) listed = listed.filter((t) => prefixes.some((p) => t.unit.startsWith(p)));
  if (!listed.length) return [];
  const show = (units: string[], props: string) =>
    exec('systemctl', [...base, 'show', '--timestamp=unix', `--property=${props}`, ...units]);
  const timers = parseShowMulti(
    await show(
      listed.map((t) => t.unit),
      TIMER_PROPS,
    ),
  );
  const serviceNames = [
    ...new Set(
      listed.map(
        (t) =>
          t.activates ??
          first(timers.get(t.unit), 'Unit') ??
          t.unit.replace(/\.timer$/, '.service'),
      ),
    ),
  ];
  const services = parseShowMulti(await show(serviceNames, SERVICE_PROPS));
  return buildTimerJobs(listed, timers, services);
}

// ---- Store ----

/** Replaces one source's rows: upsert what was read, delete what is gone. */
export function replaceExternal(
  db: Db,
  source: string,
  machine: string | null,
  jobs: ExternalJob[],
  now = new Date(),
): { jobs: number; removed: number } {
  const at = now.toISOString();
  const upsert = db.prepare(
    `INSERT INTO external_jobs (source, external_id, name, schedule, timezone, command, enabled,
       last_run_at, last_status, next_run_at, machine_id, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source, external_id) DO UPDATE SET name = excluded.name,
       schedule = excluded.schedule, timezone = excluded.timezone, command = excluded.command,
       enabled = excluded.enabled, last_run_at = excluded.last_run_at,
       last_status = excluded.last_status, next_run_at = excluded.next_run_at,
       machine_id = excluded.machine_id, read_at = excluded.read_at`,
  );
  db.exec('BEGIN');
  try {
    const seen = new Set<string>();
    for (const j of jobs) {
      if (seen.has(j.external_id)) continue; // a duplicate id in the source counts once
      seen.add(j.external_id);
      upsert.run(
        source,
        j.external_id,
        j.name,
        j.schedule,
        j.timezone,
        j.command,
        j.enabled ? 1 : 0,
        j.last_run_at,
        j.last_status,
        j.next_run_at,
        machine,
        at,
      );
    }
    const removed = Number(
      db.prepare('DELETE FROM external_jobs WHERE source = ? AND read_at <> ?').run(source, at)
        .changes,
    );
    db.exec('COMMIT');
    return { jobs: seen.size, removed };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Drops rows from sources no longer configured as mirror collectors. */
export function pruneUnconfigured(db: Db, config: Config): number {
  const ids = mirrorCollectors(config).map((c) => c.id);
  const marks = ids.map(() => '?').join(',');
  const sql = ids.length
    ? `DELETE FROM external_jobs WHERE source NOT IN (${marks})`
    : 'DELETE FROM external_jobs';
  return Number(db.prepare(sql).run(...ids).changes);
}

export interface MirrorEnv {
  readFile: (path: string) => string;
  timers: (scope: 'user' | 'system', prefixes: string[]) => Promise<ExternalJob[]>;
  now: () => Date;
}

export const defaultMirrorEnv = (): MirrorEnv => ({
  readFile: (p) => readFileSync(p, 'utf8'),
  timers: (scope, prefixes) => listSystemdTimers(scope, prefixes),
  now: () => new Date(),
});

export function mirrorCollectors(config: Config): CollectorConfig[] {
  return config.collectors.filter((c) => (MIRROR_KINDS as readonly string[]).includes(c.kind));
}

function prefixList(v: unknown): string[] {
  if (typeof v === 'string' && v) return [v];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [];
}

export async function runMirror(
  db: Db,
  config: Config,
  c: CollectorConfig,
  env: MirrorEnv = defaultMirrorEnv(),
): Promise<MirrorReport> {
  const report: MirrorReport = { id: c.id, kind: c.kind, ok: true };
  try {
    let jobs: ExternalJob[];
    if (c.kind === 'hermes-cron') {
      const file = expandHome(typeof c.path === 'string' ? c.path : '~/.hermes/cron/jobs.json');
      let text: string;
      try {
        text = env.readFile(file);
      } catch (err) {
        // The path stays on the host; the code says enough (ENOENT, EACCES).
        throw new Error(
          `could not read jobs.json (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
          { cause: err },
        );
      }
      jobs = parseHermesCron(text);
    } else if (c.kind === 'systemd-timers') {
      jobs = await env.timers(c.scope === 'system' ? 'system' : 'user', prefixList(c.prefix));
    } else {
      throw new Error(`not a mirror collector kind: ${c.kind}`);
    }
    Object.assign(report, replaceExternal(db, c.id, collectorMachine(config, c), jobs, env.now()));
  } catch (err) {
    report.ok = false;
    report.error = (err as Error).message;
  }
  return report;
}

export async function runMirrors(
  db: Db,
  config: Config,
  env: MirrorEnv = defaultMirrorEnv(),
): Promise<MirrorReport[]> {
  pruneUnconfigured(db, config);
  const out: MirrorReport[] = [];
  for (const c of mirrorCollectors(config)) out.push(await runMirror(db, config, c, env));
  return out;
}

export function mirrorEvery(c: CollectorConfig): number {
  return Math.max(30, typeof c.every_s === 'number' ? c.every_s : DEFAULT_MIRROR_EVERY_S);
}

/** Reads every mirror at start, then each on its own interval. Returns a stop function. */
export function scheduleMirrors(
  db: Db,
  config: Config,
  onError: (msg: string) => void,
  env: MirrorEnv = defaultMirrorEnv(),
): () => void {
  pruneUnconfigured(db, config);
  const timers: NodeJS.Timeout[] = [];
  for (const c of mirrorCollectors(config)) {
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await runMirror(db, config, c, env);
        if (!r.ok) onError(`collector ${r.id} (${r.kind}): ${r.error}`);
      } finally {
        busy = false;
      }
    };
    void tick();
    const t = setInterval(() => void tick(), mirrorEvery(c) * 1000);
    t.unref();
    timers.push(t);
  }
  return () => timers.forEach(clearInterval);
}

export interface ExternalJobView extends ExternalJob {
  id: number;
  source: string;
  kind: string | null;
  machine_id: string | null;
  read_at: string;
  /** Not refreshed for over two read intervals: shown as stale, never as current. */
  stale: boolean;
}

export function listExternal(db: Db, config: Config, now = new Date()): ExternalJobView[] {
  const rows = db
    .prepare('SELECT * FROM external_jobs ORDER BY source, enabled DESC, name COLLATE NOCASE')
    .all() as unknown as (Omit<ExternalJobView, 'enabled' | 'stale' | 'kind'> & {
    enabled: number | null;
  })[];
  const bySource = new Map(config.collectors.map((c) => [c.id, c]));
  return rows.map((r) => {
    const c = bySource.get(r.source);
    const every = c ? mirrorEvery(c) : DEFAULT_MIRROR_EVERY_S;
    return {
      ...r,
      enabled: r.enabled === 1,
      kind: c?.kind ?? null,
      stale: now.getTime() - Date.parse(r.read_at) > 2 * every * 1000 + 30_000,
    };
  });
}
