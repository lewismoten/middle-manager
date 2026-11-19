// CSV import of existing plan readings. Columns (header row required, any order):
//   time,source,machine,window,used_pct,resets_at,how
// `source` is a plan id, or mapped to one with { "claude": "my-plan" }. Rows for unknown plans,
// other windows (e.g. weekly_opus) or without a usage number are skipped and counted.

import { PLAN_WINDOWS } from '../config.ts';
import { parseReading, ReadingError, type NewReading } from './store.ts';

export const CSV_COLUMNS = ['time', 'source', 'machine', 'window', 'used_pct', 'resets_at', 'how'];
export const MAX_CSV_BYTES = 20 * 1024 * 1024;

/** RFC 4180-ish: commas, double-quoted fields with "" escapes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface CsvImportResult {
  readings: NewReading[];
  rows: number;
  skipped: { unknown_plan: number; other_window: number; invalid: number };
  errors: string[];
}

export function readingsFromCsv(
  text: string,
  planIds: string[],
  map: Record<string, string> = {},
): CsvImportResult {
  const out: CsvImportResult = {
    readings: [],
    rows: 0,
    skipped: { unknown_plan: 0, other_window: 0, invalid: 0 },
    errors: [],
  };
  const [header, ...rows] = parseCsv(text.replace(/^\uFEFF/, ''));
  if (!header) return out;
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const missing = ['time', 'source', 'window', 'used_pct'].filter((c) => col[c] === undefined);
  if (missing.length) {
    throw new ReadingError(
      `CSV header is missing ${missing.join(', ')} (expected ${CSV_COLUMNS.join(',')})`,
    );
  }
  const known = new Set(planIds);
  const get = (r: string[], c: string) => (col[c] === undefined ? '' : (r[col[c]] ?? '').trim());
  rows.forEach((r, i) => {
    out.rows++;
    const source = get(r, 'source');
    const plan = map[source] ?? source;
    if (!known.has(plan)) return void out.skipped.unknown_plan++;
    const window = get(r, 'window');
    if (!(PLAN_WINDOWS as readonly string[]).includes(window)) {
      return void out.skipped.other_window++;
    }
    if (!get(r, 'used_pct')) return void out.skipped.invalid++;
    try {
      if (!get(r, 'time')) throw new ReadingError('time is empty');
      out.readings.push(
        parseReading(
          {
            window,
            used_pct: get(r, 'used_pct'),
            resets_at: get(r, 'resets_at'),
            read_at: get(r, 'time'),
            machine_id: get(r, 'machine'),
            how: get(r, 'how'),
          },
          plan,
          { read_at: '', how: 'csv-import', machine_id: null },
        ),
      );
    } catch (err) {
      if (err instanceof ReadingError) {
        out.skipped.invalid++;
        if (out.errors.length < 10) out.errors.push(`row ${i + 2}: ${err.message}`);
      } else throw err;
    }
  });
  return out;
}
