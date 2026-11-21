import { describe, expect, it } from 'vitest';
import { startRun, patchRun } from '../server/agents/runs.ts';
import { startServer } from '../server/server.ts';
import {
  aggregateUsage,
  localDate,
  parseUsageQuery,
  planFor,
  spread,
  usage,
  type UsageRun,
} from '../server/usage/usage.ts';
import { memoryDb, testConfig } from './helpers.ts';

const NOW = new Date('2026-11-19T12:30:00.000Z');
const HOUR = 3600_000;
const iso = (t: number) => new Date(t).toISOString();
const ago = (h: number) => iso(NOW.getTime() - h * HOUR);

const config = testConfig({
  site: { name: 'Test fleet', timezone: 'America/New_York' },
  plans: [
    { id: 'claude', name: 'Claude plan', provider: 'manual' },
    { id: 'codex', name: 'Codex plan', provider: 'codex-sessions', sessions_dir: '/tmp/none' },
  ],
  models: { claude: ['sonnet', 'opus'] },
});

function run(extra: Partial<UsageRun> = {}): UsageRun {
  return {
    id: 1,
    agent_kind: 'other',
    model: null,
    provider: null,
    status: 'done',
    started_at: ago(2),
    ended_at: ago(1),
    tokens_in: null,
    tokens_out: null,
    tokens_cache_read: null,
    tokens_cache_write: null,
    cost_note: null,
    ...extra,
  };
}

describe('planFor', () => {
  it('prefers provider, then model ladder, then the only matching login', () => {
    expect(
      planFor({ provider: 'codex', model: 'opus', agent_kind: 'claude-code' }, config)?.id,
    ).toBe('codex');
    expect(planFor({ provider: null, model: 'opus', agent_kind: 'other' }, config)?.id).toBe(
      'claude',
    );
    expect(planFor({ provider: null, model: 'x', agent_kind: 'codex' }, config)?.id).toBe('codex');
    // No anthropic-oauth plan configured, so a claude-code run with an unknown model has no plan.
    expect(planFor({ provider: null, model: 'x', agent_kind: 'claude-code' }, config)).toBeNull();
    expect(planFor({ provider: 'nope', model: null, agent_kind: 'local' }, config)).toBeNull();
  });
});

describe('spread', () => {
  const first = Date.parse('2026-11-19T00:00:00.000Z');
  it('splits a run over the hours it was open', () => {
    const s = spread(first + 0.5 * HOUR, first + 2.5 * HOUR, first, 4);
    expect(s).toEqual([0.25, 0.5, 0.25, 0]);
  });
  it('puts an instant run in its start hour and ignores time outside the buckets', () => {
    expect(spread(first + 1.2 * HOUR, first + 1.2 * HOUR, first, 3)).toEqual([0, 1, 0]);
    expect(spread(first - HOUR, first + HOUR, first, 2)).toEqual([0.5, 0]);
  });
});

describe('aggregateUsage', () => {
  it('buckets tokens by plan and model per hour and per local day', () => {
    const u = aggregateUsage(
      [
        run({
          id: 1,
          model: 'opus',
          started_at: ago(2.5), // 10:00Z .. 12:00Z, two full hours
          ended_at: ago(0.5),
          tokens_in: 100,
          tokens_out: 1000,
          tokens_cache_read: 5000,
        }),
        run({
          id: 2,
          agent_kind: 'codex',
          model: 'gpt',
          started_at: ago(0.25),
          ended_at: null,
          tokens_out: 300,
        }),
        run({ id: 3, model: 'opus', started_at: ago(30), ended_at: ago(30), tokens_out: 50 }),
        run({ id: 4, agent_kind: 'local', started_at: ago(1), cost_note: '  free, local GPU ' }),
      ],
      config,
      { days: 3, hours: 6 },
      NOW,
    );
    expect(u.timezone).toBe('America/New_York');
    expect(u.series.map((s) => [s.key, s.plan_name, s.runs])).toEqual([
      ['claude|opus', 'Claude plan', 2],
      ['codex|gpt', 'Codex plan', 1],
    ]);
    expect(u.series[0]?.tokens).toEqual({ in: 100, out: 1050, cache_read: 5000, cache_write: 0 });

    expect(u.hourly.buckets).toHaveLength(6);
    expect(u.hourly.buckets.at(-1)).toBe('2026-11-19T12:00:00.000Z');
    const opus = u.hourly.series.find((s) => s.key === 'claude|opus');
    expect(opus?.out).toEqual([0, 0, 0, 500, 500, 0]); // 10:00 and 11:00
    expect(u.hourly.series.find((s) => s.key === 'codex|gpt')?.out).toEqual([0, 0, 0, 0, 0, 300]);

    // Local days in New York: 11-17, 11-18, 11-19. 30 h ago is 2026-11-18 01:30 local.
    expect(u.daily.buckets).toEqual(['2026-11-17', '2026-11-18', '2026-11-19']);
    const opusDay = u.daily.series.find((s) => s.key === 'claude|opus');
    expect(opusDay?.out).toEqual([0, 50, 1000]);
    expect(opusDay?.cache_read).toEqual([0, 0, 5000]);

    expect(u.runs_per_day.by_kind).toEqual([
      { agent_kind: 'codex', counts: [0, 0, 1] },
      { agent_kind: 'local', counts: [0, 0, 1] },
      { agent_kind: 'other', counts: [0, 1, 1] },
    ]);
    expect(u.cost_notes).toEqual([
      expect.objectContaining({ run_id: 4, note: 'free, local GPU', plan_id: null }),
    ]);
    expect(u.runs_without_tokens).toBe(1);
  });

  it('counts only the share of a long run that falls in the window', () => {
    const u = aggregateUsage(
      [run({ model: 'opus', started_at: ago(200), ended_at: ago(0.5), tokens_out: 1995 })],
      config,
      { days: 1, hours: 2 },
      NOW,
    );
    const total = u.series[0]?.tokens.out ?? 0;
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(1995);
    // 199.5 h run, 1995 tokens: 10 per hour. It ended at 12:00, so the 12:00 bucket is empty.
    expect(u.hourly.series[0]?.out).toEqual([10, 0]);
  });

  it('is empty without runs', () => {
    const u = aggregateUsage([], config, { days: 2, hours: 3 }, NOW);
    expect(u.series).toEqual([]);
    expect(u.hourly.series).toEqual([]);
    expect(u.daily.buckets).toHaveLength(2);
    expect(u.runs_per_day.by_kind).toEqual([]);
  });
});

describe('usage query and route', () => {
  it('validates days and hours', () => {
    expect(parseUsageQuery(new URLSearchParams())).toEqual({ days: 14, hours: 48 });
    expect(parseUsageQuery(new URLSearchParams('days=7&hours=24'))).toEqual({ days: 7, hours: 24 });
    expect(() => parseUsageQuery(new URLSearchParams('days=0'))).toThrow(/days/);
    expect(() => parseUsageQuery(new URLSearchParams('hours=1.5'))).toThrow(/hours/);
    expect(() => parseUsageQuery(new URLSearchParams('days=91'))).toThrow(/days/);
  });

  it('reads runs from the database and serves GET /usage', async () => {
    const db = memoryDb(config);
    const r = startRun(
      db,
      {
        agent_kind: 'claude-code',
        model: 'sonnet',
        started_at: ago(3),
        tokens: { in: 10, out: 20 },
      },
      NOW,
    ).run;
    patchRun(db, r.id, { status: 'done', cost_note: 'subscription' }, new Date(ago(2)));
    startRun(db, { agent_kind: 'codex', started_at: ago(24 * 100) }, NOW); // long ago, still open

    const direct = usage(db, config, { days: 2, hours: 4 }, NOW);
    expect(direct.series.map((s) => s.key)).toEqual(['claude|sonnet']);
    expect(direct.cost_notes.map((n) => n.note)).toEqual(['subscription']);
    expect(direct.runs_without_tokens).toBe(1);

    const app = await startServer({
      config,
      db,
      host: '127.0.0.1',
      port: 0,
      retention: false,
      agentCollectors: false,
      schedules: false,
      webRoot: '/nonexistent',
      log: () => {},
    });
    try {
      const ok = await fetch(`${app.url}/api/v1/usage?days=3&hours=12`);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { days: number; hourly: { buckets: string[] } };
      expect(body.days).toBe(3);
      expect(body.hourly.buckets).toHaveLength(12);
      const bad = await fetch(`${app.url}/api/v1/usage?days=abc`);
      expect(bad.status).toBe(400);
    } finally {
      await app.close();
      db.close();
    }
  });

  it('formats local dates in the site zone', () => {
    expect(localDate(Date.parse('2026-11-19T03:00:00Z'), 'America/New_York')).toBe('2026-11-18');
    expect(localDate(Date.parse('2026-11-19T03:00:00Z'), 'UTC')).toBe('2026-11-19');
  });
});
