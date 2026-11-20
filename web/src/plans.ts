// Plan pacing data from the API, plus the formatting both plan pages share.

import { api } from './api.ts';
import type { WindowSummary } from './pages/past-weeks-logic.ts';
import { h } from './dom.ts';
import {
  burnForecast,
  paceDifference,
  shortOutcome,
  shortProjections,
  type Mode,
  type WeeklyPace,
} from './plans-logic.ts';

export {
  pct,
  shortOutcome,
  shortProjections,
  type Mode,
  type ShortProjection,
  type WeeklyPace,
} from './plans-logic.ts';

export interface Reading {
  id: number;
  plan_id: string;
  window: string;
  used_pct: number;
  resets_at: string | null;
  read_at: string;
  machine_id: string | null;
  how: string | null;
}

export interface PlanPace {
  plan: string;
  name: string;
  provider: string;
  empty_buffer_hours: number;
  window_hours?: number;
  models: string[];
  weekly: WeeklyPace | null;
  five_hour: Reading | null;
}

export interface PaceResponse {
  generated: string;
  plans: PlanPace[];
}

export interface PastWeek {
  reset_at: string;
  last_reading_at: string;
  used_pct: number;
  unused_pct: number;
  readings: number;
}

export interface PlanSummary {
  id: string;
  name: string;
  provider: string;
  windows: string[];
  readings: number;
  latest: Record<string, Reading | null>;
  past_weeks: PastWeek[];
}

export interface WindowDetail {
  plan: string;
  window_hours: number;
  window: WindowSummary;
  readings: { read_at: string; used_pct: number; machine_id: string | null; how: string | null }[];
}

export const getWindows = (id: string) =>
  api<{ plan: string; window_hours: number; windows: WindowSummary[] }>(
    `/plans/${encodeURIComponent(id)}/windows`,
  );
export const getWindow = (id: string, window: string) =>
  api<WindowDetail>(`/plans/${encodeURIComponent(id)}/windows/${encodeURIComponent(window)}`);

export const getPace = () => api<PaceResponse>('/plans/pace');
export const getPlans = () => api<{ plans: PlanSummary[] }>('/plans');
export const getReadings = (id: string, q: Record<string, string>) =>
  api<{ readings: Reading[] }>(
    `/plans/${encodeURIComponent(id)}/readings?${new URLSearchParams(q).toString()}`,
  );

export const MODE_TEXT: Record<Mode, string> = {
  burn: 'Burn: use more, the plan will not run out in time',
  steady: 'Steady: on pace to run out just before the reset',
  conserve: 'Conserve: slow down, the plan would run out early',
  stop: 'Stop: nearly spent, finish what is running',
};

export function modeBadge(mode: Mode): HTMLElement {
  return h('span', { class: `mode mode-${mode}`, title: MODE_TEXT[mode] }, mode);
}

export const rate = (v: number) => `${v.toFixed(2)}%/h`;

export const recentRateLabel = (w: WeeklyPace) =>
  `${rate(w.rate_pct_per_h)} (last ${w.rate_basis_h} h)`;

export function paceDifferenceLine(w: WeeklyPace): HTMLElement | null {
  const text = paceDifference(w);
  return text === null ? null : h('span', { class: 'pace-difference' }, text);
}

export function burnForecastLine(w: WeeklyPace): HTMLElement | null {
  const text = burnForecast(w);
  return text === null ? null : h('span', { class: 'burn-forecast small' }, text);
}

/**
 * "Last 2 h: 97% at reset · Last 1 h: runs out Fri 5:10 PM" in the given time zone. Each part's
 * tooltip gives the rate, or why there is none.
 */
export function shortProjectionsLine(w: WeeklyPace, tz?: string): HTMLElement | null {
  const list = shortProjections(w);
  if (!list.length) return null;
  const parts: (HTMLElement | string)[] = [];
  list.forEach((p, i) => {
    if (i) parts.push(' · ');
    parts.push(
      h(
        'span',
        {
          'data-proj': `${p.window_h}h`,
          title:
            p.rate_pct_per_h === null
              ? (p.reason_text ?? 'not enough readings')
              : `${rate(p.rate_pct_per_h)} over the last ${p.window_h} h`,
        },
        `Last ${p.window_h} h: ${shortOutcome(p, (iso) => fmtTime(iso, tz))}`,
      ),
    );
  });
  return h('span', { class: 'short-projections small' }, ...parts);
}

/** "2d 4h", "3h 20m", "12m"; negative spans read "now". */
export function span(ms: number): string {
  if (ms <= 30_000) return 'now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return `${hrs}h ${m % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

export function ago(iso: string, now = Date.now()): string {
  const s = span(now - new Date(iso).getTime());
  return s === 'now' ? 'just now' : `${s} ago`;
}

export function until(iso: string, now = Date.now()): string {
  const s = span(new Date(iso).getTime() - now);
  return s === 'now' ? 'now' : `in ${s}`;
}

export function fmtTime(iso: string, tz?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz,
  }).format(new Date(iso));
}

export function fmtDate(iso: string, tz?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz,
  }).format(new Date(iso));
}

/** "Reading 12m ago", with a visible stale warning (never color alone). */
export function readingAge(w: WeeklyPace, now = Date.now()): HTMLElement {
  const text = `Reading ${ago(w.last_reading_at, now)}`;
  return w.stale
    ? h(
        'span',
        { class: 'stale', title: 'The newest reading is over 2 hours old' },
        h('span', { 'aria-hidden': 'true' }, '⚠ '),
        `${text} (stale)`,
      )
    : h('span', {}, text);
}

/** Keeps a page's numbers fresh while it is on screen; stops once it is replaced. */
export function refreshWhileShown(el: Element, fn: () => void, everyMs = 60_000): void {
  const id = window.setInterval(() => {
    if (!el.isConnected) window.clearInterval(id);
    else if (document.visibilityState === 'visible') fn();
  }, everyMs);
}
