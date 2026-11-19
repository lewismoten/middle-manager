import { readJson, HttpError, type Route } from '../http/app.ts';
import { object, validate, task, atomic, save, invalid } from './tasks.ts';
export const boardRoutes: Route[] = [
  {
    method: 'GET',
    path: '/tasks',
    handler: ({ state, url }) => {
      const clauses: string[] = [],
        args: string[] = [];
      for (const [param, col] of Object.entries({
        status: 'status',
        project: 'project_id',
        assignee: 'assignee',
        sprint: 'sprint',
      })) {
        const value = url.searchParams.get(param);
        if (value) {
          clauses.push(col + '=?');
          args.push(value);
        }
      }
      const q = url.searchParams.get('q');
      if (q) {
        clauses.push(
          '(' +
            ['title', 'short_name', 'body', 'external_ref']
              .map((c) => 'instr(lower(' + c + '),lower(?))>0')
              .join(' OR ') +
            ')',
        );
        args.push(q, q, q, q);
      }
      return state.db
        .prepare(
          'SELECT * FROM tasks ' +
            (clauses.length ? 'WHERE ' + clauses.join(' AND ') : '') +
            ' ORDER BY id DESC',
        )
        .all(...args);
    },
  },
  {
    method: 'GET',
    path: '/tasks/:id',
    handler: ({ state: { db }, params }) => ({
      ...task(db, params.id!),
      events: db
        .prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY at,id')
        .all(params.id!),
      runs: db
        .prepare('SELECT * FROM runs WHERE task_id=? ORDER BY started_at DESC,id DESC')
        .all(params.id!),
    }),
  },
  {
    method: 'POST',
    path: '/tasks',
    handler: async ({ state: { db }, req, token }) => {
      const values = validate(object(await readJson(req)), true);
      return atomic(db, () => save(db, values, token!.name));
    },
  },
  {
    method: 'PATCH',
    path: '/tasks/:id',
    handler: async ({ state: { db }, req, params, token }) => {
      const values = validate(object(await readJson(req)), false);
      return atomic(db, () => {
        const row = task(db, params.id!);
        if (row.external_ref)
          throw new HttpError(409, 'imported_task', 'Imported cards accept local notes only');
        return save(db, values, token!.name, Number(row.id));
      });
    },
  },
  {
    method: 'POST',
    path: '/tasks/:id/events',
    handler: async ({ state: { db }, req, params, token }) => {
      const { kind, data } = object(await readJson(req));
      const row = task(db, params.id!);
      if (typeof kind !== 'string' || !kind.trim() || kind === 'status')
        invalid('Supply an event kind; change status with PATCH');
      if (row.external_ref && !['comment', 'note'].includes(kind))
        throw new HttpError(409, 'imported_task', 'Imported cards accept local notes only');
      const payload = object(data);
      if (
        ['comment', 'note'].includes(kind) &&
        (typeof payload.text !== 'string' || !payload.text.trim())
      )
        invalid('Supply note text');
      return db
        .prepare(
          'INSERT INTO task_events(task_id,at,actor,kind,data_json) VALUES(?,?,?,?,?) RETURNING *',
        )
        .get(params.id!, new Date().toISOString(), token!.name, kind, JSON.stringify(payload));
    },
  },
];
