import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));

export const VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

/** True when the module at `metaFilename` is the script node was started with. */
export function isMain(metaFilename: string): boolean {
  return process.argv[1] !== undefined && realpathOrSelf(process.argv[1]) === metaFilename;
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
