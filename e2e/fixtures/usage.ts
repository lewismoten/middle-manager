// Synthetic finished runs with token counts for the Usage page: two plans, three models, spread
// over the last ten days. Every run ends at least two hours ago so the Agents page's
// "finished in the last hour" view is unchanged.

import type { Db } from '../../server/db/index.ts';
import { patchRun, startRun } from '../../server/agents/runs.ts';

const HOUR = 3600_000;

export function seedUsage(db: Db, now = new Date()): void {
  const at = (h: number) => new Date(now.getTime() - h * HOUR).toISOString();
  const shapes = [
    { agent_kind: 'claude-code', model: 'large', in: 2400, out: 41_000, cache: 900_000 },
    { agent_kind: 'claude-code', model: 'small', in: 5200, out: 18_000, cache: 310_000 },
    { agent_kind: 'codex', model: 'medium', in: 9000, out: 12_500, cache: 120_000 },
  ] as const;
  for (let i = 0; i < 36; i++) {
    const shape = shapes[i % shapes.length] as (typeof shapes)[number];
    const startH = 4 + i * 6.5 + (i % 4) * 1.3; // about 10 days back
    const lenH = 0.4 + (i % 5) * 0.35;
    const scale = 0.5 + ((i * 7) % 10) / 10;
    const run = startRun(
      db,
      {
        machine_id: i % 3 ? 'server-1' : 'laptop-1',
        agent_kind: shape.agent_kind,
        model: shape.model,
        role: i % 4 === 0 ? 'orchestrator' : 'agent',
        project_id: 'main',
        prompt: `Sample task ${i + 1}`,
        started_at: at(startH),
        tokens: {
          in: Math.round(shape.in * scale),
          out: Math.round(shape.out * scale),
          cache_read: Math.round(shape.cache * scale),
          cache_write: Math.round(shape.cache * 0.04 * scale),
        },
      },
      new Date(at(startH)),
    ).run;
    patchRun(
      db,
      run.id,
      {
        status: i % 9 === 4 ? 'failed' : 'done',
        ...(i === 2 ? { cost_note: 'Included in the subscription; no extra charge.' } : {}),
        ...(i === 7 ? { cost_note: 'Retried twice after a rate limit.' } : {}),
      },
      new Date(at(Math.max(2, startH - lenH))),
    );
  }
}
