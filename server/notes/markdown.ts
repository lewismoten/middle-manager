// A small, safe markdown renderer for the Notes page (SPEC 6: /documents/:id returns rendered
// markdown). No dependency on purpose (SPEC 2). Safety comes from the order of work: every piece
// of source text is HTML-escaped before it is placed in output, and the only tags in the output
// are the ones written here. Raw HTML in a document shows as text. Links keep only http(s) and
// mailto targets; anything else (relative paths, javascript:, #anchors that would fight the
// hash router) is shown as plain text.
//
// Supported: ATX headings (shifted down one level under the page's h1), paragraphs, hard breaks,
// emphasis/strong/strikethrough, inline code, fenced code, blockquotes, nested bullet and
// numbered lists, task items, pipe tables, horizontal rules, links, autolinks and bare URLs.
// Images render as a labelled link (the page's CSP blocks remote images anyway).

export interface Frontmatter {
  [key: string]: string;
}

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

/** Splits a leading `---` YAML block off. Only simple `key: value` lines are read. */
export function splitFrontmatter(text: string): { meta: Frontmatter; body: string } {
  const src = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: Frontmatter = {};
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
    if (kv?.[1]) meta[kv[1].toLowerCase()] = (kv[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return { meta, body: src.slice(m[0].length) };
}

/** The target if it is safe to link to, else null. */
export function safeUrl(raw: string): string | null {
  const url = raw.trim();
  if (/^(https?:\/\/|mailto:)/i.test(url) && !/[\s<>"']/.test(url)) return url;
  return null;
}

// ---- Inline ----

const BARE_URL = /\bhttps?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]*_~]/g;

/**
 * Renders inline markdown. Code spans and links are swapped for placeholders first so that
 * emphasis rules never see inside them; everything else is escaped before any tag is added.
 */
export function renderInline(src: string, allowLinks = true): string {
  const held: string[] = [];
  const hold = (html: string) => `\uE000${held.push(html) - 1}\uE001`;
  let s = src.replace(/[\uE000\uE001]/g, '');

  // Code spans: `x` or ``x ` y``.
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t: string, code: string) =>
    hold(`<code>${escapeHtml(code.replace(/^ (.*) $/, '$1'))}</code>`),
  );
  // Backslash escapes.
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_, c: string) => hold(escapeHtml(c)));

  // Images: ![alt](src) -> a labelled link (or just the label).
  s = s.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g, (_, alt: string, url) => {
    const label = `<span class="md-img">image: ${escapeHtml(alt || 'untitled')}</span>`;
    const href = allowLinks ? safeUrl(url as string) : null;
    return hold(href ? link(href, label) : label);
  });
  // Links: [text](url "title")
  s = s.replace(
    /\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g,
    (_, text: string, url: string) => {
      const inner = renderInline(text, false);
      const href = allowLinks ? safeUrl(url) : null;
      return hold(href ? link(href, inner) : `<span class="md-link">${inner}</span>`);
    },
  );
  // Autolinks: <https://...>
  s = s.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, (_, url: string) => {
    const href = allowLinks ? safeUrl(url) : null;
    return hold(href ? link(href, escapeHtml(url)) : escapeHtml(url));
  });
  if (allowLinks) s = s.replace(BARE_URL, (url) => hold(link(url, escapeHtml(url))));

  // Hard breaks: two trailing spaces or a trailing backslash.
  s = s.replace(/(?: {2,}|\\)\n/g, () => hold('<br>'));

  s = escapeHtml(s);
  s = s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/\*(?=[^\s*])([\s\S]*?[^\s*])\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  // Placeholders can nest (link text holds code), so restore until none are left.
  for (let i = 0; i < 4 && s.includes('\uE000'); i++) {
    s = s.replace(/\uE000(\d+)\uE001/g, (_, n: string) => held[Number(n)] ?? '');
  }
  return s;
}

function link(href: string, inner: string): string {
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
}

// ---- Blocks ----

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TABLE_SEP = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;

const isBlank = (l: string) => /^\s*$/.test(l);
const listKind = (m: RegExpExecArray) => (/\d/.test(m[2] ?? '') ? 'ol' : 'ul');
const indentOf = (l: string) => /^ */.exec(l)?.[0].length ?? 0;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '`') {
      code = !code;
      cur += c;
    } else if (c === '|' && !code) {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    ITEM.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-'))
  );
}

function renderList(lines: string[], depth: number): string {
  const first = ITEM.exec(lines[0] as string);
  const base = first?.[1]?.length ?? 0;
  const ordered = /\d/.test(first?.[2] ?? '');
  const startNum = ordered ? parseInt(first?.[2] ?? '1', 10) : 1;
  const items: string[][] = [];
  let loose = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = ITEM.exec(line);
    if (m && (m[1]?.length ?? 0) <= base + 1) {
      items.push([m[3] ?? '']);
      continue;
    }
    const cur = items[items.length - 1];
    if (!cur) continue;
    if (isBlank(line) && i + 1 < lines.length && i > 0) loose = true;
    // Continuation lines: drop the item's indent so nested blocks parse on their own.
    const width = (first?.[1]?.length ?? 0) + (first?.[2]?.length ?? 1) + 1;
    cur.push(line.slice(Math.min(indentOf(line), Math.max(width, base + 2))));
  }
  const tag = ordered ? 'ol' : 'ul';
  const start = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
  const body = items
    .map((item) => {
      let text = item.join('\n');
      let box = '';
      const task = /^\[([ xX])\][ \t]+/.exec(text);
      if (task) {
        box = `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> `;
        text = text.slice(task[0].length);
      }
      let html = renderBlocks(text.split('\n'), depth + 1);
      if (!loose) html = html.replace(/^<p>([\s\S]*?)<\/p>(?=\n?<[uo]l|$)/, '$1');
      return `<li${task ? ' class="task"' : ''}>${box}${html}</li>`;
    })
    .join('\n');
  return `<${tag}${start}>\n${body}\n</${tag}>`;
}

function renderBlocks(lines: string[], depth = 0): string {
  if (depth > 12) return `<p>${renderInline(lines.join('\n'))}</p>`;
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${renderInline(para.join('\n').trim())}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const next = lines[i + 1];
    if (isBlank(line)) {
      flush();
      continue;
    }
    if (para.length && !startsBlock(line, next)) {
      para.push(line);
      continue;
    }
    flush();

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] as string;
      const lang = (fence[2] ?? '').replace(/[^\w+#.-]/g, '');
      const code: string[] = [];
      const indent = indentOf(line);
      i++;
      while (i < lines.length) {
        const l = lines[i] as string;
        if (new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(l))
          break;
        code.push(l.slice(Math.min(indent, indentOf(l))));
        i++;
      }
      const cls = lang ? ` class="lang-${escapeHtml(lang)}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const head = HEADING.exec(line);
    if (head) {
      const level = Math.min(6, (head[1]?.length ?? 1) + 1);
      out.push(`<h${level}>${renderInline(head[2] ?? '')}</h${level}>`);
      continue;
    }

    if (RULE.test(line)) {
      out.push('<hr>');
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && !isBlank(lines[i] as string)) {
        const l = lines[i] as string;
        inner.push(l.replace(QUOTE, ''));
        i++;
      }
      i--;
      out.push(`<blockquote>\n${renderBlocks(inner, depth + 1)}\n</blockquote>`);
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      const base = indentOf(line);
      const kind = listKind(item);
      const block: string[] = [line];
      while (i + 1 < lines.length) {
        const l = lines[i + 1] as string;
        const lm = ITEM.exec(l);
        if (isBlank(l)) {
          // A blank line continues the list only if the list goes on after it.
          const after = lines.slice(i + 2).find((x) => !isBlank(x));
          if (after === undefined) break;
          const am = ITEM.exec(after);
          const sibling = am && indentOf(after) <= base + 1 && listKind(am) === kind;
          if (!sibling && indentOf(after) <= base + 1) break;
        } else if (lm && indentOf(l) <= base + 1) {
          if (listKind(lm) !== kind) break;
        } else if (indentOf(l) <= base && startsBlock(l, lines[i + 2])) break;
        block.push(l);
        i++;
      }
      out.push(renderList(block, depth));
      continue;
    }

    if (line.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-')) {
      const heads = splitRow(line);
      const aligns = splitRow(next).map((c) =>
        c.startsWith(':') && c.endsWith(':')
          ? 'center'
          : c.endsWith(':')
            ? 'right'
            : c.startsWith(':')
              ? 'left'
              : '',
      );
      const cell = (tag: string, text: string, col: number) => {
        const a = aligns[col] ? ` style="text-align:${aligns[col]}"` : '';
        return `<${tag}${a}>${renderInline(text)}</${tag}>`;
      };
      const rows: string[] = [];
      i += 2;
      while (
        i < lines.length &&
        (lines[i] as string).includes('|') &&
        !isBlank(lines[i] as string)
      ) {
        const cells = splitRow(lines[i] as string);
        rows.push(`<tr>${heads.map((_, c) => cell('td', cells[c] ?? '', c)).join('')}</tr>`);
        i++;
      }
      i--;
      out.push(
        `<div class="md-table"><table><thead><tr>${heads.map((t, c) => cell('th', t, c)).join('')}</tr></thead>` +
          `<tbody>${rows.join('')}</tbody></table></div>`,
      );
      continue;
    }

    para.push(line);
  }
  flush();
  return out.join('\n');
}

/** Renders a markdown document (frontmatter removed) to HTML that is safe to insert. */
export function renderMarkdown(text: string): string {
  const { body } = splitFrontmatter(text);
  return renderBlocks(body.replace(/\t/g, '    ').split('\n'));
}
