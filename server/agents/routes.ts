// Runs API (SPEC 6): GET /runs, GET /runs/:id, POST /runs (start), PATCH /runs/:id (progress,
// tokens, end), POST /runs/scan (run the agent collectors now).

import { HttpError, readJson, sendJson, type Route } from '../http/app.ts';
import { runAgentCollectors, defaultEnv } from './collect.ts';
import { getRun, listRuns, parseFilters, patchRun, startRun } from './runs.ts';
import { SessionTail } from './tokens.ts';

function runId(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) throw new HttpError(400, 'invalid', 'Run id must be a number');
  return Number(raw);
}

// One read cursor per process for on-demand scans as well as scheduled ones.
const tail = new SessionTail();

export const runRoutes: Route[] = [
  {
    method: 'GET',
    path: '/runs',
    handler: ({ state, url }) => {
      const now = new Date();
      return {
        now: now.toISOString(),
        runs: listRuns(state.db, parseFilters(url.searchParams), now),
      };
    },
  },
  {
    method: 'POST',
    path: '/runs/scan',
    handler: async ({ state, res }) =>
      sendJson(res, 200, {
        collectors: await runAgentCollectors(state.db, state.config, defaultEnv(tail)),
      }),
  },
  {
    method: 'GET',
    path: '/runs/:id',
    handler: ({ state, params }) => getRun(state.db, runId(params.id)),
  },
  {
    method: 'POST',
    path: '/runs',
    handler: async ({ state, req, res }) => {
      const r = startRun(state.db, await readJson(req));
      const body = { ...getRun(state.db, r.run.id), merged: r.merged, warnings: r.warnings };
      // A merge updates an existing run (found by machine + pid), so it is 200, not 201.
      if (r.merged) return sendJson(res, 200, body);
      return body;
    },
  },
  {
    method: 'PATCH',
    path: '/runs/:id',
    handler: async ({ state, req, params }) => {
      const r = patchRun(state.db, runId(params.id), await readJson(req));
      return { ...getRun(state.db, r.run.id), warnings: r.warnings };
    },
  },
];
