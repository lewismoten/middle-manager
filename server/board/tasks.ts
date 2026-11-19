import type { Db } from '../db/index.ts';
import { HttpError } from '../http/app.ts';

export const statuses = ['backlog', 'todo', 'doing', 'review', 'blocked', 'done'];
export const fields = [
  'title',
  'short_name',
  'status',
  'project_id',
  'assignee',
  'priority',
  'lane',
  'sprint',
  'body',
];
export type Values = Record<string, string | number | null>;
export function invalid(message: string): never {
  throw new HttpError(400, 'invalid_input', message);
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('Expected a JSON object');
  return value as Record<string, unknown>;
}
export function validate(raw: Record<string, unknown>, create: boolean): Values {
  if (create && !raw.title) invalid('A title is required');
  if (!Object.keys(raw).length) invalid('Supply task fields');
  for (const [key, value] of Object.entries(raw)) {
    if (!fields.includes(key)) invalid('Unknown task field: ' + key);
    if (
      key === 'priority'
        ? value !== null && !Number.isSafeInteger(value)
        : value !== null && typeof value !== 'string'
    )
      invalid('Invalid ' + key);
    if (key === 'title' && (typeof value !== 'string' || !value.trim()))
      invalid('A title is required');
    if (key === 'status' && !statuses.includes(String(value))) invalid('Unknown status');
  }
  return raw as Values;
}
export function task(db: Db, id: string | number) {
  const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!row) throw new HttpError(404, 'not_found', 'Task not found');
  return row;
}
export function atomic<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function save(db: Db, values: Values, actor: string, id?: number, ref?: string) {
  const now = new Date().toISOString();
  const previous = id === undefined ? undefined : task(db, id);
  const keys = Object.keys(values);
  if (previous && keys.every((k) => previous[k] === values[k])) return previous;
  if (previous) {
    db.prepare(
      'UPDATE tasks SET ' + keys.map((k) => k + '=?').join(',') + ',updated_at=? WHERE id=?',
    ).run(...Object.values(values), now, id!);
  } else {
    id = Number(
      db
        .prepare(
          'INSERT INTO tasks (' +
            [...keys, 'origin', 'external_ref', 'created_at', 'updated_at'].join(',') +
            ') VALUES (' +
            Array(keys.length + 4)
              .fill('?')
              .join(',') +
            ')',
        )
        .run(...Object.values(values), ref ? 'hermes-kanban' : 'local', ref ?? null, now, now)
        .lastInsertRowid,
    );
  }
  const result = task(db, id!);
  if (previous?.status !== result.status)
    db.prepare(
      "INSERT INTO task_events(task_id,at,actor,kind,data_json) VALUES(?,?,?,'status',?)",
    ).run(id!, now, actor, JSON.stringify({ from: previous?.status ?? null, to: result.status }));
  return result;
}
