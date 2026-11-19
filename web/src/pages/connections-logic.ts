// Pure helpers and the how-to-connect copy for the Connections page
// (tested in test/connections-logic.test.ts).

export type ConnStatus = 'ok' | 'warn' | 'down' | 'manual';

export interface Check {
  label: string;
  status: ConnStatus;
  detail: string;
}

export interface ReadingInfo {
  window: string;
  used_pct: number;
  read_at: string;
  age_h: number;
  stale: boolean;
  how: string | null;
  machine_id: string | null;
}

export interface PlanConn {
  kind: 'plan';
  id: string;
  name: string;
  provider: 'anthropic-oauth' | 'codex-sessions' | 'manual';
  status: ConnStatus;
  summary: string;
  checks: Check[];
  readings: ReadingInfo[];
  last_reading_at: string | null;
  path?: string | null;
}

export interface LocalConn {
  kind: 'local';
  id: string;
  name: string;
  model_kind: 'ollama' | 'openai';
  status: ConnStatus;
  summary: string;
  latency_ms: number | null;
  models: string[];
  model_count: number;
  checked_at: string;
  last_ok_at: string | null;
  url?: string;
}

export interface ConnectionsResponse {
  now: string;
  stale_after_h: number;
  plans: PlanConn[];
  local_models: LocalConn[];
}

export const STATUS_TEXT: Record<ConnStatus, string> = {
  ok: 'working',
  warn: 'check',
  down: 'not connected',
  manual: 'manual',
};

/** Chip tone class (st-*) for a status. */
export function statusTone(s: ConnStatus): 'done' | 'ask' | 'block' | 'muted' {
  return s === 'ok' ? 'done' : s === 'warn' ? 'ask' : s === 'down' ? 'block' : 'muted';
}

export function providerLabel(p: PlanConn['provider'] | LocalConn['model_kind']): string {
  switch (p) {
    case 'anthropic-oauth':
      return 'Claude subscription';
    case 'codex-sessions':
      return 'Codex (ChatGPT login)';
    case 'manual':
      return 'Manual readings';
    case 'ollama':
      return 'Ollama';
    case 'openai':
      return 'OpenAI-compatible';
  }
}

export interface HowTo {
  /** What middle-manager reads, in one sentence. */
  reads: string;
  steps: string[];
  /** Privacy note shown under the steps. */
  note?: string;
  /** Config keys that point at the source (shown when signed in). */
  config: string;
}

export function howTo(p: PlanConn['provider'] | LocalConn['model_kind']): HowTo {
  switch (p) {
    case 'anthropic-oauth':
      return {
        reads:
          'Usage for the weekly and 5-hour windows, using the Claude Code login already on this host.',
        steps: [
          'Install Claude Code on the machine that runs middle-manager and log in once (`claude`, then `/login`).',
          'Point the plan at the login file: `credentials: ~/.claude/.credentials.json`.',
          'Schedule the plan collector on the Schedules page (every 10-15 minutes is plenty), or press Read now.',
        ],
        note: 'The login never leaves this host. middle-manager reads the access token from the file only to ask Anthropic for usage; it never stores, logs, refreshes or returns it. Claude Code refreshes the login itself when it runs.',
        config: 'credentials',
      };
    case 'codex-sessions':
      return {
        reads: 'The newest rate-limit event in Codex session logs from the last three days.',
        steps: [
          'Log in to Codex with your ChatGPT account on the machine that runs middle-manager.',
          'Point the plan at the session logs: `sessions_dir: ~/.codex/sessions`.',
          'Readings appear while Codex runs here; between runs the last reading goes stale, which is expected.',
        ],
        note: 'Only the rate-limit numbers are read from the logs. Prompts and replies in them are not stored.',
        config: 'sessions_dir',
      };
    case 'manual':
      return {
        reads: 'Nothing on its own. Readings arrive from outside.',
        steps: [
          'Post a reading: `POST /api/v1/plans/<id>/readings` with a token (see docs/agents.md).',
          'Or import old readings from CSV: `middle-manager import <collector>`.',
        ],
        config: 'provider',
      };
    case 'ollama':
      return {
        reads: 'The list of installed models from `/api/tags`, checked live.',
        steps: [
          'Run Ollama where this host can reach it (default port 11434).',
          'Add it under `local_models` with `kind: ollama` and its `url`.',
          'To reach it from another machine, start Ollama with `OLLAMA_HOST=0.0.0.0`.',
        ],
        config: 'url',
      };
    case 'openai':
      return {
        reads: 'The model list from `/v1/models`, checked live.',
        steps: [
          'Run an OpenAI-compatible server (llama.cpp, vLLM, LM Studio and similar) where this host can reach it.',
          'Add it under `local_models` with `kind: openai` and its base `url` (with or without `/v1`).',
          'Endpoints that need an API key answer 401 here; keys are not sent.',
        ],
        config: 'url',
      };
  }
}

export interface CodePart {
  code: boolean;
  text: string;
}

/** Splits `code` spans out of a how-to line so the page can render them as <code>. */
export function codeParts(s: string): CodePart[] {
  return s
    .split(/(`[^`]+`)/)
    .filter(Boolean)
    .map((t) =>
      t.startsWith('`') && t.endsWith('`') && t.length > 1
        ? { code: true, text: t.slice(1, -1) }
        : { code: false, text: t },
    );
}

export function windowLabel(w: string): string {
  return w === 'five_hour' ? '5-hour' : w === 'weekly' ? 'Weekly' : w;
}

export function headline(r: Pick<ConnectionsResponse, 'plans' | 'local_models'>): string {
  const all = [...r.plans, ...r.local_models];
  if (!all.length) return 'Nothing configured yet';
  const n = (s: ConnStatus) => all.filter((c) => c.status === s).length;
  const parts: string[] = [];
  if (n('ok')) parts.push(`${n('ok')} working`);
  if (n('warn')) parts.push(`${n('warn')} to check`);
  if (n('down')) parts.push(`${n('down')} not connected`);
  if (n('manual')) parts.push(`${n('manual')} manual`);
  return parts.join(' · ');
}

/** Short model list: the first few names and how many more. */
export function modelSummary(models: string[], total: number, max = 6): string {
  if (!total) return 'none';
  const shown = models.slice(0, max).join(', ');
  return total > max ? `${shown} +${total - max} more` : shown;
}
