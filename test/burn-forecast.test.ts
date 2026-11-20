import { expect, it } from 'vitest';
import { burnForecast } from '../web/src/plans-logic.ts';

const weekly = {
  current: true,
  mode: 'burn',
  unused_pct: 39.8,
  need_pct_per_h: 2.8,
  rate_pct_per_h: 1.33,
} as const;

it('shows the projected unused allowance and needed rate divided by recent rate', () => {
  expect(burnForecast(weekly)).toBe('~40% unused at this rate · need 2.1x pace');
});

it('explains a zero recent rate', () => {
  expect(burnForecast({ ...weekly, rate_pct_per_h: 0 })).toBe('no use in the last 3 h');
});

it.each(['steady', 'conserve', 'stop'] as const)('omits the line in %s mode', (mode) => {
  expect(burnForecast({ ...weekly, mode })).toBeNull();
});

it('omits the forecast after reset', () => {
  expect(burnForecast({ ...weekly, current: false })).toBeNull();
});
