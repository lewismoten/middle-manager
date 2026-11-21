import { describe, expect, it } from 'vitest';
import {
  boardOf,
  columns,
  countLabel,
  laneNames,
  matches,
  phoneColumn,
  projectOf,
  sortColumn,
  type Task,
} from '../web/src/pages/board-logic.ts';

const NOW = Date.parse('2026-06-30T12:00:00Z');
const DAY = 86_400_000;
let next = 1;
function task(over: Partial<Task> = {}): Task {
  return {
    id: next++,
    title: 'Card',
    short_name: null,
    body: null,
    project_id: null,
    status: 'todo',
    assignee: null,
    lane: null,
    sprint: null,
    priority: null,
    external_ref: null,
    updated_at: new Date(NOW).toISOString(),
    ...over,
  };
}
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

describe('board names', () => {
  it('reads the board from a Hermes kanban ref', () => {
    expect(boardOf('hermes-kanban:sample-board:t_12')).toBe('sample-board');
    expect(boardOf('hermes-kanban:a:b:7')).toBe('a:b');
    expect(boardOf('other:thing')).toBeNull();
    expect(boardOf(null)).toBeNull();
  });
  it('replaces the placeholder project with the board, and hides it when nothing is known', () => {
    expect(projectOf({ project_id: 'default', external_ref: 'hermes-kanban:ops:1' })).toBe('ops');
    expect(projectOf({ project_id: 'main', external_ref: 'hermes-kanban:ops:1' })).toBe('main');
    expect(projectOf({ project_id: 'default', external_ref: null })).toBeNull();
    expect(projectOf({ project_id: ' ', external_ref: null })).toBeNull();
  });
});

describe('filters', () => {
  const a = task({
    title: 'Fix login',
    assignee: 'w1',
    project_id: 'default',
    external_ref: 'hermes-kanban:ops:9',
  });
  const b = task({ title: 'Write docs', body: 'mentions LOGIN flow', project_id: 'main' });
  it('searches title, body and ref case-insensitively', () => {
    const f = { q: 'login', project: '', assignee: '' };
    expect([a, b].filter((t) => matches(t, f))).toEqual([a, b]);
    expect(matches(a, { ...f, q: 'ops:9' })).toBe(true);
    expect(matches(a, { ...f, q: '  ' })).toBe(true);
  });
  it('filters by the shown project (board name for imports) and assignee', () => {
    expect(matches(a, { q: '', project: 'ops', assignee: '' })).toBe(true);
    expect(matches(a, { q: '', project: 'default', assignee: '' })).toBe(false);
    expect(matches(b, { q: '', project: 'main', assignee: 'w1' })).toBe(false);
  });
});

describe('ordering and columns', () => {
  it('sorts done newest first and others by priority then recency', () => {
    const old = task({ status: 'done', updated_at: ago(3) });
    const recent = task({ status: 'done', updated_at: ago(1) });
    expect(sortColumn('done', [old, recent])).toEqual([recent, old]);
    const p2 = task({ priority: 2, updated_at: ago(0) });
    const p1 = task({ priority: 1, updated_at: ago(5) });
    const none = task({ updated_at: ago(0) });
    expect(sortColumn('todo', [none, p2, p1])).toEqual([p1, p2, none]);
  });
  it('keeps the last 14 days of done unless older are shown, counting the whole column', () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => task({ status: 'done', updated_at: ago(i) })),
      ...Array.from({ length: 561 }, (_, i) => task({ status: 'done', updated_at: ago(15 + i) })),
      task({ status: 'blocked' }),
    ];
    const cols = columns(rows, { now: NOW, showOlder: false });
    expect(cols.map((c) => c.status)).toEqual([
      'backlog',
      'todo',
      'doing',
      'review',
      'blocked',
      'done',
    ]);
    const done = cols.find((c) => c.status === 'done')!;
    expect(done.cards).toHaveLength(12);
    expect(done.older).toBe(561);
    expect(countLabel(done)).toBe('12 of 573');
    expect(countLabel(cols.find((c) => c.status === 'blocked')!)).toBe('1');
    const all = columns(rows, { now: NOW, showOlder: true }).find((c) => c.status === 'done')!;
    expect(all.cards).toHaveLength(573);
    expect(countLabel(all)).toBe('573');
  });
  it('treats missing timestamps as old', () => {
    const cols = columns([task({ status: 'done', updated_at: null })], {
      now: NOW,
      showOlder: false,
    });
    expect(countLabel(cols[5]!)).toBe('0 of 1');
  });
});

describe('phone column and lanes', () => {
  const cols = (totals: number[]) =>
    ['backlog', 'todo', 'doing', 'review', 'blocked', 'done'].map((status, i) => ({
      status,
      total: totals[i]!,
    }));
  it('keeps the current choice, else the first busy column before done', () => {
    expect(phoneColumn(null, cols([0, 53, 0, 0, 80, 573]))).toBe('todo');
    expect(phoneColumn('done', cols([0, 53, 0, 0, 80, 573]))).toBe('done');
    expect(phoneColumn(null, cols([0, 0, 0, 0, 0, 5]))).toBe('done');
    expect(phoneColumn(null, cols([0, 0, 0, 0, 0, 0]))).toBe('todo');
  });
  it('orders lanes by name with unassigned last', () => {
    expect(
      laneNames([
        task({ assignee: 'b' }),
        task(),
        task({ assignee: 'a' }),
        task({ assignee: 'b' }),
      ]),
    ).toEqual(['a', 'b', null]);
  });
});
