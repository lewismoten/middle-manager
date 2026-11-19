#!/usr/bin/env node
// Entry point for `npx middle-manager ...`. Needs Node >= 22.18 (runs the TypeScript sources directly).
import { runCli } from '../server/cli.ts';

Promise.resolve()
  .then(() => runCli(process.argv.slice(2)))
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
