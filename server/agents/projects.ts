import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { cleanRemote } from './process-scan.ts';
import type { Db } from '../db/index.ts';

/** Config also accepts owner/repo as shorthand for a GitHub remote. */
export function normalizeRepo(remote: string): string | null {
  const value = remote.trim();
  let host: string;
  let path: string;
  if (value.includes('://')) {
    try {
      const url = new URL(value);
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
      host = url.host;
      path = url.pathname.slice(1);
    } catch {
      return null;
    }
  } else {
    const ssh = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(value);
    if (ssh) {
      host = ssh[1]!;
      path = ssh[2]!;
    } else {
      if (!/^[\w-][\w.-]*\/[\w.-]+$/.test(value)) return null;
      host = 'github.com';
      path = value;
    }
  }
  path = path.replace(/\/$/, '').replace(/\.git$/, '');
  return host && path ? host.toLowerCase() + '/' + path : null;
}

export function projectRepos(db: Db) {
  const repos = new Map<string, string>();
  const rows = db
    .prepare('SELECT id, repo FROM projects WHERE in_config = 1 AND repo IS NOT NULL ORDER BY id')
    .all();
  for (const row of rows) {
    const key = normalizeRepo(String(row.repo));
    if (key && !repos.has(key)) repos.set(key, String(row.id));
  }
  return repos;
}

export function worktreeOrigin(worktree: string): string | null {
  if (!isAbsolute(worktree)) return null;
  try {
    return cleanRemote(
      execFileSync('git', ['-C', worktree, 'config', '--local', '--get', 'remote.origin.url'], {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null;
  }
}

export function matchProject(repos: Map<string, string>, origin: string): string | null {
  return repos.get(normalizeRepo(origin) ?? '') ?? null;
}

export function backfillRunProjects(db: Db): void {
  const repos = projectRepos(db);
  const origins = new Map<string, string | null>();
  const rows = db
    .prepare(
      'SELECT id, project_id, origin, worktree FROM runs WHERE origin IS NOT NULL OR worktree IS NOT NULL',
    )
    .all();
  const update = db.prepare('UPDATE runs SET project_id = ?, origin = ? WHERE id = ?');
  for (const row of rows) {
    let origin = row.origin as string | null;
    if (!origin && row.worktree && repos.size) {
      const cwd = String(row.worktree);
      if (!origins.has(cwd)) origins.set(cwd, worktreeOrigin(cwd));
      origin = origins.get(cwd) ?? null;
    }
    if (origin) {
      const project = matchProject(repos, origin);
      if (project !== row.project_id || origin !== row.origin) update.run(project, origin, row.id!);
    }
  }
  db.exec(
    "UPDATE runs SET project_id = NULL WHERE project_id = 'default' AND NOT EXISTS (SELECT 1 FROM projects WHERE in_config = 1 AND id = 'default')",
  );
}
