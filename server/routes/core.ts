// S1 routes: health, public config, DB stats, and who the current token belongs to.

import type { Config } from '../config.ts';
import { dbStats } from '../db/index.ts';
import type { Route } from '../http/app.ts';

/** The parts of the config that are safe to show anyone on the network: no paths, URLs or secrets. */
export function publicConfig(config: Config, version: string) {
  return {
    version,
    site: { name: config.site.name, timezone: config.site.timezone },
    machines: config.machines.map(({ id, name, role }) => ({ id, name, role: role ?? null })),
    plans: config.plans.map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      windows: p.windows,
      empty_buffer_hours: p.empty_buffer_hours,
      models: config.models[p.id] ?? [],
    })),
    local_models: config.local_models.map(({ id, name, kind }) => ({ id, name, kind })),
    projects: config.projects.map((p) => ({
      id: p.id,
      name: p.name,
      repo: p.repo ?? null,
      default_branch: p.default_branch ?? null,
    })),
    documents: config.documents.map((d) => ({ id: d.id, name: d.name, private: d.private })),
    collectors: config.collectors.map((c) => ({ id: c.id, kind: c.kind })),
    retention: config.retention,
  };
}

export const coreRoutes: Route[] = [
  {
    method: 'GET',
    path: '/health',
    handler: ({ state }) => {
      state.db.prepare('SELECT 1').get();
      return {
        ok: true,
        version: state.version,
        time: new Date().toISOString(),
        uptime_s: Math.round((Date.now() - state.startedAt.getTime()) / 1000),
      };
    },
  },
  {
    method: 'GET',
    path: '/config/public',
    handler: ({ state }) => publicConfig(state.config, state.version),
  },
  {
    method: 'GET',
    path: '/stats',
    handler: ({ state }) => {
      // The file path stays on the host; the Settings page shows it to signed-in users later.
      const db: Partial<ReturnType<typeof dbStats>> = dbStats(state.db, state.config.database.path);
      delete db.path;
      return {
        version: state.version,
        db,
        retention: state.config.retention,
        last_retention: state.lastRetention ?? null,
      };
    },
  },
  {
    method: 'GET',
    path: '/auth/whoami',
    handler: ({ token }) =>
      token ? { token: { name: token.name, scopes: token.scopes } } : { token: null },
  },
];
