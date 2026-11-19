// Usage API (SPEC 8.5): GET /usage?days=&hours= — tokens by plan and model, runs per day.

import type { Route } from '../http/app.ts';
import { parseUsageQuery, usage } from './usage.ts';

export const usageRoutes: Route[] = [
  {
    method: 'GET',
    path: '/usage',
    handler: ({ state, url }) => usage(state.db, state.config, parseUsageQuery(url.searchParams)),
  },
];
