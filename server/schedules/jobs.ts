// Jobs and job runs (SPEC 5): middle-manager's own schedules.
//   kind collector: runs a configured collector (built-in code only)
//   kind shell:     runs a command with /bin/sh as the service user; needs the jobs:shell scope

import { attentionFor, type Attention } from './attention.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { HttpError } from '../http/app.ts';
import { checkSchedule, nextRun } from './cron.ts';

export const JOB_KINDS = ['collector', 'shell'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const MAX_TIMEOUT_S = 24 * 3600;
const NAME_MAX = 80;
const COMMAND_MAX = 4000;

export interface JobRow {
  id: number;
  name: string;
  schedule: string;
  timezone: string | null;
  kind: JobKind;
  command: string | null;
  collector_id: string | null;
  enabled: number;
  timeout_s: number;
  notify: string | null;
  created_by: string | null;
  created_at: string;
}

export interface JobRunRow {
  id: number;
  job_id: number;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  output: string | null;
  truncated: number;
  trigger: string | null;
  actor: string | null;
}

export type RunStatus = 'running' | 'ok' | 'failed' | 'interrupted';

export function runStatus(r: Pick<JobRunRow, 'ended_at' | 'exit_code'>): RunStatus {
  if (!r.ended_at) return 'running';
  if (r.exit_code === null) return 'interrupted';
  return r.exit_code === 0 ? 'ok' : 'failed';
}

export interface RunSummary {
  id: number;
  started_at: string;
  ended_at: string | null;
  duration_s: number | null;
  exit_code: number | null;
  status: RunStatus;
  trigger: string | null;
  actor: string | null;
  truncated: boolean;
}

export function summarizeRun(r: JobRunRow): RunSummary {
  return {
    id: r.id,
    started_at: r.started_at,
    ended_at: r.ended_at,
    duration_s: r.ended_at
      ? Math.max(0, (Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000)
      : null,
    exit_code: r.exit_code,
    status: runStatus(r),
    trigger: r.trigger,
    actor: r.actor,
    truncated: r.truncated === 1,
  };
}

export interface JobView extends Omit<JobRow, 'enabled'> {
  attention: Attention;
  enabled: boolean;
  /** The time zone the schedule is read in (the job's, else the site's). */
  effective_timezone: string;
  next_run_at: string | null;
  last_run: RunSummary | null;
  running: boolean;
  failed_24h: number;
}

// ---- Validation ----

export interface JobInput {
  name: string;
  schedule: string;
  timezone: string | null;
  kind: JobKind;
  command: string | null;
  collector_id: string | null;
  enabled: boolean;
  timeout_s: number;
  notify: string | null;
}

function invalid(message: string): never {
  throw new HttpError(400, 'invalid', message);
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function optString(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') invalid(`${field} must be a string`);
  const s = v.trim();
  if (s.length > max) invalid(`${field} is longer than ${max} characters`);
  return s || null;
}

/**
 * Validates a create (no `existing`) or a patch (merged onto `existing`). Returns the full job.
 * `collectorIds` are the collectors a job may run.
 */
export function parseJobInput(
  body: unknown,
  config: Config,
  collectorIds: string[],
  existing?: JobRow,
): JobInput {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    invalid('Body must be a JSON object');
  const b = body as Record<string, unknown>;
  const allowed = [
    'name',
    'schedule',
    'timezone',
    'kind',
    'command',
    'collector_id',
    'enabled',
    'timeout_s',
    'notify',
  ];
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length)
    invalid(`Unknown field(s): ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`);
  const has = (k: string) => Object.hasOwn(b, k);

  const name = has('name') ? optString(b.name, 'name', NAME_MAX) : (existing?.name ?? null);
  if (!name) invalid('name is required');

  const schedule = has('schedule')
    ? optString(b.schedule, 'schedule', 120)
    : (existing?.schedule ?? null);
  if (!schedule) invalid('schedule is required, e.g. "0 * * * *" (hourly)');

  const timezone = has('timezone')
    ? optString(b.timezone, 'timezone', 64)
    : (existing?.timezone ?? null);
  if (timezone && !validTimezone(timezone))
    invalid(`timezone "${timezone}" is not a known IANA time zone (e.g. "America/New_York")`);
  const check = checkSchedule(schedule, timezone ?? config.site.timezone, 1);
  if (!check.ok) invalid(`schedule: ${check.error}`);

  const kindRaw = has('kind') ? b.kind : (existing?.kind ?? 'collector');
  if (!(JOB_KINDS as readonly unknown[]).includes(kindRaw))
    invalid(`kind must be one of: ${JOB_KINDS.join(', ')}`);
  const kind = kindRaw as JobKind;

  let command: string | null = null;
  let collector_id: string | null = null;
  if (kind === 'shell') {
    command = has('command')
      ? optString(b.command, 'command', COMMAND_MAX)
      : (existing?.command ?? null);
    if (!command) invalid('Shell jobs need a command');
    if (has('collector_id') && b.collector_id)
      invalid('Shell jobs take a command, not a collector_id');
  } else {
    collector_id = has('collector_id')
      ? optString(b.collector_id, 'collector_id', 64)
      : (existing?.collector_id ?? null);
    if (!collector_id) invalid('Collector jobs need a collector_id');
    if (!collectorIds.includes(collector_id))
      invalid(
        `Unknown collector "${collector_id}". Collectors: ${collectorIds.join(', ') || '(none configured)'}`,
      );
    if (has('command') && b.command) invalid('Collector jobs take a collector_id, not a command');
  }

  let enabled = existing ? existing.enabled === 1 : true;
  if (has('enabled')) {
    if (typeof b.enabled !== 'boolean') invalid('enabled must be true or false');
    enabled = b.enabled;
  }

  let timeout_s = existing?.timeout_s ?? 300;
  if (has('timeout_s')) {
    const t = b.timeout_s;
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > MAX_TIMEOUT_S)
      invalid(`timeout_s must be a whole number of seconds from 1 to ${MAX_TIMEOUT_S}`);
    timeout_s = t;
  }

  const notify = has('notify') ? optString(b.notify, 'notify', 200) : (existing?.notify ?? null);

  return { name, schedule, timezone, kind, command, collector_id, enabled, timeout_s, notify };
}

// ---- Store ----

export function getJob(db: Db, id: number): JobRow | null {
  return (db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow) ?? null;
}

export function mustGetJob(db: Db, id: number): JobRow {
  const job = getJob(db, id);
  if (!job) throw new HttpError(404, 'not_found', `No job ${id}`);
  return job;
}

function nameTaken(db: Db, name: string, exceptId?: number): boolean {
  return Boolean(
    db
      .prepare('SELECT 1 FROM jobs WHERE name = ? COLLATE NOCASE AND id <> ?')
      .get(name, exceptId ?? -1),
  );
}

export function insertJob(
  db: Db,
  input: JobInput,
  createdBy: string | null,
  now = new Date(),
): JobRow {
  if (nameTaken(db, input.name))
    throw new HttpError(409, 'conflict', `A job named "${input.name}" exists`);
  return db
    .prepare(
      `INSERT INTO jobs (name, schedule, timezone, kind, command, collector_id, enabled, timeout_s,
         notify, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      input.name,
      input.schedule,
      input.timezone,
      input.kind,
      input.command,
      input.collector_id,
      input.enabled ? 1 : 0,
      input.timeout_s,
      input.notify,
      createdBy,
      now.toISOString(),
    ) as unknown as JobRow;
}

export function updateJob(db: Db, id: number, input: JobInput): JobRow {
  if (nameTaken(db, input.name, id))
    throw new HttpError(409, 'conflict', `A job named "${input.name}" exists`);
  return db
    .prepare(
      `UPDATE jobs SET name = ?, schedule = ?, timezone = ?, kind = ?, command = ?, collector_id = ?,
         enabled = ?, timeout_s = ?, notify = ? WHERE id = ? RETURNING *`,
    )
    .get(
      input.name,
      input.schedule,
      input.timezone,
      input.kind,
      input.command,
      input.collector_id,
      input.enabled ? 1 : 0,
      input.timeout_s,
      input.notify,
      id,
    ) as unknown as JobRow;
}

export function deleteJob(db: Db, id: number): boolean {
  return Number(db.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes) > 0;
}

export function listJobRuns(db: Db, jobId: number, limit = 50): JobRunRow[] {
  return db
    .prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT ?')
    .all(jobId, Math.max(1, Math.min(limit, 500))) as unknown as JobRunRow[];
}

export function getJobRun(db: Db, runId: number): JobRunRow | null {
  return (
    (db.prepare('SELECT * FROM job_runs WHERE id = ?').get(runId) as unknown as JobRunRow) ?? null
  );
}

export function viewJob(
  db: Db,
  config: Config,
  job: JobRow,
  running: boolean,
  now = new Date(),
): JobView {
  const tz = job.timezone ?? config.site.timezone;
  const last = db
    .prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT 1')
    .get(job.id) as unknown as JobRunRow | undefined;
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const failed = db
    .prepare(
      `SELECT count(*) AS n FROM job_runs WHERE job_id = ? AND started_at >= ?
       AND ended_at IS NOT NULL AND (exit_code IS NULL OR exit_code <> 0)`,
    )
    .get(job.id, since) as { n: number };
  const next_run_at = job.enabled === 1 ? nextRun(job.schedule, tz, now) : null;
  const last_run = last ? summarizeRun(last) : null;
  return {
    ...job,
    enabled: job.enabled === 1,
    effective_timezone: tz,
    next_run_at,
    last_run,
    attention: attentionFor(
      {
        enabled: job.enabled === 1,
        schedule: job.schedule,
        timezone: tz,
        last_run_at: last_run?.started_at ?? null,
        last_status: running ? 'running' : (last_run?.status ?? null),
        next_run_at,
      },
      now,
    ),
    running,
    failed_24h: Number(failed.n),
  };
}

export function listJobs(db: Db): JobRow[] {
  return db.prepare('SELECT * FROM jobs ORDER BY name COLLATE NOCASE').all() as unknown as JobRow[];
}
