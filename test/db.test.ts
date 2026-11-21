import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COUNTED_TABLES,
  dbStats,
  migrate,
  openDb,
  readMigrations,
  syncConfig,
} from '../server/db/index.ts';
import { memoryDb, testConfig } from './helpers.ts';

// Slices add numbered migrations; tests follow the folder instead of naming each one.
const SHIPPED = readMigrations();

function tables(db: ReturnType<typeof openDb>): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  )
    .map((r) => r.name)
    .sort();
}

describe('migrations', () => {
  it('creates every SPEC section 5 table', () => {
    const db = openDb(':memory:');
    expect(migrate(db)).toEqual(SHIPPED.map((m) => m.version));
    expect(tables(db)).toEqual([...COUNTED_TABLES, 'schema_migrations'].sort());
  });

  it('is idempotent and records versions', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(migrate(db)).toEqual([]);
    const rows = db.prepare('SELECT version, name FROM schema_migrations').all();
    expect(rows).toEqual(SHIPPED.map(({ version, name }) => ({ version, name })));
    expect(rows[0]).toEqual({ version: 1, name: '0001_initial.sql' });
  });

  it('applies only new migrations, in order', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mm-mig-'));
    writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (x INTEGER);');
    const db = openDb(':memory:');
    expect(migrate(db, readMigrations(dir))).toEqual([1]);
    writeFileSync(path.join(dir, '0002_b.sql'), 'CREATE TABLE b (y INTEGER);');
    expect(migrate(db, readMigrations(dir))).toEqual([2]);
    expect(tables(db)).toEqual(['a', 'b', 'schema_migrations']);
  });

  it('rolls back a failing migration', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mm-mig-'));
    writeFileSync(path.join(dir, '0001_bad.sql'), 'CREATE TABLE ok (x); CREATE TABLE broken (;');
    const db = openDb(':memory:');
    expect(() => migrate(db, readMigrations(dir))).toThrow(/Migration 0001_bad.sql failed/);
    expect(tables(db)).toEqual(['schema_migrations']);
  });

  it('rejects badly named migration files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mm-mig-'));
    writeFileSync(path.join(dir, 'init.sql'), '');
    expect(() => readMigrations(dir)).toThrow(/0001_name\.sql/);
  });

  it('enforces task status values', () => {
    const db = memoryDb();
    const insert = db.prepare(
      "INSERT INTO tasks (title, status, created_at, updated_at) VALUES ('t', ?, 'now', 'now')",
    );
    expect(() => insert.run('doing')).not.toThrow();
    expect(() => insert.run('someday')).toThrow(/CHECK/);
  });

  it('mirrors config rows; config wins and removed ids are kept but marked', () => {
    const cfg = testConfig({
      machines: [
        { id: 'server-1', name: 'One' },
        { id: 'server-2', name: 'Two' },
      ],
      plans: [{ id: 'p', name: 'Plan', provider: 'manual' }],
    });
    const db = memoryDb(cfg);
    db.prepare("UPDATE machines SET name = 'edited' WHERE id = 'server-1'").run();
    syncConfig(db, testConfig({ machines: [{ id: 'server-1', name: 'One' }] }));
    expect(db.prepare('SELECT id, name, in_config FROM machines ORDER BY id').all()).toEqual([
      { id: 'server-1', name: 'One', in_config: 1 },
      { id: 'server-2', name: 'Two', in_config: 0 },
    ]);
    expect(db.prepare('SELECT in_config FROM plans').get()).toEqual({ in_config: 0 });
  });

  it('reports stats for every counted table', () => {
    const db = memoryDb();
    const s = dbStats(db, ':memory:');
    expect(Object.keys(s.rows)).toEqual([...COUNTED_TABLES]);
    expect(s.schema_version).toBe(Math.max(...SHIPPED.map((m) => m.version)));
    expect(s.page_size).toBeGreaterThan(0);
  });
});
