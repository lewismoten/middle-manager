import { checkQuery } from '../http/query.ts';
// S2 routes: plans, readings, pacing and running plan collectors.

import { HttpError, readJson, type Ctx, type Route } from '../http/app.ts';
import { CollectorError } from './collectors.ts';
import {
  allPace,
  CollectorInputError,
  planWindowDetail,
  planWindowList,
  planSummaries,
  resolveCollector,
  runCollector,
} from './service.ts';
import { insertReadings, isoTime, listReadings, parseReading, ReadingError } from './store.ts';
import { hostMachineId } from './collectors.ts';

const MAX_READINGS_PER_POST = 500;

function planOr404(ctx: Ctx) {
  const plan = ctx.state.config.plans.find((p) => p.id === ctx.params.id);
  if (!plan) throw new HttpError(404, 'not_found', `No plan "${ctx.params.id}"`);
  return plan;
}

function badRequest(err: unknown): never {
  if (err instanceof ReadingError || err instanceof CollectorInputError) {
    throw new HttpError(400, 'bad_request', err.message);
  }
  throw err;
}

export const planRoutes: Route[] = [
  {
    method: 'GET',
    path: '/plans',
    handler: ({ state }) => ({ plans: planSummaries(state.db, state.config) }),
  },
  {
    method: 'GET',
    path: '/plans/pace',
    handler: ({ state, url }) => {
      const { config, db } = state;
      const q = url.searchParams;
      checkQuery(q, {
        plan: config.plans.map((p) => p.id),
        model: Object.values(config.models).flat(),
      });
      const plan = q.get('plan'),
        model = q.get('model');
      const plans = config.plans.filter(
        (p) => (!plan || p.id === plan) && (!model || config.models[p.id]?.includes(model)),
      );
      return allPace(db, { ...config, plans });
    },
  },
  {
    method: 'GET',
    path: '/plans/:id/readings',
    handler: (ctx) => {
      const plan = planOr404(ctx);
      const q = ctx.url.searchParams;
      let since: string | undefined;
      try {
        since = q.get('since') ? isoTime(q.get('since'), 'since') : undefined;
      } catch (err) {
        badRequest(err);
      }
      const window = q.get('window') ?? undefined;
      const limit = Math.min(10_000, Math.max(1, Number(q.get('limit')) || 5000));
      let reset: number | undefined;
      try {
        reset = q.get('reset') ? Date.parse(isoTime(q.get('reset'), 'reset')) : undefined;
      } catch (err) {
        badRequest(err);
      }
      const rawMax = q.get('max_points');
      const maxPoints = rawMax === null ? undefined : Number(rawMax);
      if (
        maxPoints !== undefined &&
        (!Number.isInteger(maxPoints) || maxPoints < 10 || maxPoints > 5000)
      ) {
        throw new HttpError(
          400,
          'invalid_input',
          'max_points must be a whole number from 10 to 5000',
        );
      }
      return {
        plan: plan.id,
        readings: listReadings(ctx.state.db, plan.id, { since, window, limit, reset, maxPoints }),
      };
    },
  },
  {
    method: 'GET',
    path: '/plans/:id/windows',
    handler: (ctx) => {
      const plan = planOr404(ctx);
      const q = ctx.url.searchParams;
      checkQuery(q, { current: ['0', '1'], limit: null });
      const raw = q.get('limit');
      const limit = raw === null ? 52 : Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new HttpError(400, 'invalid_input', 'limit must be a whole number from 1 to 200');
      }
      return planWindowList(ctx.state.db, plan, {
        limit,
        includeCurrent: q.get('current') !== '0',
      });
    },
  },
  {
    method: 'GET',
    path: '/plans/:id/windows/:window',
    handler: (ctx) => {
      const plan = planOr404(ctx);
      const which = ctx.params.window ?? '';
      if (which !== 'current') {
        try {
          isoTime(which, 'window');
        } catch {
          throw new HttpError(
            400,
            'bad_request',
            'window must be "current" or a reset time with a zone, such as 2026-11-20T23:00:00Z',
          );
        }
      }
      const out = planWindowDetail(ctx.state.db, plan, which);
      if (!out) throw new HttpError(404, 'not_found', `No weekly window resetting at ${which}`);
      return out;
    },
  },
  {
    method: 'POST',
    path: '/plans/:id/readings',
    handler: async (ctx) => {
      const plan = planOr404(ctx);
      const body = await readJson(ctx.req);
      const list =
        body && typeof body === 'object' && Array.isArray((body as { readings?: unknown }).readings)
          ? (body as { readings: unknown[] }).readings
          : [body];
      if (list.length > MAX_READINGS_PER_POST) {
        throw new HttpError(
          400,
          'bad_request',
          `At most ${MAX_READINGS_PER_POST} readings per request`,
        );
      }
      const defaults = {
        read_at: new Date().toISOString(),
        how: 'api',
        machine_id: hostMachineId(ctx.state.config),
      };
      try {
        const readings = list.map((r) => parseReading(r, plan.id, defaults));
        return { plan: plan.id, ...insertReadings(ctx.state.db, readings), readings };
      } catch (err) {
        badRequest(err);
      }
    },
  },
  {
    // Namespaced under /plans/ to avoid colliding with the board's
    // /collectors/:id/run (the hermes-kanban importer).
    method: 'POST',
    path: '/plans/collectors/:id/run',
    handler: async (ctx) => {
      const target = resolveCollector(ctx.state.config, ctx.params.id ?? '');
      if (!target) throw new HttpError(404, 'not_found', `No plan collector "${ctx.params.id}"`);
      const body = ((await readJson(ctx.req)) ?? {}) as Record<string, unknown>;
      if (typeof body !== 'object' || Array.isArray(body)) {
        throw new HttpError(400, 'bad_request', 'Body must be a JSON object');
      }
      const map =
        body.map && typeof body.map === 'object' && !Array.isArray(body.map)
          ? Object.fromEntries(Object.entries(body.map).map(([k, v]) => [k, String(v)]))
          : undefined;
      try {
        const result = await runCollector(ctx.state.db, ctx.state.config, target, {
          csv: typeof body.csv === 'string' ? body.csv : undefined,
          map,
          reading: body.reading,
        });
        return { ok: true, ...result, readings: result.readings.length };
      } catch (err) {
        if (err instanceof CollectorError) {
          throw new HttpError(502, 'collector_failed', `${target.id}: ${err.message}`);
        }
        badRequest(err);
      }
    },
  },
];
