// One entry point for collector jobs: finds the slice that owns a collector and runs it.
//   plan ids (anthropic-oauth, codex-sessions), csv-import collectors   -> plans (S2)
//   hermes-kanban                                                       -> board importer (S3)
//   process-scan, systemd-workers, session-tokens                       -> agent collectors (S4)
//   hermes-cron, systemd-timers                                         -> schedule mirror (S5)

import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { runCollector as runBoardCollector } from '../board/import.ts';
import {
  AGENT_COLLECTOR_KINDS,
  defaultEnv,
  runCollector as runAgentCollector,
  type CollectorEnv,
} from '../agents/collect.ts';
import type { CollectOptions } from '../plans/collectors.ts';
import { resolveCollector, runCollector as runPlanCollector } from '../plans/service.ts';
import { MIRROR_KINDS, runMirror, type MirrorEnv } from './mirror.ts';

export interface RunnableCollector {
  id: string;
  kind: string;
}

const CONFIG_KINDS: readonly string[] = [
  'hermes-kanban',
  'csv-import',
  ...AGENT_COLLECTOR_KINDS,
  ...MIRROR_KINDS,
];

/** Collectors a job can run. Manual plans are left out: they need a reading sent to them. */
export function runnableCollectors(config: Config): RunnableCollector[] {
  return [
    ...config.plans
      .filter((p) => p.provider !== 'manual')
      .map((p) => ({ id: p.id, kind: p.provider as string })),
    ...config.collectors
      .filter((c) => CONFIG_KINDS.includes(c.kind))
      .map((c) => ({ id: c.id, kind: c.kind })),
  ];
}

/** Thrown when no plan or configured collector has this id. */
export class UnknownCollectorError extends Error {}

/** Host access for each collector family; tests swap these for fixtures. */
export interface CollectorHooks {
  agents?: CollectorEnv;
  mirror?: MirrorEnv;
  plans?: CollectOptions;
}

/** Runs a collector and returns its report. Throws with a short message on failure. */
export async function runCollectorById(
  db: Db,
  config: Config,
  id: string,
  hooks: CollectorHooks = {},
): Promise<Record<string, unknown>> {
  const c = config.collectors.find((x) => x.id === id);
  if (c?.kind === 'hermes-kanban') {
    return { id, kind: c.kind, ok: true, ...runBoardCollector(db, config, id) };
  }
  if (c && (AGENT_COLLECTOR_KINDS as readonly string[]).includes(c.kind)) {
    const r = await runAgentCollector(db, config, c, hooks.agents ?? defaultEnv());
    if (!r.ok) throw new Error(r.error ?? 'collector failed');
    return { ...r };
  }
  if (c && (MIRROR_KINDS as readonly string[]).includes(c.kind)) {
    const r = await runMirror(db, config, c, hooks.mirror);
    if (!r.ok) throw new Error(r.error ?? 'collector failed');
    return { ...r };
  }
  const target = resolveCollector(config, id);
  if (target) {
    const r = await runPlanCollector(db, config, target, {}, hooks.plans);
    return { id, ok: true, ...r, readings: r.readings.length };
  }
  const known = runnableCollectors(config).map((x) => x.id);
  throw new UnknownCollectorError(
    `No collector "${id}" in the config${known.length ? ` (collectors: ${known.join(', ')})` : ''}`,
  );
}
