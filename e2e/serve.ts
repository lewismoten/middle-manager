// Starts the built server for Playwright with a temporary config and database.
// Removes both on exit. Usage: node e2e/serve.ts <port>

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createToken } from '../server/auth.ts';
import { loadConfig } from '../server/config.ts';
import { openAppDb } from '../server/db/index.ts';
import { startServer } from '../server/server.ts';
import { E2E_PORT, E2E_TOKEN } from './constants.ts';
import { seedAgents } from './fixtures/agents.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'mm-e2e-'));
const configFile = path.join(dir, 'middle-manager.yaml');
writeFileSync(
  configFile,
  `site: { name: "Test fleet", timezone: "UTC" }
server: { host: 127.0.0.1, port: ${E2E_PORT} }
database: { path: ${JSON.stringify(path.join(dir, 'mm.db'))} }
machines:
  - { id: server-1, name: "Build server", role: "agents run here" }
plans:
  - { id: plan-a, name: "Plan A", provider: manual, windows: [weekly, five_hour] }
models:
  plan-a: [small, large]
local_models:
  - { id: local, name: "Local model", url: "http://127.0.0.1:9", kind: openai }
projects:
  - { id: main, name: "Main project", repo: "owner/repo", default_branch: develop }
documents:
  - { id: logs, name: "Ops logs", path: ${JSON.stringify(dir)} }
  - { id: private, name: "Private notes", path: ${JSON.stringify(dir)}, private: true }
collectors:
  - { id: processes, kind: process-scan }
`,
);

const config = loadConfig(configFile);
const db = openAppDb(config);
createToken(db, 'e2e', ['write'], new Date(), E2E_TOKEN);
seedAgents(db);
// Collectors would scan this host's real processes; the smoke tests use seeded runs only.
const running = await startServer({ config, db, agentCollectors: false });
console.log(`e2e server on ${running.url} (temp dir ${dir})`);

let done = false;
async function stop() {
  if (done) return;
  done = true;
  await running.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
