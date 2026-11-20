// Runs (SPEC 5 and 6): one row per agent run, reported through the API and/or discovered by
// collectors. A reported run and a discovered process with the same machine + pid are one run.

import type { Db } from '../db/index.ts';
import { HttpError } from '../http/app.ts';
import { matchProject, projectRepos, worktreeOrigin } from './projects.ts';

export const AGENT_KINDS = ['claude-code', 'codex', 'hermes', 'local', 'other'] as const;
export const ROLES = ['orchestrator', 'agent', 'sub-agent', 'review'] as const;
/** running is the only open status; the others close the run. ended = it vanished, outcome unknown. */
export const RUN_STATUSES = ['running', 'done', 'failed', 'cancelled', 'ended'] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];
export type Role = (typeof ROLES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunRow {
  id: number;
  machine_id: string | null;
  agent_kind: AgentKind;
  parent_run_id: number | null;
  role: Role;
  harness: string | null;
  model: string | null;
  provider: string | null;
  task_id: number | null;
  prompt: string | null;
  prompt_ref: string | null;
  project_id: string | null;
  origin: string | null;
  branch: string | null;
  worktree: string | null;
  pid: number | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  cost_note: string | null;
  log_ref: string | null;
  summary: string | null;
  command: string | null;
  source: string | null;
  unit: string | null;
  seen_at: string | null;
}

type Obj = Record<string, unknown>;

const TEXT_LIMITS: Record<string, number> = {
  machine_id: 64,
  harness: 200,
  model: 200,
  provider: 200,
  prompt: 64 * 1024,
  prompt_ref: 2000,
  project_id: 64,
  origin: 2000,
  branch: 500,
  worktree: 2000,
  cost_note: 2000,
  log_ref: 2000,
  summary: 16 * 1024,
  command: 4000,
};
const INT_FIELDS = [
  'pid',
  'parent_run_id',
  'tokens_in',
  'tokens_out',
  'tokens_cache_read',
  'tokens_cache_write',
] as const;
const TIME_FIELDS = ['started_at', 'ended_at'] as const;

/** Fields a client may set. id, source, unit and seen_at belong to the server and collectors. */
export const WRITABLE = [
  ...Object.keys(TEXT_LIMITS),
  ...INT_FIELDS,
  ...TIME_FIELDS,
  'agent_kind',
  'role',
  'status',
  'task_id',
  'task',
  'tokens',
  'end',
] as const;

function bad(message: string): never {
  throw new HttpError(400, 'invalid', message);
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toIso(v: unknown, key: string): string {
  if (typeof v !== 'string' && typeof v !== 'number') bad(`${key} must be an ISO time or epoch ms`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) bad(`${key} is not a valid time: ${JSON.stringify(v)}`);
  return d.toISOString();
}

export interface RunInput {
  fields: Partial<Record<keyof RunRow, string | number | null>>;
  /** A task reference by short name or external ref, resolved by the caller. */
  taskRef?: string;
  end?: boolean;
}

/** Validates a POST/PATCH body. Unknown keys are an error so typos are not silently dropped. */
export function parseRunInput(body: unknown): RunInput {
  if (body === undefined) body = {};
  if (!isObj(body)) bad('Body must be a JSON object');
  const unknown = Object.keys(body).filter((k) => !(WRITABLE as readonly string[]).includes(k));
  if (unknown.length) bad(`Unknown field(s): ${unknown.join(', ')}`);
  const fields: RunInput['fields'] = {};
  const out: RunInput = { fields };

  for (const [key, max] of Object.entries(TEXT_LIMITS)) {
    if (!(key in body)) continue;
    const v = body[key];
    if (v === null) fields[key as keyof RunRow] = null;
    else if (typeof v !== 'string') bad(`${key} must be a string`);
    else fields[key as keyof RunRow] = v.length > max ? v.slice(0, max) : v;
  }
  for (const key of INT_FIELDS) {
    if (!(key in body)) continue;
    const v = body[key];
    if (v === null) fields[key] = null;
    else if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
      bad(`${key} must be a whole number >= 0`);
    else fields[key] = v;
  }
  if (isObj(body.tokens)) {
    const map = {
      in: 'tokens_in',
      out: 'tokens_out',
      cache_read: 'tokens_cache_read',
      cache_write: 'tokens_cache_write',
    } as const;
    for (const [k, v] of Object.entries(body.tokens)) {
      const col = map[k as keyof typeof map];
      if (!col) bad(`tokens.${k} is not one of: ${Object.keys(map).join(', ')}`);
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
        bad(`tokens.${k} must be a whole number >= 0`);
      fields[col] = v;
    }
  } else if (body.tokens !== undefined) bad('tokens must be an object like {"in": 1, "out": 2}');
  for (const key of TIME_FIELDS) {
    if (!(key in body)) continue;
    fields[key] = body[key] === null ? null : toIso(body[key], key);
  }
  const oneOf = (key: 'agent_kind' | 'role' | 'status', allowed: readonly string[]) => {
    if (!(key in body)) return;
    const v = body[key];
    if (typeof v !== 'string' || !allowed.includes(v))
      bad(`${key} must be one of: ${allowed.join(', ')}`);
    fields[key] = v;
  };
  oneOf('agent_kind', AGENT_KINDS);
  oneOf('role', ROLES);
  oneOf('status', RUN_STATUSES);
  if ('task_id' in body || 'task' in body) {
    const v = body.task_id ?? body.task;
    if (v === null) fields.task_id = null;
    else if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) fields.task_id = v;
    else if (typeof v === 'string' && /^\d+$/.test(v)) fields.task_id = Number(v);
    else if (typeof v === 'string' && v.trim()) out.taskRef = v.trim().slice(0, 500);
    else bad('task_id must be a task id, or task a short name / external ref');
  }
  if ('end' in body) {
    if (typeof body.end !== 'boolean') bad('end must be true or false');
    out.end = body.end;
  }
  return out;
}

export function getRunRow(db: Db, id: number): RunRow | undefined {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
}

function findTask(db: Db, ref: string): number | null {
  const row = db
    .prepare(
      'SELECT id FROM tasks WHERE short_name = ? OR external_ref = ? ORDER BY updated_at DESC LIMIT 1',
    )
    .get(ref, ref) as { id: number } | undefined;
  return row?.id ?? null;
}

/** Resolves task and parent references; returns warnings for things that were dropped. */
function resolveRefs(db: Db, input: RunInput): string[] {
  const warnings: string[] = [];
  const f = input.fields;
  if (input.taskRef !== undefined) {
    const id = findTask(db, input.taskRef);
    if (id === null) warnings.push(`No task "${input.taskRef}"; the run was saved without a task`);
    else f.task_id = id;
  }
  if (typeof f.task_id === 'number') {
    const ok = db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(f.task_id);
    if (!ok) {
      warnings.push(`No task with id ${f.task_id}; the run was saved without a task`);
      delete f.task_id;
    }
  }
  if (typeof f.parent_run_id === 'number' && !getRunRow(db, f.parent_run_id)) {
    bad(`parent_run_id ${f.parent_run_id} does not exist`);
  }
  return warnings;
}

/** Applies `end` and status rules: closing statuses get ended_at, an ended_at closes the run. */
function applyEnd(f: RunInput['fields'], end: boolean | undefined, now: string): void {
  if (end && !f.status) f.status = 'done';
  if (f.ended_at && (!f.status || f.status === 'running')) f.status = 'done';
  if (f.status && f.status !== 'running' && !f.ended_at) f.ended_at = now;
  if (f.status === 'running') f.ended_at = null;
}

function addSource(current: string | null, more: string): string {
  const parts = new Set((current ?? '').split('+').filter(Boolean));
  parts.add(more);
  return [...parts].sort().join('+');
}

function deriveProject(db: Db, f: RunInput['fields'], existing?: RunRow): void {
  if (existing && !('origin' in f || 'worktree' in f || 'project_id' in f)) return;
  const moved = existing?.worktree != null && 'worktree' in f && f.worktree !== existing?.worktree;
  const cwd = 'worktree' in f ? f.worktree : existing?.worktree;
  let origin = 'origin' in f ? f.origin : existing?.origin;
  if (moved && !('origin' in f)) origin = null;
  if (!origin && typeof cwd === 'string') origin = worktreeOrigin(cwd);
  if (typeof origin === 'string') {
    f.origin = origin;
    f.project_id = matchProject(projectRepos(db), origin);
  } else if (existing && (moved || 'origin' in f)) {
    f.origin = null;
    f.project_id = null;
  }
}

function insertRow(db: Db, f: RunInput['fields']): number {
  deriveProject(db, f);
  const keys = Object.keys(f);
  const sql = `INSERT INTO runs (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  const res = db.prepare(sql).run(...(Object.values(f) as (string | number | null)[]));
  return Number(res.lastInsertRowid);
}

function updateRow(db: Db, existing: RunRow, f: RunInput['fields']): void {
  deriveProject(db, f, existing);
  const keys = Object.keys(f);
  if (!keys.length) return;
  db.prepare(`UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
    ...(Object.values(f) as (string | number | null)[]),
    existing.id,
  );
}

export interface WriteResult {
  run: RunRow;
  merged: boolean;
  warnings: string[];
}

/** POST /runs: starts a run, or merges into an open discovered run with the same machine + pid. */
export function startRun(db: Db, body: unknown, now = new Date()): WriteResult {
  const input = parseRunInput(body);
  const at = now.toISOString();
  const warnings = resolveRefs(db, input);
  const f = input.fields;
  if (f.parent_run_id && !f.role) f.role = 'sub-agent';
  applyEnd(f, input.end, at);

  if (f.machine_id && typeof f.pid === 'number') {
    const open = db
      .prepare(
        'SELECT * FROM runs WHERE machine_id = ? AND pid = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
      )
      .get(f.machine_id, f.pid) as RunRow | undefined;
    if (open) {
      // What the agent reports wins over what a collector guessed; the process start time stays.
      const patch: RunInput['fields'] = { ...f, source: addSource(open.source, 'api') };
      if (open.source?.includes('process-scan') || open.source?.includes('systemd'))
        delete patch.started_at;
      updateRow(db, open, patch);
      return { run: getRunRow(db, open.id) as RunRow, merged: true, warnings };
    }
  }
  const id = insertRow(db, {
    status: 'running',
    ...f,
    started_at: f.started_at ?? at,
    source: 'api',
  });
  return { run: getRunRow(db, id) as RunRow, merged: false, warnings };
}

/** PATCH /runs/:id: progress, tokens, end. */
export function patchRun(db: Db, id: number, body: unknown, now = new Date()): WriteResult {
  const existing = getRunRow(db, id);
  if (!existing) throw new HttpError(404, 'not_found', `No run ${id}`);
  const input = parseRunInput(body);
  if (input.fields.parent_run_id === id) bad('A run cannot be its own parent');
  const warnings = resolveRefs(db, input);
  applyEnd(input.fields, input.end, now.toISOString());
  // Late token or summary updates on a finished run are fine; only status "running" reopens it.
  updateRow(db, existing, input.fields);
  return { run: getRunRow(db, id) as RunRow, merged: false, warnings };
}

// ---- Reading ----

export interface RunFilters {
  active?: boolean;
  /** Open runs plus runs that ended within this many hours. */
  finished_within_h?: number;
  machine?: string;
  task?: string;
  model?: string;
  project?: string;
  role?: string;
  kind?: string;
  status?: string;
  parent?: number;
  limit?: number;
}

export function parseFilters(q: URLSearchParams): RunFilters {
  const f: RunFilters = {};
  const str = (k: string) => {
    const v = q.get(k);
    return v === null || v === '' ? undefined : v;
  };
  const active = str('active');
  if (active !== undefined) f.active = active === '1' || active === 'true';
  const hours = str('finished_within_h') ?? str('hours');
  if (hours !== undefined) {
    const n = Number(hours);
    if (!Number.isFinite(n) || n <= 0 || n > 24 * 366) bad('finished_within_h must be hours > 0');
    f.finished_within_h = n;
  }
  f.machine = str('machine');
  f.task = str('task');
  f.model = str('model');
  f.project = str('project');
  f.role = str('role');
  if (f.role && !(ROLES as readonly string[]).includes(f.role))
    bad(`role must be one of: ${ROLES.join(', ')}`);
  f.kind = str('kind');
  if (f.kind && !(AGENT_KINDS as readonly string[]).includes(f.kind))
    bad(`kind must be one of: ${AGENT_KINDS.join(', ')}`);
  f.status = str('status');
  const parent = str('parent');
  if (parent !== undefined) {
    if (!/^\d+$/.test(parent)) bad('parent must be a run id');
    f.parent = Number(parent);
  }
  const limit = str('limit');
  if (limit !== undefined) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) bad('limit must be a whole number >= 1');
    f.limit = Math.min(n, 2000);
  }
  return f;
}

interface JoinedRow extends RunRow {
  task_short_name: string | null;
  task_title: string | null;
}

/** First non-empty line of the prompt, capped for list views. */
export function firstLine(text: string | null, max = 200): string | null {
  if (!text) return null;
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function shape(r: JoinedRow, now: Date, full: boolean) {
  const { task_short_name, task_title, prompt, ...rest } = r;
  const end = r.ended_at ? Date.parse(r.ended_at) : now.getTime();
  return {
    ...rest,
    ...(full ? { prompt } : {}),
    prompt_first_line: firstLine(prompt),
    prompt_chars: prompt?.length ?? 0,
    task: r.task_id ? { id: r.task_id, short_name: task_short_name, title: task_title } : null,
    duration_s: Math.max(0, Math.round((end - Date.parse(r.started_at)) / 1000)),
    tokens_total:
      (r.tokens_in ?? 0) +
      (r.tokens_out ?? 0) +
      (r.tokens_cache_read ?? 0) +
      (r.tokens_cache_write ?? 0),
  };
}

export type RunView = ReturnType<typeof shape>;

const SELECT = `SELECT r.*, t.short_name AS task_short_name, t.title AS task_title
  FROM runs r LEFT JOIN tasks t ON t.id = r.task_id`;

export function listRuns(db: Db, f: RunFilters, now = new Date()): RunView[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.finished_within_h !== undefined) {
    where.push('(r.ended_at IS NULL OR r.ended_at >= ?)');
    args.push(new Date(now.getTime() - f.finished_within_h * 3600_000).toISOString());
  } else if (f.active) {
    where.push('r.ended_at IS NULL');
  }
  const add = (sql: string, ...vals: (string | number)[]) => {
    where.push(sql);
    args.push(...vals);
  };
  if (f.machine) add('r.machine_id = ?', f.machine);
  if (f.model) add('r.model = ?', f.model);
  if (f.project) add('r.project_id = ?', f.project);
  if (f.role) add('r.role = ?', f.role);
  if (f.kind) add('r.agent_kind = ?', f.kind);
  if (f.status) add('r.status = ?', f.status);
  if (f.parent !== undefined) add('r.parent_run_id = ?', f.parent);
  if (f.task) {
    if (/^\d+$/.test(f.task)) add('r.task_id = ?', Number(f.task));
    else add('(t.short_name = ? OR t.external_ref = ?)', f.task, f.task);
  }
  const sql = `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY r.started_at DESC, r.id DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...args, f.limit ?? 500) as unknown as JoinedRow[];
  return rows.map((r) => shape(r, now, false));
}

export function getRun(db: Db, id: number, now = new Date()) {
  const row = db.prepare(`${SELECT} WHERE r.id = ?`).get(id) as JoinedRow | undefined;
  if (!row) throw new HttpError(404, 'not_found', `No run ${id}`);
  const children = (
    db
      .prepare(`${SELECT} WHERE r.parent_run_id = ? ORDER BY r.started_at`)
      .all(id) as unknown as JoinedRow[]
  ).map((r) => shape(r, now, false));
  const parent = row.parent_run_id
    ? (db.prepare(`${SELECT} WHERE r.id = ?`).get(row.parent_run_id) as JoinedRow | undefined)
    : undefined;
  return {
    ...shape(row, now, true),
    parent: parent ? shape(parent, now, false) : null,
    children,
  };
}

// ---- Collector merge ----

/** A run as seen by a collector on this machine. */
export interface Discovered {
  pid: number | null;
  unit?: string | null;
  command: string;
  agent_kind: AgentKind;
  role?: Role;
  status?: RunStatus;
  started_at: string | null;
  ended_at?: string | null;
  model?: string | null;
  prompt?: string | null;
  harness?: string | null;
  origin?: string | null;
  branch?: string | null;
  worktree?: string | null;
  /** pid of the nearest discovered ancestor, if any. */
  parent_pid?: number | null;
}

export interface MergeResult {
  inserted: number;
  updated: number;
  ended: number;
}

/**
 * Merges what a collector saw into runs. Matches an open run by unit (when given), else by
 * machine + pid. Fills fields the run does not have yet; never overwrites what an agent reported.
 */
export function mergeDiscovered(
  db: Db,
  machine: string,
  source: string,
  items: Discovered[],
  now = new Date(),
): MergeResult & { ids: Map<number, number> } {
  const at = now.toISOString();
  const res = { inserted: 0, updated: 0, ended: 0, ids: new Map<number, number>() };
  const byUnit = db.prepare(
    'SELECT * FROM runs WHERE machine_id = ? AND unit = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
  );
  const byPid = db.prepare(
    'SELECT * FROM runs WHERE machine_id = ? AND pid = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
  );
  db.exec('BEGIN');
  try {
    for (const d of items) {
      let open = d.unit ? (byUnit.get(machine, d.unit) as RunRow | undefined) : undefined;
      if (!open && d.pid) open = byPid.get(machine, d.pid) as RunRow | undefined;
      const closing = d.status && d.status !== 'running';
      if (open) {
        const patch: RunInput['fields'] = { seen_at: at, source: addSource(open.source, source) };
        const fill = (k: keyof RunRow, v: string | number | null | undefined) => {
          if (v !== undefined && v !== null && (open[k] === null || open[k] === undefined))
            patch[k] = v;
        };
        fill('pid', d.pid);
        fill('unit', d.unit);
        fill('command', d.command);
        fill('model', d.model);
        fill('prompt', d.prompt);
        fill('harness', d.harness);
        fill('origin', d.origin);
        fill('branch', d.branch);
        fill('worktree', d.worktree);
        if (closing) {
          patch.status = d.status;
          patch.ended_at = d.ended_at ?? at;
        }
        updateRow(db, open, patch);
        if (d.pid) res.ids.set(d.pid, open.id);
        res.updated++;
      } else if (!closing) {
        const id = insertRow(db, {
          machine_id: machine,
          pid: d.pid,
          unit: d.unit ?? null,
          command: d.command,
          agent_kind: d.agent_kind,
          role: d.role ?? (d.parent_pid ? 'sub-agent' : 'agent'),
          model: d.model ?? null,
          prompt: d.prompt ?? null,
          harness: d.harness ?? null,
          origin: d.origin ?? null,
          branch: d.branch ?? null,
          worktree: d.worktree ?? null,
          status: 'running',
          started_at: d.started_at ?? at,
          seen_at: at,
          source,
        });
        if (d.pid) res.ids.set(d.pid, id);
        res.inserted++;
      }
    }
    // Link discovered children to their discovered parents.
    const setParent = db.prepare(
      'UPDATE runs SET parent_run_id = ? WHERE id = ? AND parent_run_id IS NULL',
    );
    for (const d of items) {
      if (!d.pid || !d.parent_pid) continue;
      const child = res.ids.get(d.pid);
      const parent = res.ids.get(d.parent_pid);
      if (child && parent && child !== parent) setParent.run(parent, child);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return res;
}

/**
 * Ends open runs on this machine whose process is gone. `alive` maps every live pid on the host
 * to its start time (ISO, or null if unknown). A pid that is alive but started well after the
 * run was discovered has been reused by another program, so that run ended too.
 */
export function endVanishedPids(
  db: Db,
  machine: string,
  alive: Map<number, string | null>,
  now = new Date(),
): number {
  const at = now.toISOString();
  const open = db
    .prepare(
      'SELECT id, pid, started_at, source FROM runs WHERE machine_id = ? AND pid IS NOT NULL AND ended_at IS NULL',
    )
    .all(machine) as { id: number; pid: number; started_at: string; source: string | null }[];
  const end = db.prepare(
    "UPDATE runs SET status = 'ended', ended_at = ?, summary = COALESCE(summary, 'Process vanished') WHERE id = ?",
  );
  let n = 0;
  for (const r of open) {
    const started = alive.get(r.pid);
    let gone = started === undefined;
    if (!gone && started && r.source?.includes('process-scan')) {
      // Discovered runs carry the process start time; a later start means the pid was reused.
      gone = Date.parse(started) - Date.parse(r.started_at) > 5000;
    }
    if (gone) {
      end.run(at, r.id);
      n++;
    }
  }
  return n;
}

/** Ends open runs for worker units that are no longer listed. */
export function endVanishedUnits(
  db: Db,
  machine: string,
  prefix: string,
  listed: Set<string>,
  now = new Date(),
): number {
  const open = db
    .prepare(
      'SELECT id, unit FROM runs WHERE machine_id = ? AND unit IS NOT NULL AND ended_at IS NULL',
    )
    .all(machine) as { id: number; unit: string }[];
  const end = db.prepare(
    "UPDATE runs SET status = 'ended', ended_at = ?, summary = COALESCE(summary, 'Unit gone') WHERE id = ?",
  );
  let n = 0;
  for (const r of open) {
    if (!r.unit.startsWith(prefix) || listed.has(r.unit)) continue;
    end.run(now.toISOString(), r.id);
    n++;
  }
  return n;
}

/** Raises token totals to what a session log says. Totals only grow, so the larger value wins. */
export function applyTokenTotals(
  db: Db,
  id: number,
  t: {
    tokens_in: number;
    tokens_out: number;
    tokens_cache_read: number;
    tokens_cache_write: number;
  },
  extra: { model?: string | null; log_ref?: string | null } = {},
): void {
  db.prepare(
    `UPDATE runs SET
       tokens_in = MAX(COALESCE(tokens_in, 0), ?),
       tokens_out = MAX(COALESCE(tokens_out, 0), ?),
       tokens_cache_read = MAX(COALESCE(tokens_cache_read, 0), ?),
       tokens_cache_write = MAX(COALESCE(tokens_cache_write, 0), ?),
       model = COALESCE(model, ?),
       log_ref = COALESCE(log_ref, ?)
     WHERE id = ?`,
  ).run(
    t.tokens_in,
    t.tokens_out,
    t.tokens_cache_read,
    t.tokens_cache_write,
    extra.model ?? null,
    extra.log_ref ?? null,
    id,
  );
}
