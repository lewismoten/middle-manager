// middle-manager CLI: serve, token create|list|revoke, db migrate|stats.

import { flagString, parseArgs } from './args.ts';
import { createToken, listTokens, parseScopes, revokeToken, SCOPES, TokenError } from './auth.ts';
import { ConfigError, loadConfig } from './config.ts';
import { dbStats, openAppDb, openDb, migrate } from './db/index.ts';
import { reportFatal, serve } from './index.ts';
import { isMain } from './version.ts';

export const USAGE = `Usage: middle-manager <command> [options]

Commands:
  serve                         Start the service (same as npm start)
  token create <name> [--scopes write,jobs:shell,admin]
                                Create an API token; it is printed once
  token list                    List tokens (names, scopes, last use; never the token)
  token revoke <name>           Revoke the live token with this name
  db migrate                    Apply pending schema migrations
  db stats                      Show database size and row counts

Options:
  --config <file>               Config file (default config/middle-manager.yaml, or $MM_CONFIG)
  --help                        Show this help

Scopes: ${SCOPES.join(', ')} (default: write)`;

type Out = (line: string) => void;

export function runCli(argv: string[], out: Out = console.log): number | Promise<number> {
  const args = parseArgs(argv);
  const [cmd, sub, name] = args.positional;
  if (!cmd || args.flags.help || cmd === 'help') {
    out(USAGE);
    return cmd ? 0 : args.flags.help ? 0 : 2;
  }
  if (cmd === 'serve') return serve(argv.filter((a) => a !== 'serve')).then(() => 0);

  const config = loadConfig(flagString(args, 'config'));

  if (cmd === 'db' && sub === 'migrate') {
    const db = openDb(config.database.path);
    try {
      const applied = migrate(db);
      out(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date');
    } finally {
      db.close();
    }
    return 0;
  }

  const db = openAppDb(config);
  try {
    if (cmd === 'db' && sub === 'stats') {
      const s = dbStats(db, config.database.path);
      out(`Database: ${s.path}`);
      out(`Size: ${s.size_bytes} bytes (+ ${s.wal_bytes} WAL), schema version ${s.schema_version}`);
      for (const [t, n] of Object.entries(s.rows)) out(`  ${t.padEnd(14)} ${n}`);
      return 0;
    }
    if (cmd === 'token' && sub === 'create') {
      if (!name) throw new TokenError('Usage: middle-manager token create <name> [--scopes write]');
      const scopes = parseScopes(flagString(args, 'scopes'));
      const { token, info } = createToken(db, name, scopes);
      out(`Created token "${info.name}" with scopes: ${info.scopes.join(', ')}`);
      out('Copy it now; it is stored only as a hash and cannot be shown again:');
      out('');
      out(token);
      out('');
      out('Use it as: Authorization: Bearer <token>');
      return 0;
    }
    if (cmd === 'token' && sub === 'list') {
      const tokens = listTokens(db);
      if (!tokens.length) out('No tokens. Create one with: middle-manager token create <name>');
      for (const t of tokens) {
        const state = t.revoked_at ? `revoked ${t.revoked_at}` : 'live';
        out(
          `${t.name.padEnd(20)} ${t.scopes.join(',').padEnd(22)} created ${t.created_at}  last used ${t.last_used_at ?? 'never'}  ${state}`,
        );
      }
      return 0;
    }
    if (cmd === 'token' && sub === 'revoke') {
      if (!name) throw new TokenError('Usage: middle-manager token revoke <name>');
      if (!revokeToken(db, name)) throw new TokenError(`No live token named "${name}"`);
      out(`Revoked token "${name}"`);
      return 0;
    }
  } finally {
    db.close();
  }
  out(USAGE);
  return 2;
}

if (isMain(import.meta.filename)) {
  Promise.resolve()
    .then(() => runCli(process.argv.slice(2)))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((err: unknown) => {
      if (err instanceof TokenError || err instanceof ConfigError) {
        console.error(err.message);
        process.exit(1);
      }
      reportFatal(err);
    });
}
