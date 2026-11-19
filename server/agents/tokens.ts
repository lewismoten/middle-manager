// Token readers: sum a run's token usage from the harness's own session log on this host.
//
// Extension point: add a TokenReader to TOKEN_READERS for another harness. A reader
//   - locates the session file for a run (from log_ref, or by cwd + start time), and
//   - folds JSONL lines into totals (incrementally: only appended bytes are read again).
//
// log_ref forms understood: "claude-code:<session-id>", "codex:<session-id>", or an absolute
// path to a .jsonl file.

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AgentKind, RunRow } from './runs.ts';

export interface TokenTotals {
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  model: string | null;
}

export interface ReaderDirs {
  claude_dir: string;
  codex_dir: string;
}

export interface TokenReader<S = unknown> {
  kind: AgentKind;
  /** Prefix used in log_ref, e.g. "codex" for "codex:<session-id>". */
  ref: string;
  /** Finds the session file for a run, or null when it cannot be told apart from others. */
  locate(
    run: Pick<RunRow, 'log_ref' | 'worktree' | 'started_at'>,
    dirs: ReaderDirs,
  ): Located | null;
  init(): S;
  /** Folds one parsed JSONL line into the state. */
  line(state: S, obj: Record<string, unknown>): void;
  totals(state: S): TokenTotals;
}

export interface Located {
  file: string;
  /** A stable log_ref to store on the run, e.g. "codex:<id>". */
  ref: string;
}

type Obj = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Obj | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null;

// ---- Claude Code: ~/.claude/projects/<cwd with non-alphanumerics as "-">/<session-id>.jsonl ----

/** How Claude Code names a project folder for a working directory. */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

interface ClaudeState {
  /** Usage per assistant message id: a message is written once per content block, same usage. */
  byMessage: Map<string, { i: number; o: number; cr: number; cw: number }>;
  model: string | null;
}

export const claudeReader: TokenReader<ClaudeState> = {
  kind: 'claude-code',
  ref: 'claude-code',
  locate(run, dirs) {
    const ref = run.log_ref ?? '';
    if (ref.startsWith('claude-code:')) {
      const id = ref.slice('claude-code:'.length);
      if (!/^[A-Za-z0-9-]+$/.test(id)) return null;
      const direct = run.worktree
        ? path.join(dirs.claude_dir, claudeProjectDir(run.worktree), `${id}.jsonl`)
        : null;
      if (direct && existsSync(direct)) return { file: direct, ref };
      for (const d of safeReaddir(dirs.claude_dir)) {
        const f = path.join(dirs.claude_dir, d, `${id}.jsonl`);
        if (existsSync(f)) return { file: f, ref };
      }
      return null;
    }
    if (ref.endsWith('.jsonl') && path.isAbsolute(ref))
      return existsSync(ref) ? { file: ref, ref } : null;
    if (ref || !run.worktree) return null;
    // No log_ref: the one session in this project folder written since the run started.
    const dir = path.join(dirs.claude_dir, claudeProjectDir(run.worktree));
    const since = Date.parse(run.started_at) - 60_000;
    const fresh = safeReaddir(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f))
      .filter((f) => mtimeMs(f) >= since && birthMs(f) >= since);
    if (fresh.length !== 1) return null;
    const file = fresh[0] as string;
    return { file, ref: `claude-code:${path.basename(file, '.jsonl')}` };
  },
  init: () => ({ byMessage: new Map(), model: null }),
  line(s, o) {
    const msg = obj(o.message);
    const usage = obj(msg?.usage);
    if (!msg || !usage) return;
    const key = String(msg.id ?? o.requestId ?? o.uuid ?? s.byMessage.size);
    s.byMessage.set(key, {
      i: num(usage.input_tokens),
      o: num(usage.output_tokens),
      cr: num(usage.cache_read_input_tokens),
      cw: num(usage.cache_creation_input_tokens),
    });
    if (typeof msg.model === 'string' && !msg.model.startsWith('<')) s.model = msg.model;
  },
  totals(s) {
    const t = {
      tokens_in: 0,
      tokens_out: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      model: s.model,
    };
    for (const u of s.byMessage.values()) {
      t.tokens_in += u.i;
      t.tokens_out += u.o;
      t.tokens_cache_read += u.cr;
      t.tokens_cache_write += u.cw;
    }
    return t;
  },
};

// ---- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<session-id>.jsonl ----
// token_count events carry a running total; input_tokens includes the cached part.

interface CodexState {
  total: Obj | null;
  model: string | null;
}

function codexDays(dir: string, startedAt: string): string[] {
  const t = Date.parse(startedAt);
  const days = new Set<string>();
  for (const offset of [-1, 0, 1]) {
    const d = new Date(t + offset * 86400_000);
    // Codex names folders by local date; check both sides of midnight.
    const local = [d.getFullYear(), d.getMonth() + 1, d.getDate()];
    const utc = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    for (const [y, m, dd] of [local, utc]) {
      days.add(path.join(dir, String(y), String(m).padStart(2, '0'), String(dd).padStart(2, '0')));
    }
  }
  return [...days];
}

/** Reads just the first line (session_meta) of a Codex session file. */
function firstJsonLine(file: string): Obj | null {
  try {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, n).toString('utf8');
      const nl = text.indexOf('\n');
      return obj(JSON.parse(nl >= 0 ? text.slice(0, nl) : text));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export const codexReader: TokenReader<CodexState> = {
  kind: 'codex',
  ref: 'codex',
  locate(run, dirs) {
    const ref = run.log_ref ?? '';
    if (ref.endsWith('.jsonl') && path.isAbsolute(ref))
      return existsSync(ref) ? { file: ref, ref } : null;
    const id = ref.startsWith('codex:') ? ref.slice('codex:'.length) : null;
    if (id !== null && !/^[A-Za-z0-9-]+$/.test(id)) return null;
    if (ref && id === null) return null;
    const start = Date.parse(run.started_at);
    let best: { file: string; id: string; gap: number } | null = null;
    let ties = 0;
    for (const day of codexDays(dirs.codex_dir, run.started_at)) {
      for (const f of safeReaddir(day)) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(day, f);
        if (id) {
          if (f.includes(id)) return { file, ref };
          continue;
        }
        if (!run.worktree) continue;
        const meta = obj(firstJsonLine(file)?.payload);
        if (!meta || meta.cwd !== run.worktree) continue;
        const gap = Math.abs(Date.parse(String(meta.timestamp ?? '')) - start);
        if (!(gap <= 5 * 60_000)) continue;
        if (best && gap === best.gap) ties++;
        if (!best || gap < best.gap) {
          best = { file, id: String(meta.id ?? meta.session_id ?? ''), gap };
          ties = 0;
        }
      }
    }
    if (!best || ties || !best.id) return null;
    return { file: best.file, ref: `codex:${best.id}` };
  },
  init: () => ({ total: null, model: null }),
  line(s, o) {
    const p = obj(o.payload);
    if (!p) return;
    if (o.type === 'turn_context') {
      // The turn's model; newer logs also carry it under collaboration_mode.settings.
      const m = p.model ?? obj(obj(p.collaboration_mode)?.settings)?.model;
      if (typeof m === 'string' && m) s.model = m;
    }
    if (p.type === 'token_count') {
      const total = obj(obj(p.info)?.total_token_usage);
      if (total) s.total = total;
    }
  },
  totals(s) {
    const t = s.total ?? {};
    const input = num(t.input_tokens);
    const cached = num(t.cached_input_tokens);
    return {
      tokens_in: Math.max(0, input - cached),
      tokens_out: num(t.output_tokens),
      tokens_cache_read: cached,
      tokens_cache_write: num(t.cache_write_input_tokens),
      model: s.model,
    };
  },
};

/** Readers by agent kind. Add one here for another harness. */
export const TOKEN_READERS: Partial<Record<AgentKind, TokenReader<never>>> = {
  'claude-code': claudeReader as TokenReader<never>,
  codex: codexReader as TokenReader<never>,
};

export function readerFor(run: Pick<RunRow, 'agent_kind' | 'log_ref'>): TokenReader<never> | null {
  const prefix = run.log_ref?.split(':')[0];
  const byRef = Object.values(TOKEN_READERS).find((r) => r?.ref === prefix);
  return byRef ?? TOKEN_READERS[run.agent_kind] ?? null;
}

// ---- Incremental file folding ----

interface Cursor {
  offset: number;
  state: unknown;
  reader: TokenReader<unknown>;
}

const MAX_CURSORS = 500;

/** Keeps per-file read positions so growing session logs are only read once. */
export class SessionTail {
  private cursors = new Map<string, Cursor>();

  read<S>(reader: TokenReader<S>, file: string): TokenTotals {
    let c = this.cursors.get(file);
    const size = statSync(file).size;
    if (!c || c.reader !== (reader as TokenReader<unknown>) || size < c.offset) {
      c = { offset: 0, state: reader.init(), reader: reader as TokenReader<unknown> };
      if (this.cursors.size >= MAX_CURSORS) {
        const oldest = this.cursors.keys().next().value;
        if (oldest !== undefined) this.cursors.delete(oldest);
      }
      this.cursors.set(file, c);
    }
    const state = c.state as S;
    if (size > c.offset) {
      const fd = openSync(file, 'r');
      try {
        const chunk = Buffer.alloc(1024 * 1024);
        let pending = Buffer.alloc(0);
        let pos = c.offset;
        while (pos < size) {
          const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
          if (n <= 0) break;
          pos += n;
          let buf = Buffer.concat([pending, chunk.subarray(0, n)]);
          let nl: number;
          while ((nl = buf.indexOf(10)) >= 0) {
            const text = buf.subarray(0, nl).toString('utf8');
            buf = buf.subarray(nl + 1);
            c.offset += nl + 1;
            if (!text.trim()) continue;
            try {
              const o = JSON.parse(text) as unknown;
              if (obj(o)) reader.line(state, o as Obj);
            } catch {
              /* a torn or foreign line: skip it */
            }
          }
          pending = Buffer.from(buf);
        }
        // A trailing line without "\n" is still being written; it is read next time.
      } finally {
        closeSync(fd);
      }
    }
    return reader.totals(state);
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function mtimeMs(f: string): number {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}

/** File creation time where the filesystem has one, else mtime (then the check is weaker). */
function birthMs(f: string): number {
  try {
    const s = statSync(f);
    return s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs;
  } catch {
    return 0;
  }
}
