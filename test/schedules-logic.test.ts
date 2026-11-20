import { describe, expect, it } from 'vitest';
import {
  anyRunning,
  externalTone,
  formBody,
  groupExternal,
  kindLabel,
  relTime,
  runTone,
  sourceLabel,
  summaryText,
  type ExternalJob,
  type Job,
} from '../web/src/pages/schedules-logic.ts';

const NOW = Date.parse('2026-11-19T12:00:00.000Z');

function job(extra: Partial<Job> = {}): Job {
  return {
    id: 1,
    name: 'j',
    schedule: '@daily',
    timezone: null,
    effective_timezone: 'UTC',
    kind: 'collector',
    command: null,
    collector_id: 'c',
    enabled: true,
    attention: null,
    timeout_s: 300,
    notify: null,
    created_by: null,
    created_at: '2026-11-01T00:00:00Z',
    next_run_at: null,
    last_run: null,
    running: false,
    failed_24h: 0,
    ...extra,
  };
}

function ext(source: string, read_at: string, extra: Partial<ExternalJob> = {}): ExternalJob {
  return {
    id: 1,
    source,
    kind: 'hermes-cron',
    external_id: 'x',
    name: 'x',
    schedule: null,
    timezone: null,
    command: null,
    enabled: true,
    attention: null,
    last_run_at: null,
    last_status: null,
    next_run_at: null,
    machine_id: 'm1',
    read_at,
    stale: false,
    ...extra,
  };
}

describe('schedules page logic', () => {
  it('formats relative times both ways', () => {
    expect(relTime('2026-11-19T12:05:03.000Z', NOW)).toBe('in 5m 03s');
    expect(relTime('2026-11-19T09:50:00.000Z', NOW)).toBe('2h 10m ago');
    expect(relTime('2026-11-19T12:00:00.400Z', NOW)).toBe('now');
    expect(relTime(null, NOW)).toBe('–');
  });

  it('maps statuses to tones', () => {
    expect(runTone('ok')).toBe('done');
    expect(runTone('running')).toBe('doing');
    expect(runTone('failed')).toBe('block');
    expect(runTone('interrupted')).toBe('block');
    expect(externalTone('ok (completed)')).toBe('done');
    expect(externalTone('failed (exit 1)')).toBe('block');
    expect(externalTone('error')).toBe('block');
    expect(externalTone('delivery_queued')).toBe('muted');
    expect(externalTone(null)).toBe('muted');
  });

  it('labels kinds and sources', () => {
    expect(kindLabel({ kind: 'shell', collector_id: null })).toBe('shell');
    expect(kindLabel({ kind: 'collector', collector_id: 'boards' })).toBe('collector · boards');
    expect(sourceLabel('systemd-timers')).toBe('systemd timers');
    expect(sourceLabel(null)).toBe('unconfigured source');
  });

  it('groups mirrored jobs by source, oldest read time and any staleness', () => {
    const groups = groupExternal([
      ext('a', '2026-11-19T11:00:00Z'),
      ext('a', '2026-11-19T10:00:00Z', { stale: true }),
      ext('b', '2026-11-19T11:30:00Z', { kind: 'systemd-timers' }),
    ]);
    expect(groups.map((g) => [g.source, g.jobs.length, g.read_at, g.stale])).toEqual([
      ['a', 2, '2026-11-19T10:00:00Z', true],
      ['b', 1, '2026-11-19T11:30:00Z', false],
    ]);
  });

  it('summarises counts', () => {
    const jobs = [job(), job({ enabled: false, failed_24h: 2 }), job({ running: true })];
    expect(summaryText(jobs, [ext('a', 'x')])).toBe(
      '3 jobs · 2 enabled · 1 running · 2 failed runs in 24 h · 1 mirrored',
    );
    expect(summaryText([], [])).toBe('0 jobs · 0 enabled · 0 mirrored');
    expect(anyRunning(jobs)).toBe(true);
    expect(anyRunning([job()])).toBe(false);
  });

  it('builds the request body from the form', () => {
    const base = {
      name: ' Nightly ',
      kind: 'collector',
      collector_id: 'boards',
      command: 'ignored',
      schedule: ' 0 3 * * * ',
      timezone: '',
      timeout_s: '90',
      enabled: true,
    };
    expect(formBody(base)).toEqual({
      name: 'Nightly',
      kind: 'collector',
      schedule: '0 3 * * *',
      timezone: null,
      enabled: true,
      collector_id: 'boards',
      command: null,
      timeout_s: 90,
    });
    expect(formBody({ ...base, kind: 'shell', command: ' echo hi ', timeout_s: '' })).toEqual({
      name: 'Nightly',
      kind: 'shell',
      schedule: '0 3 * * *',
      timezone: null,
      enabled: true,
      collector_id: null,
      command: 'echo hi',
    });
  });
});
