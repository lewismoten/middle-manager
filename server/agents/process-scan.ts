// process-scan collector: finds agent processes on this host by command-line patterns from config,
// with pid, command, cwd, start time and the git branch/origin of the cwd.
// Linux reads /proc directly; other systems fall back to `ps` (no cwd there).

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentKind, Discovered, Role } from './runs.ts';

const run = promisify(execFile);

export interface ProcInfo {
  pid: number;
  ppid: number;
  argv: string[];
  /** argv joined with spaces, as shown to people. */
  command: string;
  cwd: string | null;
  started_at: string | null;
}

export interface MatchRule {
  pattern: string;
  kind?: AgentKind;
  role?: Role;
}

// ---- Listing processes ----

/** Linux /proc: USER_HZ is 100 on every Linux ABI, so start ticks / 100 = seconds after boot. */
const USER_HZ = 100;

function bootTimeMs(procRoot: string): number | null {
  try {
    const m = /^btime (\d+)$/m.exec(readFileSync(path.join(procRoot, 'stat'), 'utf8'));
    return m ? Number(m[1]) * 1000 : null;
  } catch {
    return null;
  }
}

/** Parses /proc/<pid>/stat; the command name in parentheses may contain spaces or ")". */
export function parseProcStat(text: string): { ppid: number; startTicks: number } | null {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const rest = text.slice(close + 2).split(' ');
  // rest[0] is field 3 (state); ppid is field 4, starttime is field 22.
  const ppid = Number(rest[1]);
  const startTicks = Number(rest[19]);
  if (!Number.isFinite(ppid) || !Number.isFinite(startTicks)) return null;
  return { ppid, startTicks };
}

export function listProcProcesses(procRoot = '/proc'): ProcInfo[] {
  const boot = bootTimeMs(procRoot);
  const out: ProcInfo[] = [];
  for (const name of readdirSync(procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    const dir = path.join(procRoot, name);
    try {
      const raw = readFileSync(path.join(dir, 'cmdline'), 'utf8');
      const argv = raw.split('\0').filter((a, i, all) => a !== '' || i < all.length - 1);
      if (!argv.length) continue; // kernel threads
      const stat = parseProcStat(readFileSync(path.join(dir, 'stat'), 'utf8'));
      let cwd: string | null = null;
      try {
        cwd = readlinkSync(path.join(dir, 'cwd'));
      } catch {
        /* another user's process */
      }
      out.push({
        pid: Number(name),
        ppid: stat?.ppid ?? 0,
        argv,
        command: argv.join(' '),
        cwd,
        started_at:
          stat && boot !== null
            ? new Date(boot + (stat.startTicks / USER_HZ) * 1000).toISOString()
            : null,
      });
    } catch {
      /* exited while we looked */
    }
  }
  return out;
}

/** Parses `ps -axo pid=,ppid=,lstart=,command=` (lstart is "Thu Nov 19 10:00:00 2026"). */
export function parsePs(text: string): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    const command = m[4] ?? '';
    const started = new Date(m[3] ?? '');
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      argv: command.split(/\s+/),
      command,
      cwd: null,
      started_at: Number.isNaN(started.getTime()) ? null : started.toISOString(),
    });
  }
  return out;
}

export async function listProcesses(): Promise<ProcInfo[]> {
  if (existsSync('/proc/self/stat')) return listProcProcesses();
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,lstart=,command='], {
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return parsePs(stdout);
}

// ---- Matching ----

export function parseMatchRules(raw: unknown): MatchRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('match must be a list of patterns');
  return raw.map((m, i) => {
    if (typeof m === 'string' && m.trim()) return { pattern: m };
    if (typeof m === 'object' && m !== null && typeof (m as MatchRule).pattern === 'string') {
      return m as MatchRule;
    }
    throw new Error(`match[${i}] must be a string or { pattern, kind?, role? }`);
  });
}

export function inferKind(command: string): AgentKind {
  const c = command.toLowerCase();
  if (/\bclaude\b/.test(c)) return 'claude-code';
  if (/\bcodex\b/.test(c)) return 'codex';
  if (/\bhermes\b/.test(c)) return 'hermes';
  if (/\b(ollama|llama[-.]?cpp|llama-server|lm-studio)\b/.test(c)) return 'local';
  return 'other';
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh']);

function isShellWrapper(p: ProcInfo): boolean {
  const base = path.basename(p.argv[0] ?? '').replace(/^-/, '');
  return SHELLS.has(base) && p.argv.slice(1).some((a) => /^-\w*c\w*$/.test(a));
}

/** Pulls the model, and the prompt when it is on the command line, out of argv. */
export function argvDetails(argv: string[]): { model: string | null; prompt: string | null } {
  let model: string | null = null;
  let prompt: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--model' || a === '-m') model = argv[i + 1] ?? null;
    else if (a.startsWith('--model=')) model = a.slice(8);
    if ((a === '-p' || a === '--print') && argv[i + 1] && !argv[i + 1]?.startsWith('-')) {
      prompt = argv[i + 1] ?? null;
    }
  }
  const exec = argv.indexOf('exec');
  if (!prompt && exec >= 0 && /codex/.test(argv.slice(0, exec).join(' '))) {
    const last = argv[argv.length - 1];
    if (argv.length - 1 > exec && last && !last.startsWith('-')) prompt = last;
  }
  return { model, prompt };
}

export interface Matched {
  proc: ProcInfo;
  rule: MatchRule;
  parentPid: number | null;
}

/**
 * Picks agent processes. Wrappers are dropped in favour of the agent they start: a shell running
 * `-c "claude -p ..."` or a `timeout 600 claude -p ...` whose command contains its child's.
 * Each kept process is linked to its nearest kept ancestor (a sub-agent started by an agent).
 */
export function matchProcesses(
  procs: ProcInfo[],
  rules: MatchRule[],
  selfPid = process.pid,
): Matched[] {
  if (!rules.length) return [];
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const hits = new Map<number, Matched>();
  for (const p of procs) {
    if (p.pid === selfPid) continue;
    const rule = rules.find((r) => p.command.includes(r.pattern));
    if (rule) hits.set(p.pid, { proc: p, rule, parentPid: null });
  }
  const ancestors = (pid: number): number[] => {
    const chain: number[] = [];
    let cur = byPid.get(pid)?.ppid;
    const seen = new Set<number>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = byPid.get(cur)?.ppid;
    }
    return chain;
  };
  // Drop wrappers.
  for (const m of [...hits.values()]) {
    for (const a of ancestors(m.proc.pid)) {
      const anc = hits.get(a);
      if (!anc) continue;
      if (isShellWrapper(anc.proc) || anc.proc.command.includes(m.proc.command)) hits.delete(a);
      break;
    }
  }
  for (const m of hits.values()) {
    m.parentPid = ancestors(m.proc.pid).find((a) => hits.has(a)) ?? null;
  }
  return [...hits.values()];
}

// ---- Secrets ----

const SECRET_FLAG =
  /(--?[\w-]*(?:key|token|secret|password|passwd|auth)[\w-]*)(=|\s+)("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_ENV =
  /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g;
const SECRET_VALUE =
  /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|mm_[A-Za-z0-9_-]{30,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,})/g;

/**
 * Masks things that look like credentials in a command line before it is stored: the runs API
 * is readable by anyone on the network. Best effort, not a guarantee.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_FLAG, (_m, flag: string, sep: string) => `${flag}${sep}***`)
    .replace(SECRET_ENV, (_m, name: string) => `${name}=***`)
    .replace(SECRET_VALUE, '***');
}

// ---- Git ----

export interface GitInfo {
  branch: string | null;
  origin: string | null;
  worktree: string | null;
}

/** Removes user:password@ from http(s) remotes so a token in a remote URL never reaches the API. */
export function cleanRemote(url: string | null): string | null {
  if (!url) return null;
  const u = url.trim();
  if (/^[a-z+]+:\/\//i.test(u)) {
    try {
      const parsed = new URL(u);
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    } catch {
      return null;
    }
  }
  return u;
}

export async function gitInfo(cwd: string): Promise<GitInfo> {
  const git = async (...args: string[]) => {
    try {
      const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 3000 });
      return stdout.trim();
    } catch {
      return null;
    }
  };
  const top = await git('rev-parse', '--abbrev-ref', 'HEAD', '--show-toplevel');
  if (!top) return { branch: null, origin: null, worktree: null };
  const [branch, worktree] = top.split('\n');
  const origin = await git('config', '--get', 'remote.origin.url');
  return {
    branch: branch && branch !== 'HEAD' ? branch : null,
    origin: cleanRemote(origin),
    worktree: worktree || null,
  };
}

/** Looks up git info once per cwd during a scan. */
export function gitCache(lookup: (cwd: string) => Promise<GitInfo> = gitInfo) {
  const cache = new Map<string, Promise<GitInfo>>();
  return (cwd: string | null): Promise<GitInfo> => {
    if (!cwd) return Promise.resolve({ branch: null, origin: null, worktree: null });
    let p = cache.get(cwd);
    if (!p) cache.set(cwd, (p = lookup(cwd)));
    return p;
  };
}

/** Turns matched processes into runs for mergeDiscovered. */
export async function discoverProcesses(
  procs: ProcInfo[],
  rules: MatchRule[],
  git = gitCache(),
  selfPid = process.pid,
): Promise<Discovered[]> {
  const matched = matchProcesses(procs, rules, selfPid);
  return Promise.all(
    matched.map(async (m): Promise<Discovered> => {
      const g = await git(m.proc.cwd);
      const { model, prompt } = argvDetails(m.proc.argv);
      return {
        pid: m.proc.pid,
        command: redactSecrets(m.proc.command).slice(0, 4000),
        agent_kind: m.rule.kind ?? inferKind(m.proc.command),
        role: m.rule.role ?? (m.parentPid ? 'sub-agent' : 'agent'),
        started_at: m.proc.started_at,
        model,
        prompt: prompt === null ? null : redactSecrets(prompt),
        harness: m.rule.pattern,
        origin: g.origin,
        branch: g.branch,
        worktree: g.worktree ?? m.proc.cwd,
        parent_pid: m.parentPid,
      };
    }),
  );
}
