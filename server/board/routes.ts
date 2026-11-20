import { readJson, sendJson, HttpError, type Route } from '../http/app.ts';
import { object, validate, task, atomic, save, invalid } from './tasks.ts';
const eligible = `tasks.status='todo' AND claimed_by IS NULL AND external_ref IS NULL
  AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks parent ON parent.id=d.depends_on
    WHERE d.task_id=tasks.id AND parent.status!='done')`;

function checkQuery(url: URL, allowed: string[]) {
  for (const key of url.searchParams.keys())
    if (!allowed.includes(key)) invalid('Unknown query parameter: ' + key);
}
function pageNumber(url: URL, key: string, fallback: number) {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) invalid('Invalid ' + key);
  return Number(raw);
}
export const boardRoutes: Route[] = [
  {
    method: 'GET',
    path: '/tasks',
    handler: ({ state, url }) => {
      checkQuery(url, [
        'status',
        'project',
        'assignee',
        'sprint',
        'q',
        'limit',
        'offset',
        'include_body',
      ]);
      const includeBody = url.searchParams.get('include_body');
      if (includeBody !== null && includeBody !== '1') invalid('Invalid include_body');
      const columns = `id,short_name,title,status,lane,project_id,assignee,priority,sprint,origin,
        external_ref,created_at,updated_at,source_created_at,status_since,claimed_by,
        rtrim(substr(substr(body,1,256),1,instr(substr(body,1,256)||char(10),char(10))-1),char(13)) AS body_first_line`;
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
          'SELECT ' +
            columns +
            (includeBody ? ',body' : '') +
            ' FROM tasks ' +
            (clauses.length ? 'WHERE ' + clauses.join(' AND ') : '') +
            ' ORDER BY id DESC LIMIT ? OFFSET ?',
        )
        .all(...args, pageNumber(url, 'limit', 200), pageNumber(url, 'offset', 0));
    },
  },
  {
    method: 'GET',
    path: '/tasks/next',
    handler: ({ state: { db }, url, res }) => {
      checkQuery(url, ['project', 'assignee']);
      const project = url.searchParams.get('project') || null,
        assignee = url.searchParams.get('assignee') || null;
      const row = db
        .prepare(
          `SELECT * FROM tasks WHERE ${eligible}
        AND (? IS NULL OR project_id=?) AND (? IS NULL OR assignee=?)
        ORDER BY priority ASC NULLS LAST,julianday(coalesce(status_since,source_created_at,updated_at)) DESC,id DESC LIMIT 1`,
        )
        .get(project, project, assignee, assignee);
      if (row) return row;
      res.writeHead(204);
      res.end();
    },
  },
  {
    method: 'POST',
    path: '/tasks/:id/claim',
    handler: async ({ state: { db }, url, res, req, token, params }) => {
      checkQuery(url, []);
      const raw = await readJson(req);
      const input = raw === undefined ? {} : object(raw);
      const actor = token!.name;
      for (const key of Object.keys(input))
        if (!['assignee', 'run_id'].includes(key)) invalid('Unknown claim field: ' + key);
      if (input.assignee !== undefined && input.assignee !== actor)
        invalid('Assignee must match token name');
      const run = input.run_id;
      if (run !== undefined && (typeof run !== 'number' || !Number.isSafeInteger(run) || run < 1))
        invalid('Invalid run_id');
      const id = params.id!;
      const row = atomic(db, () => {
        const now = new Date().toISOString();
        const claimed = db
          .prepare(
            `UPDATE tasks SET status='doing',assignee=?,claimed_by=?,updated_at=?,status_since=?
          WHERE id=? AND ${eligible} RETURNING *`,
          )
          .get(actor, actor, now, now, id);
        if (!claimed) {
          task(db, id);
          throw new HttpError(409, 'conflict', 'Task is unavailable');
        }
        if (
          typeof run === 'number' &&
          !db
            .prepare('UPDATE runs SET task_id=? WHERE id=? AND (task_id IS NULL OR task_id=?)')
            .run(id, run, id).changes
        )
          throw new HttpError(409, 'conflict', 'Run unavailable');
        db.prepare(
          "INSERT INTO task_events(task_id,at,actor,kind,data_json) VALUES(?,?,?,'status',?)",
        ).run(id, now, actor, JSON.stringify({ from: 'todo', to: 'doing' }));
        return claimed;
      });
      sendJson(res, 200, row);
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
