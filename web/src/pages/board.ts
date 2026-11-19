import { api, type PublicConfig } from '../api.ts';
import { h } from '../dom.ts';
import './board.css';

const statuses = ['backlog', 'todo', 'doing', 'review', 'blocked', 'done'];
interface Task {
  id: number;
  title: string;
  short_name: string | null;
  body: string | null;
  project_id: string | null;
  status: string;
  assignee: string | null;
  lane: string | null;
  sprint: string | null;
  priority: number | null;
  external_ref: string | null;
}
interface Detail extends Task {
  events: { actor: string; at: string; kind: string; data_json: string | null }[];
  runs: { id: number; agent_kind: string; branch: string | null; status: string }[];
}
const caption = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function button(label: string, action: () => void) {
  const b = h('button', { type: 'button' }, label);
  b.onclick = action;
  return b;
}
function select(label: string, values: string[], all?: string) {
  return h(
    'select',
    { 'aria-label': label },
    ...(all ? [h('option', { value: '' }, all)] : []),
    ...values.map((v) => h('option', { value: v }, v)),
  );
}
function markdown(body: string) {
  const box = h('div', { class: 'card-markdown' });
  let list: HTMLUListElement | undefined;
  for (const line of body.split(/\r?\n/)) {
    const item = /^[-*] /.test(line),
      heading = /^(#{1,3}) /.exec(line);
    const block = item ? h('li') : heading ? h('h3') : h('p');
    if (item) {
      if (!list) {
        list = h('ul');
        box.append(list);
      }
      list.append(block);
    } else {
      list = undefined;
      box.append(block);
    }
    const content = line.replace(/^(?:#{1,3}|[-*]) /, '');
    for (const part of content.split(
      /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g,
    )) {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
      block.append(
        link
          ? h('a', { href: link[2] }, link[1])
          : part.startsWith('**') && part.endsWith('**')
            ? h('strong', {}, part.slice(2, -2))
            : part.startsWith('`') && part.endsWith('`')
              ? h('code', {}, part.slice(1, -1))
              : part.startsWith('*') && part.endsWith('*')
                ? h('em', {}, part.slice(1, -1))
                : part,
      );
    }
  }
  return box;
}
export function board(canWrite: boolean, projects: PublicConfig['projects']) {
  const root = h('section', { class: 'board-page' }),
    panel = h('div', { class: 'board-scroll' }),
    bar = h('div', { class: 'board-tools' }),
    tabs = h('div', { class: 'row' });
  const query = h('input', {
    type: 'search',
    'aria-label': 'Search cards',
    placeholder: 'Search cards',
  });
  const project = select('Project', [], 'All projects'),
    agent = select('Assignee', [], 'All assignees'),
    lanes = h('input', { type: 'checkbox' });
  const notice = h('div', { role: 'alert' }),
    sheet = h('dialog', { class: 'sheet board-sheet', 'aria-label': 'Card details' });
  const close = button('Close', () => sheet.close());
  const body = h('div', { class: 'body' });
  sheet.append(close, body);
  let tasks: Task[] = [],
    view = 'Board';
  const fail = (err: unknown) => {
    const message = (err as Error).message;
    if (sheet.open) body.append(h('p', { role: 'alert' }, message));
    else notice.textContent = message;
  };
  const show = () => {
    if (!sheet.open) sheet.showModal();
  };
  const write = (path: string, method: string, payload: unknown) =>
    api<Task>(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  function edit(t?: Task) {
    const form = h('form', { class: 'board-form' });
    const controls = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
    for (const k of [
      'title',
      'short_name',
      'status',
      'project_id',
      'assignee',
      'priority',
      'sprint',
      'lane',
      'body',
    ] as const) {
      const control =
        k === 'body'
          ? h('textarea', { rows: 6 })
          : k === 'status'
            ? select('Status', statuses)
            : h('input', { type: k === 'priority' ? 'number' : 'text', required: k === 'title' });
      control.value = String(t?.[k] ?? (k === 'status' ? 'backlog' : ''));
      controls.set(k, control);
      form.append(h('label', {}, caption(k.replace('_', ' ')), control));
    }
    const submit = h('button', { type: 'submit', class: 'primary' }, 'Save card');
    form.append(submit);
    form.onsubmit = (e) => {
      e.preventDefault();
      submit.disabled = true;
      const values = Object.fromEntries(
        [...controls].map(([k, c]) => [
          k,
          c.value ? (k === 'priority' ? Number(c.value) : c.value) : null,
        ]),
      );
      void write(t ? '/tasks/' + t.id : '/tasks', t ? 'PATCH' : 'POST', values)
        .then(async (saved) => {
          await load();
          await detail(saved.id);
        })
        .catch(fail)
        .finally(() => (submit.disabled = false));
    };
    body.replaceChildren(h('h2', {}, t ? 'Edit card' : 'Create card'), form);
    show();
  }
  async function detail(id: number) {
    const t = await api<Detail>('/tasks/' + id);
    if (!root.isConnected) return;
    body.replaceChildren(
      h('h2', {}, t.title),
      h(
        'p',
        { class: 'muted' },
        [t.short_name, t.status, t.project_id, t.assignee, t.sprint, t.external_ref]
          .filter(Boolean)
          .join(' · '),
      ),
      markdown(t.body ?? ''),
    );
    if (canWrite && !t.external_ref) body.append(button('Edit card', () => edit(t)));
    body.append(h('h3', {}, 'Linked runs'));
    for (const run of t.runs)
      body.append(
        h(
          'p',
          {},
          '#' + run.id + ' · ' + run.agent_kind + ' · ' + run.status,
          run.branch ? ' · Branch ' + run.branch : '',
        ),
      );
    if (!t.runs.length) body.append(h('p', { class: 'muted' }, 'No linked runs'));
    body.append(h('h3', {}, 'History'));
    for (const event of t.events) {
      const data = JSON.parse(event.data_json ?? '{}') ?? {};
      const entry = h(
        'div',
        { class: 'board-event' },
        h('small', {}, event.at + ' · ' + event.actor),
        h(
          'p',
          {},
          event.kind === 'status'
            ? [data.from, data.to].filter(Boolean).join(' → ')
            : String(data.text ?? event.kind),
        ),
      );
      for (const key of ['branch', 'pr', 'url'])
        if (typeof data[key] === 'string')
          entry.append(
            /^https?:\/\//i.test(data[key])
              ? h('a', { href: data[key] }, key === 'pr' ? 'Pull request' : data[key])
              : h('span', {}, key + ' ' + data[key]),
          );
      body.append(entry);
    }
    if (canWrite) {
      const note = h('textarea', { 'aria-label': 'Local note', required: true });
      const submit = h('button', { type: 'submit' }, 'Add note');
      const form = h('form', { class: 'board-form' }, note, submit);
      form.onsubmit = (e) => {
        e.preventDefault();
        submit.disabled = true;
        void write('/tasks/' + id + '/events', 'POST', {
          kind: 'comment',
          data: { text: note.value },
        })
          .then(() => detail(id))
          .catch(fail)
          .finally(() => (submit.disabled = false));
      };
      body.append(form);
    }
    show();
  }
  const card = (t: Task) => {
    const b = button(t.title, () => void detail(t.id).catch(fail));
    b.className = 'board-card';
    b.prepend(h('small', {}, t.short_name ?? '#' + t.id));
    b.append(h('small', {}, [t.project_id, t.assignee].filter(Boolean).join(' · ')));
    return b;
  };
  function draw() {
    panel.replaceChildren();
    const rows = tasks.filter(
      (t) =>
        (!project.value || t.project_id === project.value) &&
        (!agent.value || t.assignee === agent.value) &&
        [t.title, t.short_name, t.body, t.external_ref].some((s) =>
          s?.toLowerCase().includes(query.value.toLowerCase()),
        ),
    );
    for (const b of tabs.querySelectorAll('button'))
      b.setAttribute('aria-pressed', String(b.textContent === view));
    if (view === 'Board') {
      for (const name of lanes.checked ? [...new Set(rows.map((t) => t.assignee))] : [null]) {
        if (lanes.checked) panel.append(h('h2', {}, name ?? 'Unassigned'));
        const grid = h('div', { class: 'board-grid' });
        for (const status of statuses) {
          const group = rows.filter(
            (t) => t.status === status && (!lanes.checked || t.assignee === name),
          );
          grid.append(
            h(
              'section',
              { class: 'board-column ' + status },
              h('h3', {}, caption(status), h('small', {}, group.length)),
              ...group.map(card),
            ),
          );
        }
        panel.append(grid);
      }
    } else {
      const sprints = [...new Set(rows.map((t) => t.sprint))]
        .sort()
        .reverse()
        .map((name) => {
          const group = rows.filter((t) => t.sprint === name);
          return {
            name,
            completed: group.filter((t) => t.status === 'done'),
            remaining: group.filter((t) => t.status !== 'done'),
          };
        });
      if (view === 'Velocity') {
        const chart = h('section', { class: 'box' }, h('h2', {}, 'Cards completed per sprint'));
        const maximum = Math.max(1, ...sprints.map((s) => s.completed.length));
        for (const sprint of sprints) {
          const count = sprint.completed.length;
          const bar = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          bar.setAttribute('viewBox', '0 0 100 10');
          bar.setAttribute('preserveAspectRatio', 'none');
          bar.setAttribute('aria-hidden', 'true');
          const rect = document.createElementNS(bar.namespaceURI, 'rect');
          rect.setAttribute('width', String((count * 100) / maximum));
          rect.setAttribute('height', '10');
          rect.setAttribute('fill', 'var(--done)');
          bar.append(rect);
          chart.append(
            h(
              'div',
              { class: 'velocity-row' },
              h('span', {}, sprint.name ?? 'Unscheduled'),
              bar,
              h('strong', {}, count),
            ),
          );
        }
        panel.append(chart);
      } else {
        for (const sprint of sprints) {
          const section = h('section', { class: 'box' }, h('h2', {}, sprint.name ?? 'Unscheduled'));
          for (const [name, cards] of [
            ['Remaining', sprint.remaining],
            ['Completed', sprint.completed],
          ] as const) {
            section.append(
              h('h3', {}, name + ' · ' + cards.length),
              h('div', { class: 'sprint-cards' }, ...cards.map(card)),
            );
          }
          panel.append(section);
        }
      }
    }
    if (!rows.length) panel.append(h('p', { class: 'muted' }, 'No matching cards'));
  }
  async function load() {
    tasks = await api<Task[]>('/tasks');
    for (const [control, values] of [
      [project, [...projects.map((p) => p.id), ...tasks.map((t) => t.project_id)]],
      [agent, tasks.map((t) => t.assignee)],
    ] as const) {
      const current = control.value;
      control.length = 1;
      for (const v of [...new Set(values)].sort())
        if (v) control.append(h('option', { value: v }, v));
      control.value = current;
    }
    draw();
  }
  for (const v of ['Board', 'Sprint', 'Velocity'])
    tabs.append(
      button(v, () => {
        view = v;
        draw();
      }),
    );
  for (const c of [project, agent, lanes, query]) c.oninput = draw;
  bar.append(query, project, agent, h('label', {}, lanes, ' Assignee lanes'));
  if (canWrite) bar.append(button('Create card', () => edit()));
  root.append(tabs, bar, notice, panel, sheet);
  void load().catch(fail);
  return root;
}
