// Starts the service: node server/index.ts [--config file] [--port n] [--host h]

import { flagString, parseArgs } from './args.ts';
import { ConfigError, loadConfig } from './config.ts';
import { startServer } from './server.ts';
import { isMain } from './version.ts';

export async function serve(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const config = loadConfig(flagString(args, 'config'));
  const portFlag = flagString(args, 'port') ?? process.env.MM_PORT;
  const port = portFlag === undefined ? undefined : Number(portFlag);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error(`--port must be a whole number from 0 to 65535 (got ${portFlag})`);
  }
  const running = await startServer({
    config,
    port,
    host: flagString(args, 'host') ?? process.env.MM_HOST,
  });
  console.log(`middle-manager ${running.state.version} listening on ${running.url}`);
  console.log(`config: ${config.source}`);
  console.log(`database: ${config.database.path}`);
  const stop = (signal: string) => {
    console.log(`${signal}: shutting down`);
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

export function reportFatal(err: unknown): never {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

if (isMain(import.meta.filename)) {
  serve(process.argv.slice(2)).catch(reportFatal);
}
