import { describe, expect, it } from 'vitest';
import {
  dayLabel,
  fmtTokens,
  hourLabel,
  labelEvery,
  layers,
  measureOf,
  measureSeries,
  niceMax,
  OTHER_KEY,
  stack,
  summaryText,
  type Usage,
} from '../web/src/pages/usage-logic.ts';

const t = (inn: number, out: number, cr = 0, cw = 0) => ({
  in: inn,
  out: out,
  cache_read: cr,
  cache_write: cw,
});

describe('measures', () => {
  it('counts in + out, or everything with cache', () => {
    expect(measureOf(t(1, 2, 300, 4), 'io')).toBe(3);
    expect(measureOf(t(1, 2, 300, 4), 'all')).toBe(307);
    const s = { key: 'k', in: [1, 0], out: [2, 5], cache_read: [10, 0], cache_write: [0, 1] };
    expect(measureSeries(s, 'io')).toEqual([3, 5]);
    expect(measureSeries(s, 'all')).toEqual([13, 6]);
  });
});

describe('layers', () => {
  const info = (keys: string[]) => keys.map((k) => ({ key: k, label: k.toUpperCase() }));

  it('gives slots by key, not by size, and drops empty series', () => {
    const ls = layers(
      info(['b', 'a', 'z']),
      [
        { key: 'b', values: [5, 5] },
        { key: 'a', values: [1, 0] },
        { key: 'z', values: [0, 0] },
      ],
      2,
    );
    expect(ls.map((l) => [l.key, l.slot, l.total])).toEqual([
      ['a', 1, 1],
      ['b', 2, 10],
    ]);
  });

  it('keeps a series color when the other series change size', () => {
    const one = layers(
      info(['a', 'b']),
      [
        { key: 'a', values: [1] },
        { key: 'b', values: [9] },
      ],
      1,
    );
    const two = layers(
      info(['a', 'b']),
      [
        { key: 'a', values: [9] },
        { key: 'b', values: [1] },
      ],
      1,
    );
    expect(one.find((l) => l.key === 'b')?.slot).toBe(two.find((l) => l.key === 'b')?.slot);
  });

  it('folds past seven series into Other, keeping the biggest named', () => {
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
    const ls = layers(
      info(keys),
      keys.map((k, i) => ({ key: k, values: [i + 1] })),
      1,
    );
    expect(ls).toHaveLength(8);
    expect(ls.at(-1)).toMatchObject({ key: OTHER_KEY, label: 'Other (3)', slot: 8, total: 6 });
    expect(ls.slice(0, 7).map((l) => l.key)).toEqual(['k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9']);
  });
});

describe('stack', () => {
  it('stacks layers bottom-up and skips zeros', () => {
    const ls = layers(
      [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
      [
        { key: 'a', values: [2, 0] },
        { key: 'b', values: [3, 4] },
      ],
      2,
    );
    expect(stack(ls, 2)).toEqual([
      {
        total: 5,
        segments: [
          { key: 'a', slot: 1, y0: 0, y1: 2 },
          { key: 'b', slot: 2, y0: 2, y1: 5 },
        ],
      },
      { total: 4, segments: [{ key: 'b', slot: 2, y0: 0, y1: 4 }] },
    ]);
  });
});

describe('axis and labels', () => {
  it('rounds the axis up to a nice step', () => {
    expect(niceMax(0)).toEqual({ max: 1, step: 0.25 });
    expect(niceMax(87)).toEqual({ max: 100, step: 25 });
    expect(niceMax(1_234_567)).toEqual({ max: 1_500_000, step: 500_000 });
    expect(niceMax(3, 4, 1)).toEqual({ max: 3, step: 1 });
  });
  it('formats token counts', () => {
    expect(fmtTokens(950)).toBe('950');
    expect(fmtTokens(1200)).toBe('1.2k');
    expect(fmtTokens(34_000)).toBe('34k');
    expect(fmtTokens(1_500_000)).toBe('1.5M');
    expect(fmtTokens(2_000_000_000)).toBe('2B');
  });
  it('labels days and hours in the site zone', () => {
    expect(dayLabel('2026-11-19')).toBe('Thu 19');
    expect(dayLabel('2026-11-19', true)).toBe('Thu, Nov 19');
    expect(hourLabel('2026-11-19T15:00:00.000Z', 'America/New_York')).toBe('10:00');
  });
  it('thins axis labels to fit', () => {
    expect(labelEvery(14, 700, 44)).toBe(1);
    expect(labelEvery(48, 300, 48)).toBe(8);
    expect(labelEvery(0, 300, 48)).toBe(1);
  });
});

describe('summaryText', () => {
  const base: Usage = {
    now: '2026-11-19T12:00:00.000Z',
    timezone: 'UTC',
    days: 14,
    hours: 48,
    series: [],
    hourly: { buckets: [], series: [] },
    daily: { buckets: [], series: [] },
    runs_per_day: { buckets: [], by_kind: [] },
    cost_notes: [],
    runs_without_tokens: 0,
  };
  it('says when there is nothing', () => {
    expect(summaryText(base, 'io')).toBe('No token counts in the last 14 days');
  });
  it('totals the chosen measure', () => {
    const u: Usage = {
      ...base,
      series: [
        {
          key: 'a|x',
          plan_id: 'a',
          plan_name: 'A',
          model: 'x',
          runs: 2,
          tokens: t(1000, 500, 1e6),
        },
        { key: '-|y', plan_id: null, plan_name: 'No plan', model: 'y', runs: 1, tokens: t(0, 500) },
      ],
      runs_per_day: { buckets: ['d'], by_kind: [{ agent_kind: 'codex', counts: [3] }] },
    };
    expect(summaryText(u, 'io')).toBe(
      '2k tokens (in + out) · 3 runs started · 2 plans · last 14 days',
    );
    expect(summaryText(u, 'all')).toMatch(/^1M tokens \(with cache\)/);
  });
});
