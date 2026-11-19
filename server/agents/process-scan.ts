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

const OPERATORS = new Set([';', '&&', '||', '|', '&']);

/**
 * Splits a command line into words the way a POSIX shell would for our purposes: single and
 * double quotes, backslash escapes (systemd prints ExecStart with escaped spaces) and the
 * operators ; && || | & as words of their own. No expansion is done.
 */
export function shellWords(text: string): string[] {
  const out: string[] = [];
  let word = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  const flush = () => {
    if (has) out.push(word);
    word = '';
    has = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1] as string))
        word += text[++i];
      else word += ch;
    } else if (ch === '\\') {
      if (i + 1 < text.length) word += text[++i];
      has = true;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      flush();
    } else if (ch === ';' || ch === '|' || ch === '&') {
      flush();
      const two = text.slice(i, i + 2);
      if (two === '&&' || two === '||') i++;
      out.push(two === '&&' || two === '||' ? two : ch);
    } else {
      word += ch;
      has = true;
    }
  }
  flush();
  return out;
}

const isShell = (w: string | undefined) => SHELLS.has(path.basename(w ?? '').replace(/^-/, ''));

/** Replaces each `sh -c <script>` script with its words, a few levels deep. */
export function expandShellScripts(argv: string[], depth = 0): string[] {
  if (depth > 4) return argv;
  const out: string[] = [];
  argv.forEach((w, i) => {
    if (i >= 2 && /^-\w*c\w*$/.test(argv[i - 1] ?? '') && isShell(argv[i - 2])) {
      out.push(...expandShellScripts(shellWords(w), depth + 1));
    } else out.push(w);
  });
  return out;
}

const AGENT_BIN = /^(codex|claude)$/;
const unquote = (v: string) => v.replace(/^(["'])(.*)\1$/, '$2');

/**
 * Pulls the model, and the prompt when it is on the command line, out of argv. Shell wrappers
 * (`bash -c "... codex exec -m x ..."`) are looked into, and only the codex/claude invocation's
 * own flags count, so `git commit -m msg && claude -p ...` does not read "msg" as a model.
 * Model flags: -m / --model / --model=<m>, and Codex config overrides -c / --config model=<m>.
 */
export function argvDetails(argv: string[]): { model: string | null; prompt: string | null } {
  const words = expandShellScripts(argv);
  // The command segment (between shell operators) that runs the agent; else every word.
  let seg = words;
  let from = 0;
  let segStart = 0;
  for (let i = 0; i <= words.length; i++) {
    const w = words[i];
    if (w === undefined || OPERATORS.has(w)) {
      const part = words.slice(segStart, i);
      const at = part.findIndex((x) => AGENT_BIN.test(path.basename(x)));
      if (at >= 0) {
        seg = part;
        from = at;
        break;
      }
      segStart = i + 1;
    }
  }
  let model: string | null = null;
  let prompt: string | null = null;
  for (let i = from; i < seg.length; i++) {
    const a = seg[i] ?? '';
    const next = seg[i + 1];
    if (a === '--model' || a === '-m') model = next ?? null;
    else if (a.startsWith('--model=')) model = a.slice(8);
    else if ((a === '-c' || a === '--config') && next && /^model\s*=/.test(next)) {
      model ??= unquote(next.replace(/^model\s*=\s*/, ''));
    } else if (a.startsWith('--config=model='))
      model ??= unquote(a.slice('--config=model='.length));
    if ((a === '-p' || a === '--print') && next && !next.startsWith('-')) prompt = next;
  }
  const exec = seg.indexOf('exec', from);
  if (!prompt && exec >= 0 && /codex/.test(seg.slice(0, exec).join(' '))) {
    const last = seg[seg.length - 1];
    if (seg.length - 1 > exec && last && !last.startsWith('-')) prompt = last;
  }
  return { model: model || null, prompt };
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
