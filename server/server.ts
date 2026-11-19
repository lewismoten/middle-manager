import { boardRoutes } from './board/routes.ts';
// Builds and starts the HTTP server for a loaded config.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Config } from './config.ts';
import { openAppDb, type Db } from './db/index.ts';
import { createApp, type AppState, type Route } from './http/app.ts';
import { scheduleRetention } from './retention.ts';
import { coreRoutes } from './routes/core.ts';
import { planRoutes } from './plans/routes.ts';
import { scheduleAgentCollectors } from './agents/collect.ts';
import { runRoutes } from './agents/routes.ts';
import { scheduleMirrors } from './schedules/mirror.ts';
import { scheduleRoutes } from './schedules/routes.ts';
import type { CollectorHooks } from './schedules/collectors.ts';
import { noteRoutes } from './notes/routes.ts';
import { connectionRoutes } from './connections/routes.ts';
import { usageRoutes } from './usage/routes.ts';
import { forgetScheduler, schedulerFor } from './schedules/scheduler.ts';
import { ROOT_DIR, VERSION } from './version.ts';

export const DEFAULT_WEB_ROOT = path.join(ROOT_DIR, 'dist', 'web');

export interface StartOptions {
  config: Config;
  db?: Db;
  webRoot?: string;
  /** Overrides config.server.port (0 picks a free port). */
  port?: number;
  host?: string;
  extraRoutes?: Route[];
  /** Run the retention job at start and daily. Default true. */
  retention?: boolean;
  /** Run the agent collectors (process-scan, systemd-workers, session-tokens). Default true. */
  agentCollectors?: boolean;
  /** Run job timers and the Hermes cron / systemd timer mirror. Default true. */
  schedules?: boolean;
  log?: (msg: string) => void;
  /** Host access for POST /collectors/:id/run (tests). */
  collectorHooks?: CollectorHooks;
}

export interface Running {
  server: Server;
  state: AppState;
  url: string;
  close: () => Promise<void>;
}

export function buildState(config: Config, db: Db, webRoot = DEFAULT_WEB_ROOT): AppState {
  return { db, config, version: VERSION, startedAt: new Date(), webRoot };
}

export async function startServer(opts: StartOptions): Promise<Running> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const db = opts.db ?? openAppDb(opts.config);
  const state = buildState(opts.config, db, opts.webRoot);
  if (opts.collectorHooks) state.collectorHooks = opts.collectorHooks;
  const handler = createApp(state, [
    ...coreRoutes,
    ...boardRoutes,
    ...planRoutes,
    ...runRoutes,
    ...scheduleRoutes,
    ...noteRoutes,
    ...connectionRoutes,
    ...usageRoutes,
    ...(opts.extraRoutes ?? []),
  ]);
  const server = createServer((req, res) => void handler(req, res));

  const stopRetention =
    opts.retention === false
      ? () => {}
      : scheduleRetention(
          db,
          opts.config.retention,
          (r) => {
            state.lastRetention = r;
            const n = Object.values(r.deleted).reduce((a, b) => a + b, 0);
            if (n || r.truncated_job_outputs) log(`retention: ${JSON.stringify(r)}`);
          },
          (err) => console.error('retention failed:', err),
        );

  const stopAgents =
    opts.agentCollectors === false
      ? () => {}
      : scheduleAgentCollectors(db, opts.config, (msg) => console.error(msg));

  const scheduler = schedulerFor(db, opts.config);
  const stopMirrors =
    opts.schedules === false ? () => {} : scheduleMirrors(db, opts.config, (m) => console.error(m));
  if (opts.schedules !== false) scheduler.start();

  const host = opts.host ?? opts.config.server.host;
  const port = opts.port ?? opts.config.server.port;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const url = `http://${shownHost}:${addr.port}`;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    stopRetention();
    stopAgents();
    stopMirrors();
    await scheduler.stop();
    forgetScheduler(db);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    if (!opts.db) db.close();
  };
  return { server, state, url, close };
}
