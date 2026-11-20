# middle-manager: specification

> It watches others work, schedules meetings, and reports the burn.

A small self-hosted service that gives one person eyes on a fleet of AI coding agents: what each
agent is doing, on which machine and model, what it costs against each subscription, what the work
board looks like, and whether each plan will run out at the right time. Humans use the web UI;
agents use the same JSON API.

Status: v0 spec, 2026-11-19.

## 1. Principles

1. **Generic.** No machine, person, agent or project name is hard-coded. Everything site-specific lives in
   `config/middle-manager.yaml` (example: `config/middle-manager.example.yaml`). Someone else can clone the
   repo, write their own config, and run it.
2. **Local first.** One process, one SQLite file (`data/middle-manager.db`, git-ignored). No cloud
   services, no telemetry, no CDN at runtime (fonts and assets are bundled).
3. **Read open, write with a token.** Any device on the LAN/tailnet can read. Every change (POST/PUT/
   PATCH/DELETE) needs `Authorization: Bearer <token>`. Tokens are created with a CLI command, stored only
   as SHA-256 hashes, named (`laptop`, `lead-agent`) and revocable. Folders/documents marked
   `private: true` in config are also token-only to read.
4. **Bounded growth.** The owner's servers have crashed from runaway logs. Every table that grows has a
   retention rule in config (days and/or row cap), enforced by a daily built-in job; the Settings page
   shows DB size and row counts; job output is capped (default 64 KB per run, last 50 runs per job).
5. **Evidence over claims.** Data shows where it came from (`source`, `machine`, `how`) and how old it
   is. A stale reading is shown as stale, never as current.
6. **Pages, not one long scroll.** Tabs across the top; each page fits a laptop screen without scrolling
   the whole page (long lists scroll inside their panel). Phone layout stacks panels; nothing overflows
   sideways from 320 px up.

## 2. Stack

- Node >= 22.18 (runs server TypeScript directly; `node:sqlite` needs 22.13), TypeScript, ES modules. Server: `node:http` + `node:sqlite` (built in), no
  web framework. Dependencies kept minimal: `yaml` (config), `croner` (cron expressions) allowed; anything
  else needs a reason in the PR.
- Front end: Vite + TypeScript, no UI framework. Charts drawn as inline SVG by our own small helpers (no
  chart library). Light and dark themes (follow the OS, with a toggle).
- Tests: Vitest for server and pure functions; Playwright (bundled Chromium) for a smoke test of each page
  at 1440, 768 and 375 px, light and dark, plus a no-horizontal-overflow check.
- Lint/format: ESLint + Prettier. `npm run check` = format check + lint + typecheck + tests.

## 3. Running it

- `npm run dev` (Vite + server with reload), `npm run build`, `npm start` (serves the built UI and API on
  one port). Default `host: 0.0.0.0`, `port: 4747` (config).
- `npx middle-manager token create <name>` / `token list` / `token revoke <name>`; `db migrate`;
  `db stats`; `import <source>` (run one collector now).
- `deploy/middle-manager.service`: a systemd **user** unit example (Restart=on-failure,
  `MemoryMax=512M`, logs to journald, never to a growing file).
- Schema migrations: numbered SQL files in `server/db/migrations/`, applied at start, recorded in a
  `schema_migrations` table.

## 4. Config (`config/middle-manager.yaml`)

```yaml
site: { name: "My agent fleet", timezone: "America/New_York" }
server: { host: 0.0.0.0, port: 4747 }
machines:            # shown on Agents/Machines pages; collectors run on the machine that hosts the service
  - id: server-1     # free text ids; display names separate
    name: "Build server"
    role: "agents run here"
plans:               # subscriptions to pace
  - id: claude
    name: "Claude plan"
    provider: anthropic-oauth      # collector type
    credentials: ~/.claude/.credentials.json
    windows: [weekly, five_hour]
    empty_buffer_hours: 1          # target: run out this long before reset
  - id: codex
    name: "Codex plan"
    provider: codex-sessions
    sessions_dir: ~/.codex/sessions
models:              # ladder used by the pacing advice, cheapest first, per plan
  claude: [sonnet, opus]
  codex: [gpt-6.1-terra, gpt-6.1-sol, gpt-6.2-astra]
local_models:        # OpenAI-compatible or Ollama endpoints; status shown on Connections
  - { id: ollama, name: "Ollama", url: "http://127.0.0.1:11434", kind: ollama }
projects:            # git repos agents work on
  - { id: main, name: "Main project", repo: "owner/repo", path: ~/dev/project, default_branch: develop }
documents:           # markdown folders shown on the Notes page
  - { id: ops-logs, name: "Ops logs", path: ~/ops-logs, glob: "*.md" }
  - { id: what-mattered, name: "What mattered", path: ~/notes/what-mattered, glob: "*.md", private: true }
collectors:          # importers; each can be scheduled as a job
  - { id: hermes-kanban, kind: hermes-kanban, path: ~/.hermes/kanban/boards }
  - { id: hermes-cron, kind: hermes-cron, path: ~/.hermes/cron/jobs.json }
  - { id: processes, kind: process-scan, match: ["codex exec", "claude -p", "hermes"] }
retention: { plan_readings_days: 120, runs_days: 90, job_runs_per_job: 50, job_output_kb: 64, events_days: 30 }  # events_days applies to the audit table; task history is kept. Only finished runs expire.
```

Secrets (tokens, credentials) never go in config or the DB in plain text; config only points at files.

## 5. Data model (SQLite)

- `machines`, `projects`, `plans` — mirrored from config at start (config wins).
- `plan_readings(id, plan_id, window, used_pct, resets_at, read_at, machine_id, how)` — one row per
  reading. Indexed by (plan_id, window, read_at).
- `tasks(id, short_name, title, status, lane, project_id, assignee, priority, sprint, body, origin,
  external_ref, created_at, updated_at)` — the board. Status: `backlog | todo | doing | review | blocked |
  done`. `external_ref` links an imported card (e.g. `hermes-kanban:gamemaker-claude:t_123`). Imported
  cards are read-only in the UI except for local notes.
- `task_events(id, task_id, at, actor, kind, data_json)` — history (status changes, comments, links).
- `runs(id, machine_id, agent_kind, parent_run_id, role, harness, model, provider, task_id, prompt,
  prompt_ref, project_id, origin, branch, worktree, pid, status, started_at, ended_at, tokens_in,
  tokens_out, tokens_cache_read, tokens_cache_write, cost_note, log_ref, summary)` — one row per agent run.
  `role`: `orchestrator | agent | sub-agent | review`. `agent_kind`: `claude-code | codex | hermes |
  local | other`. Runs are reported by agents through the API and/or discovered by collectors; a discovered
  process and a reported run with the same pid+machine merge.
- `jobs(id, name, schedule, timezone, kind, command, collector_id, enabled, timeout_s, notify, created_by,
  created_at)` and `job_runs(id, job_id, started_at, ended_at, exit_code, output, truncated)`. `kind`:
  `collector | shell`. Shell jobs need a token with the `jobs:shell` scope to create or edit.
- `external_jobs(...)` — read-only mirror of other schedulers (Hermes cron, systemd timers) for one view.
- `documents(id, collection_id, path, title, date, mtime, size, private)` — index only; file contents are
  read from disk on request (never copied into the DB).
- `tokens(id, name, hash, scopes, created_at, last_used_at, revoked_at)`; `audit(id, at, token_name,
  method, path, status)` for every write.

## 6. API (JSON, `/api/v1`)

Read (open on LAN; private documents need a token): `GET /health`, `/config/public`, `/machines`,
`/plans`, `/plans/:id/readings?since=`, `/plans/pace` (see 7), `/tasks?status=&project=&q=`,
`/tasks/:id` (with events and runs), `/runs?active=1&machine=&task=`, `/runs/:id`, `/jobs`,
`/jobs/:id/runs`, `/external-jobs`, `/documents?collection=`, `/documents/:id` (rendered markdown),
`/stats` (DB size, row counts, retention).

Write (token): `POST /plans/:id/readings`, `POST/PATCH /tasks`, `POST /tasks/:id/events`,
`POST /runs` (start), `PATCH /runs/:id` (progress, tokens, end), `POST/PATCH/DELETE /jobs`,
`POST /jobs/:id/run`, `POST /collectors/:id/run`.

Agents should be able to self-report with one curl each at start and end; document those two calls in
`docs/agents.md` with copy-paste examples. Errors: `{error: {code, message}}`. An OpenAPI file
(`docs/openapi.yaml`) is kept in sync and served at `/api/v1/openapi.yaml`.

## 7. Pacing (burndown) logic

For each plan's weekly window: used %, even-pace %, recent rate (last 3 h of readings, else 24 h),
needed rate to reach 100% at `reset - empty_buffer_hours`, projection at reset, and a mode:
`burn` (recent < 0.75 x needed), `steady`, `conserve` (> 1.25 x needed), `stop` (>= 97% used). The mode
maps to a suggested model rung from `models` (burn = top rung, conserve = bottom). Alongside, the
1 h and 2 h rates (from the reading at or just before now minus 1 h / 2 h to the newest reading;
null with a reason unless the readings cover 30 min of that window) are projected to the reset
and reported on the API, charts and cards. They do not change the mode. Port the existing
reference implementation `tools/kaylee-usage/burndown.py` + `plan_reads.py` (see section 11) and keep its
results identical on the same input (unit test with a fixture CSV).

## 8. Pages (tabs)

1. **Overview** — one screen: each plan's gauge (used, even pace, projection, mode, reset countdown),
   agents running now (count by machine/model), board counts by status, jobs that failed in the last 24 h,
   anything marked "needs a person".
2. **Burndown** — per plan: weekly chart (readings, even-pace line, projection, "now"), 5-hour window when
   available, history of past weeks (how much was left unused at each reset), pacing table.
3. **Board** — kanban columns by status with project/assignee filters, swimlanes by agent optional; card
   detail in a side sheet (body, events, linked runs, branch, PR). Sprint/Velocity sub-tabs like the
   reference board.
4. **Agents** — table of runs, default "active now", grouped by machine: agent kind and role (orchestrator
   / agent / sub-agent / review, indented under its parent), model, tokens (in/out/cache), task short name
   + task id (links to the Board card), prompt (first line; full prompt in the detail sheet), duration
   (live), origin & branch & worktree, status. Filters: machine, model, project, role, finished in last
   N hours.
5. **Usage** — tokens per hour/day by plan and model (stacked bars), runs per day, cost notes;
   reference: the existing usage charts (section 11).
6. **Schedules** — middle-manager's own jobs (create/edit/enable/run now, last runs with output) plus the
   read-only mirror of Hermes cron and systemd timers, so every scheduled thing is visible in one place.
7. **Notes** — document collections (ops logs, chat summaries, handoffs, what mattered): list by date,
   rendered markdown, search by title; private collections show a lock until a token is entered.
8. **Connections** — how to connect each plan and model: Claude subscription (Claude Code login on the
   host; what is read and that the token never leaves the host), Codex (ChatGPT login; session logs),
   local models (Ollama / OpenAI-compatible URL), each with a live status check and last reading time.
9. **Settings** — config summary (read-only, with the file path), tokens (list/create/revoke when signed
   in), DB stats and retention, version.

Visual reference (local only, git-ignored; never commit it): `reference/board.html` (Sandbox Sprint Board: IBM Plex Sans/Mono, the color tokens,
status colors, light/dark) and `reference/usage-charts/*.svg`. Bundle IBM Plex locally (OFL; credit it).

## 9. Security notes

- Writes and private reads need a token; the UI asks for a token once and keeps it in localStorage.
- Shell jobs run as the service user with a timeout and an output cap; creating them requires the
  `jobs:shell` scope. Collector jobs run built-in code only.
- Credentials files are read on the host only; their contents are never returned by the API or logged.
- No CORS by default (same origin); `server.cors_origins` opt-in.

## 10. Work plan (slices; each a feature branch + PR, verified before merge)

- **S1 foundation:** repo tooling, config loader + validation, migrations, token CLI + auth middleware,
  `/health`, `/config/public`, `/stats`, retention job, systemd unit, UI shell with the 9 tabs (empty
  states), themes, IBM Plex bundled, Playwright smoke at 3 widths.
- **S2 plans & burndown:** plan collectors (anthropic-oauth, codex-sessions, CSV import of existing
  readings), pacing, Overview gauges, Burndown page.
- **S3 board:** tasks API, Hermes-kanban importer, Board page with side sheet, Sprint/Velocity.
- **S4 agents:** runs API, process-scan collector, Claude Code/Codex/Hermes session token readers, Agents
  page, `docs/agents.md` self-report snippets.
- **S5 schedules:** job scheduler (croner) + job runs, Hermes cron/systemd mirror, Schedules page.
- **S6 notes & connections:** document index + renderer + private gating, Connections page with checks.
- **S7 polish:** Usage page, a11y pass (axe), docs, screenshots in README.

## 11. Reference material

Maintainers keep local, git-ignored reference files in `reference/` (see `reference/SOURCES.md` on the
maintainer's machine): a previous sprint board, usage charts and a Python burndown implementation.

Never copy personal content (what-mattered notes, chat logs, job-search files) into the repo; fixtures
must be synthetic or plan-reading numbers only.
