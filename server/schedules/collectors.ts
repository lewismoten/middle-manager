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
} from '../agents/collect.ts';
import { resolveCollector, runCollector as runPlanCollector } from '../plans/service.ts';
import { MIRROR_KINDS, runMirror } from './mirror.ts';

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

/** Runs a collector and returns its report. Throws with a short message on failure. */
export async function runCollectorById(db: Db, config: Config, id: string): Promise<unknown> {
  const c = config.collectors.find((x) => x.id === id);
  if (c?.kind === 'hermes-kanban') return runBoardCollector(db, config, id);
  if (c && (AGENT_COLLECTOR_KINDS as readonly string[]).includes(c.kind)) {
    const r = await runAgentCollector(db, config, c, defaultEnv());
    if (!r.ok) throw new Error(r.error ?? 'collector failed');
    return r;
  }
  if (c && (MIRROR_KINDS as readonly string[]).includes(c.kind)) {
    const r = await runMirror(db, config, c);
    if (!r.ok) throw new Error(r.error ?? 'collector failed');
    return r;
  }
  const target = resolveCollector(config, id);
  if (target) {
    const r = await runPlanCollector(db, config, target);
    return { ...r, readings: r.readings.length };
  }
  throw new Error(`No collector "${id}" in the config`);
}
