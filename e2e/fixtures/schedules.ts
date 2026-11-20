// Synthetic schedules for the e2e server: four own jobs with run history, a Hermes cron file and
// mirrored systemd timers. All names and commands are made up.

import { writeFileSync } from 'node:fs';
import type { Db } from '../../server/db/index.ts';
import { parseHermesCron, replaceExternal } from '../../server/schedules/mirror.ts';

const MIN = 60_000;

export function hermesJobsJson(now = Date.now()): string {
  const iso = (t: number) => new Date(t).toISOString();
  return JSON.stringify({
    updated_at: iso(now),
    jobs: [
      {
        id: 'h1',
        name: 'Sample digest',
        prompt: 'Summarise the sample queue.',
        schedule: { kind: 'cron', expr: '0 * * * *', display: '0 * * * *' },
        enabled: true,
        state: 'scheduled',
        last_run_at: iso(now - 25 * MIN),
        last_status: 'ok',
        next_run_at: iso(now + 35 * MIN),
      },
      {
        id: 'h2',
        name: 'Sample site sync',
        script: 'sample_sync.py',
        schedule: { kind: 'interval', minutes: 15, display: 'every 15m' },
        enabled: false,
        state: 'paused',
        last_run_at: iso(now - 3 * 24 * 60 * MIN),
        last_status: 'error',
      },
      {
        id: 'h3',
        name: 'Release reminder',
        prompt: 'Remind about the sample release.',
        schedule: {
          kind: 'once',
          run_at: iso(now + 2 * 24 * 60 * MIN),
          display: 'once in two days',
        },
        enabled: true,
        state: 'scheduled',
        next_run_at: iso(now + 2 * 24 * 60 * MIN),
      },
    ],
  });
}

export function seedSchedules(db: Db, hermesFile: string, now = Date.now()): void {
  const iso = (t: number) => new Date(t).toISOString();
  const text = hermesJobsJson(now);
  writeFileSync(hermesFile, text);
  replaceExternal(db, 'hermes-cron', 'server-1', parseHermesCron(text), new Date(now));
  replaceExternal(
    db,
    'timers',
    'server-1',
    [
      ...Array.from({ length: 4 }, (_, i) => ({
        external_id: `archive-${i + 1}.timer`,
        name: `Archive batch ${i + 1}`,
        schedule: 'OnUnitActiveSec=1h',
        timezone: null,
        command: null,
        enabled: false,
        last_run_at: null,
        last_status: null,
        next_run_at: null,
      })),
      {
        external_id: 'sample-index.timer',
        name: 'Index sample feed',
        schedule: 'OnUnitActiveSec=2min',
        timezone: null,
        command: null,
        enabled: true,
        last_run_at: iso(now - 20 * MIN),
        last_status: 'running',
        next_run_at: null,
      },
      {
        external_id: 'sample-backup.timer',
        name: 'Nightly sample backup',
        schedule: 'OnCalendar=*-*-* 03:30:00 UTC',
        timezone: null,
        command: '/usr/local/bin/sample-backup --target /srv/sample',
        enabled: true,
        last_run_at: iso(now - 9 * 60 * MIN),
        last_status: 'ok',
        next_run_at: iso(now + 15 * 60 * MIN),
      },
      {
        external_id: 'sample-poll.timer',
        name: 'Poll sample feed',
        schedule: 'OnUnitInactiveSec=2min',
        timezone: null,
        command: '/bin/sh poll-sample.sh',
        enabled: true,
        last_run_at: iso(now - 1 * MIN),
        last_status: 'failed (exit 1)',
        next_run_at: iso(now + 1 * MIN),
      },
    ],
    new Date(now),
  );

  const job = db.prepare(
    `INSERT INTO jobs (name, schedule, timezone, kind, command, collector_id, enabled, timeout_s,
       created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 60, 'seed', ?) RETURNING id`,
  );
  const run = db.prepare(
    `INSERT INTO job_runs (job_id, started_at, ended_at, exit_code, output, truncated, trigger)
     VALUES (?, ?, ?, ?, ?, 0, 'schedule')`,
  );
  const id = (...a: (string | number | null)[]) =>
    (job.get(...a, iso(now - 7 * 24 * 60 * MIN)) as { id: number }).id;

  const mirror = id(
    'Mirror Hermes cron',
    '*/10 * * * *',
    null,
    'collector',
    null,
    'hermes-cron',
    1,
  );
  for (const ago of [43, 33, 23, 13, 3])
    run.run(
      mirror,
      iso(now - ago * MIN),
      iso(now - ago * MIN + 1200),
      0,
      '{\n  "ok": true,\n  "jobs": 3\n}',
    );

  const cleanup = id(
    'Nightly cleanup',
    '30 3 * * *',
    'UTC',
    'shell',
    'sh cleanup-sample.sh',
    null,
    1,
  );
  run.run(
    cleanup,
    iso(now - 26 * 60 * MIN),
    iso(now - 26 * 60 * MIN + 4000),
    0,
    'removed 12 sample files\n',
  );
  run.run(
    cleanup,
    iso(now - 2 * 60 * MIN),
    iso(now - 2 * 60 * MIN + 95_000),
    2,
    'removed 3 sample files\nerror: sample cache is locked\n',
  );

  id('Weekly report', '0 9 * * 1', null, 'shell', 'echo weekly sample report', null, 0);
  id('Say hello', '0 4 1 1 *', null, 'shell', 'echo hello from the sample job', null, 1);
}
