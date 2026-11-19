// Schedules API (SPEC 6): GET/POST /jobs, GET/PATCH/DELETE /jobs/:id, POST /jobs/:id/run,
// GET /jobs/:id/runs, GET /jobs/preview, GET /external-jobs, POST /external-jobs/refresh,
// POST /collectors/:id/run (any runnable collector: plans, board, agents, mirrors).
// Creating, editing or deleting a shell job needs the jobs:shell scope (SPEC 9); so does turning
// a collector job into a shell job. Running an existing job needs only `write`.

import type { TokenInfo } from '../auth.ts';
import { HttpError, readJson, sendJson, type Ctx, type Route } from '../http/app.ts';
import { CollectorError } from '../plans/collectors.ts';
import { CollectorInputError } from '../plans/service.ts';
import { runCollectorById, runnableCollectors, UnknownCollectorError } from './collectors.ts';
import { checkSchedule } from './cron.ts';
import {
  deleteJob,
  insertJob,
  listJobRuns,
  listJobs,
  mustGetJob,
  parseJobInput,
  summarizeRun,
  updateJob,
  validTimezone,
  viewJob,
  type JobRunRow,
} from './jobs.ts';
import { listExternal, runMirrors } from './mirror.ts';
import { schedulerFor } from './scheduler.ts';

function jobId(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) throw new HttpError(400, 'invalid', 'Job id must be a number');
  return Number(raw);
}

function needShellScope(token: TokenInfo | null): void {
  if (!token?.scopes.some((s) => s === 'jobs:shell' || s === 'admin'))
    throw new HttpError(
      403,
      'forbidden',
      `Shell jobs need a token with the "jobs:shell" scope${token ? ` ("${token.name}" lacks it)` : ''}`,
    );
}

function fullRun(r: JobRunRow) {
  return { ...summarizeRun(r), job_id: r.job_id, output: r.output ?? '' };
}

const collectorIds = (ctx: Ctx) => runnableCollectors(ctx.state.config).map((c) => c.id);

export const scheduleRoutes: Route[] = [
  {
    method: 'GET',
    path: '/jobs',
    handler: ({ state }) => {
      const now = new Date();
      const s = schedulerFor(state.db, state.config);
      const jobs = listJobs(state.db).map((j) =>
        viewJob(state.db, state.config, j, s.isRunning(j.id), now),
      );
      return {
        now: now.toISOString(),
        site_timezone: state.config.site.timezone,
        jobs,
        failed_24h: jobs.reduce((n, j) => n + j.failed_24h, 0),
        collectors: runnableCollectors(state.config),
      };
    },
  },
  {
    // Checks a schedule and lists its next runs, for the job form. Before /jobs/:id on purpose.
    method: 'GET',
    path: '/jobs/preview',
    handler: ({ state, url }) => {
      const schedule = url.searchParams.get('schedule') ?? '';
      const tz = url.searchParams.get('timezone') || state.config.site.timezone;
      if (!validTimezone(tz))
        return {
          ok: false,
          error: `"${tz}" is not a known IANA time zone`,
          next: [],
          timezone: tz,
        };
      return { ...checkSchedule(schedule, tz, 3), timezone: tz };
    },
  },
  {
    method: 'POST',
    path: '/jobs',
    handler: async (ctx) => {
      const input = parseJobInput(await readJson(ctx.req), ctx.state.config, collectorIds(ctx));
      if (input.kind === 'shell') needShellScope(ctx.token);
      const job = insertJob(ctx.state.db, input, ctx.token?.name ?? null);
      const s = schedulerFor(ctx.state.db, ctx.state.config);
      s.sync(job.id);
      return viewJob(ctx.state.db, ctx.state.config, job, false);
    },
  },
  {
    method: 'GET',
    path: '/jobs/:id',
    handler: ({ state, params }) => {
      const job = mustGetJob(state.db, jobId(params.id));
      const s = schedulerFor(state.db, state.config);
      return viewJob(state.db, state.config, job, s.isRunning(job.id));
    },
  },
  {
    method: 'PATCH',
    path: '/jobs/:id',
    handler: async (ctx) => {
      const existing = mustGetJob(ctx.state.db, jobId(ctx.params.id));
      const input = parseJobInput(
        await readJson(ctx.req),
        ctx.state.config,
        collectorIds(ctx),
        existing,
      );
      if (existing.kind === 'shell' || input.kind === 'shell') needShellScope(ctx.token);
      const job = updateJob(ctx.state.db, existing.id, input);
      const s = schedulerFor(ctx.state.db, ctx.state.config);
      s.sync(job.id);
      return viewJob(ctx.state.db, ctx.state.config, job, s.isRunning(job.id));
    },
  },
  {
    method: 'DELETE',
    path: '/jobs/:id',
    handler: ({ state, params, token }) => {
      const job = mustGetJob(state.db, jobId(params.id));
      if (job.kind === 'shell') needShellScope(token);
      const s = schedulerFor(state.db, state.config);
      if (s.isRunning(job.id))
        throw new HttpError(409, 'job_running', 'This job is running; delete it after it ends');
      deleteJob(state.db, job.id);
      s.sync(job.id);
      return { deleted: job.id };
    },
  },
  {
    // Starts a run and answers 202 at once; ?wait=1 waits for the end (max the job's timeout).
    method: 'POST',
    path: '/jobs/:id/run',
    handler: async ({ state, params, token, url, res }) => {
      const job = mustGetJob(state.db, jobId(params.id));
      const s = schedulerFor(state.db, state.config);
      const { run, done } = s.run(job, 'manual', token?.name ?? null);
      if (url.searchParams.get('wait') === '1') return sendJson(res, 200, fullRun(await done));
      done.catch(() => null);
      return sendJson(res, 202, fullRun(run));
    },
  },
  {
    method: 'GET',
    path: '/jobs/:id/runs',
    handler: ({ state, params, url }) => {
      const job = mustGetJob(state.db, jobId(params.id));
      const raw = Number(url.searchParams.get('limit') ?? 20);
      const limit = Number.isInteger(raw) && raw > 0 ? raw : 20;
      return { job_id: job.id, runs: listJobRuns(state.db, job.id, limit).map(fullRun) };
    },
  },
  {
    method: 'GET',
    path: '/external-jobs',
    handler: ({ state }) => {
      const now = new Date();
      return { now: now.toISOString(), jobs: listExternal(state.db, state.config, now) };
    },
  },
  {
    method: 'POST',
    path: '/external-jobs/refresh',
    handler: async ({ state, res }) =>
      sendJson(res, 200, { collectors: await runMirrors(state.db, state.config) }),
  },
  {
    method: 'POST',
    path: '/collectors/:id/run',
    handler: async ({ state, params }) => {
      const id = params.id ?? '';
      try {
        return await runCollectorById(state.db, state.config, id, state.collectorHooks);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (err instanceof UnknownCollectorError)
          throw new HttpError(404, 'not_found', err.message);
        if (err instanceof CollectorInputError)
          throw new HttpError(400, 'bad_request', err.message);
        const msg = err instanceof CollectorError ? err.message : (err as Error).message;
        throw new HttpError(502, 'collector_failed', `${id}: ${msg}`);
      }
    },
  },
];
