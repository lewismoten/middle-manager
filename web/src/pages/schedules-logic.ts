// Pure helpers for the Schedules page (tested with Vitest).

import { duration } from './agents-logic.ts';

export { duration };

export type RunStatus = 'running' | 'ok' | 'failed' | 'interrupted';

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

export interface JobRun extends RunSummary {
  job_id: number;
  output: string;
}

export type Attention = 'failed' | 'stuck' | 'overdue' | null;
export interface Job {
  attention: Attention;
  id: number;
  name: string;
  schedule: string;
  timezone: string | null;
  effective_timezone: string;
  kind: 'collector' | 'shell';
  command: string | null;
  collector_id: string | null;
  enabled: boolean;
  timeout_s: number;
  notify: string | null;
  created_by: string | null;
  created_at: string;
  next_run_at: string | null;
  last_run: RunSummary | null;
  running: boolean;
  failed_24h: number;
}

export interface JobsResponse {
  now: string;
  site_timezone: string;
  jobs: Job[];
  failed_24h: number;
  collectors: { id: string; kind: string }[];
}

export interface ExternalJob {
  attention: Attention;
  id: number;
  source: string;
  kind: string | null;
  external_id: string;
  name: string;
  schedule: string | null;
  timezone: string | null;
  command: string | null;
  enabled: boolean;
  last_run_at: string | null;
  last_status: string | null;
  next_run_at: string | null;
  machine_id: string | null;
  read_at: string;
  stale: boolean;
}

export type Tone = 'doing' | 'done' | 'block' | 'muted';

/** "in 5m 03s", "2h 10m ago", "now". */
export function relTime(iso: string | null, nowMs: number): string {
  if (!iso) return '–';
  const diff = (Date.parse(iso) - nowMs) / 1000;
  if (Math.abs(diff) < 1) return 'now';
  return diff > 0 ? `in ${duration(diff)}` : `${duration(-diff)} ago`;
}

export function runTone(status: RunStatus): Tone {
  if (status === 'running') return 'doing';
  if (status === 'ok') return 'done';
  return 'block';
}

/** Mirrored jobs report free-form status: ok, error, failed (exit 1), running, delivery_queued… */
export function externalTone(status: string | null): Tone {
  if (!status) return 'muted';
  if (status === 'running') return 'doing';
  if (/^(ok|success)/.test(status)) return 'done';
  if (/^(error|fail)/.test(status)) return 'block';
  return 'muted';
}

export function kindLabel(job: Pick<Job, 'kind' | 'collector_id'>): string {
  return job.kind === 'shell' ? 'shell' : `collector · ${job.collector_id ?? '?'}`;
}

export function sourceLabel(kind: string | null): string {
  if (kind === 'hermes-cron') return 'Hermes cron';
  if (kind === 'systemd-timers') return 'systemd timers';
  return kind ?? 'unconfigured source';
}

export interface ExternalGroup {
  source: string;
  kind: string | null;
  machine_id: string | null;
  read_at: string;
  stale: boolean;
  jobs: ExternalJob[];
}

/** Groups adjacent mirrored jobs without changing their attention order; the group's read time is its oldest row's. */
export function groupExternal(jobs: ExternalJob[]): ExternalGroup[] {
  const groups: ExternalGroup[] = [];
  for (const j of jobs) {
    let g = groups.at(-1);
    if (!g || g.source !== j.source) {
      g = {
        source: j.source,
        kind: j.kind,
        machine_id: j.machine_id,
        read_at: j.read_at,
        stale: false,
        jobs: [],
      };
      groups.push(g);
    }
    g.jobs.push(j);
    if (j.read_at < g.read_at) g.read_at = j.read_at;
    g.stale ||= j.stale;
  }
  return groups;
}

export function summaryText(jobs: Job[], external: ExternalJob[]): string {
  const enabled = jobs.filter((j) => j.enabled).length;
  const running = jobs.filter((j) => j.running).length;
  const failed = jobs.reduce((n, j) => n + j.failed_24h, 0);
  const parts = [`${jobs.length} job${jobs.length === 1 ? '' : 's'}`, `${enabled} enabled`];
  if (running) parts.push(`${running} running`);
  if (failed) parts.push(`${failed} failed run${failed === 1 ? '' : 's'} in 24 h`);
  parts.push(`${external.length} mirrored`);
  return parts.join(' · ');
}

export interface FormValues {
  name: string;
  kind: string;
  collector_id: string;
  command: string;
  schedule: string;
  timezone: string;
  timeout_s: string;
  enabled: boolean;
}

/** Turns the form into a POST/PATCH body; the server does the real validation. */
export function formBody(v: FormValues): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: v.name.trim(),
    kind: v.kind,
    schedule: v.schedule.trim(),
    timezone: v.timezone.trim() || null,
    enabled: v.enabled,
  };
  if (v.kind === 'shell') {
    body.command = v.command.trim();
    body.collector_id = null;
  } else {
    body.collector_id = v.collector_id;
    body.command = null;
  }
  const t = Number(v.timeout_s);
  if (v.timeout_s.trim() && Number.isFinite(t)) body.timeout_s = Math.round(t);
  return body;
}

/** True while any job runs, so the page refreshes faster. */
export function anyRunning(jobs: Job[]): boolean {
  return jobs.some((j) => j.running || j.last_run?.status === 'running');
}
