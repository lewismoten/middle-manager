// Starts the built server for Playwright with a temporary config and database.
// Removes both on exit. Usage: node e2e/serve.ts [board]
// With `board`, serves the 706-card synthetic board (e2e/fixtures/board.ts) on E2E_BOARD_PORT, plus
// plan-d, a plan about to reset, for the final-stretch view.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createToken } from '../server/auth.ts';
import { loadConfig } from '../server/config.ts';
import { openAppDb } from '../server/db/index.ts';
import { startServer } from '../server/server.ts';
import { E2E_BOARD_PORT, E2E_PORT, E2E_TOKEN } from './constants.ts';
import { nearReset, seedPlanReadings } from './seed.ts';
import { insertReadings } from '../server/plans/store.ts';
import { seedAgents } from './fixtures/agents.ts';
import { seedSchedules } from './fixtures/schedules.ts';
import { seedNotes } from './fixtures/notes.ts';
import { seedConnections } from './fixtures/connections.ts';
import { seedBoard } from './fixtures/board.ts';
import { seedUsage } from './fixtures/usage.ts';

const bigBoard = process.argv[2] === 'board';

const dir = mkdtempSync(path.join(tmpdir(), 'mm-e2e-'));
const configFile = path.join(dir, 'middle-manager.yaml');
const notes = seedNotes(dir);
const conn = await seedConnections(dir);
writeFileSync(
  configFile,
  `site: { name: "Test fleet", timezone: "UTC" }
server: { host: 127.0.0.1, port: ${bigBoard ? E2E_BOARD_PORT : E2E_PORT} }
database: { path: ${JSON.stringify(path.join(dir, 'mm.db'))} }
machines:
  - { id: server-1, name: "Build server", role: "agents run here" }
plans:
  # plan-a and plan-b have seeded readings; their sources are synthetic files (e2e/fixtures/connections.ts).
  - { id: plan-a, name: "Plan A", provider: anthropic-oauth, credentials: ${JSON.stringify(conn.credentials)}, windows: [weekly, five_hour] }
  - { id: plan-b, name: "Plan B", provider: codex-sessions, sessions_dir: ${JSON.stringify(conn.sessionsDir)}, empty_buffer_hours: 2 }
  - { id: plan-c, name: "Plan C", provider: manual }
${
  bigBoard
    ? `  # plan-d (this server only, so the main smoke pages keep three plans): 5-minute readings, reset
  # about 1 h 40 min away, for the final-stretch view (e2e/final-stretch.smoke.spec.ts).
  - { id: plan-d, name: "Plan D", provider: manual }
`
    : ''
}models:
  plan-a: [small, large]
  plan-b: [medium]
local_models:
  - { id: local, name: "Local model", url: ${JSON.stringify(conn.ollamaUrl)}, kind: ollama }
  - { id: offline, name: "Offline server", url: ${JSON.stringify(conn.offlineUrl)}, kind: openai }
projects:
  - { id: main, name: "Main project", repo: "owner/repo", default_branch: develop }
documents:
  - { id: logs, name: "Ops logs", path: ${JSON.stringify(notes.logs)} }
  - { id: private, name: "Private notes", path: ${JSON.stringify(notes.private)}, private: true }
collectors:
  - { id: processes, kind: process-scan }
  - { id: hermes-cron, kind: hermes-cron, path: ${JSON.stringify(path.join(dir, 'jobs.json'))} }
  - { id: timers, kind: systemd-timers, prefix: [sample-] }
`,
);

const config = loadConfig(configFile);
const db = openAppDb(config);
createToken(db, 'e2e', ['write'], new Date(), E2E_TOKEN);
if (bigBoard) seedBoard(db);
else
  for (const [status, title] of Object.entries({
    todo: 'Check build cache',
    doing: 'Review queue metrics',
    review: 'Validate release notes',
    done: 'Index sample logs',
  }))
    db.prepare(
      "INSERT INTO tasks (title,status,assignee,project_id,sprint,body,created_at,updated_at) VALUES(?,?,'worker-a','main','Iteration A','Verify **sample output**.',datetime('now'),datetime('now'))",
    ).run(title, status);
db.prepare(
  "UPDATE tasks SET external_ref='hermes-kanban:sample:1',origin='hermes-kanban' WHERE title='Review queue metrics'",
).run();
seedPlanReadings(db);
if (bigBoard) insertReadings(db, nearReset(Date.now()));
seedSchedules(db, path.join(dir, 'jobs.json'));
// The agents fixture adds its own cards; the large board keeps the exact synthetic distribution.
if (!bigBoard) {
  seedAgents(db);
  seedUsage(db);
}
// Collectors would scan this host's real processes and timers; the smoke tests use seeded data
// only (job timers stay off too; "run now" still works).
const running = await startServer({ config, db, agentCollectors: false, schedules: false });
console.log(`e2e server on ${running.url} (temp dir ${dir})`);

let done = false;
async function stop() {
  if (done) return;
  done = true;
  await running.close();
  await conn.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
