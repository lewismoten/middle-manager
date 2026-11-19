import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createToken } from '../server/auth.ts';
import {
  describeDocument,
  ensureIndexed,
  findFiles,
  globToRegExp,
  indexCollection,
  listDocuments,
  MAX_RENDER_BYTES,
} from '../server/notes/documents.ts';
import { renderInline, renderMarkdown, splitFrontmatter } from '../server/notes/markdown.ts';
import { startServer, type Running } from '../server/server.ts';
import { memoryDb, testConfig } from './helpers.ts';

// ---- Markdown ----

describe('renderMarkdown', () => {
  it('renders the common blocks', () => {
    const html = renderMarkdown(
      [
        '# Title',
        '',
        'Some **bold**, *em*, `code` and ~~gone~~.',
        'Same paragraph.',
        '',
        '- one',
        '- two',
        '  - nested',
        '- [x] done',
        '',
        '1. first',
        '2. second',
        '',
        '> quoted',
        '',
        '```ts',
        'const a = 1 < 2;',
        '```',
        '',
        '| a | b |',
        '|---|--:|',
        '| 1 | 2 |',
        '',
        '---',
      ].join('\n'),
    );
    expect(html).toContain('<h2>Title</h2>'); // shifted under the page h1
    expect(html).toContain(
      '<p>Some <strong>bold</strong>, <em>em</em>, <code>code</code> and <del>gone</del>.\nSame paragraph.</p>',
    );
    expect(html).toMatch(/<ul>\n<li>one<\/li>\n<li>two\n?<ul>\n<li>nested<\/li>\n<\/ul><\/li>/);
    expect(html).toContain('<li class="task"><input type="checkbox" disabled checked> done</li>');
    expect(html).toContain('<ol>\n<li>first</li>\n<li>second</li>\n</ol>');
    expect(html).toContain('<blockquote>\n<p>quoted</p>\n</blockquote>');
    expect(html).toContain('<pre><code class="lang-ts">const a = 1 &lt; 2;</code></pre>');
    expect(html).toContain('<th>a</th><th style="text-align:right">b</th>');
    expect(html).toContain('<td>1</td><td style="text-align:right">2</td>');
    expect(html).toContain('<hr>');
  });

  it('never passes raw HTML or unsafe links through', () => {
    const html = renderMarkdown(
      [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        '[click](javascript:alert(1)) [rel](other.md) [hash](#top)',
        '[ok](https://example.com/a?b=1&c="2") <https://example.com/x>',
        '![pic](https://example.com/p.png) ![local](p.png)',
        '`<b>` **<i>x</i>**',
        '```',
        '</code></pre><script>x</script>',
        '```',
      ].join('\n\n'),
    );
    expect(html).not.toMatch(/<script|<img|<i>|<b>|javascript:|onerror=alert\(1\)>/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<span class="md-link">click</span>');
    expect(html).toContain('<span class="md-link">rel</span>');
    expect(html).toContain('<span class="md-link">hash</span>');
    // Quotes in a URL stop it being a link at all.
    expect(html).not.toContain('href="https://example.com/a?b=1&amp;c=&quot;2&quot;"');
    expect(html).toContain(
      '<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>',
    );
    expect(html).toContain('<span class="md-img">image: pic</span></a>');
    expect(html).toContain('<span class="md-img">image: local</span>');
    expect(html).toContain('<code>&lt;b&gt;</code>');
    // Every tag in the output is one the renderer writes.
    const tags = new Set([...html.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]));
    for (const t of tags)
      expect([
        'p',
        'a',
        'span',
        'code',
        'pre',
        'strong',
        'em',
        'del',
        'br',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'ul',
        'ol',
        'li',
        'input',
        'blockquote',
        'hr',
        'div',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
      ]).toContain(t);
  });

  it('links bare URLs and escapes ampersands in them', () => {
    expect(renderInline('see https://example.com/a?x=1&y=2.')).toBe(
      'see <a href="https://example.com/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">https://example.com/a?x=1&amp;y=2</a>.',
    );
  });

  it('keeps underscores inside words and handles hard breaks', () => {
    expect(renderInline('snake_case_name and _em_')).toBe('snake_case_name and <em>em</em>');
    expect(renderInline('a  \nb')).toBe('a<br>b');
  });

  it('strips frontmatter and reads simple keys', () => {
    const { meta, body } = splitFrontmatter('---\ntitle: "Hello"\ndate: 2026-11-02\n---\n# Body\n');
    expect(meta).toEqual({ title: 'Hello', date: '2026-11-02' });
    expect(body).toBe('# Body\n');
    expect(renderMarkdown('---\ntitle: x\n---\ntext')).toBe('<p>text</p>');
  });
});

// ---- Index ----

describe('globs and descriptions', () => {
  it('matches globs like a shell', () => {
    expect(globToRegExp('*.md').test('a.md')).toBe(true);
    expect(globToRegExp('*.md').test('sub/a.md')).toBe(false);
    expect(globToRegExp('**/*.md').test('a.md')).toBe(true);
    expect(globToRegExp('**/*.md').test('x/y/a.md')).toBe(true);
    expect(globToRegExp('*.{md,txt}').test('a.txt')).toBe(true);
    expect(globToRegExp('log-??.md').test('log-01.md')).toBe(true);
    expect(globToRegExp('a.md').test('aXmd')).toBe(false);
  });

  it('takes the title from frontmatter, a heading or the file name, and the date likewise', () => {
    const m = new Date('2026-11-19T03:00:00Z');
    expect(describeDocument('x.md', '---\ntitle: T\ndate: 2026-10-01\n---\n# H', m, 'UTC')).toEqual(
      { title: 'T', date: '2026-10-01' },
    );
    expect(
      describeDocument('2026-11-02-ops.md', '```\n# not\n```\n## Real *one*', m, 'UTC'),
    ).toEqual({
      title: 'Real one',
      date: '2026-11-02',
    });
    // No heading, no date in the name: file name and the modified day in the site zone.
    expect(describeDocument('notes.md', 'plain', m, 'America/New_York')).toEqual({
      title: 'notes',
      date: '2026-11-18',
    });
    expect(describeDocument('2026-13-40.md', '', m, 'UTC').date).toBe('2026-11-19');
  });
});

describe('indexing a collection', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mm-notes-'));
    mkdirSync(path.join(dir, 'pub', 'sub'), { recursive: true });
    mkdirSync(path.join(dir, 'pub', '.hidden'));
    mkdirSync(path.join(dir, 'priv'));
    writeFileSync(path.join(dir, 'pub', '2026-11-01-first.md'), '# First log\nbody');
    writeFileSync(path.join(dir, 'pub', '2026-11-03-second.md'), '# Second log\n');
    writeFileSync(path.join(dir, 'pub', 'sub', 'deep.md'), '# Deep\n');
    writeFileSync(path.join(dir, 'pub', '.hidden', 'x.md'), '# Hidden\n');
    writeFileSync(path.join(dir, 'pub', 'skip.txt'), 'no');
    writeFileSync(path.join(dir, 'priv', 'secret.md'), '# Secret plan\n');
    writeFileSync(path.join(dir, 'outside.md'), '# Outside\n');
    symlinkSync(path.join(dir, 'outside.md'), path.join(dir, 'pub', 'escape.md'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const config = () =>
    testConfig({
      documents: [
        { id: 'pub', name: 'Public', path: path.join(dir, 'pub') },
        { id: 'deep', name: 'Deep', path: path.join(dir, 'pub'), glob: '**/*.md' },
        { id: 'priv', name: 'Private', path: path.join(dir, 'priv'), private: true },
        { id: 'gone', name: 'Missing', path: path.join(dir, 'nope') },
      ],
    });

  it('finds matching files, skipping dot folders and symlinks that leave the folder', () => {
    const top = findFiles(path.join(dir, 'pub'), '*.md')
      .map((f) => f.rel)
      .sort();
    expect(top).toEqual(['2026-11-01-first.md', '2026-11-03-second.md']);
    const deep = findFiles(path.join(dir, 'pub'), '**/*.md')
      .map((f) => f.rel)
      .sort();
    expect(deep).toEqual(['2026-11-01-first.md', '2026-11-03-second.md', 'sub/deep.md']);
  });

  it('adds, updates and removes rows to mirror the folder', () => {
    const cfg = config();
    const db = memoryDb(cfg);
    const col = cfg.documents[0]!;
    expect(indexCollection(db, col, 'UTC')).toMatchObject({ ok: true, files: 2, added: 2 });
    expect(indexCollection(db, col, 'UTC')).toMatchObject({ added: 0, updated: 0, removed: 0 });
    const f = path.join(dir, 'pub', '2026-11-01-first.md');
    writeFileSync(f, '# First log, renamed\n');
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(indexCollection(db, col, 'UTC')).toMatchObject({ updated: 1 });
    const titles = listDocuments(db, cfg, { signedIn: false, collection: 'pub' }).documents.map(
      (d) => d.title,
    );
    expect(titles).toEqual(['Second log', 'First log, renamed']); // newest date first
    rmSync(path.join(dir, 'pub', '2026-11-03-second.md'));
    expect(indexCollection(db, col, 'UTC')).toMatchObject({ removed: 1, files: 1 });
    writeFileSync(path.join(dir, 'pub', '2026-11-03-second.md'), '# Second log\n');
  });

  it('reports a missing folder without dropping rows, and prunes removed collections', () => {
    const cfg = config();
    const db = memoryDb(cfg);
    db.prepare(
      "INSERT INTO documents (collection_id, path, title) VALUES ('gone','a.md','A'), ('old','b.md','B')",
    ).run();
    const scans = ensureIndexed(db, cfg);
    expect(scans.get('gone')).toMatchObject({ ok: false, error: 'folder not found' });
    const ids = db.prepare('SELECT DISTINCT collection_id AS c FROM documents ORDER BY c').all();
    expect(ids.map((r) => r.c)).toEqual(['deep', 'gone', 'priv', 'pub']);
  });

  it('hides private collections without a token', () => {
    const cfg = config();
    const db = memoryDb(cfg);
    ensureIndexed(db, cfg);
    const anon = listDocuments(db, cfg, { signedIn: false });
    expect(anon.collections.find((c) => c.id === 'priv')).toMatchObject({
      locked: true,
      count: null,
    });
    expect(anon.documents.some((d) => d.collection_id === 'priv')).toBe(false);
    const signed = listDocuments(db, cfg, { signedIn: true, q: 'secret' });
    expect(signed.documents.map((d) => d.title)).toEqual(['Secret plan']);
    expect(listDocuments(db, cfg, { signedIn: true, q: '100%_' }).total).toBe(0);
  });
});

// ---- API ----

describe('documents API', () => {
  let dir: string;
  let running: Running;
  let token: string;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'mm-notes-api-'));
    mkdirSync(path.join(dir, 'pub'));
    mkdirSync(path.join(dir, 'priv'));
    writeFileSync(path.join(dir, 'pub', '2026-11-05-log.md'), '# Log\n\n<b>hi</b> **there**');
    writeFileSync(path.join(dir, 'pub', 'big.md'), `# Big\n${'x'.repeat(MAX_RENDER_BYTES + 10)}`);
    writeFileSync(path.join(dir, 'priv', 'p.md'), '# Private one\n');
    const config = testConfig({
      documents: [
        { id: 'pub', name: 'Public', path: path.join(dir, 'pub') },
        { id: 'priv', name: 'Private', path: path.join(dir, 'priv'), private: true },
      ],
    });
    const db = memoryDb(config);
    token = createToken(db, 'reader', ['write']).token;
    running = await startServer({
      config,
      db,
      port: 0,
      host: '127.0.0.1',
      retention: false,
      agentCollectors: false,
      schedules: false,
      log: () => {},
    });
  });
  afterAll(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (p: string, auth = false) =>
    fetch(`${running.url}/api/v1${p}`, {
      headers: auth ? { authorization: `Bearer ${token}` } : {},
    });

  it('lists open documents and locks private collections', async () => {
    const res = await get('/documents');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      collections: { id: string; locked: boolean }[];
      documents: { id: number; title: string; collection_id: string }[];
    };
    expect(body.collections.map((c) => [c.id, c.locked])).toEqual([
      ['pub', false],
      ['priv', true],
    ]);
    expect(body.documents.map((d) => d.title).sort()).toEqual(['Big', 'Log']);
    expect((await get('/documents?collection=priv')).status).toBe(401);
    expect((await get('/documents?collection=nope')).status).toBe(404);
    const signed = (await (await get('/documents?collection=priv', true)).json()) as typeof body;
    expect(signed.documents.map((d) => d.title)).toEqual(['Private one']);
  });

  it('renders a document from disk, gates private ones and caps size', async () => {
    const list = (await (await get('/documents', true)).json()) as {
      documents: { id: number; title: string }[];
    };
    const id = (t: string) => list.documents.find((d) => d.title === t)!.id;
    const doc = (await (await get(`/documents/${id('Log')}`)).json()) as {
      html: string;
      truncated: boolean;
      collection_name: string;
    };
    expect(doc.html).toBe('<h2>Log</h2>\n<p>&lt;b&gt;hi&lt;/b&gt; <strong>there</strong></p>');
    expect(doc.truncated).toBe(false);
    expect(doc.collection_name).toBe('Public');
    const big = (await (await get(`/documents/${id('Big')}`)).json()) as { truncated: boolean };
    expect(big.truncated).toBe(true);
    expect((await get(`/documents/${id('Private one')}`)).status).toBe(401);
    expect((await get(`/documents/${id('Private one')}`, true)).status).toBe(200);
    expect((await get('/documents/99999')).status).toBe(404);
    expect((await get('/documents/abc')).status).toBe(400);
    rmSync(path.join(dir, 'pub', '2026-11-05-log.md'));
    expect((await get(`/documents/${id('Log')}`)).status).toBe(404);
  });
});
