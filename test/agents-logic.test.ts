import { describe, expect, it } from 'vitest';
import {
  baseName,
  buildGroups,
  compact,
  DEFAULT_FILTERS,
  duration,
  elapsed,
  filtersToQuery,
  shortOrigin,
  type RunView,
} from '../web/src/pages/agents-logic.ts';

let nextId = 1;
function run(p: Partial<RunView>): RunView {
  return {
    id: nextId++,
    machine_id: 'a',
    agent_kind: 'codex',
    parent_run_id: null,
    role: 'agent',
    harness: null,
    model: null,
    provider: null,
    task_id: null,
    prompt_first_line: null,
    prompt_chars: 0,
    prompt_ref: null,
    project_id: null,
    origin: null,
    branch: null,
    worktree: null,
    pid: null,
    status: 'running',
    started_at: '2026-11-19T12:00:00.000Z',
    ended_at: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cache_read: null,
    tokens_cache_write: null,
    tokens_total: 0,
    cost_note: null,
    log_ref: null,
    summary: null,
    command: null,
    source: null,
    unit: null,
    seen_at: null,
    duration_s: 0,
    task: null,
    ...p,
  };
}

describe('agents page logic', () => {
  it('groups by machine in config order and nests children under parents', () => {
    const p = run({ id: 100, machine_id: 'b', started_at: '2026-11-19T10:00:00Z' });
    const c2 = run({
      id: 102,
      machine_id: 'b',
      parent_run_id: 100,
      started_at: '2026-11-19T10:20:00Z',
    });
    const c1 = run({
      id: 101,
      machine_id: 'b',
      parent_run_id: 100,
      started_at: '2026-11-19T10:10:00Z',
    });
    const gc = run({ id: 103, machine_id: 'b', parent_run_id: 101 });
    const orphan = run({ id: 104, machine_id: 'b', parent_run_id: 999 });
    const done = run({
      id: 105,
      machine_id: 'b',
      ended_at: '2026-11-19T13:00:00Z',
      started_at: '2026-11-19T12:59:00Z',
    });
    const other = run({ id: 106, machine_id: 'z' });
    const none = run({ id: 107, machine_id: null });
    const groups = buildGroups(
      [none, other, done, gc, c2, orphan, c1, p],
      [
        { id: 'b', name: 'Bee' },
        { id: 'a', name: 'Ay' },
      ],
    );
    expect(groups.map((g) => [g.machine, g.name, g.running])).toEqual([
      ['b', 'Bee', 5],
      ['z', 'z', 1],
      [null, 'Unknown machine', 1],
    ]);
    expect(groups[0]?.rows.map((r) => [r.run.id, r.depth, r.orphanOf])).toEqual([
      [104, 0, 999],
      [100, 0, null],
      [101, 1, null],
      [103, 2, null],
      [102, 1, null],
      [105, 0, null],
    ]);
  });

  it('survives a parent loop', () => {
    const a = run({ id: 200, parent_run_id: 201 });
    const b = run({ id: 201, parent_run_id: 200 });
    const rows = buildGroups([a, b], [])[0]?.rows ?? [];
    expect(rows.map((r) => r.run.id).sort()).toEqual([200, 201]);
  });

  it('builds the query from filters', () => {
    expect(filtersToQuery(DEFAULT_FILTERS)).toBe('active=1');
    expect(
      filtersToQuery({ hours: 6, machine: 'm', model: 'x y', project: '', role: 'review' }),
    ).toBe('finished_within_h=6&machine=m&model=x+y&role=review');
  });

  it('formats numbers, durations, origins and paths', () => {
    expect([
      compact(null),
      compact(950),
      compact(1200),
      compact(34_000),
      compact(2_496_000),
      compact(150_000_000),
    ]).toEqual(['–', '950', '1.2k', '34k', '2.5M', '150M']);
    expect([duration(45), duration(725), duration(3 * 3600 + 240), duration(51 * 3600)]).toEqual([
      '45s',
      '12m 05s',
      '3h 04m',
      '2d 03h',
    ]);
    expect(
      elapsed(
        { started_at: '2026-11-19T12:00:00Z', ended_at: null },
        Date.parse('2026-11-19T12:01:00Z'),
      ),
    ).toBe(60);
    expect(shortOrigin('https://example.com/owner/repo.git')).toBe('owner/repo');
    expect(shortOrigin('git@example.com:owner/repo.git')).toBe('owner/repo');
    expect(shortOrigin('ssh://git@example.com:22/owner/repo')).toBe('owner/repo');
    expect(shortOrigin(null)).toBeNull();
    expect(baseName('/srv/work/repo-wt/')).toBe('repo-wt');
  });
});
