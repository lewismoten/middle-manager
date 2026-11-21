import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_RETENTION,
  loadConfig,
  parseConfig,
  validateConfig,
} from '../server/config.ts';
import { publicConfig } from '../server/routes/core.ts';

function problems(raw: unknown): string[] {
  try {
    validateConfig(raw, 'x.yaml');
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

describe('config', () => {
  it('accepts the example config', () => {
    const text = readFileSync('config/middle-manager.example.yaml', 'utf8');
    const cfg = parseConfig(text, 'example');
    expect(cfg.site.name).toBe('My agent fleet');
    expect(cfg.server.port).toBe(4747);
    expect(cfg.machines[0]?.id).toBe('server-1');
    expect(cfg.plans.map((p) => p.id)).toEqual(['claude', 'codex']);
    expect(cfg.documents.find((d) => d.private)?.id).toBe('journal');
  });

  it('fills defaults for a minimal config', () => {
    const cfg = validateConfig({ site: { name: 'A' } });
    expect(cfg.site.timezone).toBe('UTC');
    expect(cfg.server).toEqual({ host: '0.0.0.0', port: 4747, cors_origins: [] });
    expect(cfg.retention).toEqual(DEFAULT_RETENTION);
    expect(cfg.plans).toEqual([]);
    expect(cfg.plans).toEqual([]);
  });

  it('requires site.name', () => {
    expect(problems({})).toContain('site: is required (site: { name: "..." })');
    expect(problems({ site: { name: '' } })).toContain('site.name: must be a non-empty string');
  });

  it('reports every problem at once, with the key path', () => {
    const p = problems({
      site: { name: 'A', timezone: 'Mars/Olympus' },
      server: { port: 70000 },
      machines: [
        { id: 'm1', name: 'M' },
        { id: 'm1', name: 'Again' },
      ],
      plans: [{ id: 'p', name: 'P', provider: 'nope' }],
      models: { ghost: ['a'] },
      retention: { runs_days: 0, typo_days: 3 },
      surprise: true,
    });
    expect(p).toEqual(
      expect.arrayContaining([
        'surprise: unknown key (allowed: site, server, database, machines, plans, models, local_models, projects, documents, collectors, retention)',
        'site.timezone: "Mars/Olympus" is not a known IANA time zone (e.g. "America/New_York")',
        'server.port: must be at most 65535',
        'machines[1].id: duplicate id "m1"',
        'plans[0].provider: must be one of: anthropic-oauth, codex-sessions, manual (got "nope")',
        'models.ghost: no plan with id "ghost" (plans: p)',
        'retention.runs_days: must be at least 1',
        expect.stringMatching(/^retention\.typo_days: unknown key/),
      ]),
    );
    expect(p).toHaveLength(8);
  });

  it('checks provider-specific fields', () => {
    const p = problems({
      site: { name: 'A' },
      plans: [
        { id: 'c', name: 'C', provider: 'anthropic-oauth' },
        { id: 'x', name: 'X', provider: 'codex-sessions', windows: ['monthly'] },
      ],
    });
    expect(p).toEqual([
      'plans[0].credentials: is required for provider anthropic-oauth (path to the credentials file)',
      'plans[1].windows: must be a non-empty list of: weekly, five_hour',
      'plans[1].sessions_dir: is required for provider codex-sessions',
    ]);
  });

  it('rejects a window too short to group and a buffer as long as the window', () => {
    const p = problems({
      site: { name: 'A' },
      plans: [
        { id: 'a', name: 'A', provider: 'manual', window_hours: 3 },
        { id: 'b', name: 'B', provider: 'manual', window_hours: 48, empty_buffer_hours: 48 },
        { id: 'c', name: 'C', provider: 'manual', window_hours: 120, empty_buffer_hours: 2 },
      ],
    });
    expect(p).toEqual([
      'plans[0].window_hours: must be at least 24',
      'plans[1].empty_buffer_hours: must be less than window_hours',
    ]);
  });

  it('validates lists, ids and urls', () => {
    const p = problems({
      site: { name: 'A' },
      machines: 'server-1',
      local_models: [{ id: 'o', name: 'O', url: 'ftp://x', kind: 'ollama' }],
      projects: [{ id: 'has space', name: 'P' }],
      documents: [{ id: 'd', name: 'D' }],
    });
    expect(p).toEqual([
      'machines: must be a list',
      'local_models[0].url: "ftp://x" must be an http(s) URL',
      'projects[0].id: "has space" must be letters, digits, ".", "_" or "-" (max 64)',
      'documents[0].path: is required',
    ]);
  });

  it('reports YAML syntax errors with a line number', () => {
    expect(() => parseConfig('site: { name: a\n', 'bad.yaml')).toThrow(/line \d+, column \d+/);
  });

  it('explains a missing file', () => {
    expect(() => loadConfig('/nonexistent/middle-manager.yaml')).toThrow(/file not found/);
  });

  it('loads from disk and resolves the database path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mm-config-'));
    const file = path.join(dir, 'c.yaml');
    writeFileSync(file, 'site: { name: Disk }\ndatabase: { path: data/x.db }\n');
    const cfg = loadConfig(file);
    expect(cfg.source).toBe(file);
    expect(path.isAbsolute(cfg.database.path)).toBe(true);
  });

  it('public config has no paths, urls or credentials', () => {
    const cfg = parseConfig(readFileSync('config/middle-manager.example.yaml', 'utf8'));
    const text = JSON.stringify(publicConfig(cfg, '0.0.0'));
    expect(text).not.toMatch(/~\/|credentials|sessions_dir|http:\/\/|"path"|"url"|"match"/);
    expect(text).toContain('My agent fleet');
  });
});
