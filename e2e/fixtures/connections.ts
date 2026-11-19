// Synthetic connection sources for the e2e server: a Claude credentials file with a fake token,
// a Codex sessions folder with one log (no rate limits, so "Read now" stays local and adds
// nothing), a tiny fake Ollama endpoint, and a port nothing listens on.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

export interface ConnectionFixtures {
  credentials: string;
  sessionsDir: string;
  ollamaUrl: string;
  offlineUrl: string;
  close: () => Promise<void>;
}

export async function seedConnections(dir: string, now = Date.now()): Promise<ConnectionFixtures> {
  const credentials = path.join(dir, 'claude-credentials.json');
  writeFileSync(
    credentials,
    JSON.stringify({
      claudeAiOauth: { accessToken: 'e2e-fake-token-not-a-secret', expiresAt: now + 8 * 3600_000 },
    }),
  );
  const d = new Date(now);
  const day = path.join(
    dir,
    'codex-sessions',
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
  );
  mkdirSync(day, { recursive: true });
  writeFileSync(
    path.join(day, 'rollout-sample.jsonl'),
    `${JSON.stringify({ timestamp: d.toISOString(), type: 'session_meta' })}\n`,
  );

  const ollama = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags')
      res.end(JSON.stringify({ models: [{ name: 'tiny-model:1b' }, { name: 'small-coder:7b' }] }));
    else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r));
  const offline = createServer();
  await new Promise<void>((r) => offline.listen(0, '127.0.0.1', r));
  const offlinePort = (offline.address() as AddressInfo).port;
  await new Promise<void>((r) => offline.close(() => r()));

  return {
    credentials,
    sessionsDir: path.join(dir, 'codex-sessions'),
    ollamaUrl: `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`,
    offlineUrl: `http://127.0.0.1:${offlinePort}`,
    close: () => new Promise<void>((r) => ollama.close(() => r())),
  };
}
