import { checkSchedule } from './cron.ts';

export type Attention = 'failed' | 'stuck' | 'overdue' | null;

function intervalMs(
  schedule: string,
  timezone: string | null,
  start: number,
  next: string | null,
): number {
  const match =
    /(?:^every |(?:^|; )OnUnit(?:Active|Inactive)Sec=)([\d.]+)\s*(ms|s|min|h|d)(?:$|;)/.exec(
      schedule,
    );
  const units: Record<string, number> = { ms: 1, s: 1000, min: 60000, h: 3600000, d: 86400000 };
  if (match?.[1] && match[2]) return Number(match[1]) * (units[match[2]] ?? NaN);
  // Calendar timers report their adjacent service start and upcoming trigger.
  if (schedule.startsWith('OnCalendar=')) return Date.parse(next ?? '') - start;
  const [a, b] = checkSchedule(schedule, timezone, 2, new Date(start - 1)).next;
  return a && b ? Date.parse(b) - Date.parse(a) : NaN;
}

export function attentionFor(
  job: {
    enabled: boolean;
    schedule: string | null;
    timezone: string | null;
    last_run_at: string | null;
    last_status: string | null;
    next_run_at: string | null;
  },
  now: Date,
): Attention {
  if (!job.enabled) return null;
  if (/^(fail|error)/i.test(job.last_status ?? '')) return 'failed';
  if (job.last_status === 'running') {
    const start = Date.parse(job.last_run_at ?? '');
    if (!Number.isFinite(start) || !job.schedule) return null;
    const interval = intervalMs(job.schedule, job.timezone, start, job.next_run_at);
    return interval > 0 && now.getTime() - start > 2 * interval ? 'stuck' : null;
  }
  return Date.parse(job.next_run_at ?? '') < now.getTime() ? 'overdue' : null;
}
