# Installing middle-manager

middle-manager runs as one Node process with one SQLite file. These steps set it up on a Linux
host as a systemd **user** service.

## Requirements

- Node.js 22.18 or newer (the server runs its TypeScript sources directly and uses the built-in
  `node:sqlite`). Check with `node --version`.
- git and npm.

## 1. Clone and install

```sh
git clone https://github.com/<owner>/middle-manager.git ~/middle-manager
cd ~/middle-manager
npm ci
npm run build          # builds the web UI into dist/web
```

## 2. Write your config

```sh
cp config/middle-manager.example.yaml config/middle-manager.yaml
$EDITOR config/middle-manager.yaml
```

`config/middle-manager.yaml` is git-ignored. Set at least `site.name`; list your machines, plans,
projects and document folders. Paths may start with `~`. Secrets never go in the config: plans
point at credential files that stay on the host.

If the config has a mistake, the server and CLI refuse to start and list every problem with the
key that caused it, for example:

```
Invalid config /home/me/middle-manager/config/middle-manager.yaml:
  - plans[0].provider: must be one of: anthropic-oauth, codex-sessions, manual (got "claude")
  - models.codx: no plan with id "codx" (plans: claude, codex)
```

## 3. Create a token

Anyone who can reach the server can read. Every change needs a token:

```sh
npx middle-manager token create laptop               # scope: write
npx middle-manager token create agent-lead --scopes write,jobs:shell
npx middle-manager token list
npx middle-manager token revoke laptop
```

The token is printed once; only its SHA-256 hash is stored. Use it as
`Authorization: Bearer <token>`, or paste it into **Sign in** in the web UI (it is kept in that
browser's localStorage).

Scopes: `write` (ordinary writes), `jobs:shell` (create or edit shell jobs), `admin` (manage
tokens from the UI; implies the others).

`npm run cli -- token list` does the same as `npx middle-manager token list`.

## 4. Run it

```sh
npm start              # serves the UI and the API on server.host:server.port
```

Then open `http://<host>:<port>/`. Check it from another shell:

```sh
curl http://localhost:4747/api/v1/health
```

Other commands: `npx middle-manager db migrate` (migrations also run at start) and
`npx middle-manager db stats` (database size and row counts).

## 5. Run it as a service

```sh
mkdir -p ~/.config/systemd/user
cp deploy/middle-manager.service ~/.config/systemd/user/
$EDITOR ~/.config/systemd/user/middle-manager.service   # WorkingDirectory, path to node
systemctl --user daemon-reload
systemctl --user enable --now middle-manager
loginctl enable-linger "$USER"   # keep running after you log out
journalctl --user -u middle-manager -f
```

The unit restarts on failure, caps memory at 512 MB and logs only to journald.

## Upgrading

```sh
cd ~/middle-manager
git pull
npm ci
npm run build
systemctl --user restart middle-manager   # pending migrations apply at start
```

## Data and retention

The database is `data/middle-manager.db` (git-ignored; change it with `database.path`). A
built-in job runs at start and daily to apply the `retention` rules from the config: old plan
readings, finished runs, job runs past the per-job cap and old audit rows are deleted, and job
output over the size cap is cut. The Settings page shows database size and row counts.

## Development

```sh
npm run dev        # API on 127.0.0.1:6181 with reload, UI on http://localhost:6180
npm run check      # format check, lint, typecheck, unit tests
npm run test:e2e   # builds, then runs the Playwright smoke test on port 6147
```

`npm run dev` uses `config/middle-manager.yaml` (or `$MM_CONFIG`) but listens on `MM_PORT`
(default 6181), so it does not collide with an installed service.
