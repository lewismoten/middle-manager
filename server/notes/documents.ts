// Document index for the Notes page (SPEC 5, 6, 8.7). Each configured collection is a folder of
// markdown files matched by a glob. The `documents` table holds only an index (path, title, date,
// mtime, size); file contents are read from disk on request and never copied into the DB.
//
// Bounded growth (SPEC 1.4): the index mirrors the folders, so rows for deleted files and for
// collections removed from config are dropped on the next scan, and a collection is capped at
// MAX_DOCS_PER_COLLECTION files (newest kept). Rendering reads at most MAX_RENDER_BYTES.

import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { expandHome, type Config, type DocumentCollectionConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { renderMarkdown, splitFrontmatter } from './markdown.ts';

export const MAX_DOCS_PER_COLLECTION = 5000;
export const MAX_RENDER_BYTES = 512 * 1024;
const HEAD_BYTES = 8 * 1024;
const MAX_DEPTH = 8;
/** A collection is rescanned on read when its last scan is older than this. */
export const RESCAN_MS = 30_000;

export interface DocumentRow {
  id: number;
  collection_id: string;
  path: string;
  title: string | null;
  date: string | null;
  mtime: string | null;
  size: number | null;
  private: number;
}

export interface ScanResult {
  collection: string;
  at: string;
  ok: boolean;
  error: string | null;
  files: number;
  added: number;
  updated: number;
  removed: number;
  capped: boolean;
}

// ---- Globs ----

/** `*` (not across folders), `**` (any folders), `?`, `{a,b}`. Matched against a/b/c.md paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:[^/]+/)*';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) re += '\\{';
      else {
        const alts = glob
          .slice(i + 1, end)
          .split(',')
          .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        re += `(?:${alts.join('|')})`;
        i = end;
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// ---- Titles and dates ----

const DATE_IN_NAME = /(?:^|[^\d])(\d{4})-(\d{2})-(\d{2})(?!\d)/;

function validDate(y: string, m: string, d: string): string | null {
  const s = `${y}-${m}-${d}`;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s ? null : s;
}

/** The calendar date of an instant in a time zone, as YYYY-MM-DD. */
export function localDate(t: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(t);
  } catch {
    return t.toISOString().slice(0, 10);
  }
}

/**
 * Title: frontmatter `title`, else the first heading, else the file name. Date: frontmatter
 * `date`, else a YYYY-MM-DD in the file name, else the file's modified day in the site zone.
 */
export function describeDocument(
  relPath: string,
  head: string,
  mtime: Date,
  timeZone: string,
): { title: string; date: string } {
  const { meta, body } = splitFrontmatter(head);
  const base = path.posix.basename(relPath).replace(/\.(md|markdown|txt)$/i, '');
  let title = meta.title?.trim() || '';
  if (!title) {
    let fenced = false;
    for (const line of body.split('\n')) {
      if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced;
      const m = fenced ? null : /^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/.exec(line);
      if (m?.[1]) {
        title = m[1].replace(/[*_`]/g, '').trim();
        break;
      }
    }
  }
  if (!title) title = base;
  let date: string | null = null;
  const fm = meta.date ? /^(\d{4})-(\d{2})-(\d{2})/.exec(meta.date) : null;
  if (fm) date = validDate(fm[1] as string, fm[2] as string, fm[3] as string);
  if (!date) {
    const m = DATE_IN_NAME.exec(path.posix.basename(relPath));
    if (m) date = validDate(m[1] as string, m[2] as string, m[3] as string);
  }
  return { title: title.slice(0, 300), date: date ?? localDate(mtime, timeZone) };
}

function readHead(file: string, bytes = HEAD_BYTES): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// ---- Scanning ----

export function collectionRoot(col: DocumentCollectionConfig, base = process.cwd()): string {
  return path.resolve(base, expandHome(col.path));
}

interface Found {
  rel: string;
  abs: string;
  size: number;
  mtime: Date;
}

function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Files under root whose relative path matches the glob. Skips dot folders and escapes. */
export function findFiles(root: string, glob: string): Found[] {
  const re = globToRegExp(glob);
  const deep = glob.includes('/');
  const realRoot = realpathSync(root);
  const out: Found[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (deep && depth < MAX_DEPTH && e.name !== 'node_modules') walk(abs, r, depth + 1);
        continue;
      }
      if (!(e.isFile() || e.isSymbolicLink()) || !re.test(r)) continue;
      try {
        // A symlink must point at a regular file inside the collection folder.
        if (e.isSymbolicLink() && !isInside(realRoot, realpathSync(abs))) continue;
        const st = statSync(abs);
        if (!st.isFile()) continue;
        out.push({ rel: r, abs, size: st.size, mtime: st.mtime });
      } catch {
        continue;
      }
    }
  };
  walk(realRoot, '', 0);
  return out;
}

/** Rescans one collection into the index. Errors (missing folder) are reported, not thrown. */
export function indexCollection(
  db: Db,
  col: DocumentCollectionConfig,
  timeZone: string,
  now = new Date(),
): ScanResult {
  const result: ScanResult = {
    collection: col.id,
    at: now.toISOString(),
    ok: true,
    error: null,
    files: 0,
    added: 0,
    updated: 0,
    removed: 0,
    capped: false,
  };
  const root = collectionRoot(col);
  let found: Found[];
  try {
    if (!statSync(root).isDirectory()) throw Object.assign(new Error(), { code: 'ENOTDIR' });
    found = findFiles(root, col.glob);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    result.ok = false;
    result.error =
      code === 'ENOENT'
        ? 'folder not found'
        : code === 'ENOTDIR'
          ? 'path is not a folder'
          : `folder could not be read (${code ?? 'error'})`;
    // Keep the old rows: a missing mount should not wipe the index.
    return result;
  }
  found.sort((a, b) => b.mtime.getTime() - a.mtime.getTime() || a.rel.localeCompare(b.rel));
  if (found.length > MAX_DOCS_PER_COLLECTION) {
    found = found.slice(0, MAX_DOCS_PER_COLLECTION);
    result.capped = true;
  }
  result.files = found.length;

  const existing = new Map(
    (
      db
        .prepare('SELECT id, path, mtime, size, private FROM documents WHERE collection_id = ?')
        .all(col.id) as unknown as Pick<DocumentRow, 'id' | 'path' | 'mtime' | 'size' | 'private'>[]
    ).map((r) => [r.path, r]),
  );
  const insert = db.prepare(
    `INSERT INTO documents (collection_id, path, title, date, mtime, size, private)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    'UPDATE documents SET title = ?, date = ?, mtime = ?, size = ?, private = ? WHERE id = ?',
  );
  const setPrivate = db.prepare('UPDATE documents SET private = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM documents WHERE id = ?');
  const priv = col.private ? 1 : 0;

  db.exec('BEGIN');
  try {
    for (const f of found) {
      const mtime = f.mtime.toISOString();
      const old = existing.get(f.rel);
      existing.delete(f.rel);
      if (old && old.mtime === mtime && old.size === f.size) {
        if (old.private !== priv) setPrivate.run(priv, old.id);
        continue;
      }
      let head = '';
      try {
        head = readHead(f.abs);
      } catch {
        /* unreadable: index by file name */
      }
      const { title, date } = describeDocument(f.rel, head, f.mtime, timeZone);
      if (old) {
        update.run(title, date, mtime, f.size, priv, old.id);
        result.updated++;
      } else {
        insert.run(col.id, f.rel, title, date, mtime, f.size, priv);
        result.added++;
      }
    }
    for (const gone of existing.values()) {
      remove.run(gone.id);
      result.removed++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return result;
}

// ---- Freshness: scan on read, at most every RESCAN_MS per collection ----

const lastScans = new WeakMap<Db, Map<string, ScanResult>>();

function scansFor(db: Db): Map<string, ScanResult> {
  let m = lastScans.get(db);
  if (!m) lastScans.set(db, (m = new Map()));
  return m;
}

/** Drops rows of collections that are no longer configured. */
export function pruneRemovedCollections(db: Db, config: Config): number {
  const ids = config.documents.map((d) => d.id);
  const marks = ids.map(() => '?').join(',');
  const sql = ids.length
    ? `DELETE FROM documents WHERE collection_id NOT IN (${marks})`
    : 'DELETE FROM documents';
  return Number(db.prepare(sql).run(...ids).changes);
}

export function ensureIndexed(
  db: Db,
  config: Config,
  opts: { force?: boolean; now?: Date; only?: string } = {},
): Map<string, ScanResult> {
  const now = opts.now ?? new Date();
  const scans = scansFor(db);
  if (!scans.size) pruneRemovedCollections(db, config);
  for (const col of config.documents) {
    if (opts.only && col.id !== opts.only) continue;
    const last = scans.get(col.id);
    if (!opts.force && last && now.getTime() - Date.parse(last.at) < RESCAN_MS) continue;
    scans.set(col.id, indexCollection(db, col, config.site.timezone, now));
  }
  return scans;
}

// ---- Views ----

export interface CollectionView {
  id: string;
  name: string;
  private: boolean;
  /** Private and the request has no token: nothing about its documents is returned. */
  locked: boolean;
  count: number | null;
  indexed_at: string | null;
  error: string | null;
  capped: boolean;
}

export interface DocumentView {
  id: number;
  collection_id: string;
  path: string;
  title: string;
  date: string | null;
  mtime: string | null;
  size: number | null;
  private: boolean;
}

function view(r: DocumentRow): DocumentView {
  return {
    id: r.id,
    collection_id: r.collection_id,
    path: r.path,
    title: r.title ?? r.path,
    date: r.date,
    mtime: r.mtime,
    size: r.size,
    private: Boolean(r.private),
  };
}

export interface ListOptions {
  collection?: string | null;
  q?: string | null;
  limit?: number;
  signedIn: boolean;
}

/** Collections (with lock state) and documents newest first, filtered by collection and title. */
export function listDocuments(db: Db, config: Config, opts: ListOptions) {
  const scans = scansFor(db);
  const open = config.documents.filter((d) => opts.signedIn || !d.private);
  const counts = new Map(
    (
      db
        .prepare('SELECT collection_id AS id, COUNT(*) AS n FROM documents GROUP BY collection_id')
        .all() as { id: string; n: number }[]
    ).map((r) => [r.id, Number(r.n)]),
  );
  const collections: CollectionView[] = config.documents.map((d) => {
    const locked = d.private && !opts.signedIn;
    const s = scans.get(d.id);
    return {
      id: d.id,
      name: d.name,
      private: d.private,
      locked,
      count: locked ? null : (counts.get(d.id) ?? 0),
      indexed_at: locked ? null : (s?.at ?? null),
      error: locked ? null : (s?.error ?? null),
      capped: locked ? false : (s?.capped ?? false),
    };
  });

  const ids = open.map((d) => d.id).filter((id) => !opts.collection || id === opts.collection);
  const limit = Math.min(Math.max(1, opts.limit ?? 500), 2000);
  let documents: DocumentView[] = [];
  let total = 0;
  if (ids.length) {
    const where = [`collection_id IN (${ids.map(() => '?').join(',')})`];
    const args: (string | number)[] = [...ids];
    const q = opts.q?.trim();
    if (q) {
      where.push("(title LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')");
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      args.push(like, like);
    }
    const w = where.join(' AND ');
    total = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE ${w}`).get(...args) as { n: number })
        .n,
    );
    documents = (
      db
        .prepare(
          `SELECT * FROM documents WHERE ${w}
            ORDER BY date DESC, mtime DESC, path ASC LIMIT ?`,
        )
        .all(...args, limit) as unknown as DocumentRow[]
    ).map(view);
  }
  return { collections, documents, total, limit };
}

export function getDocumentRow(db: Db, id: number): DocumentRow | null {
  return (
    (db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as unknown as
      DocumentRow | undefined) ?? null
  );
}

export class DocumentReadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Reads a document from disk (inside its collection folder only) and renders it. */
export function readDocument(row: DocumentRow, col: DocumentCollectionConfig) {
  const root = collectionRoot(col);
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(path.join(realRoot, ...row.path.split('/')));
  } catch {
    throw new DocumentReadError(404, 'The file is no longer there');
  }
  if (!isInside(realRoot, real)) throw new DocumentReadError(404, 'The file is no longer there');
  let st;
  try {
    st = statSync(real);
  } catch {
    throw new DocumentReadError(404, 'The file is no longer there');
  }
  if (!st.isFile()) throw new DocumentReadError(404, 'The file is no longer there');
  const truncated = st.size > MAX_RENDER_BYTES;
  let text = readHead(real, Math.min(st.size, MAX_RENDER_BYTES));
  // Do not end on half a multi-byte character.
  if (truncated) text = text.replace(/�$/, '');
  return {
    ...view(row),
    mtime: st.mtime.toISOString(),
    size: st.size,
    truncated,
    html: renderMarkdown(text),
  };
}
