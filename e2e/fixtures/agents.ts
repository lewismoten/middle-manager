// Synthetic runs for the Agents page smoke test. Times are relative to now so durations are live.

import type { Db } from '../../server/db/index.ts';
import { mergeDiscovered, patchRun, startRun } from '../../server/agents/runs.ts';

export function seedAgents(db: Db, now = new Date()): { taskId: number; orchestrator: number } {
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const task = db
    .prepare(
      `INSERT INTO tasks (short_name, title, status, created_at, updated_at)
       VALUES ('login-fix', 'Fix the login redirect', 'doing', ?, ?)`,
    )
    .run(ago(120), ago(5));
  const taskId = Number(task.lastInsertRowid);

  const orch = startRun(db, {
    machine_id: 'server-1',
    agent_kind: 'claude-code',
    role: 'orchestrator',
    model: 'large',
    task_id: taskId,
    prompt: 'Coordinate the login fix\nSplit the work into a fix and a review, then merge.',
    origin: 'https://github.com/owner/repo.git',
    branch: 'feature/login-fix',
    worktree: '/srv/work/repo-login-fix',
    started_at: ago(42),
    tokens: { in: 1840, out: 52300, cache_read: 2_400_000, cache_write: 96_000 },
  }).run;
  startRun(db, {
    machine_id: 'server-1',
    agent_kind: 'codex',
    parent_run_id: orch.id,
    model: 'small',
    task_id: taskId,
    origin: 'git@github.com:owner/repo',
    prompt: 'Write the failing test for the redirect, then make it pass.',
    branch: 'feature/login-fix',
    worktree: '/srv/work/repo-login-fix',
    started_at: ago(30),
    tokens: { in: 12000, out: 3400, cache_read: 410_000 },
  });
  const review = startRun(db, {
    machine_id: 'server-1',
    agent_kind: 'claude-code',
    parent_run_id: orch.id,
    role: 'review',
    model: 'large',
    prompt: 'Review the redirect fix for security issues.',
    started_at: ago(20),
  }).run;
  patchRun(db, review.id, { status: 'done', summary: 'No issues found.' }, new Date(ago(8)));
  mergeDiscovered(
    db,
    'laptop-2',
    'process-scan',
    [
      {
        pid: 31337,
        command: 'codex exec --model small "Tidy the README"',
        agent_kind: 'codex',
        started_at: ago(3),
        model: 'small',
        prompt: 'Tidy the README',
        harness: 'codex exec',
        branch: 'docs/readme',
        worktree: '/srv/work/repo-docs',
      },
    ],
    now,
  );
  return { taskId, orchestrator: orch.id };
}
