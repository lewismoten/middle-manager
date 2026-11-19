// Runs the agent collectors configured in config.collectors:
//   - { id, kind: process-scan, match: ["codex exec", "claude -p"], every_s?, machine? }
//   - { id, kind: systemd-workers, prefix: "worker-", every_s?, machine?, agent_kind? }
//   - { id, kind: session-tokens, claude_dir?, codex_dir?, every_s?, machine? }
// They run on the machine that hosts the service, every `every_s` seconds (default 30), and on
// demand through POST /runs/scan.

import { hostname } from 'node:os';
import type { CollectorConfig, Config } from '../config.ts';
import { expandHome } from '../config.ts';
import type { Db } from '../db/index.ts';
import {
  discoverProcesses,
  gitCache,
  listProcesses,
  parseMatchRules,
  type ProcInfo,
} from './process-scan.ts';
import {
  AGENT_KINDS,
  applyTokenTotals,
  endVanishedPids,
  endVanishedUnits,
  mergeDiscovered,
  type AgentKind,
  type RunRow,
} from './runs.ts';
import { discoverUnits, listWorkerUnits, type UnitInfo } from './systemd.ts';
import { readerFor, SessionTail, type ReaderDirs } from './tokens.ts';

export const AGENT_COLLECTOR_KINDS = ['process-scan', 'systemd-workers', 'session-tokens'] as const;

export interface CollectorReport {
  id: string;
  kind: string;
  ok: boolean;
  error?: string;
  inserted?: number;
  updated?: number;
  ended?: number;
  tokens_updated?: number;
}

/** Hooks so tests can run collectors without touching the real host. */
export interface CollectorEnv {
  listProcesses: () => Promise<ProcInfo[]>;
  listUnits: (prefix: string) => Promise<UnitInfo[]>;
  git: ReturnType<typeof gitCache>;
  tail: SessionTail;
  now: () => Date;
}

export function defaultEnv(tail = new SessionTail()): CollectorEnv {
  return {
    listProcesses,
    listUnits: listWorkerUnits,
    git: gitCache(),
    tail,
    now: () => new Date(),
  };
}

/** The machine id collectors record: the collector's `machine`, else the first configured machine. */
export function collectorMachine(config: Config, c: CollectorConfig): string {
  if (typeof c.machine === 'string' && c.machine) return c.machine;
  return config.machines[0]?.id ?? hostname();
}

function readerDirs(config: Config, c: CollectorConfig): ReaderDirs {
  const codexPlan = config.plans.find((p) => p.provider === 'codex-sessions');
  return {
    claude_dir: expandHome(typeof c.claude_dir === 'string' ? c.claude_dir : '~/.claude/projects'),
    codex_dir: expandHome(
      typeof c.codex_dir === 'string'
        ? c.codex_dir
        : (codexPlan?.sessions_dir ?? '~/.codex/sessions'),
    ),
  };
}

export function agentCollectors(config: Config): CollectorConfig[] {
  return config.collectors.filter((c) =>
    (AGENT_COLLECTOR_KINDS as readonly string[]).includes(c.kind),
  );
}

export async function runCollector(
  db: Db,
  config: Config,
  c: CollectorConfig,
  env: CollectorEnv,
): Promise<CollectorReport> {
  const report: CollectorReport = { id: c.id, kind: c.kind, ok: true };
  const machine = collectorMachine(config, c);
  const now = env.now();
  try {
    if (c.kind === 'process-scan') {
      const rules = parseMatchRules(c.match);
      const procs = await env.listProcesses();
      const found = await discoverProcesses(procs, rules, env.git);
      const r = mergeDiscovered(db, machine, 'process-scan', found, now);
      const alive = new Map(procs.map((p) => [p.pid, p.started_at]));
      Object.assign(report, {
        inserted: r.inserted,
        updated: r.updated,
        ended: endVanishedPids(db, machine, alive, now),
      });
    } else if (c.kind === 'systemd-workers') {
      const prefix = typeof c.prefix === 'string' && c.prefix ? c.prefix : 'worker-';
      const kind =
        typeof c.agent_kind === 'string' &&
        (AGENT_KINDS as readonly string[]).includes(c.agent_kind)
          ? (c.agent_kind as AgentKind)
          : undefined;
      const units = await env.listUnits(prefix);
      const found = await discoverUnits(units, { kind }, env.git);
      const r = mergeDiscovered(db, machine, 'systemd-workers', found, now);
      const listed = new Set(units.map((u) => u.unit));
      const ended = endVanishedUnits(db, machine, prefix, listed, now);
      Object.assign(report, { inserted: r.inserted, updated: r.updated, ended });
    } else if (c.kind === 'session-tokens') {
      report.tokens_updated = readSessionTokens(db, machine, readerDirs(config, c), env.tail, now);
    } else {
      return { ...report, ok: false, error: `not an agent collector kind: ${c.kind}` };
    }
  } catch (err) {
    report.ok = false;
    report.error = (err as Error).message;
  }
  return report;
}

/** Refreshes tokens for open runs (and runs that ended in the last 15 minutes) on this machine. */
export function readSessionTokens(
  db: Db,
  machine: string,
  dirs: ReaderDirs,
  tail: SessionTail,
  now = new Date(),
): number {
  const since = new Date(now.getTime() - 15 * 60_000).toISOString();
  const runs = db
    .prepare(
      `SELECT * FROM runs WHERE machine_id = ? AND (ended_at IS NULL OR ended_at >= ?)
       AND agent_kind IN ('claude-code', 'codex')`,
    )
    .all(machine, since) as unknown as RunRow[];
  let n = 0;
  for (const run of runs) {
    const reader = readerFor(run);
    if (!reader) continue;
    const loc = reader.locate(run, dirs);
    if (!loc) continue;
    try {
      const t = tail.read(reader, loc.file);
      applyTokenTotals(db, run.id, t, { model: t.model, log_ref: loc.ref });
      n++;
    } catch {
      /* file vanished between locate and read */
    }
  }
  return n;
}

export async function runAgentCollectors(
  db: Db,
  config: Config,
  env: CollectorEnv,
): Promise<CollectorReport[]> {
  const out: CollectorReport[] = [];
  // Units first, so a worker's main process merges into its unit's run; tokens last.
  const order = ['systemd-workers', 'process-scan', 'session-tokens'];
  const list = agentCollectors(config).sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
  );
  for (const c of list) out.push(await runCollector(db, config, c, env));
  return out;
}

/** Starts the periodic scan. Returns a stop function. */
export function scheduleAgentCollectors(
  db: Db,
  config: Config,
  onError: (msg: string) => void,
  env = defaultEnv(),
): () => void {
  const list = agentCollectors(config);
  if (!list.length) return () => {};
  const every = Math.max(
    5,
    Math.min(...list.map((c) => (typeof c.every_s === 'number' ? c.every_s : 30))),
  );
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      env.git = gitCache();
      for (const r of await runAgentCollectors(db, config, env)) {
        if (!r.ok) onError(`collector ${r.id} (${r.kind}): ${r.error}`);
      }
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), every * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
