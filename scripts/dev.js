// npm run dev: the API server with reload (node --watch) plus the Vite dev server.
// Uses config/middle-manager.yaml (or $MM_CONFIG), but listens on MM_PORT (default 6181)
// so it never collides with an installed service on the configured port.
import { spawn } from 'node:child_process';

const apiPort = process.env.MM_PORT ?? '6181';
const env = { ...process.env, MM_PORT: apiPort };
const children = [
  spawn(process.execPath, ['--watch', 'server/index.ts', '--host', '127.0.0.1'], {
    stdio: 'inherit',
    env,
  }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit', env }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  process.exitCode = code;
}
for (const c of children) c.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
