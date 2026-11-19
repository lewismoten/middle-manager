// Plan collectors (SPEC 4, 10/S2). Each returns readings; the caller stores them.
//
// anthropic-oauth  GET https://api.anthropic.com/api/oauth/usage with the access token from the
//                  plan's credentials file (Claude Code login). Read-only: the token is never
//                  logged, stored or returned, and is never refreshed here (refreshing would rotate
//                  the login out from under Claude Code).
// codex-sessions   newest "rate_limits" event in sessions_dir/YYYY/MM/DD/*.jsonl (last 3 days).
//                  Only fresh when Codex ran recently; the reading's time is the event's time.
// manual           no collector; readings arrive through the API, the CLI or a CSV import.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { expandHome, type Config, type PlanConfig } from '../config.ts';
import type { NewReading, PlanWindow } from './store.ts';

export const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_TIMEOUT_MS = 20_000;
const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;

export class CollectorError extends Error {}

export interface CollectOptions {
  now?: Date;
  fetch?: typeof fetch;
  machineId?: string | null;
}

/**
 * Which configured machine this process runs on: $MM_MACHINE, else a machine whose id matches the
 * host name, else the only configured machine, else none.
 */
export function hostMachineId(config: Config, env = process.env, host = hostname()): string | null {
  if (env.MM_MACHINE) return env.MM_MACHINE;
  const h = host.toLowerCase().split('.')[0];
  const match = config.machines.find((m) => m.id.toLowerCase() === h);
  if (match) return match.id;
  return config.machines.length === 1 ? (config.machines[0]?.id ?? null) : null;
}

const iso = (d: Date) => d.toISOString();

function wantWindow(plan: PlanConfig, w: string): w is PlanWindow {
  return (plan.windows as string[]).includes(w);
}

// ---- anthropic-oauth ----

function readAccessToken(file: string): string {
  let raw: string;
  try {
    raw = readFileSync(expandHome(file), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new CollectorError(
      code === 'ENOENT'
        ? 'credentials file not found (log in with Claude Code on this host)'
        : `credentials file could not be read (${code ?? 'error'})`,
    );
  }
  let token: unknown;
  let expiresAt: unknown;
  try {
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    token = parsed.claudeAiOauth?.accessToken;
    expiresAt = parsed.claudeAiOauth?.expiresAt;
  } catch {
    throw new CollectorError('credentials file is not valid JSON');
  }
  if (typeof token !== 'string' || !token) {
    throw new CollectorError('credentials file has no claudeAiOauth.accessToken');
  }
  if (typeof expiresAt === 'number' && expiresAt < Date.now()) {
    throw new CollectorError(
      'the Claude Code login has expired; run Claude Code on this host once to refresh it',
    );
  }
  return token;
}

const OAUTH_WINDOWS: [string, PlanWindow][] = [
  ['seven_day', 'weekly'],
  ['five_hour', 'five_hour'],
];

export async function collectAnthropicOauth(
  plan: PlanConfig,
  opts: CollectOptions = {},
): Promise<NewReading[]> {
  if (!plan.credentials) throw new CollectorError(`plan ${plan.id} has no credentials file`);
  const token = readAccessToken(plan.credentials);
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(OAUTH_USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': 'middle-manager',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // Network errors do not carry the token, but keep the message generic all the same.
    throw new CollectorError(`usage request failed (${(err as Error).name})`);
  }
  if (!res.ok) {
    throw new CollectorError(
      res.status === 401 || res.status === 403
        ? `usage request was refused (HTTP ${res.status}); log in with Claude Code again`
        : `usage request failed (HTTP ${res.status})`,
    );
  }
  let data: Record<string, { utilization?: unknown; resets_at?: unknown } | null>;
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new CollectorError('usage response is not JSON');
  }
  const now = iso(opts.now ?? new Date());
  const out: NewReading[] = [];
  for (const [key, window] of OAUTH_WINDOWS) {
    const w = data?.[key];
    if (!w || w.utilization === null || w.utilization === undefined || !wantWindow(plan, window)) {
      continue;
    }
    const used = Number(w.utilization);
    if (!Number.isFinite(used)) continue;
    const resets = typeof w.resets_at === 'string' ? new Date(w.resets_at) : null;
    out.push({
      plan_id: plan.id,
      window,
      used_pct: Math.min(100, Math.max(0, used)),
      resets_at: resets && !Number.isNaN(resets.getTime()) ? iso(resets) : null,
      read_at: now,
      machine_id: opts.machineId ?? null,
      how: 'oauth-usage',
    });
  }
  if (!out.length) throw new CollectorError('usage response had no usable windows');
  return out;
}

// ---- codex-sessions ----

interface CodexLimit {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
  resets_in_seconds?: unknown;
}

function sessionFiles(dir: string, now: Date): string[] {
  const files: string[] = [];
  for (let d = 0; d < 3; d++) {
    const day = new Date(now.getTime() - d * 86_400_000);
    const sub = path.join(
      dir,
      String(day.getUTCFullYear()),
      String(day.getUTCMonth() + 1).padStart(2, '0'),
      String(day.getUTCDate()).padStart(2, '0'),
    );
    let names: string[];
    try {
      names = readdirSync(sub);
    } catch {
      continue;
    }
    for (const n of names) if (n.endsWith('.jsonl')) files.push(path.join(sub, n));
  }
  return files;
}

export function collectCodexSessions(plan: PlanConfig, opts: CollectOptions = {}): NewReading[] {
  if (!plan.sessions_dir) throw new CollectorError(`plan ${plan.id} has no sessions_dir`);
  const dir = expandHome(plan.sessions_dir);
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new CollectorError('sessions_dir not found (has Codex run on this host?)');
  }
  let best: { ts: string; t: number; rl: Record<string, CodexLimit> } | null = null;
  for (const f of sessionFiles(dir, opts.now ?? new Date())) {
    let text: string;
    try {
      if (statSync(f).size > MAX_SESSION_FILE_BYTES) continue;
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"rate_limits"')) continue;
      let ev: { timestamp?: unknown; rate_limits?: unknown; payload?: { rate_limits?: unknown } };
      try {
        ev = JSON.parse(line) as typeof ev;
      } catch {
        continue;
      }
      const rl = (ev.payload?.rate_limits ?? ev.rate_limits) as Record<string, CodexLimit> | null;
      if (!rl || typeof rl !== 'object' || typeof ev.timestamp !== 'string') continue;
      const t = new Date(ev.timestamp).getTime();
      if (Number.isNaN(t)) continue;
      if (!best || t > best.t) best = { ts: ev.timestamp, t, rl };
    }
  }
  if (!best) return [];
  const out: NewReading[] = [];
  for (const slot of ['primary', 'secondary']) {
    const w = best.rl[slot];
    if (!w || typeof w !== 'object') continue;
    const window =
      w.window_minutes === 10080 ? 'weekly' : w.window_minutes === 300 ? 'five_hour' : null;
    const used = Number(w.used_percent);
    if (!window || !wantWindow(plan, window) || !Number.isFinite(used)) continue;
    let resets: string | null = null;
    if (typeof w.resets_at === 'number') resets = iso(new Date(w.resets_at * 1000));
    else if (typeof w.resets_in_seconds === 'number') {
      resets = iso(new Date(best.t + w.resets_in_seconds * 1000));
    }
    out.push({
      plan_id: plan.id,
      window,
      used_pct: Math.min(100, Math.max(0, used)),
      resets_at: resets,
      read_at: iso(new Date(best.t)),
      machine_id: opts.machineId ?? null,
      how: 'codex-log',
    });
  }
  return out;
}

/** Runs the collector for a plan's provider. Manual plans have nothing to collect. */
export async function collectPlan(
  plan: PlanConfig,
  opts: CollectOptions = {},
): Promise<NewReading[]> {
  switch (plan.provider) {
    case 'anthropic-oauth':
      return collectAnthropicOauth(plan, opts);
    case 'codex-sessions':
      return collectCodexSessions(plan, opts);
    case 'manual':
      return [];
  }
}
