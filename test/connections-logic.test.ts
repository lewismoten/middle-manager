import { describe, expect, it } from 'vitest';
import {
  codeParts,
  headline,
  howTo,
  modelSummary,
  providerLabel,
  statusTone,
  windowLabel,
  type LocalConn,
  type PlanConn,
} from '../web/src/pages/connections-logic.ts';

describe('connections logic', () => {
  it('maps statuses to tones and labels', () => {
    expect(statusTone('ok')).toBe('done');
    expect(statusTone('warn')).toBe('ask');
    expect(statusTone('down')).toBe('block');
    expect(statusTone('manual')).toBe('muted');
    expect(providerLabel('anthropic-oauth')).toBe('Claude subscription');
    expect(providerLabel('openai')).toBe('OpenAI-compatible');
    expect(windowLabel('five_hour')).toBe('5-hour');
  });

  it('has how-to copy for every provider, with the Claude privacy note', () => {
    for (const p of ['anthropic-oauth', 'codex-sessions', 'manual', 'ollama', 'openai'] as const) {
      const t = howTo(p);
      expect(t.reads.length).toBeGreaterThan(10);
      expect(t.steps.length).toBeGreaterThan(1);
    }
    expect(howTo('anthropic-oauth').note).toMatch(/never leaves this host/);
  });

  it('splits code spans out of copy', () => {
    expect(codeParts('Set `url` and `kind`.')).toEqual([
      { code: false, text: 'Set ' },
      { code: true, text: 'url' },
      { code: false, text: ' and ' },
      { code: true, text: 'kind' },
      { code: false, text: '.' },
    ]);
  });

  it('summarizes statuses and model lists', () => {
    const p = (status: PlanConn['status']) => ({ status }) as PlanConn;
    const l = (status: LocalConn['status']) => ({ status }) as LocalConn;
    expect(headline({ plans: [p('ok'), p('warn'), p('manual')], local_models: [l('down')] })).toBe(
      '1 working · 1 to check · 1 not connected · 1 manual',
    );
    expect(headline({ plans: [], local_models: [] })).toBe('Nothing configured yet');
    expect(modelSummary([], 0)).toBe('none');
    expect(modelSummary(['a', 'b', 'c'], 3, 2)).toBe('a, b +1 more');
  });
});
