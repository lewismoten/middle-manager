// Notes page (SPEC 8.7): document collections listed by date, title search, and the selected
// document rendered from disk. Private collections show a lock until a token is entered.
// The HTML comes from the server's renderer (server/notes/markdown.ts), which escapes all source
// text and writes only its own tags, so it is safe to insert.

import './agents.css'; // shared: chips, sr-only
import './notes.css';
import { api, ApiError, getToken, type PublicConfig } from '../api.ts';
import { h } from '../dom.ts';
import {
  dateLabel,
  filterDocs,
  groupByDate,
  sizeText,
  summaryLine,
  todayIn,
  type DocFull,
  type DocsResponse,
  type DocSummary,
} from './notes-logic.ts';

interface Ctx {
  config: PublicConfig | null;
  title: string;
}

export function mountNotes(main: HTMLElement, ctx: Ctx): () => void {
  let stopped = false;
  let data: DocsResponse | null = null;
  let selected: number | null = null;
  let docRequest = 0;
  const tz = ctx.config?.site.timezone ?? 'UTC';

  const summary = h('p', { class: 'arrives', id: 'notes-summary', 'aria-live': 'polite' });
  const refresh = h('button', { type: 'button', id: 'notes-refresh', class: 'ghost' }, 'Refresh');
  const head = h(
    'div',
    { class: 'page-head' },
    h('h1', { id: 'page-title', tabindex: '-1' }, ctx.title),
    summary,
    h('span', { class: 'head-actions' }, refresh),
  );

  const collectionSelect = h('select', { id: 'notes-collection' });
  const search = h('input', {
    type: 'search',
    id: 'notes-search',
    placeholder: 'Search titles',
    autocomplete: 'off',
  });
  const tools = h(
    'div',
    { class: 'notes-tools' },
    h(
      'span',
      { class: 'field' },
      h('label', { for: 'notes-collection' }, 'Collection'),
      collectionSelect,
    ),
    h('span', { class: 'field grow' }, h('label', { for: 'notes-search' }, 'Search'), search),
  );
  const list = h('div', { class: 'notes-scroll', id: 'notes-list' });
  const listPanel = h(
    'section',
    { class: 'notes-panel', id: 'notes-list-panel', 'aria-labelledby': 'notes-list-title' },
    h('h2', { id: 'notes-list-title', class: 'sr-only' }, 'Documents'),
    tools,
    list,
  );
  const doc = h('article', {
    class: 'notes-panel notes-doc',
    id: 'notes-doc',
    'aria-live': 'polite',
    tabindex: '-1',
  });
  main.replaceChildren(head, h('div', { class: 'notes-grid' }, listPanel, doc));

  function emptyDoc(text: string): void {
    doc.replaceChildren(h('div', { class: 'notes-empty' }, h('p', { class: 'muted' }, text)));
  }

  function signInButton(): HTMLElement {
    const b = h('button', { type: 'button', class: 'notes-sign-in' }, 'Sign in');
    b.addEventListener('click', () => document.getElementById('sign-in')?.click());
    return b;
  }

  function renderCollections(): void {
    if (!data) return;
    const keep = collectionSelect.value;
    collectionSelect.replaceChildren(
      h('option', { value: '' }, 'All collections'),
      ...data.collections.map((c) =>
        h(
          'option',
          { value: c.id, disabled: c.locked },
          c.locked ? `${c.name} (locked)` : `${c.name} (${c.count ?? 0})`,
        ),
      ),
    );
    collectionSelect.value = data.collections.some((c) => c.id === keep && !c.locked) ? keep : '';
  }

  function renderList(): void {
    if (!data) return;
    const shown = filterDocs(data.documents, collectionSelect.value, search.value);
    const names = new Map(data.collections.map((c) => [c.id, c.name]));
    const today = todayIn(tz);
    const out: HTMLElement[] = [];

    // Locked and broken collections first, so nobody wonders where they went.
    for (const c of data.collections) {
      if (collectionSelect.value && c.id !== collectionSelect.value && !c.locked) continue;
      if (c.locked)
        out.push(
          h(
            'div',
            { class: 'notes-locked', 'data-collection': c.id },
            h('span', { class: 'lock-icon', 'aria-hidden': 'true' }, '🔒'),
            h(
              'p',
              {},
              h('b', {}, c.name),
              ' is private. ',
              h('span', { class: 'muted' }, 'Sign in with a token to read it.'),
            ),
            signInButton(),
          ),
        );
      else if (c.error)
        out.push(
          h(
            'p',
            { class: 'notes-error', 'data-collection': c.id },
            h('b', {}, c.name),
            `: ${c.error}`,
          ),
        );
      else if (c.capped)
        out.push(
          h('p', { class: 'notes-error muted' }, `${c.name}: only the newest files are indexed`),
        );
    }

    if (!shown.length) {
      out.push(
        h(
          'p',
          { class: 'muted pad', id: 'notes-none' },
          data.documents.length
            ? 'No titles match.'
            : data.collections.length
              ? 'No documents yet.'
              : 'No document collections in the config.',
        ),
      );
    }
    for (const g of groupByDate(shown)) {
      const ul = h('ul', { class: 'doc-list' });
      for (const d of g.docs) ul.append(h('li', {}, docButton(d, names.get(d.collection_id))));
      out.push(
        h(
          'section',
          { class: 'date-group', 'data-date': g.date },
          h('h3', {}, h('time', { datetime: g.date || null }, dateLabel(g.date || null, today))),
          ul,
        ),
      );
    }
    list.replaceChildren(...out);
  }

  function docButton(d: DocSummary, collection: string | undefined): HTMLElement {
    const b = h(
      'button',
      {
        type: 'button',
        class: 'doc-open',
        'data-doc': d.id,
        'aria-current': d.id === selected ? 'true' : null,
      },
      h('span', { class: 'doc-title' }, d.title),
      h(
        'span',
        { class: 'doc-meta' },
        (data?.collections.length ?? 0) > 1 && collection
          ? h('span', { class: 'chip' }, collection)
          : null,
        d.private ? h('span', { class: 'lock' }, 'private') : null,
        h('span', { class: 'doc-path' }, d.path),
      ),
    );
    b.addEventListener('click', () => void open(d.id, true));
    return b;
  }

  async function open(id: number, fromClick: boolean): Promise<void> {
    selected = id;
    for (const b of list.querySelectorAll<HTMLElement>('.doc-open')) {
      if (Number(b.dataset.doc) === id) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    }
    const req = ++docRequest;
    doc.setAttribute('aria-busy', 'true');
    try {
      const d = await api<DocFull>(`/documents/${id}`);
      if (stopped || req !== docRequest) return;
      const body = h('div', { class: 'md' });
      body.innerHTML = d.html; // server-rendered and escaped; see the note at the top
      // The header already shows the title; drop a leading heading that repeats it.
      const lead = body.firstElementChild;
      if (lead?.matches('h2') && lead.textContent?.trim() === d.title) lead.remove();
      doc.replaceChildren(
        h(
          'header',
          { class: 'notes-doc-head' },
          h('h2', { id: 'notes-doc-title' }, d.title),
          h(
            'p',
            { class: 'doc-meta' },
            h('span', { class: 'chip' }, d.collection_name),
            d.private ? h('span', { class: 'lock' }, 'private') : null,
            d.date ? h('time', { datetime: d.date }, dateLabel(d.date, todayIn(tz))) : null,
            h('span', {}, sizeText(d.size)),
            h('span', { class: 'doc-path' }, d.path),
          ),
        ),
        ...(d.truncated
          ? [h('p', { class: 'notes-error' }, 'This file is long; only the first 512 KB is shown.')]
          : []),
        body,
      );
      doc.scrollTop = 0;
      if (fromClick && window.matchMedia('(max-width: 1000px)').matches)
        doc.scrollIntoView({ block: 'start' });
    } catch (err) {
      if (stopped || req !== docRequest) return;
      emptyDoc(
        err instanceof ApiError && err.status === 401
          ? 'This document is private. Sign in to read it.'
          : `Could not open it: ${(err as Error).message}`,
      );
    } finally {
      if (req === docRequest) doc.removeAttribute('aria-busy');
    }
  }

  async function load(force = false): Promise<void> {
    refresh.disabled = true;
    try {
      const r = await api<DocsResponse>(`/documents${force ? '?refresh=1' : ''}`);
      if (stopped) return;
      data = r;
      summary.textContent = summaryLine(r);
      renderCollections();
      renderList();
      const still = r.documents.some((d) => d.id === selected);
      if (selected !== null && still) {
        if (force) void open(selected, false);
      } else {
        const first = filterDocs(r.documents, collectionSelect.value, search.value)[0];
        if (first) void open(first.id, false);
        else {
          selected = null;
          emptyDoc(
            r.collections.some((c) => c.locked) && !getToken()
              ? 'Pick a document. Private collections need a sign-in.'
              : 'Pick a document to read it here.',
          );
        }
      }
    } catch (err) {
      if (stopped) return;
      list.replaceChildren(
        h('p', { class: 'muted pad' }, `Could not load documents: ${(err as Error).message}`),
      );
      emptyDoc('');
    } finally {
      refresh.disabled = false;
    }
  }

  collectionSelect.addEventListener('change', renderList);
  search.addEventListener('input', renderList);
  refresh.addEventListener('click', () => void load(true));

  list.replaceChildren(h('p', { class: 'muted pad' }, 'Loading documents…'));
  emptyDoc('');
  void load();

  return () => {
    stopped = true;
  };
}
