// Opens the SQLite database, applies numbered migrations and mirrors config rows.

import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.ts';

import { backfillRunProjects } from '../agents/projects.ts';

export type Db = DatabaseSync;

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

const MIGRATION_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export function readMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const seen = new Set<number>();
  return files.map((name) => {
    const m = MIGRATION_RE.exec(name);
    if (!m) throw new Error(`Migration file name must look like 0001_name.sql: ${name}`);
    const version = Number(m[1]);
    if (seen.has(version)) throw new Error(`Duplicate migration number ${m[1]}`);
    seen.add(version);
    return { version, name, sql: readFileSync(path.join(dir, name), 'utf8') };
  });
}

/** Opens (creating if needed) the database file. Use ":memory:" for tests. */
export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** Applies migrations not yet recorded in schema_migrations, each in its own transaction. */
export function migrate(db: Db, migrations = readMigrations()): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const done = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const applied: number[] = [];
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      record.run(m.version, m.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`, { cause: err });
    }
    applied.push(m.version);
  }
  return applied;
}

/** Mirrors machines, projects and plans from config. Config wins; removed ids get in_config = 0. */
export function syncConfig(db: Db, config: Config, now = new Date()): void {
  const at = now.toISOString();
  db.exec('BEGIN');
  try {
    db.exec('UPDATE machines SET in_config = 0');
    db.exec('UPDATE projects SET in_config = 0');
    db.exec('UPDATE plans SET in_config = 0');
    const m = db.prepare(
      `INSERT INTO machines (id, name, role, in_config, updated_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, role = excluded.role,
         in_config = 1, updated_at = excluded.updated_at`,
    );
    for (const x of config.machines) m.run(x.id, x.name, x.role ?? null, at);
    const p = db.prepare(
      `INSERT INTO projects (id, name, repo, path, default_branch, in_config, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, repo = excluded.repo, path = excluded.path,
         default_branch = excluded.default_branch, in_config = 1, updated_at = excluded.updated_at`,
    );
    for (const x of config.projects) {
      p.run(x.id, x.name, x.repo ?? null, x.path ?? null, x.default_branch ?? null, at);
    }
    backfillRunProjects(db);
    const pl = db.prepare(
      `INSERT INTO plans (id, name, provider, windows, empty_buffer_hours, in_config, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, provider = excluded.provider,
         windows = excluded.windows, empty_buffer_hours = excluded.empty_buffer_hours,
         in_config = 1, updated_at = excluded.updated_at`,
    );
    for (const x of config.plans) {
      pl.run(x.id, x.name, x.provider, JSON.stringify(x.windows), x.empty_buffer_hours, at);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Opens the configured database, migrates it and mirrors config. */
export function openAppDb(config: Config): Db {
  const db = openDb(config.database.path);
  migrate(db);
  syncConfig(db, config);
  return db;
}

export const COUNTED_TABLES = [
  'machines',
  'projects',
  'plans',
  'plan_readings',
  'tasks',
  'task_dependencies',
  'task_events',
  'runs',
  'jobs',
  'job_runs',
  'external_jobs',
  'documents',
  'tokens',
  'audit',
] as const;

export interface DbStats {
  path: string;
  size_bytes: number;
  wal_bytes: number;
  page_count: number;
  page_size: number;
  schema_version: number;
  rows: Record<string, number>;
}

export function dbStats(db: Db, file: string): DbStats {
  const fileSize = (p: string) => {
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  };
  const rows: Record<string, number> = {};
  for (const t of COUNTED_TABLES) {
    rows[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  const pragma = (name: string) =>
    Number(Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0] ?? 0);
  const version = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null;
  };
  return {
    path: file,
    size_bytes: file === ':memory:' ? 0 : fileSize(file),
    wal_bytes: file === ':memory:' ? 0 : fileSize(`${file}-wal`),
    page_count: pragma('page_count'),
    page_size: pragma('page_size'),
    schema_version: version.v ?? 0,
    rows,
  };
}
