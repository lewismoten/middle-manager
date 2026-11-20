import { expect, it } from 'vitest';
import { burnForecast } from '../web/src/plans-logic.ts';

const weekly = {
  current: true,
  mode: 'burn',
  unused_pct: 39.8,
  need_pct_per_h: 2.8,
  rate_pct_per_h: 1.33,
  rate_basis_h: 3,
} as const;

it('shows the projected unused allowance and needed rate divided by recent rate', () => {
  expect(burnForecast(weekly)).toBe('~40% unused at this rate · need 2.1x pace');
});

it.each([3, 24])('explains a zero recent rate on a %s h basis', (basis) => {
  expect(burnForecast({ ...weekly, rate_pct_per_h: 0, rate_basis_h: basis })).toBe(
    `no use in the last ${basis} h`,
  );
});

it.each(['steady', 'conserve', 'stop'] as const)('omits the line in %s mode', (mode) => {
  expect(burnForecast({ ...weekly, mode })).toBeNull();
});

it('omits the forecast after reset', () => {
  expect(burnForecast({ ...weekly, current: false })).toBeNull();
});
