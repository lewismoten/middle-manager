// Connections API: GET /connections (?refresh=1 re-checks local models now). Open to read;
// file paths and URLs are included only for signed-in requests.

import type { Route } from '../http/app.ts';
import { connections } from './checks.ts';

export const connectionRoutes: Route[] = [
  {
    method: 'GET',
    path: '/connections',
    handler: ({ state, url, token }) =>
      connections(state.db, state.config, {
        refresh: url.searchParams.get('refresh') === '1',
        signedIn: Boolean(token),
      }),
  },
];
