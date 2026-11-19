import { DatabaseSync } from 'node:sqlite';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expandHome, type Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { HttpError } from '../http/app.ts';
import { atomic, save, statuses, validate, type Values } from './tasks.ts';

const aliases: Record<string, string[]> = {
  id: ['id', 'task_id', 'card_id'],
  title: ['title', 'name'],
  status: ['status', 'column', 'state'],
  body: ['body', 'description', 'detail'],
  assignee: ['assignee', 'assigned_to', 'owner'],
  project_id: ['project_id', 'project'],
  short_name: ['short_name'],
  priority: ['priority'],
  lane: ['lane'],
  sprint: ['sprint'],
};
const equivalents: Record<string, string> = {
  todo: 'todo',
  ondeck: 'todo',
  do: 'doing',
  failed: 'blocked',
  ready: 'todo',
  queued: 'todo',
  open: 'todo',
  in_progress: 'doing',
  running: 'doing',
  active: 'doing',
  in_review: 'review',
  completed: 'done',
  closed: 'done',
  pending: 'backlog',
  triage: 'backlog',
  archived: 'done',
};
export function importBoards(db: Db, root: string) {
  let boards = 0,
    cards = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, entry.name, 'kanban.db');
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const uri = pathToFileURL(file);
    uri.searchParams.set('mode', 'ro');
    const source = new DatabaseSync(uri.href, { readOnly: true });
    try {
      const tables = source.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all();
      const table = ['tasks', 'cards'].find((t) => tables.some((row) => row.name === t));
      if (!table) throw new Error('No tasks or cards table in ' + entry.name);
      const columns = source
        .prepare('SELECT name FROM pragma_table_info(?)')
        .all(table)
        .map((row) => String(row.name));
      const mapping = Object.fromEntries(
        Object.entries(aliases).map(([key, names]) => [
          key,
          names.find((name) => columns.includes(name)),
        ]),
      );
      if (!mapping.id || !mapping.title)
        throw new Error('Missing card identity or title in ' + entry.name);
      atomic(db, () => {
        for (const row of source.prepare('SELECT * FROM ' + table).iterate()) {
          const values: Values = {};
          for (const [key, col] of Object.entries(mapping)) {
            if (!col || key === 'id') continue;
            const value = row[col];
            values[key] = value == null ? null : key === 'priority' ? Number(value) : String(value);
          }
          const raw = String(values.status ?? 'backlog')
            .toLowerCase()
            .replace(/[ -]/g, '_');
          values.status = statuses.includes(raw) ? raw : (equivalents[raw] ?? raw);
          validate(values, true);
          const identity = row[mapping.id!];
          if (identity == null || identity === '') throw new Error('Missing card id');
          const ref = 'hermes-kanban:' + entry.name + ':' + identity;
          const existing = db.prepare('SELECT id FROM tasks WHERE external_ref=?').get(ref);
          const task = save(
            db,
            values,
            'hermes-kanban',
            existing ? Number(existing.id) : undefined,
            ref,
          );
          if (columns.some((c) => ['branch', 'pr', 'pr_url', 'pull_request_url'].includes(c))) {
            const links = JSON.stringify({
              branch: row.branch ?? null,
              pr: row.pr_url ?? row.pull_request_url ?? row.pr ?? null,
            });
            const last = db
              .prepare(
                "SELECT data_json FROM task_events WHERE task_id=? AND kind='link' AND actor='hermes-kanban' ORDER BY id DESC LIMIT 1",
              )
              .get(task.id!);
            if (
              last?.data_json !== links &&
              (last || row.branch || row.pr_url || row.pull_request_url || row.pr)
            ) {
              db.prepare(
                "INSERT INTO task_events(task_id,at,actor,kind,data_json) VALUES(?,?,'hermes-kanban','link',?)",
              ).run(task.id!, new Date().toISOString(), links);
            }
          }
          cards++;
        }
      });
      boards++;
    } finally {
      source.close();
    }
  }
  return { boards, cards };
}
export function runCollector(db: Db, config: Config, id: string) {
  const col = config.collectors.find((c) => c.id === id);
  if (!col || col.kind !== 'hermes-kanban')
    throw new HttpError(404, 'not_found', 'Board collector not found');
  if (typeof col.path !== 'string' || !col.path)
    throw new HttpError(400, 'collector_config', 'Board collector needs a path');
  return importBoards(db, expandHome(col.path));
}
