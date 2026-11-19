// Notes API (SPEC 6): GET /documents?collection=&q=&limit=&refresh=1 and GET /documents/:id.
// Reads are open, except private collections (SPEC 1.3): without a token their documents are
// left out of lists, and asking for one directly is a 401.

import { HttpError, type Route } from '../http/app.ts';
import {
  DocumentReadError,
  ensureIndexed,
  getDocumentRow,
  listDocuments,
  readDocument,
} from './documents.ts';

const PRIVATE_MESSAGE = 'This collection is private; sign in with a token';

export const noteRoutes: Route[] = [
  {
    method: 'GET',
    path: '/documents',
    handler: ({ state, url, token }) => {
      const collection = url.searchParams.get('collection');
      const col = collection ? state.config.documents.find((d) => d.id === collection) : null;
      if (collection && !col)
        throw new HttpError(404, 'not_found', `No document collection "${collection}"`);
      if (col?.private && !token) throw new HttpError(401, 'unauthorized', PRIVATE_MESSAGE);
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw && /^\d+$/.test(limitRaw) ? Number(limitRaw) : undefined;
      // Locked collections are not scanned for someone who cannot read them.
      const signedIn = Boolean(token);
      for (const d of state.config.documents) {
        if (d.private && !signedIn) continue;
        if (collection && d.id !== collection) continue;
        ensureIndexed(state.db, state.config, {
          force: url.searchParams.get('refresh') === '1',
          only: d.id,
        });
      }
      return {
        now: new Date().toISOString(),
        ...listDocuments(state.db, state.config, {
          collection,
          q: url.searchParams.get('q'),
          limit,
          signedIn,
        }),
      };
    },
  },
  {
    method: 'GET',
    path: '/documents/:id',
    handler: ({ state, params, token }) => {
      if (!/^\d+$/.test(params.id ?? ''))
        throw new HttpError(400, 'invalid', 'Document id must be a number');
      const row = getDocumentRow(state.db, Number(params.id));
      const col = row && state.config.documents.find((d) => d.id === row.collection_id);
      if (!row || !col) throw new HttpError(404, 'not_found', `No document ${params.id}`);
      if (col.private && !token) throw new HttpError(401, 'unauthorized', PRIVATE_MESSAGE);
      try {
        return { ...readDocument(row, col), collection_name: col.name };
      } catch (err) {
        if (err instanceof DocumentReadError) throw new HttpError(err.status, 'gone', err.message);
        throw err;
      }
    },
  },
];
