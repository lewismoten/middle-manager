// `middle-manager import <collector>`: run one plan collector now.
//   import <plan-id>                            anthropic-oauth / codex-sessions plans
//   import <plan-id> --used 42 [--resets-at ISO] [--window weekly] [--at ISO]   manual reading
//   import csv-import --file readings.csv [--map claude=my-plan,codex=other]
//   import <csv-collector-id>                   a configured collector of kind csv-import

import { flagString, type Args } from '../args.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { CollectorError } from './collectors.ts';
import {
  CollectorInputError,
  planCollectorIds,
  resolveCollector,
  runCollector,
  type CollectorInput,
} from './service.ts';

export const IMPORT_USAGE = `  import <collector> [options]  Run one plan collector now. <collector> is a plan id,
                                csv-import, or a configured csv-import collector
      --file <csv>              CSV of time,source,machine,window,used_pct,resets_at,how
      --map src=plan,...        Map CSV sources to plan ids
      --used <pct> [--resets-at <iso>] [--window weekly|five_hour] [--at <iso>]
                                Add a manual reading to a plan`;

export function parseMap(s: string | undefined): Record<string, string> | undefined {
  if (!s) return undefined;
  const out: Record<string, string> = {};
  for (const pair of s.split(',')) {
    const [k, v] = pair.split('=').map((x) => x.trim());
    if (!k || !v)
      throw new CollectorInputError(`--map entries look like source=plan (got "${pair}")`);
    out[k] = v;
  }
  return out;
}

export async function importCommand(
  db: Db,
  config: Config,
  id: string | undefined,
  args: Args,
  out: (line: string) => void,
): Promise<number> {
  if (!id) {
    out(
      `Usage: middle-manager import <collector>\nCollectors: ${planCollectorIds(config).join(', ')}`,
    );
    return 2;
  }
  const target = resolveCollector(config, id);
  if (!target) {
    out(`No plan collector "${id}". Collectors: ${planCollectorIds(config).join(', ')}`);
    return 2;
  }
  const input: CollectorInput = {
    file: flagString(args, 'file'),
    map: parseMap(flagString(args, 'map')),
  };
  const used = flagString(args, 'used');
  if (used !== undefined) {
    input.reading = {
      used_pct: used,
      resets_at: flagString(args, 'resets-at'),
      window: flagString(args, 'window'),
      read_at: flagString(args, 'at'),
    };
  }
  try {
    const r = await runCollector(db, config, target, input);
    out(`${r.collector} (${r.kind}): added ${r.added}, skipped ${r.skipped}`);
    for (const x of r.readings) {
      out(
        `  ${x.window.padEnd(9)} ${String(x.used_pct).padStart(5)}%  resets ${x.resets_at ?? '?'}  read ${x.read_at}`,
      );
    }
    for (const n of r.notes) out(`  note: ${n}`);
    return 0;
  } catch (err) {
    if (err instanceof CollectorError || err instanceof CollectorInputError) {
      out(`${id}: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
