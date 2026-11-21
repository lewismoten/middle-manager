-- 0001: every table from SPEC section 5. Later slices add code, not tables, where they can.
-- Times are ISO 8601 UTC text ("2026-11-19T17:52:00.000Z") so they sort and compare as strings.

-- Mirrored from config at start (config wins). Rows whose id left the config keep in_config = 0
-- so history that points at them still resolves.
CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  in_config INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo TEXT,
  path TEXT,
  default_branch TEXT,
  in_config INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  windows TEXT NOT NULL,               -- JSON array, e.g. ["weekly","five_hour"]
  empty_buffer_hours REAL NOT NULL,
  in_config INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE plan_readings (
  id INTEGER PRIMARY KEY,
  plan_id TEXT NOT NULL,
  "window" TEXT NOT NULL,              -- weekly | five_hour
  used_pct REAL NOT NULL,
  resets_at TEXT,
  read_at TEXT NOT NULL,
  machine_id TEXT,
  how TEXT                             -- where the number came from (collector, api, import)
);
CREATE INDEX plan_readings_plan_window_read ON plan_readings (plan_id, "window", read_at);
CREATE INDEX plan_readings_read_at ON plan_readings (read_at);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  short_name TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'backlog'
    CHECK (status IN ('backlog', 'todo', 'doing', 'review', 'blocked', 'done')),
  lane TEXT,
  project_id TEXT,
  assignee TEXT,
  priority INTEGER,
  sprint TEXT,
  body TEXT,
  origin TEXT,
  external_ref TEXT UNIQUE,            -- e.g. hermes-kanban:board:t_123; imported cards are read-only
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_status ON tasks (status);
CREATE INDEX tasks_project ON tasks (project_id);

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  actor TEXT,
  kind TEXT NOT NULL,                  -- status, comment, link, ...
  data_json TEXT
);
CREATE INDEX task_events_task_at ON task_events (task_id, at);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  machine_id TEXT,
  agent_kind TEXT NOT NULL DEFAULT 'other'
    CHECK (agent_kind IN ('claude-code', 'codex', 'hermes', 'local', 'other')),
  parent_run_id INTEGER REFERENCES runs (id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT 'agent'
    CHECK (role IN ('orchestrator', 'agent', 'sub-agent', 'review')),
  harness TEXT,
  model TEXT,
  provider TEXT,
  task_id INTEGER REFERENCES tasks (id) ON DELETE SET NULL,
  prompt TEXT,
  prompt_ref TEXT,
  project_id TEXT,
  origin TEXT,
  branch TEXT,
  worktree TEXT,
  pid INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  tokens_cache_read INTEGER,
  tokens_cache_write INTEGER,
  cost_note TEXT,
  log_ref TEXT,
  summary TEXT
);
CREATE INDEX runs_started ON runs (started_at);
CREATE INDEX runs_ended ON runs (ended_at);
CREATE INDEX runs_machine_pid ON runs (machine_id, pid);
CREATE INDEX runs_task ON runs (task_id);
CREATE INDEX runs_parent ON runs (parent_run_id);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  schedule TEXT NOT NULL,              -- cron expression
  timezone TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('collector', 'shell')),
  command TEXT,                        -- shell jobs only (needs the jobs:shell scope)
  collector_id TEXT,                   -- collector jobs only
  enabled INTEGER NOT NULL DEFAULT 1,
  timeout_s INTEGER NOT NULL DEFAULT 300,
  notify TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  output TEXT,                         -- capped at retention.job_output_kb
  truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX job_runs_job_started ON job_runs (job_id, started_at);

-- Read-only mirror of other schedulers (Hermes cron, systemd timers), replaced on each import.
CREATE TABLE external_jobs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,                -- collector id, e.g. hermes-cron or systemd-timers
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  schedule TEXT,
  timezone TEXT,
  command TEXT,
  enabled INTEGER,
  last_run_at TEXT,
  last_status TEXT,
  next_run_at TEXT,
  machine_id TEXT,
  read_at TEXT NOT NULL,
  UNIQUE (source, external_id)
);

-- Index only: file contents are read from disk on request, never copied here.
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  collection_id TEXT NOT NULL,
  path TEXT NOT NULL,                  -- relative to the collection folder
  title TEXT,
  date TEXT,
  mtime TEXT,
  size INTEGER,
  private INTEGER NOT NULL DEFAULT 0,
  UNIQUE (collection_id, path)
);
CREATE INDEX documents_collection_date ON documents (collection_id, date);

CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,           -- SHA-256 hex of the token; the token itself is never stored
  scopes TEXT NOT NULL,                -- JSON array, e.g. ["write"]
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
-- A name can be reused after the old token is revoked, but only one live token per name.
CREATE UNIQUE INDEX tokens_live_name ON tokens (name) WHERE revoked_at IS NULL;

CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  token_name TEXT,                     -- null when the request had no valid token
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL
);
CREATE INDEX audit_at ON audit (at);
