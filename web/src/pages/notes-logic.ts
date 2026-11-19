// Pure helpers for the Notes page (tested in test/notes-logic.test.ts).

export interface Collection {
  id: string;
  name: string;
  private: boolean;
  locked: boolean;
  count: number | null;
  indexed_at: string | null;
  error: string | null;
  capped: boolean;
}

export interface DocSummary {
  id: number;
  collection_id: string;
  path: string;
  title: string;
  date: string | null;
  mtime: string | null;
  size: number | null;
  private: boolean;
}

export interface DocsResponse {
  now: string;
  collections: Collection[];
  documents: DocSummary[];
  total: number;
  limit: number;
}

export interface DocFull extends DocSummary {
  html: string;
  truncated: boolean;
  collection_name: string;
}

export interface DateGroup {
  date: string;
  docs: DocSummary[];
}

/** Today's date (YYYY-MM-DD) in a time zone. */
export function todayIn(timeZone: string, now = Date.now()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

const DAY = 86_400_000;

/** "Today", "Yesterday", "Mon 2 Nov" (this year) or "2 Nov 2025". */
export function dateLabel(date: string | null, today: string): string {
  if (!date) return 'No date';
  const t = Date.parse(`${date}T00:00:00Z`);
  const n = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(t)) return date;
  if (t === n) return 'Today';
  if (t === n - DAY) return 'Yesterday';
  const d = new Date(t);
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: sameYear ? 'short' : undefined,
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric',
  })
    .format(d)
    .replace(',', '');
}

/** Documents in a collection ('' = all) whose title or path holds every search word. */
export function filterDocs(docs: DocSummary[], collection: string, q: string): DocSummary[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return docs.filter((d) => {
    if (collection && d.collection_id !== collection) return false;
    if (!words.length) return true;
    const hay = `${d.title} ${d.path}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Groups documents by date, keeping their order (the API sends newest first). */
export function groupByDate(docs: DocSummary[]): DateGroup[] {
  const out: DateGroup[] = [];
  for (const d of docs) {
    const key = d.date ?? '';
    const last = out[out.length - 1];
    if (last && last.date === key) last.docs.push(d);
    else out.push({ date: key, docs: [d] });
  }
  return out;
}

export function sizeText(n: number | null): string {
  if (n === null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function summaryLine(r: Pick<DocsResponse, 'collections' | 'documents' | 'total'>): string {
  const open = r.collections.filter((c) => !c.locked).length;
  const locked = r.collections.length - open;
  const parts = [
    `${r.total} document${r.total === 1 ? '' : 's'} in ${open} collection${open === 1 ? '' : 's'}`,
  ];
  if (locked) parts.push(`${locked} locked`);
  if (r.total > r.documents.length) parts.push(`showing the newest ${r.documents.length}`);
  return parts.join(' · ');
}
