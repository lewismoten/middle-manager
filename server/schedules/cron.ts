// Cron expressions through croner (SPEC 2). Five fields only (minute precision): a job that runs
// every second would fill the database long before retention could catch it.
//   "*/15 * * * *", "0 9 * * 1-5", "@hourly", "@daily", "@weekly"

import { Cron } from 'croner';

export interface ScheduleCheck {
  ok: boolean;
  error?: string;
  /** Next run times (ISO), empty when the expression never fires again. */
  next: string[];
}

function make(schedule: string, timezone?: string | null): Cron {
  return new Cron(schedule, { paused: true, mode: '5-part', timezone: timezone ?? undefined });
}

/** Strips croner's class-name prefixes so the message reads well in a form. */
function tidy(message: string): string {
  return message
    .replace(/^Cron(Pattern|Date)?:\s*/, '')
    .replace(/\. Original error:.*$/s, '')
    .trim();
}

/** Validates an expression in a time zone and lists the next `n` runs after `from`. */
export function checkSchedule(
  schedule: string,
  timezone?: string | null,
  n = 3,
  from = new Date(),
): ScheduleCheck {
  if (typeof schedule !== 'string' || !schedule.trim()) {
    return { ok: false, error: 'Schedule is required, e.g. "0 * * * *" (hourly)', next: [] };
  }
  try {
    const cron = make(schedule.trim(), timezone);
    const next = cron.nextRuns(n, from).map((d) => d.toISOString());
    return { ok: true, next };
  } catch (err) {
    return { ok: false, error: tidy((err as Error).message), next: [] };
  }
}

/** The next run after `from`, or null (bad expression, or it never fires again). */
export function nextRun(
  schedule: string,
  timezone?: string | null,
  from = new Date(),
): string | null {
  try {
    return make(schedule, timezone).nextRun(from)?.toISOString() ?? null;
  } catch {
    return null;
  }
}

/** Starts a live timer that calls `fn` on each run. Returns a stop function. */
export function startCron(schedule: string, timezone: string | null, fn: () => void): () => void {
  // protect: never overlap with itself; the runner also guards each job.
  const cron = new Cron(
    schedule,
    { mode: '5-part', timezone: timezone ?? undefined, protect: true, catch: true, unref: true },
    fn,
  );
  return () => cron.stop();
}
