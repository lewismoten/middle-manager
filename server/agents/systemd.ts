// systemd-workers collector: transient user units whose names match a prefix (e.g. worker-*),
// such as agents started with `systemd-run --user --unit worker-<name> ...`.

import { execFile } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { promisify } from 'node:util';
import { argvDetails, gitCache, inferKind, redactSecrets } from './process-scan.ts';
import type { AgentKind, Discovered, RunStatus } from './runs.ts';

const run = promisify(execFile);

export interface UnitInfo {
  unit: string;
  active_state: string;
  sub_state: string;
  started_at: string | null;
  ended_at: string | null;
  main_pid: number | null;
  cwd: string | null;
  command: string | null;
  description: string | null;
}

const PROPS = [
  'Id',
  'ActiveState',
  'SubState',
  'ExecMainStartTimestamp',
  'ExecMainExitTimestamp',
  'MainPID',
  'WorkingDirectory',
  'ExecStart',
  'Description',
];

/** Parses systemd times printed with --timestamp=unix ("@1763560000") or the default format. */
export function parseSystemdTime(v: string | undefined): string | null {
  if (!v || v === 'n/a' || v === '0') return null;
  const unix = /^@(\d+)$/.exec(v.trim());
  if (unix) return new Date(Number(unix[1]) * 1000).toISOString();
  // "Thu 2026-11-19 10:00:00 UTC": drop the weekday; Date understands the rest for UTC/GMT.
  const m = /^\w{3} (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?: (\S+))?$/.exec(v.trim());
  if (!m) return null;
  const zone = m[3] && /^(UTC|GMT)$/.test(m[3]) ? 'Z' : '';
  const d = new Date(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ExecStart looks like "{ path=/usr/bin/x ; argv[]=/usr/bin/x a b ; ignore_errors=no ; ... }". */
export function parseExecStart(v: string | undefined): string | null {
  if (!v) return null;
  const m = /argv\[\]=(.*?) ;/.exec(v);
  return m?.[1]?.trim() || null;
}

/** Parses `systemctl show` output for several units (blocks separated by blank lines). */
export function parseShow(text: string): UnitInfo[] {
  const out: UnitInfo[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const p: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) p[line.slice(0, i)] = line.slice(i + 1);
    }
    if (!p.Id) continue;
    const pid = Number(p.MainPID);
    out.push({
      unit: p.Id,
      active_state: p.ActiveState ?? 'unknown',
      sub_state: p.SubState ?? '',
      started_at: parseSystemdTime(p.ExecMainStartTimestamp),
      ended_at: parseSystemdTime(p.ExecMainExitTimestamp),
      main_pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      cwd: p.WorkingDirectory || null,
      command: parseExecStart(p.ExecStart),
      description: p.Description || null,
    });
  }
  return out;
}

export function unitStatus(u: UnitInfo): RunStatus {
  if (
    u.active_state === 'active' ||
    u.active_state === 'activating' ||
    u.active_state === 'reloading'
  )
    return 'running';
  if (u.active_state === 'failed') return 'failed';
  return 'ended';
}

export async function listWorkerUnits(prefix: string): Promise<UnitInfo[]> {
  const pattern = `${prefix}*`;
  const { stdout: list } = await run(
    'systemctl',
    [
      '--user',
      'list-units',
      '--all',
      '--plain',
      '--no-legend',
      '--no-pager',
      '--type=service',
      pattern,
    ],
    { timeout: 5000 },
  );
  const units = list
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter((u) => u.startsWith(prefix));
  if (!units.length) return [];
  const { stdout } = await run(
    'systemctl',
    ['--user', 'show', '--no-pager', '--timestamp=unix', `--property=${PROPS.join(',')}`, ...units],
    { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
  );
  return parseShow(stdout);
}

function procCwd(pid: number | null): string | null {
  if (!pid) return null;
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

export async function discoverUnits(
  units: UnitInfo[],
  opts: { kind?: AgentKind } = {},
  git = gitCache(),
  cwdOf = procCwd,
): Promise<Discovered[]> {
  return Promise.all(
    units.map(async (u): Promise<Discovered> => {
      const cwd = u.cwd ?? cwdOf(u.main_pid);
      const g = await git(cwd);
      const command = redactSecrets(u.command ?? u.description ?? u.unit);
      const status = unitStatus(u);
      const { model, prompt } = argvDetails(command.split(/\s+/));
      return {
        pid: u.main_pid,
        unit: u.unit,
        command: command.slice(0, 4000),
        agent_kind: opts.kind ?? inferKind(command),
        status,
        started_at: u.started_at,
        ended_at: status === 'running' ? null : u.ended_at,
        model,
        prompt,
        harness: 'systemd',
        origin: g.origin,
        branch: g.branch,
        worktree: g.worktree ?? cwd,
      };
    }),
  );
}
