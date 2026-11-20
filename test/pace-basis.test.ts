import { expect, it } from 'vitest';
import { planPace } from '../server/plans/service.ts';
import { insertReadings } from '../server/plans/store.ts';
import { HOUR_MS } from '../server/plans/pacing.ts';
import { paceDifference } from '../web/src/plans-logic.ts';
import { memoryDb, testConfig } from './helpers.ts';

it('projects the reviewer example using the same 3 h rate as its steady mode', () => {
  const config = testConfig({ plans: [{ id: 'sample', name: 'Sample', provider: 'manual' }] });
  const db = memoryDb(config);
  const now = Date.UTC(2026, 10, 20);
  const reset = new Date(now + 14.47 * HOUR_MS).toISOString();
  for (const [hoursAgo, used] of [
    [24, 61 - 24 * 0.466],
    [3, 61 - 3 * 2.286],
    [0, 61],
  ] as const) {
    insertReadings(db, [
      {
        plan_id: 'sample',
        window: 'weekly',
        used_pct: used,
        resets_at: reset,
        read_at: new Date(now - hoursAgo * HOUR_MS).toISOString(),
        machine_id: null,
        how: null,
      },
    ]);
  }
  const weekly = planPace(db, config, config.plans[0]!, now).weekly!;
  expect(weekly).toMatchObject({
    used_pct: 61,
    even_pace_pct: 91.4,
    rate_basis_h: 3,
    rate_pct_per_h: 2.286,
    rate_24h: 0.466,
    ratio: 0.79,
    mode: 'steady',
    projected_pct: 94.1,
    unused_pct: 5.9,
  });
  expect(paceDifference(weekly)).toBe('3 pts ahead of even pace');
  db.close();
});

it.each([
  [61, '30 pts behind even pace'],
  [90.5, null],
  [92.3, null],
] as const)('describes a projection of %s against 91.4%% even pace', (projected_pct, expected) => {
  expect(paceDifference({ even_pace_pct: 91.4, projected_pct })).toBe(expected);
});
