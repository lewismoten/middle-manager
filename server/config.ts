// Loads and validates config/middle-manager.yaml.
// Every problem is collected and reported together, each with the path of the offending key,
// so a typo in one section does not hide a mistake in another.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';

export const PLAN_PROVIDERS = ['anthropic-oauth', 'codex-sessions', 'manual'] as const;
export const PLAN_WINDOWS = ['weekly', 'five_hour'] as const;
export const LOCAL_MODEL_KINDS = ['ollama', 'openai'] as const;

export interface SiteConfig {
  name: string;
  timezone: string;
}
export interface ServerConfig {
  host: string;
  port: number;
  cors_origins: string[];
}
export interface DatabaseConfig {
  path: string;
}
export interface MachineConfig {
  id: string;
  name: string;
  role?: string;
}
export interface PlanConfig {
  id: string;
  name: string;
  provider: (typeof PLAN_PROVIDERS)[number];
  credentials?: string;
  sessions_dir?: string;
  windows: (typeof PLAN_WINDOWS)[number][];
  empty_buffer_hours: number;
}
export interface LocalModelConfig {
  id: string;
  name: string;
  url: string;
  kind: (typeof LOCAL_MODEL_KINDS)[number];
}
export interface ProjectConfig {
  id: string;
  name: string;
  repo?: string;
  path?: string;
  default_branch?: string;
}
export interface DocumentCollectionConfig {
  id: string;
  name: string;
  path: string;
  glob: string;
  private: boolean;
}
export interface CollectorConfig {
  id: string;
  kind: string;
  [key: string]: unknown;
}
export interface RetentionConfig {
  plan_readings_days: number;
  runs_days: number;
  job_runs_per_job: number;
  job_output_kb: number;
  events_days: number;
}
export interface Config {
  site: SiteConfig;
  server: ServerConfig;
  database: DatabaseConfig;
  machines: MachineConfig[];
  plans: PlanConfig[];
  models: Record<string, string[]>;
  local_models: LocalModelConfig[];
  projects: ProjectConfig[];
  documents: DocumentCollectionConfig[];
  collectors: CollectorConfig[];
  retention: RetentionConfig;
  /** Absolute path of the file this config was loaded from (not part of the YAML). */
  source: string;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  plan_readings_days: 120,
  runs_days: 90,
  job_runs_per_job: 50,
  job_output_kb: 64,
  events_days: 30,
};

export const DEFAULT_CONFIG_PATH = 'config/middle-manager.yaml';
export const DEFAULT_DB_PATH = 'data/middle-manager.db';

export class ConfigError extends Error {
  readonly problems: string[];
  readonly file: string;
  constructor(file: string, problems: string[]) {
    super(`Invalid config ${file}:\n` + problems.map((p) => `  - ${p}`).join('\n'));
    this.name = 'ConfigError';
    this.file = file;
    this.problems = problems;
  }
}

/** Expands a leading `~` to the home directory. Other paths are returned unchanged. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class Checker {
  problems: string[] = [];

  fail(where: string, msg: string): void {
    this.problems.push(`${where}: ${msg}`);
  }

  unknownKeys(obj: Obj, where: string, allowed: readonly string[]): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) {
        const at = where ? `${where}.${key}` : key;
        this.fail(at, `unknown key (allowed: ${allowed.join(', ')})`);
      }
    }
  }

  str(obj: Obj, key: string, where: string, required: true): string;
  str(obj: Obj, key: string, where: string, required: false): string | undefined;
  str(obj: Obj, key: string, where: string, required: boolean): string | undefined {
    const v = obj[key];
    if (v === undefined || v === null) {
      if (required) this.fail(`${where}.${key}`, 'is required');
      return required ? '' : undefined;
    }
    if (typeof v !== 'string' || v.trim() === '') {
      this.fail(`${where}.${key}`, 'must be a non-empty string');
      return required ? '' : undefined;
    }
    return v;
  }

  id(obj: Obj, where: string, seen: Set<string>): string {
    const id = this.str(obj, 'id', where, true);
    if (id && !ID_RE.test(id)) {
      this.fail(`${where}.id`, `"${id}" must be letters, digits, ".", "_" or "-" (max 64)`);
    } else if (id && seen.has(id)) {
      this.fail(`${where}.id`, `duplicate id "${id}"`);
    }
    seen.add(id);
    return id;
  }

  num(
    obj: Obj,
    key: string,
    where: string,
    fallback: number,
    opts: { min?: number; max?: number; integer?: boolean } = {},
  ): number {
    const v = obj[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.fail(`${where}.${key}`, 'must be a number');
      return fallback;
    }
    if (opts.integer && !Number.isInteger(v)) {
      this.fail(`${where}.${key}`, 'must be a whole number');
      return fallback;
    }
    if (opts.min !== undefined && v < opts.min) {
      this.fail(`${where}.${key}`, `must be at least ${opts.min}`);
      return fallback;
    }
    if (opts.max !== undefined && v > opts.max) {
      this.fail(`${where}.${key}`, `must be at most ${opts.max}`);
      return fallback;
    }
    return v;
  }

  bool(obj: Obj, key: string, where: string, fallback: boolean): boolean {
    const v = obj[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'boolean') {
      this.fail(`${where}.${key}`, 'must be true or false');
      return fallback;
    }
    return v;
  }

  oneOf<T extends string>(
    obj: Obj,
    key: string,
    where: string,
    allowed: readonly T[],
    required: boolean,
  ): T | undefined {
    const v = obj[key];
    if (v === undefined || v === null) {
      if (required) this.fail(`${where}.${key}`, `is required (one of: ${allowed.join(', ')})`);
      return undefined;
    }
    if (typeof v !== 'string' || !allowed.includes(v as T)) {
      this.fail(
        `${where}.${key}`,
        `must be one of: ${allowed.join(', ')} (got ${JSON.stringify(v)})`,
      );
      return undefined;
    }
    return v as T;
  }

  section(root: Obj, key: string): Obj {
    const v = root[key];
    if (v === undefined || v === null) return {};
    if (!isObj(v)) {
      this.fail(key, 'must be a mapping (key: value pairs)');
      return {};
    }
    return v;
  }

  list(root: Obj, key: string): Obj[] {
    const v = root[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      this.fail(key, 'must be a list');
      return [];
    }
    const out: Obj[] = [];
    v.forEach((item, i) => {
      if (!isObj(item)) this.fail(`${key}[${i}]`, 'must be a mapping (key: value pairs)');
      else out.push(item);
    });
    return out;
  }
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validates a parsed YAML document. Throws ConfigError listing every problem found. */
export function validateConfig(raw: unknown, source = '<memory>'): Config {
  const c = new Checker();
  if (!isObj(raw)) {
    throw new ConfigError(source, ['the file must contain a YAML mapping at the top level']);
  }
  c.unknownKeys(raw, '', [
    'site',
    'server',
    'database',
    'machines',
    'plans',
    'models',
    'local_models',
    'projects',
    'documents',
    'collectors',
    'retention',
  ]);

  if (raw.site === undefined) c.fail('site', 'is required (site: { name: "..." })');
  const siteRaw = c.section(raw, 'site');
  c.unknownKeys(siteRaw, 'site', ['name', 'timezone']);
  const site: SiteConfig = {
    name: c.str(siteRaw, 'name', 'site', true),
    timezone: c.str(siteRaw, 'timezone', 'site', false) ?? 'UTC',
  };
  if (!isValidTimezone(site.timezone)) {
    c.fail(
      'site.timezone',
      `"${site.timezone}" is not a known IANA time zone (e.g. "America/New_York")`,
    );
  }

  const serverRaw = c.section(raw, 'server');
  c.unknownKeys(serverRaw, 'server', ['host', 'port', 'cors_origins']);
  const corsRaw = serverRaw.cors_origins;
  let cors_origins: string[] = [];
  if (corsRaw !== undefined && corsRaw !== null) {
    if (!Array.isArray(corsRaw) || corsRaw.some((o) => typeof o !== 'string')) {
      c.fail('server.cors_origins', 'must be a list of origins like "http://host:port"');
    } else {
      cors_origins = corsRaw as string[];
    }
  }
  const server: ServerConfig = {
    host: c.str(serverRaw, 'host', 'server', false) ?? '0.0.0.0',
    port: c.num(serverRaw, 'port', 'server', 4747, { min: 1, max: 65535, integer: true }),
    cors_origins,
  };

  const dbRaw = c.section(raw, 'database');
  c.unknownKeys(dbRaw, 'database', ['path']);
  const database: DatabaseConfig = {
    path: c.str(dbRaw, 'path', 'database', false) ?? DEFAULT_DB_PATH,
  };

  const machineIds = new Set<string>();
  const machines = c.list(raw, 'machines').map((m, i): MachineConfig => {
    const w = `machines[${i}]`;
    c.unknownKeys(m, w, ['id', 'name', 'role']);
    return {
      id: c.id(m, w, machineIds),
      name: c.str(m, 'name', w, true),
      role: c.str(m, 'role', w, false),
    };
  });

  const planIds = new Set<string>();
  const plans = c.list(raw, 'plans').map((p, i): PlanConfig => {
    const w = `plans[${i}]`;
    c.unknownKeys(p, w, [
      'id',
      'name',
      'provider',
      'credentials',
      'sessions_dir',
      'windows',
      'empty_buffer_hours',
    ]);
    const provider = c.oneOf(p, 'provider', w, PLAN_PROVIDERS, true) ?? 'manual';
    let windows: PlanConfig['windows'] = ['weekly'];
    if (p.windows !== undefined && p.windows !== null) {
      if (
        !Array.isArray(p.windows) ||
        p.windows.length === 0 ||
        p.windows.some((x) => !PLAN_WINDOWS.includes(x))
      ) {
        c.fail(`${w}.windows`, `must be a non-empty list of: ${PLAN_WINDOWS.join(', ')}`);
      } else {
        windows = p.windows as PlanConfig['windows'];
      }
    }
    const plan: PlanConfig = {
      id: c.id(p, w, planIds),
      name: c.str(p, 'name', w, true),
      provider,
      credentials: c.str(p, 'credentials', w, false),
      sessions_dir: c.str(p, 'sessions_dir', w, false),
      windows,
      empty_buffer_hours: c.num(p, 'empty_buffer_hours', w, 1, { min: 0, max: 168 }),
    };
    if (provider === 'anthropic-oauth' && !plan.credentials) {
      c.fail(
        `${w}.credentials`,
        'is required for provider anthropic-oauth (path to the credentials file)',
      );
    }
    if (provider === 'codex-sessions' && !plan.sessions_dir) {
      c.fail(`${w}.sessions_dir`, 'is required for provider codex-sessions');
    }
    return plan;
  });

  const models: Record<string, string[]> = {};
  const modelsRaw = c.section(raw, 'models');
  for (const [planId, ladder] of Object.entries(modelsRaw)) {
    if (!planIds.has(planId)) {
      c.fail(
        `models.${planId}`,
        `no plan with id "${planId}" (plans: ${[...planIds].join(', ') || 'none'})`,
      );
    }
    if (
      !Array.isArray(ladder) ||
      ladder.length === 0 ||
      ladder.some((m) => typeof m !== 'string' || m.trim() === '')
    ) {
      c.fail(`models.${planId}`, 'must be a non-empty list of model names, cheapest first');
    } else {
      models[planId] = ladder as string[];
    }
  }

  const localIds = new Set<string>();
  const local_models = c.list(raw, 'local_models').map((m, i): LocalModelConfig => {
    const w = `local_models[${i}]`;
    c.unknownKeys(m, w, ['id', 'name', 'url', 'kind']);
    const url = c.str(m, 'url', w, true);
    if (url) {
      try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
      } catch {
        c.fail(`${w}.url`, `"${url}" must be an http(s) URL`);
      }
    }
    return {
      id: c.id(m, w, localIds),
      name: c.str(m, 'name', w, true),
      url,
      kind: c.oneOf(m, 'kind', w, LOCAL_MODEL_KINDS, true) ?? 'openai',
    };
  });

  const projectIds = new Set<string>();
  const projects = c.list(raw, 'projects').map((p, i): ProjectConfig => {
    const w = `projects[${i}]`;
    c.unknownKeys(p, w, ['id', 'name', 'repo', 'path', 'default_branch']);
    return {
      id: c.id(p, w, projectIds),
      name: c.str(p, 'name', w, true),
      repo: c.str(p, 'repo', w, false),
      path: c.str(p, 'path', w, false),
      default_branch: c.str(p, 'default_branch', w, false),
    };
  });

  const docIds = new Set<string>();
  const documents = c.list(raw, 'documents').map((d, i): DocumentCollectionConfig => {
    const w = `documents[${i}]`;
    c.unknownKeys(d, w, ['id', 'name', 'path', 'glob', 'private']);
    return {
      id: c.id(d, w, docIds),
      name: c.str(d, 'name', w, true),
      path: c.str(d, 'path', w, true),
      glob: c.str(d, 'glob', w, false) ?? '*.md',
      private: c.bool(d, 'private', w, false),
    };
  });

  // Collector options depend on the kind; later slices validate their own fields.
  const collectorIds = new Set<string>();
  const collectors = c.list(raw, 'collectors').map((col, i): CollectorConfig => {
    const w = `collectors[${i}]`;
    return { ...col, id: c.id(col, w, collectorIds), kind: c.str(col, 'kind', w, true) };
  });

  const retRaw = c.section(raw, 'retention');
  c.unknownKeys(retRaw, 'retention', Object.keys(DEFAULT_RETENTION));
  const posInt = { min: 1, integer: true };
  const retention: RetentionConfig = {
    plan_readings_days: c.num(
      retRaw,
      'plan_readings_days',
      'retention',
      DEFAULT_RETENTION.plan_readings_days,
      posInt,
    ),
    runs_days: c.num(retRaw, 'runs_days', 'retention', DEFAULT_RETENTION.runs_days, posInt),
    job_runs_per_job: c.num(
      retRaw,
      'job_runs_per_job',
      'retention',
      DEFAULT_RETENTION.job_runs_per_job,
      posInt,
    ),
    job_output_kb: c.num(
      retRaw,
      'job_output_kb',
      'retention',
      DEFAULT_RETENTION.job_output_kb,
      posInt,
    ),
    events_days: c.num(retRaw, 'events_days', 'retention', DEFAULT_RETENTION.events_days, posInt),
  };

  if (c.problems.length) throw new ConfigError(source, c.problems);
  return {
    site,
    server,
    database,
    machines,
    plans,
    models,
    local_models,
    projects,
    documents,
    collectors,
    retention,
    source,
  };
}

/** Parses YAML text and validates it. */
export function parseConfig(text: string, source = '<memory>'): Config {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      const pos = err.linePos?.[0];
      const where = pos ? `line ${pos.line}, column ${pos.col}` : 'YAML';
      throw new ConfigError(source, [
        `${where}: ${(err.message.split('\n')[0] ?? '').replace(/ at line \d+, column \d+:?$/, '')}`,
      ]);
    }
    throw err;
  }
  return validateConfig(raw, source);
}

/** Resolves the config file path: explicit argument, then MM_CONFIG, then the default. */
export function resolveConfigPath(explicit?: string): string {
  return path.resolve(explicit ?? process.env.MM_CONFIG ?? DEFAULT_CONFIG_PATH);
}

/** Reads, parses and validates the config file. Relative database paths resolve from the working directory. */
export function loadConfig(file?: string): Config {
  const source = resolveConfigPath(file);
  let text: string;
  try {
    text = readFileSync(source, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const hint =
      code === 'ENOENT'
        ? 'file not found. Copy config/middle-manager.example.yaml to config/middle-manager.yaml and edit it, or pass --config <file>.'
        : `cannot read file (${code ?? String(err)})`;
    throw new ConfigError(source, [hint]);
  }
  const config = parseConfig(text, source);
  config.database.path = path.resolve(expandHome(config.database.path));
  return config;
}
