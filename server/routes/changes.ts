import type { Changes } from '../../shared/changes.ts';
import type { Db } from '../db/index.ts';
import { HttpError, type Route } from '../http/app.ts';
import { isoTime } from '../plans/store.ts';

function changes(db: Db, since: string, now: string): Changes {
  function list<T>(sql: string, order: string) {
    const rows = db
      .prepare(
        `SELECT *, count(*) OVER () AS total FROM (${sql})
      ORDER BY ${order}, id LIMIT 20`,
      )
      .all({ since, now });
    return {
      total: Number(rows[0]?.total ?? 0),
      items: rows.map((row) => {
        delete row.total;
        return row as T;
      }),
    };
  }
  return {
    now,
    runs: list(
      `SELECT id,status,ended_at FROM runs WHERE status IN ('done','ended','failed')
      AND ended_at > $since AND ended_at <= $now`,
      'ended_at DESC',
    ),
    cards: list(
      `SELECT t.id,t.title,max(e.at) AS moved_at FROM task_events e JOIN tasks t ON t.id=e.task_id
      WHERE e.kind='status' AND e.at > $since AND e.at <= $now
      AND json_extract(e.data_json,'$.from') IS NOT NULL
      AND json_extract(e.data_json,'$.from') <> json_extract(e.data_json,'$.to')
      GROUP BY t.id`,
      'moved_at DESC',
    ),
    jobs: list(
      `WITH recent AS (
      SELECT id,job_id,ended_at,exit_code FROM job_runs
      WHERE ended_at > $since AND ended_at <= $now AND exit_code IS NOT NULL
    ), relevant AS (
      SELECT * FROM recent
      UNION ALL
      SELECT b.id,b.job_id,b.ended_at,b.exit_code FROM (SELECT DISTINCT job_id FROM recent) j
      JOIN job_runs b ON b.id=(SELECT id FROM job_runs WHERE job_id=j.job_id
        AND ended_at <= $since AND exit_code IS NOT NULL ORDER BY ended_at DESC,id DESC LIMIT 1)
    ), history AS (
      SELECT job_id,ended_at,id,exit_code,
        lag(exit_code) OVER (PARTITION BY job_id ORDER BY ended_at,id) AS previous
      FROM relevant
    ), transitions AS (
      SELECT *,row_number() OVER (PARTITION BY job_id ORDER BY ended_at DESC,id DESC) AS position
      FROM history WHERE previous IS NULL OR (previous=0) <> (exit_code=0)
    )
    SELECT j.id,j.name,t.ended_at AS failing_since FROM transitions t JOIN jobs j ON j.id=t.job_id
    WHERE position=1 AND exit_code<>0 AND ended_at > $since`,
      'failing_since DESC',
    ),
    plans: list(
      `WITH configured AS (
      SELECT id,name,CASE WHEN EXISTS (SELECT 1 FROM json_each(windows) WHERE value='weekly')
        THEN 'weekly' ELSE json_extract(windows,'$[0]') END AS window FROM plans WHERE in_config=1
    )
    SELECT p.id,p.name,p.window,b.used_pct AS previous_pct,a.used_pct FROM configured p
    JOIN plan_readings b ON b.id=(SELECT id FROM plan_readings WHERE plan_id=p.id AND window=p.window
      AND read_at <= $since ORDER BY read_at DESC,id DESC LIMIT 1)
    JOIN plan_readings a ON a.id=(SELECT id FROM plan_readings WHERE plan_id=p.id AND window=p.window
      AND read_at <= $now ORDER BY read_at DESC,id DESC LIMIT 1)
    WHERE a.read_at > $since AND a.used_pct <> b.used_pct`,
      'name',
    ),
  };
}

export const changesRoute: Route = {
  method: 'GET',
  path: '/changes',
  handler: ({ state, url }) => {
    let since: string;
    try {
      since = isoTime(url.searchParams.get('since'), 'since');
    } catch (error) {
      throw new HttpError(400, 'bad_request', (error as Error).message);
    }
    return changes(state.db, since, new Date().toISOString());
  },
};
