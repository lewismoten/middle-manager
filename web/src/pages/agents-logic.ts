// Pure helpers for the Agents page (no DOM), so they can be unit tested.

export interface RunView {
  id: number;
  machine_id: string | null;
  agent_kind: string;
  parent_run_id: number | null;
  role: string;
  harness: string | null;
  model: string | null;
  provider: string | null;
  task_id: number | null;
  prompt_first_line: string | null;
  prompt_chars: number;
  prompt?: string | null;
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
  tokens_total: number;
  cost_note: string | null;
  log_ref: string | null;
  summary: string | null;
  command: string | null;
  source: string | null;
  unit: string | null;
  seen_at: string | null;
  duration_s: number;
  task: { id: number; short_name: string | null; title: string | null } | null;
}

export interface RunDetail extends RunView {
  prompt: string | null;
  parent: RunView | null;
  children: RunView[];
}

export interface Filters {
  /** 0 = active now only; otherwise also runs that finished in the last N hours. */
  hours: number;
  machine: string;
  model: string;
  project: string;
  role: string;
}

export const DEFAULT_FILTERS: Filters = { hours: 0, machine: '', model: '', project: '', role: '' };
export const HOUR_CHOICES = [1, 3, 6, 12, 24, 72] as const;
export const ROLES = ['orchestrator', 'agent', 'sub-agent', 'review'] as const;

export function filtersToQuery(f: Filters): string {
  const q = new URLSearchParams();
  if (f.hours > 0) q.set('finished_within_h', String(f.hours));
  else q.set('active', '1');
  if (f.machine) q.set('machine', f.machine);
  if (f.model) q.set('model', f.model);
  if (f.project) q.set('project', f.project);
  if (f.role) q.set('role', f.role);
  return q.toString();
}

export interface Row {
  run: RunView;
  depth: number;
  /** The parent is not shown here (finished, filtered out, or on another machine). */
  orphanOf: number | null;
}

export interface Group {
  machine: string | null;
  name: string;
  rows: Row[];
  running: number;
}

const isOpen = (r: RunView) => r.ended_at === null;

function byRecency(a: RunView, b: RunView): number {
  if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1;
  return b.started_at.localeCompare(a.started_at) || b.id - a.id;
}

/** Groups runs by machine (config order first) and nests sub-agents under their parents. */
export function buildGroups(runs: RunView[], machines: { id: string; name: string }[]): Group[] {
  const byMachine = new Map<string | null, RunView[]>();
  for (const r of runs) {
    const list = byMachine.get(r.machine_id) ?? [];
    list.push(r);
    byMachine.set(r.machine_id, list);
  }
  const order = machines.map((m) => m.id);
  const keys = [...byMachine.keys()].sort((a, b) => {
    const ia = a === null ? Infinity : order.indexOf(a);
    const ib = b === null ? Infinity : order.indexOf(b);
    const ra = ia < 0 ? order.length : ia;
    const rb = ib < 0 ? order.length : ib;
    return ra - rb || String(a).localeCompare(String(b));
  });
  return keys.map((key) => {
    const list = byMachine.get(key) ?? [];
    const ids = new Set(list.map((r) => r.id));
    const kids = new Map<number, RunView[]>();
    const roots: RunView[] = [];
    for (const r of list) {
      if (r.parent_run_id !== null && ids.has(r.parent_run_id) && r.parent_run_id !== r.id) {
        const k = kids.get(r.parent_run_id) ?? [];
        k.push(r);
        kids.set(r.parent_run_id, k);
      } else roots.push(r);
    }
    const rows: Row[] = [];
    const seen = new Set<number>();
    const walk = (r: RunView, depth: number) => {
      if (seen.has(r.id)) return; // a parent loop in bad data
      seen.add(r.id);
      rows.push({
        run: r,
        depth,
        orphanOf: depth === 0 && r.parent_run_id !== null ? r.parent_run_id : null,
      });
      const children = (kids.get(r.id) ?? []).sort(
        (a, b) => a.started_at.localeCompare(b.started_at) || a.id - b.id,
      );
      for (const c of children) walk(c, depth + 1);
    };
    roots.sort(byRecency).forEach((r) => walk(r, 0));
    // Anything left is in a parent loop; show it flat rather than lose it.
    for (const r of list) if (!seen.has(r.id)) walk(r, 0);
    return {
      machine: key,
      name: key === null ? 'Unknown machine' : (machines.find((m) => m.id === key)?.name ?? key),
      rows,
      running: list.filter(isOpen).length,
    };
  });
}

/** 950, 1.2k, 34k, 1.2M */
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined) return '–';
  if (n < 1000) return String(n);
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [size, suffix] of units) {
    if (n >= size) {
      const v = n / size;
      return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}${suffix}`;
    }
  }
  return String(n);
}

/** 45s, 12m 05s, 3h 04m, 2d 03h */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, '0')}h`;
}

/** Seconds a run has been going (live) or went (finished). */
export function elapsed(run: Pick<RunView, 'started_at' | 'ended_at'>, nowMs: number): number {
  const end = run.ended_at ? Date.parse(run.ended_at) : nowMs;
  return (end - Date.parse(run.started_at)) / 1000;
}

/** owner/repo from https, ssh or scp-style remotes; otherwise the remote unchanged. */
export function shortOrigin(origin: string | null): string | null {
  if (!origin) return null;
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(origin.trim());
  return m?.[1] ?? origin;
}

/** Last path segment of a worktree path. */
export function baseName(p: string | null): string | null {
  if (!p) return null;
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function cacheTokens(r: Pick<RunView, 'tokens_cache_read' | 'tokens_cache_write'>) {
  if (r.tokens_cache_read === null && r.tokens_cache_write === null) return null;
  return (r.tokens_cache_read ?? 0) + (r.tokens_cache_write ?? 0);
}

export function statusTone(status: string): 'doing' | 'done' | 'block' | 'muted' {
  if (status === 'running') return 'doing';
  if (status === 'done') return 'done';
  if (status === 'failed') return 'block';
  return 'muted';
}
