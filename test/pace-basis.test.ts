import { expect, it } from 'vitest';
import { planPace } from '../server/plans/service.ts';
import { insertReadings } from '../server/plans/store.ts';
import { HOUR_MS } from '../server/plans/pacing.ts';
import { offPace, signed } from '../web/src/plans-logic.ts';
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
    // Even pace runs to 97% an hour before the reset. In the last 24 h before that the mode aims
    // straight at 97%: (97 - 61) / 13.47 h = 2.67%/h needed.
    even_pace_pct: 89.2,
    off_pace_pts: -28.2,
    phase: 'final',
    rate_basis_h: 3,
    rate_pct_per_h: 2.286,
    rate_24h: 0.466,
    ratio: 0.86,
    mode: 'steady',
    projected_pct: 94.1,
    unused_pct: 5.9,
  });
  expect(offPace(weekly)).toBe('Off pace: \u221228.2 pts');
  db.close();
});

it.each([
  [-10.8, 'Off pace: \u221210.8 pts'],
  [3.24, 'Off pace: +3.2 pts'],
  [-0.04, 'Off pace: 0.0 pts'],
  [undefined, null],
] as const)('describes %s points off pace', (off_pace_pts, expected) => {
  expect(offPace({ off_pace_pts })).toBe(expected);
});

it('signs numbers with a real minus sign', () => {
  expect(signed(-2.25)).toBe('\u22122.3');
  expect(signed(2)).toBe('+2.0');
  expect(signed(0)).toBe('0.0');
});
