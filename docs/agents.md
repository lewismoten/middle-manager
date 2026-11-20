# Reporting agent runs

The Agents page shows every agent run: which machine, harness and model, which task, how many
tokens, how long, and on which branch. Runs get there in two ways, and both can be used at once:

1. **The agent reports itself** with one `curl` when it starts and one when it ends (below).
2. **Collectors find it** on the machine that hosts middle-manager: `process-scan` (running
   processes), `systemd-workers` (transient user units) and `session-tokens` (token totals from
   Claude Code and Codex session logs). See [Collectors](#collectors).

A reported run and a discovered process with the same `machine_id` + `pid` are merged into one run.

## Before you start

Create a token with the `write` scope on the server, and give it to the agent's environment:

```sh
npx middle-manager token create lead-agent
export MM_URL=http://your-server:4747   # where middle-manager listens
export MM_TOKEN=mm_...                  # the token printed above
```

Reading is open on your network; every write needs `Authorization: Bearer $MM_TOKEN`.

## Start: one call

```sh
RUN_ID=$(curl -fsS -X POST "$MM_URL/api/v1/runs" \
  -H "Authorization: Bearer $MM_TOKEN" -H 'Content-Type: application/json' \
  -d '{"machine_id":"server-1","agent_kind":"claude-code","role":"agent","model":"sonnet",
       "task":"login-fix","project_id":"main","branch":"feature/login-fix",
       "prompt":"Fix the login redirect"}' | sed -E 's/^\{"id":([0-9]+).*/\1/')
echo "run $RUN_ID"
```

The response is the run as JSON, starting with `"id"`; the `sed` keeps just the id. With `jq`
installed, `| jq -r .id` does the same.

## End: one call

```sh
curl -fsS -X PATCH "$MM_URL/api/v1/runs/$RUN_ID" \
  -H "Authorization: Bearer $MM_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"done","summary":"Fixed; PR opened"}'
```

`status` is one of `done`, `failed` or `cancelled`. `ended_at` is set to now unless you send it.
Sending `{"end": true}` alone is the same as `{"status": "done"}`.

## Progress (optional)

Use the same `PATCH` to update the model or summary. Omit token counts from agent reports.
The `session-tokens` collector reads totals from the harness session log.

```sh
curl -fsS -X PATCH "$MM_URL/api/v1/runs/$RUN_ID" \
  -H "Authorization: Bearer $MM_TOKEN" -H 'Content-Type: application/json' \
  -d '{"summary":"Tests written, fixing now"}'
```

## Sub-agents

Pass the parent's id. The role defaults to `sub-agent`; use `review` for a reviewer.

```sh
curl -fsS -X POST "$MM_URL/api/v1/runs" \
  -H "Authorization: Bearer $MM_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"machine_id\":\"server-1\",\"agent_kind\":\"codex\",\"parent_run_id\":$RUN_ID,\"role\":\"review\",\"prompt\":\"Review the fix\"}"
```

Roles: `orchestrator`, `agent`, `sub-agent`, `review`.

## Fields

| Field                                                                | Notes                                                                                                                            |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `machine_id`                                                         | Id from `machines` in the config (free text is accepted too).                                                                    |
| `agent_kind`                                                         | `claude-code`, `codex`, `hermes`, `local` or `other`.                                                                            |
| `role`                                                               | `orchestrator`, `agent` (default), `sub-agent`, `review`.                                                                        |
| `parent_run_id`                                                      | Id of the run that started this one. Must exist.                                                                                 |
| `model`, `provider`, `harness`                                       | Free text.                                                                                                                       |
| `task` or `task_id`                                                  | A task id, or its short name or external ref. An unknown task is dropped with a warning in the response; the run is still saved. |
| `project_id`, `origin`, `branch`, `worktree`                         | Where the work happens.                                                                                                          |
| `prompt`                                                             | Full prompt (up to 64 KB). The list shows the first line; the detail sheet shows all of it.                                      |
| `prompt_ref`, `log_ref`                                              | Pointers. `log_ref` like `claude-code:<session-id>` or `codex:<session-id>` lets `session-tokens` fill in token totals.          |
| `pid`                                                                | Process id of the agent on `machine_id`; lets a collector merge and end it.                                                      |
| `started_at`, `ended_at`                                             | ISO 8601 or epoch milliseconds. `started_at` defaults to now.                                                                    |
| `tokens_in`, `tokens_out`, `tokens_cache_read`, `tokens_cache_write` | Totals. Or `tokens: {in, out, cache_read, cache_write}`.                                                                         |
| `status`                                                             | `running`, `done`, `failed`, `cancelled`, `ended` (`ended` = vanished, outcome unknown).                                         |
| `summary`, `cost_note`                                               | Free text.                                                                                                                       |

Unknown fields are rejected (`400`), so a typo does not disappear silently. Errors look like
`{"error": {"code": "invalid", "message": "..."}}`.

## Reading

```sh
curl -fsS "$MM_URL/api/v1/runs?active=1"                       # running now
curl -fsS "$MM_URL/api/v1/runs?finished_within_h=6&machine=server-1"
curl -fsS "$MM_URL/api/v1/runs?task=login-fix&role=review"
curl -fsS "$MM_URL/api/v1/runs/$RUN_ID"                        # full prompt, parent, sub-agents
```

Read `pid` and `machine_id` from a matching run in `GET /api/v1/runs?active=1` or from
`GET /api/v1/runs/{id}`. A null pid means the process ID is unknown.

Filters: `active`, `finished` (1 or true for closed runs, 0 or false for open runs), `finished_within_h` (running plus finished in the last N hours), `machine`,
`task` (id or short name), `model`, `project`, `role`, `kind`, `status`, `parent`, `limit`
(default 500, max 2000). The list returns `prompt_first_line` instead of the full prompt.

Unknown query keys and invalid filter values return 400. Task listings accept board statuses
(backlog, todo, doing, review, blocked, done). Role and kind belong to agent runs.
Use `/plans/pace?plan=ID&model=MODEL` to select plans by configured ID and model.

Each plan's `weekly` object also has `projection_1h` and `projection_2h`: the burn rate over the
last 1 or 2 hours and where it leads (`projected_pct` at the reset, or `runs_out_at` if sooner).
They react faster than `rate_pct_per_h` when the burn changes, but the pacing mode and the
suggested model still use `rate_pct_per_h`. When there are not enough readings (they must cover
30 minutes of the window), the numbers are null and `reason` is `short_span`,
`no_recent_readings` or `window_ended`, with `reason_text` explaining it:

```sh
curl -fsS "$MM_URL/api/v1/plans/pace?plan=claude" | jq '.plans[0].weekly.projection_2h'
# { "window_h": 2, "rate_pct_per_h": 1.42, "projected_pct": 97.3, "runs_out_at": null, ... }
```

Past weeks: `GET /plans/{id}/windows` lists a plan's weekly windows, newest first (the current
one first, unless `current=0`; `limit` 1-200, default 52). Each has its start and reset, final
and peak used %, whether and when it ran out, `unused_h` (what was left, in hours of even-pace
use), the gap from the target and `mean_abs_vs_even_pct` (how far it strayed from even pace;
lower is steadier). Readings are grouped by reset time with a 3 h tolerance, because providers
report the reset with jitter. `GET /plans/{id}/windows/{window}` returns one window and its
readings; `window` is `current` or the window's `id` (its reset time):

```sh
curl -fsS "$MM_URL/api/v1/plans/claude/windows?current=0&limit=4" \
  | jq '.windows[] | {id, final_pct, ran_out_at, unused_h, mean_abs_vs_even_pct}'
curl -fsS "$MM_URL/api/v1/plans/claude/windows/2026-11-13T23:00:00.000Z" | jq '.readings | length'
```

External jobs accept `kind` (hermes-cron or systemd-timers) and `status` (running, ok, failed, error).

## Collectors

Collectors run inside middle-manager every `every_s` seconds (default 30), on the machine that
hosts it, and record runs under the collector's `machine` (default: the first machine in the
config). Run them now with `POST /api/v1/runs/scan` (needs a token).

```yaml
collectors:
  - { id: processes, kind: process-scan, match: ['codex exec', 'claude -p'] }
  - { id: workers, kind: systemd-workers, prefix: 'worker-' }
  - { id: tokens, kind: session-tokens }
```

**process-scan** looks for processes whose command line contains one of the `match` patterns
(a pattern can also be `{ pattern, kind, role }`). For each it records the pid, command, start
time and working directory, plus the git branch, origin (credentials removed) and worktree of
that directory. A shell or `timeout` wrapper is folded into the agent it starts; an agent started
by another matched agent becomes its sub-agent. When a process is gone, its run is marked
`ended`; this also applies to reported runs that sent a `pid`.

**systemd-workers** lists user units named `<prefix>*` (for example agents started with
`systemd-run --user --unit worker-fix-login ...`) and records the unit name, state, start time,
main pid and working directory. A failed unit's run is marked `failed`; a unit that disappears is
marked `ended`.

Both read the model from the agent's own flags: `-m`/`--model`/`--model=` (and Codex
`-c model=...`), looking inside `bash -c` wrappers and systemd's escaped command lines. When the
command line names no model, they take it from the run's session log (Codex `turn_context`,
Claude Code assistant messages), using the same `claude_dir`/`codex_dir` options as
`session-tokens`.

**session-tokens** sums token usage for open runs (and runs that ended in the last 15 minutes)
from the harness's own session logs on this host:

- Claude Code: `~/.claude/projects/<project>/<session>.jsonl`, the `usage` of each assistant
  message, counted once per message. Option `claude_dir`.
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, the last `token_count` total (cached
  input is reported as cache read). Option `codex_dir` (default: the `codex-sessions` plan's
  `sessions_dir`).

It finds the session from `log_ref` when given; otherwise it matches the run's worktree and start
time and gives up when more than one session fits. Totals only grow: a reported number is never
lowered by a smaller one read from a log.

Adding another harness: write a `TokenReader` in `server/agents/tokens.ts` (how to find the
session file, and how to fold one JSONL line into totals) and add it to `TOKEN_READERS`.

Use `GET /api/v1/tasks/next` to find an eligible local todo card, optionally filtering by
`project` and `assignee`. An empty queue returns 204. POST to `/api/v1/tasks/{id}/claim`
with your write bearer token and, if running under a reported run, JSON `{"run_id":23}`.
A 200 moves the card to Doing under your token name. A 409 means the card or run is
unavailable. Task listings accept `limit` (default 200) and `offset` (default 0) and
return `body_first_line` (up to 256 characters). Fetch task details for the full body.
