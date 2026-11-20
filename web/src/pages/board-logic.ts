// Pure helpers for the Board page (no DOM), so they can be unit tested.

export const STATUSES = ['backlog', 'todo', 'doing', 'review', 'blocked', 'done'] as const;
export const PAGE_SIZE = 40;
export const DONE_DAYS = 14;
const DAY = 86_400_000;

export interface Task {
  id: number;
  title: string;
  short_name: string | null;
  body: string | null;
  project_id: string | null;
  status: string;
  assignee: string | null;
  lane: string | null;
  sprint: string | null;
  priority: number | null;
  external_ref: string | null;
  source_created_at?: string | null;
  status_since?: string | null;
  updated_at?: string | null;
}

export interface Filters {
  q: string;
  project: string;
  assignee: string;
}

/** The board an imported card came from: `hermes-kanban:<board>:<id>` -> `<board>`. */
export function boardOf(ref: string | null | undefined): string | null {
  const m = /^hermes-kanban:(.+):[^:]+$/.exec(ref ?? '');
  return m ? m[1]! : null;
}

/**
 * The project a card belongs to, as people would name it. Imported cards carry the placeholder
 * project "default"; their board name says more. Null when there is nothing useful to show.
 */
export function projectOf(t: Pick<Task, 'project_id' | 'external_ref'>): string | null {
  const project = t.project_id?.trim();
  if (project && project !== 'default') return project;
  return boardOf(t.external_ref) ?? null;
}

export function cardAge(
  t: Pick<Task, 'source_created_at' | 'status_since' | 'status'>,
  now = Date.now(),
): string | null {
  const elapsed = now - Date.parse(t.status_since ?? t.source_created_at ?? '');
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const duration =
    elapsed < DAY ? Math.floor(elapsed / 3600000) + 'h' : Math.floor(elapsed / DAY) + 'd';
  return (t.status_since ? t.status : 'age') + ' ' + duration;
}

export function matches(t: Task, f: Filters): boolean {
  if (f.project && projectOf(t) !== f.project) return false;
  if (f.assignee && t.assignee !== f.assignee) return false;
  const q = f.q.trim().toLowerCase();
  if (!q) return true;
  return [t.title, t.short_name, t.body, t.external_ref].some((s) => s?.toLowerCase().includes(q));
}

const time = (t: Task) =>
  Date.parse(t.status_since ?? t.source_created_at ?? t.updated_at ?? '') || 0;

/**
 * Order inside a column. Done: newest first. Others: priority (lowest number first, unset last),
 * then most recently updated, then newest id.
 */
export function sortColumn(status: string, tasks: Task[]): Task[] {
  const out = [...tasks];
  if (status === 'done') return out.sort((a, b) => time(b) - time(a) || b.id - a.id);
  const p = (t: Task) => t.priority ?? Number.POSITIVE_INFINITY;
  return out.sort((a, b) => p(a) - p(b) || time(b) - time(a) || b.id - a.id);
}

export interface Column {
  status: string;
  /** Cards to list, in order (already limited to the recent window for done unless older shown). */
  cards: Task[];
  /** Every card in this column that passes the filters. */
  total: number;
  /** Done cards hidden by the recent window (0 for other columns or when older are shown). */
  older: number;
}

/** Splits filtered cards into ordered columns; done keeps the last `days` unless `showOlder`. */
export function columns(
  tasks: Task[],
  opts: { now: number; showOlder: boolean; days?: number },
): Column[] {
  const cutoff = opts.now - (opts.days ?? DONE_DAYS) * DAY;
  return STATUSES.map((status) => {
    const all = sortColumn(
      status,
      tasks.filter((t) => t.status === status),
    );
    if (status !== 'done' || opts.showOlder)
      return { status, cards: all, total: all.length, older: 0 };
    const recent = all.filter((t) => time(t) >= cutoff);
    return { status, cards: recent, total: all.length, older: all.length - recent.length };
  });
}

/** Header count: "53", or "12 of 573" while older done cards are hidden. */
export function countLabel(c: Pick<Column, 'cards' | 'total' | 'older'>): string {
  return c.older ? `${c.cards.length} of ${c.total}` : String(c.total);
}

/** Column to show first on a phone: the current choice if it still exists, else the first busy one. */
export function phoneColumn(current: string | null, cols: Pick<Column, 'status' | 'total'>[]) {
  if (current && cols.some((c) => c.status === current)) return current;
  return (
    (cols.find((c) => c.status !== 'done' && c.total) ?? cols.find((c) => c.total))?.status ??
    'todo'
  );
}

/** Lanes in assignment mode: named assignees A-Z, unassigned last. */
export function laneNames(tasks: Task[]): (string | null)[] {
  const names = [...new Set(tasks.map((t) => t.assignee ?? null))];
  return names.sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)));
}
