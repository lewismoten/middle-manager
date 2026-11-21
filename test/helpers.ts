import { validateConfig, type Config } from '../server/config.ts';
import { migrate, openDb, syncConfig, type Db } from '../server/db/index.ts';

export const MINIMAL = { site: { name: 'Test fleet' } };

export function testConfig(extra: Record<string, unknown> = {}): Config {
  const cfg = validateConfig({ ...MINIMAL, ...extra }, 'test.yaml');
  cfg.database.path = ':memory:';
  return cfg;
}

export function memoryDb(config: Config = testConfig()): Db {
  const db = openDb(':memory:');
  migrate(db);
  syncConfig(db, config);
  return db;
}
