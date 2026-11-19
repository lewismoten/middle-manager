// Serves the built UI from dist/web. The UI uses hash routes, so only real files are served;
// anything else that looks like a page falls back to index.html.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
};

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function fileAt(p: string): Promise<number | null> {
  try {
    const s = await stat(p);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  root: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    return plain(res, 405, 'Method not allowed');
  }
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return plain(res, 400, 'Bad path');
  }
  if (rel.includes('\0')) return plain(res, 400, 'Bad path');
  const base = path.resolve(root);
  let file = path.resolve(base, `.${rel}`);
  if (file !== base && !file.startsWith(base + path.sep)) return plain(res, 404, 'Not found');
  if (rel.endsWith('/')) file = path.join(file, 'index.html');

  let size = await fileAt(file);
  if (size === null) {
    // Asset-looking paths (with an extension) are a real 404; anything else gets the app shell.
    if (path.extname(rel)) return plain(res, 404, 'Not found');
    file = path.join(base, 'index.html');
    size = await fileAt(file);
    if (size === null) {
      return plain(res, 503, 'The web UI is not built yet. Run: npm run build');
    }
  }
  const ext = path.extname(file);
  const immutable = file.startsWith(path.join(base, 'assets') + path.sep);
  res.writeHead(200, {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}
