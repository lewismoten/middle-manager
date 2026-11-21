import { expect, it } from 'vitest';
import { attentionFor } from '../server/schedules/attention.ts';

const start = new Date('2026-11-19T12:00:00Z');
const now = new Date(start.getTime() + 4 * 60000 + 1);
const job = {
  enabled: true,
  last_status: 'running',
  last_run_at: start.toISOString(),
  next_run_at: new Date(start.getTime() + 2 * 60000).toISOString(),
  schedule: 'every 2 min',
  timezone: 'UTC',
};

it.each(['every 2 min', '*/2 * * * *', 'OnUnitActiveSec=2min', 'OnCalendar=*-*-* *:0/2:00'])(
  'uses two intervals as the running threshold for %s',
  (schedule) => {
    expect(attentionFor({ ...job, schedule }, new Date(now.getTime() - 1))).toBeNull();
    expect(attentionFor({ ...job, schedule }, now)).toBe('stuck');
  },
);

it('requires a known interval for stuck runs and a missed trigger for overdue jobs', () => {
  expect(attentionFor({ ...job, schedule: null }, now)).toBeNull();
  expect(attentionFor({ ...job, last_status: 'ok' }, now)).toBe('overdue');
  expect(attentionFor({ ...job, last_status: 'error' }, now)).toBe('failed');
  expect(attentionFor({ ...job, last_status: 'error', enabled: false }, now)).toBeNull();
});
