import { board } from './pages/board.ts';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import './styles.css';

import {
  api,
  ApiError,
  getToken,
  setToken,
  type PublicConfig,
  type Stats,
  type WhoAmI,
} from './api.ts';
import { byId, h } from './dom.ts';
import { SLICES, TABS, tabFromHash, type Skeleton, type Tab } from './tabs.ts';
import { setupThemeToggle } from './theme.ts';

let config: PublicConfig | null = null;
let who: WhoAmI['token'] = null;

const main = byId('main');
const tabList = byId<HTMLUListElement>('tab-list');

// ---- Tabs (links, so they work with Tab/Enter, middle-click and the back button) ----

function renderTabs(active: Tab): void {
  if (!tabList.childElementCount) {
    for (const t of TABS) {
      tabList.append(h('li', {}, h('a', { href: `#/${t.id}`, 'data-tab': t.id }, t.label)));
    }
  }
  for (const a of tabList.querySelectorAll<HTMLAnchorElement>('a')) {
    if (a.dataset.tab === active.id) {
      a.setAttribute('aria-current', 'page');
      a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else {
      a.removeAttribute('aria-current');
    }
  }
}

// ---- Empty states ----

function sliceChip(slice: string): HTMLElement {
  const name = SLICES[slice] ?? slice;
  return h(
    'span',
    { class: `chip slice-${slice === 'S1' ? 'now' : 'soon'}`, title: `${slice}: ${name}` },
    slice === 'later' ? 'later' : slice,
  );
}

function skeleton(kind: Skeleton): HTMLElement {
  const box = h('div', { class: `skeleton sk-${kind}`, 'aria-hidden': 'true' });
  const counts: Record<Skeleton, number> = {
    gauges: 3,
    chart: 1,
    columns: 6,
    table: 6,
    bars: 14,
    list: 5,
    cards: 3,
    split: 2,
  };
  for (let i = 0; i < counts[kind]; i++) {
    const el = h('div', { class: 'sk' });
    if (kind === 'bars') el.style.setProperty('--h', `${25 + ((i * 37) % 70)}%`);
    if (kind === 'columns') {
      for (let j = 0; j < 3 - (i % 3); j++) el.append(h('div', { class: 'sk-card' }));
    }
    box.append(el);
  }
  if (kind === 'chart') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 300 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML =
      '<line class="even" x1="0" y1="95" x2="300" y2="5"/>' +
      '<polyline class="used" points="0,95 40,88 80,80 120,70 160,62 190,50"/>' +
      '<line class="proj" x1="190" y1="50" x2="300" y2="18"/>';
    box.firstElementChild?.append(svg);
  }
  return box;
}

/** What the current config already says about this page, so the empty state is not generic. */
function fromConfig(tab: Tab): HTMLElement | null {
  if (!config) return null;
  const items: (string | HTMLElement)[] = [];
  const names = (xs: { name: string }[]) => xs.map((x) => x.name).join(', ');
  switch (tab.id) {
    case 'overview':
    case 'burndown':
      if (config.plans.length) items.push(`Plans: ${names(config.plans)}`);
      if (tab.id === 'overview' && config.machines.length)
        items.push(`Machines: ${names(config.machines)}`);
      break;
    case 'board':
      if (config.projects.length) items.push(`Projects: ${names(config.projects)}`);
      break;
    case 'agents':
      if (config.machines.length) items.push(`Machines: ${names(config.machines)}`);
      break;
    case 'usage':
      for (const p of config.plans) {
        if (p.models.length) items.push(`${p.name} models: ${p.models.join(', ')}`);
      }
      break;
    case 'schedules':
      if (config.collectors.length)
        items.push(`Collectors: ${config.collectors.map((c) => `${c.id} (${c.kind})`).join(', ')}`);
      break;
    case 'notes':
      for (const d of config.documents) {
        items.push(
          h('span', {}, d.name, d.private ? h('span', { class: 'lock' }, ' private') : ''),
        );
      }
      break;
    case 'connections':
      if (config.plans.length) items.push(`Plans: ${names(config.plans)}`);
      if (config.local_models.length) items.push(`Local models: ${names(config.local_models)}`);
      break;
    default:
      return null;
  }
  if (!items.length) return null;
  return h(
    'div',
    { class: 'box' },
    h('h3', {}, 'From your config'),
    h('ul', {}, ...items.map((i) => h('li', {}, i))),
  );
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function settingsLive(): Promise<HTMLElement> {
  const box = h('div', { class: 'box', 'aria-live': 'polite' }, h('h3', {}, 'Database'));
  try {
    const s = await api<Stats>('/stats');
    const kv = h('dl', { class: 'kv' });
    const add = (k: string, v: string) => kv.append(h('dt', {}, k), h('dd', {}, v));
    add('Version', s.version);
    add('Size', `${bytes(s.db.size_bytes)} + ${bytes(s.db.wal_bytes)} WAL`);
    add('Schema', `migration ${s.db.schema_version}`);
    add('Last cleanup', s.last_retention ? s.last_retention.at : 'not yet');
    const rows = h('dl', { class: 'kv' });
    for (const [t, n] of Object.entries(s.db.rows)) rows.append(h('dt', {}, t), h('dd', {}, n));
    const ret = h('dl', { class: 'kv' });
    for (const [k, v] of Object.entries(s.retention)) ret.append(h('dt', {}, k), h('dd', {}, v));
    box.append(kv, h('h3', {}, 'Rows'), rows, h('h3', {}, 'Retention'), ret);
  } catch (err) {
    box.append(h('p', { class: 'muted' }, `Could not load stats: ${(err as Error).message}`));
  }
  return box;
}

function renderPage(tab: Tab, focus: boolean): void {
  if (tab.id === 'board') {
    const head = h('h1', { id: 'page-title', tabindex: '-1' }, tab.title);
    main.replaceChildren(
      head,
      board(
        Boolean(who?.scopes.some((s) => s === 'write' || s === 'admin')),
        config?.projects ?? [],
      ),
    );
    document.title = tab.title + ' · ' + (config?.site.name ?? 'middle-manager');
    if (focus) head.focus({ preventScroll: true });
    return;
  }
  const arrives = [...new Set(tab.coming.map((c) => c.slice))].filter((s) => s !== 'S1');
  const head = h(
    'div',
    { class: 'page-head' },
    h('h1', { id: 'page-title', tabindex: '-1' }, tab.title),
    arrives.length
      ? h(
          'p',
          { class: 'arrives' },
          tab.coming.some((c) => c.slice === 'S1') ? 'More arrives in ' : 'Arrives in ',
          ...arrives.flatMap((s, i) => [
            i ? ', ' : '',
            h('b', {}, s === 'later' ? 'a later slice' : `${s} · ${SLICES[s] ?? ''}`),
          ]),
        )
      : null,
  );
  const coming = h(
    'div',
    { class: 'box' },
    h('h3', {}, 'What will appear here'),
    h(
      'ul',
      { class: 'coming' },
      ...tab.coming.map((c) => h('li', {}, sliceChip(c.slice), h('span', {}, c.text))),
    ),
  );
  const empty = h(
    'section',
    { class: 'empty-state', 'aria-labelledby': 'page-title' },
    h(
      'div',
      { class: 'preview' },
      skeleton(tab.skeleton),
      h('p', { class: 'empty' }, 'Nothing here yet.'),
    ),
    h('div', { class: 'side' }, h('p', { class: 'lead' }, tab.lead), coming, fromConfig(tab)),
  );
  main.replaceChildren(head, empty);
  if (tab.id === 'settings') {
    void settingsLive().then((box) => empty.querySelector('.side')?.append(box));
  }
  document.title = `${tab.title} · ${config?.site.name ?? 'middle-manager'}`;
  if (focus) byId('page-title').focus({ preventScroll: true });
}

function route(focus: boolean): void {
  const tab = tabFromHash(location.hash);
  const want = `#/${tab.id}`;
  if (location.hash !== want) history.replaceState(null, '', want);
  renderTabs(tab);
  renderPage(tab, focus);
}

// ---- Sign in ----

const signInButton = byId<HTMLButtonElement>('sign-in');
const dialog = byId<HTMLDialogElement>('sign-in-dialog');
const form = byId<HTMLFormElement>('sign-in-form');

function renderSignInButton(): void {
  signInButton.textContent = who ? who.name : 'Sign in';
  signInButton.classList.toggle('primary', !who);
  signInButton.setAttribute(
    'aria-label',
    who ? `Signed in as ${who.name}. Manage sign-in` : 'Sign in',
  );
}

function openSignIn(): void {
  form.replaceChildren();
  if (who) {
    form.append(
      h('h2', { id: 'sign-in-title' }, 'Signed in'),
      h(
        'p',
        {},
        'This browser uses the token ',
        h('b', {}, who.name),
        ` (scopes: ${who.scopes.join(', ')}). It is stored in this browser only.`,
      ),
      h(
        'div',
        { class: 'row end' },
        h('button', { type: 'submit', value: 'cancel' }, 'Close'),
        h('button', { type: 'button', id: 'sign-out' }, 'Sign out'),
      ),
    );
    byId('sign-out').addEventListener('click', () => {
      setToken(null);
      who = null;
      renderSignInButton();
      if (tabFromHash(location.hash).id === 'board') route(false);
      dialog.close();
    });
  } else {
    const input = h('input', {
      type: 'password',
      id: 'token-input',
      name: 'token',
      autocomplete: 'off',
      spellcheck: 'false',
      required: true,
      'aria-describedby': 'token-help token-error',
    });
    const error = h('p', { id: 'token-error', class: 'error', role: 'alert' });
    form.append(
      h('h2', { id: 'sign-in-title' }, 'Sign in'),
      h(
        'p',
        { id: 'token-help', class: 'muted' },
        'Reading is open to everyone on your network. Changes need an API token, created on the server with ',
        h('code', {}, 'middle-manager token create <name>'),
        '. The token is kept in this browser only.',
      ),
      h('label', { for: 'token-input' }, 'API token'),
      input,
      error,
      h(
        'div',
        { class: 'row end' },
        h('button', { type: 'button', id: 'sign-in-cancel' }, 'Cancel'),
        h('button', { type: 'submit', class: 'primary', value: 'ok' }, 'Sign in'),
      ),
    );
    byId('sign-in-cancel').addEventListener('click', () => dialog.close());
  }
  dialog.showModal();
}

form.addEventListener('submit', (ev) => {
  const submitter = (ev as SubmitEvent).submitter as HTMLButtonElement | null;
  if (who || submitter?.value === 'cancel') return; // let the dialog close
  ev.preventDefault();
  const input = byId<HTMLInputElement>('token-input');
  const error = byId('token-error');
  const token = input.value.trim();
  error.textContent = '';
  if (!token) {
    error.textContent = 'Paste a token first.';
    return;
  }
  void api<WhoAmI>('/auth/whoami', {}, token)
    .then((res) => {
      if (!res.token) {
        error.textContent = 'That token is not valid or has been revoked.';
        return;
      }
      setToken(token);
      who = res.token;
      renderSignInButton();
      if (tabFromHash(location.hash).id === 'board') route(false);
      dialog.close();
    })
    .catch((err: unknown) => {
      error.textContent =
        err instanceof ApiError ? err.message : 'Could not reach the server. Try again.';
    });
});

signInButton.addEventListener('click', openSignIn);

// ---- Boot ----

async function boot(): Promise<void> {
  // The skip link moves focus without touching the hash (the hash is the router's).
  document.querySelector('.skip')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    main.focus();
  });
  setupThemeToggle(byId<HTMLButtonElement>('theme-toggle'));
  renderSignInButton();
  route(false);
  window.addEventListener('hashchange', () => route(true));

  const [cfg, me] = await Promise.allSettled([
    api<PublicConfig>('/config/public'),
    getToken() ? api<WhoAmI>('/auth/whoami') : Promise.resolve({ token: null }),
  ]);
  if (cfg.status === 'fulfilled') {
    config = cfg.value;
    byId('site-name').textContent = config.site.name;
  }
  if (me.status === 'fulfilled') {
    who = me.value.token;
    if (!who && getToken()) setToken(null); // revoked or unknown: forget it
    renderSignInButton();
  }
  route(false);
}

void boot();
