import { describe, expect, it } from 'vitest';
import {
  dateLabel,
  filterDocs,
  groupByDate,
  sizeText,
  summaryLine,
  todayIn,
  type Collection,
  type DocSummary,
} from '../web/src/pages/notes-logic.ts';

const doc = (id: number, extra: Partial<DocSummary> = {}): DocSummary => ({
  id,
  collection_id: 'logs',
  path: `${id}.md`,
  title: `Doc ${id}`,
  date: '2026-11-19',
  mtime: null,
  size: 10,
  private: false,
  ...extra,
});

const col = (id: string, extra: Partial<Collection> = {}): Collection => ({
  id,
  name: id,
  private: false,
  locked: false,
  count: 0,
  indexed_at: null,
  error: null,
  capped: false,
  ...extra,
});

describe('notes logic', () => {
  it('labels dates relative to today', () => {
    expect(dateLabel('2026-11-19', '2026-11-19')).toBe('Today');
    expect(dateLabel('2026-11-18', '2026-11-19')).toBe('Yesterday');
    expect(dateLabel('2026-11-02', '2026-11-19')).toBe('Mon 2 Nov');
    expect(dateLabel('2025-12-31', '2026-01-02')).toBe('31 Dec 2025');
    expect(dateLabel(null, '2026-11-19')).toBe('No date');
    expect(dateLabel('garbage', '2026-11-19')).toBe('garbage');
  });

  it('finds today in the site zone', () => {
    const t = Date.parse('2026-11-19T03:00:00Z');
    expect(todayIn('UTC', t)).toBe('2026-11-19');
    expect(todayIn('America/New_York', t)).toBe('2026-11-18');
    expect(todayIn('Not/AZone', t)).toBe('2026-11-19');
  });

  it('filters by collection and every search word, in title or path', () => {
    const docs = [
      doc(1, { title: 'Deploy notes' }),
      doc(2, { title: 'Weekly summary', collection_id: 'other' }),
      doc(3, { title: 'Misc', path: 'deploy/rollback.md' }),
    ];
    expect(filterDocs(docs, '', '').map((d) => d.id)).toEqual([1, 2, 3]);
    expect(filterDocs(docs, '', 'DEPLOY').map((d) => d.id)).toEqual([1, 3]);
    expect(filterDocs(docs, '', 'deploy roll').map((d) => d.id)).toEqual([3]);
    expect(filterDocs(docs, 'other', '').map((d) => d.id)).toEqual([2]);
  });

  it('groups consecutive documents by date', () => {
    const groups = groupByDate([
      doc(1, { date: '2026-11-19' }),
      doc(2, { date: '2026-11-19' }),
      doc(3, { date: '2026-11-17' }),
      doc(4, { date: null }),
    ]);
    expect(groups.map((g) => [g.date, g.docs.length])).toEqual([
      ['2026-11-19', 2],
      ['2026-11-17', 1],
      ['', 1],
    ]);
  });

  it('formats sizes and the summary', () => {
    expect(sizeText(512)).toBe('512 B');
    expect(sizeText(2048)).toBe('2.0 KB');
    expect(sizeText(null)).toBe('');
    expect(
      summaryLine({
        collections: [col('a'), col('b', { locked: true, private: true })],
        documents: [doc(1)],
        total: 3,
      }),
    ).toBe('3 documents in 1 collection · 1 locked · showing the newest 1');
  });
});
