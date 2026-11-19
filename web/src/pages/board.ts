import { api, type PublicConfig } from '../api.ts';
import { h } from '../dom.ts';
import {
  columns,
  countLabel,
  laneNames,
  matches,
  PAGE_SIZE,
  phoneColumn,
  projectOf,
  STATUSES,
  type Task,
} from './board-logic.ts';
import './board.css';

const statuses: string[] = [...STATUSES];
interface Detail extends Task {
  events: { actor: string; at: string; kind: string; data_json: string | null }[];
  runs: { id: number; agent_kind: string; branch: string | null; status: string }[];
}
const DENSITY_KEY = 'mm.board.density';
const EMPTY_KEY = 'mm.board.show-empty';
function stored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
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
    lanes = h('input', { type: 'checkbox' }),
    compact = h('input', { type: 'checkbox', checked: stored(DENSITY_KEY) === 'compact' }),
    showEmpty = h('input', { type: 'checkbox', checked: stored(EMPTY_KEY) === '1' }),
    phonePick = h('select', { 'aria-label': 'Column', class: 'board-phone-pick' });
  const notice = h('div', { role: 'alert' }),
    sheet = h('dialog', { class: 'sheet board-sheet', 'aria-label': 'Card details' });
  const close = button('Close', () => sheet.close());
  const body = h('div', { class: 'body' });
  sheet.append(close, body);
  let tasks: Task[] = [],
    view = 'Board',
    showOlder = false,
    phone: string | null = null,
    observers: IntersectionObserver[] = [];
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
    const b = h('button', { type: 'button', class: 'board-card', title: t.title });
    b.onclick = () => void detail(t.id).catch(fail);
    // The project line says which project or imported board a card is from; it is left out when
    // it would repeat the active filter, and the assignee is left out inside its own lane.
    const where = projectOf(t);
    const meta = [where === project.value ? null : where, lanes.checked ? null : t.assignee]
      .filter(Boolean)
      .join(' · ');
    b.append(h('small', {}, t.short_name ?? '#' + t.id), h('span', { class: 'title' }, t.title));
    if (meta) b.append(h('small', { class: 'meta' }, meta));
    return b;
  };
  /**
   * Fills `list` with the first PAGE_SIZE cards and adds more when its end scrolls into view
   * (or the "Show more" button is pressed), so a 700-card column never builds 700 nodes.
   * `extra` is appended once every card is listed (the "Show older" control for done).
   */
  function incremental(list: HTMLElement, cards: Task[], root: Element | null, extra?: Node) {
    let shown = 0;
    const more = h('button', { type: 'button', class: 'board-more' });
    const step = () => {
      const next = cards.slice(shown, shown + PAGE_SIZE);
      shown += next.length;
      more.before(...next.map(card));
      const left = cards.length - shown;
      more.textContent = 'Show ' + Math.min(PAGE_SIZE, left) + ' more (' + left + ' left)';
      if (!left) {
        more.remove();
        observer?.disconnect();
        if (extra) list.append(extra);
      }
    };
    more.onclick = step;
    list.append(more);
    const observer =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && step(), {
            root,
            rootMargin: '0px 0px 240px 0px',
          })
        : undefined;
    step();
    if (more.parentNode && observer) {
      observer.observe(more);
      observers.push(observer);
    }
  }
  function boardGrid(rows: Task[], laneKey: string) {
    const grid = h('div', { class: 'board-grid', 'data-lane': laneKey });
    const cols = columns(rows, { now: Date.now(), showOlder });
    const active = phoneColumn(phone, cols);
    for (const col of cols) {
      const name = caption(col.status);
      const collapsed = !col.total && !showEmpty.checked;
      const head = h(
        'h3',
        { class: 'board-col-head' },
        h('span', {}, name),
        h('small', { class: 'count' }, countLabel(col)),
      );
      const section = h(
        'section',
        {
          class: 'board-column ' + col.status + (collapsed ? ' collapsed' : ''),
          'data-status': col.status,
          'data-active': col.status === active,
          'aria-label': name + ', ' + countLabel(col) + ' cards',
        },
        head,
      );
      if (collapsed) {
        // A narrow strip; pressing it shows every empty column again.
        const strip = button(name + ' 0', () => {
          showEmpty.checked = true;
          store(EMPTY_KEY, '1');
          draw();
        });
        strip.className = 'board-strip';
        strip.setAttribute('aria-label', name + ': no cards. Show empty columns');
        section.replaceChildren(strip);
        grid.append(section);
        continue;
      }
      const list = h('div', { class: 'board-list', tabindex: 0, 'aria-label': name + ' cards' });
      section.append(list);
      if (col.status === 'done' && showOlder && col.total)
        head.append(
          button('Recent', () => {
            showOlder = false;
            draw();
          }),
        );
      const older = col.older
        ? button('Show ' + col.older + ' older', () => {
            showOlder = true;
            draw();
          })
        : undefined;
      older?.classList.add('board-more');
      if (!col.cards.length)
        list.append(
          h('p', { class: 'muted' }, col.older ? 'Nothing in the last 14 days' : 'No cards'),
        );
      incremental(list, col.cards, list, older);
      grid.append(section);
    }
    grid.style.gridTemplateColumns = cols
      .map((c) => (!c.total && !showEmpty.checked ? 'var(--strip)' : 'minmax(var(--col), 1fr)'))
      .join(' ');
    return { grid, cols, active };
  }
  function draw() {
    for (const o of observers) o.disconnect();
    observers = [];
    panel.replaceChildren();
    const rows = tasks.filter((t) =>
      matches(t, { q: query.value, project: project.value, assignee: agent.value }),
    );
    for (const b of tabs.querySelectorAll('button'))
      b.setAttribute('aria-pressed', String(b.textContent === view));
    root.classList.toggle('compact', compact.checked);
    root.dataset.view = view.toLowerCase();
    panel.classList.toggle('lanes', view === 'Board' && lanes.checked);
    if (view === 'Board') {
      // Phone switcher: one column at a time; counts are for the whole (filtered) board.
      const whole = columns(rows, { now: Date.now(), showOlder });
      phone = phoneColumn(phone, whole);
      phonePick.replaceChildren(
        ...whole.map((c) =>
          h(
            'option',
            { value: c.status, selected: c.status === phone },
            caption(c.status) + ' (' + countLabel(c) + ')',
          ),
        ),
      );
      if (lanes.checked) {
        for (const name of laneNames(rows)) {
          const lane = h(
            'section',
            { class: 'board-lane', 'aria-label': (name ?? 'Unassigned') + ' lane' },
            h('h2', {}, name ?? 'Unassigned'),
          );
          lane.append(
            boardGrid(
              rows.filter((t) => (t.assignee ?? null) === name),
              name ?? '',
            ).grid,
          );
          panel.append(lane);
        }
      } else panel.append(boardGrid(rows, '').grid);
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
            const list = h('div', { class: 'sprint-cards' });
            section.append(h('h3', {}, name + ' · ' + cards.length), list);
            incremental(list, cards, panel);
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
      [project, [...projects.map((p) => p.id), ...tasks.map(projectOf)]],
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
  for (const c of [project, agent, lanes]) c.oninput = draw;
  let typing: ReturnType<typeof setTimeout> | undefined;
  query.oninput = () => {
    clearTimeout(typing);
    typing = setTimeout(draw, 120);
  };
  compact.oninput = () => {
    store(DENSITY_KEY, compact.checked ? 'compact' : null);
    draw();
  };
  showEmpty.oninput = () => {
    store(EMPTY_KEY, showEmpty.checked ? '1' : null);
    draw();
  };
  phonePick.oninput = () => {
    phone = phonePick.value;
    for (const col of panel.querySelectorAll<HTMLElement>('.board-column'))
      col.toggleAttribute('data-active', col.dataset.status === phone);
  };
  bar.append(
    query,
    project,
    agent,
    h('label', {}, lanes, ' Assignee lanes'),
    h('label', { class: 'board-empty-toggle' }, showEmpty, ' Empty columns'),
    h('label', {}, compact, ' Compact'),
  );
  if (canWrite) bar.append(button('Create card', () => edit()));
  root.append(tabs, bar, phonePick, notice, panel, sheet);
  void load().catch(fail);
  return root;
}
