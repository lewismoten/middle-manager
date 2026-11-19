# middle-manager

_It watches others work, schedules meetings, and reports the burn._

A self-hosted dashboard and JSON API for keeping an eye on a fleet of AI coding agents:

- **Burndown**: how much of each subscription (Claude, Codex, ...) is used, whether it will run out
  before the reset, and which model tier agents should use to burn it evenly.
- **Board**: the work, as kanban cards with history, linked runs and branches.
- **Agents**: every agent run on every machine: model, tokens, task, prompt, duration, branch, and
  whether it is an orchestrator, agent or sub-agent.
- **Schedules**: cron jobs that collect usage and run checks, plus a view of other schedulers.
- **Notes**: ops logs, chat summaries and handoffs, rendered from markdown folders.

Runs as one Node process with one SQLite file. Anyone on your network can read; changes need an API
token. Machines, plans, models and folders all come from a config file, so you can point it at your
own setup.

Status: early development. See [SPEC.md](SPEC.md).

## License

MIT
