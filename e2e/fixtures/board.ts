// A synthetic board shaped like a large imported Hermes kanban: 706 cards (backlog 0, todo 53,
// doing 0, review 0, blocked 80, done 573) across two made-up boards. Imported cards carry the
// placeholder project "default"; a few local cards belong to the config project "main".

import type { Db } from '../../server/db/index.ts';

export const BOARD_COUNTS = { backlog: 0, todo: 53, doing: 0, review: 0, blocked: 80, done: 573 };
const HOUR = 3600_000;
const BOARDS = ['alpha-board', 'beta-board'];
const ASSIGNEES = ['worker-a', 'worker-b', 'worker-c', null];

export function seedBoard(db: Db, now = Date.now()): void {
  const insert = db.prepare(
    `INSERT INTO tasks (title,short_name,status,assignee,project_id,sprint,body,origin,external_ref,
       created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let n = 0;
  db.exec('BEGIN');
  for (const [status, count] of Object.entries(BOARD_COUNTS)) {
    for (let i = 0; i < count; i++, n++) {
      // Done cards finish every 5 hours going back ~4 months, so about 67 fall in the last 14 days.
      const updated = now - (status === 'done' ? i * 5 : (i % 40) * 3 + 1) * HOUR;
      const local = status === 'todo' && i < 5;
      const board = BOARDS[n % 2]!;
      insert.run(
        `Synthetic ${status} card ${String(i + 1).padStart(3, '0')}`,
        `S${n + 1}`,
        status,
        ASSIGNEES[n % ASSIGNEES.length] ?? null,
        local ? 'main' : 'default',
        null,
        `Generated card ${n + 1} for the board layout tests.`,
        local ? 'local' : 'hermes-kanban',
        local ? null : `hermes-kanban:${board}:t_${n + 1}`,
        new Date(updated - 24 * HOUR).toISOString(),
        new Date(updated).toISOString(),
      );
    }
  }
  db.exec('COMMIT');
}
