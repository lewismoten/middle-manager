import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { API_PREFIX } from '../server/http/app.ts';
import { startServer } from '../server/server.ts';
import { testConfig } from './helpers.ts';

test('the served OpenAPI document matches every registered method and path', async () => {
  const app = await startServer({
    config: testConfig(),
    host: '127.0.0.1',
    port: 6189,
    retention: false,
    agentCollectors: false,
    schedules: false,
  });
  try {
    const response = await fetch(app.url + API_PREFIX + '/openapi.yaml');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^(application|text)\/yaml\b/);
    const doc = parse(await response.text());
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.servers).toContainEqual({ url: API_PREFIX });
    const documented = Object.entries(doc.paths as Record<string, object>).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((key) => /^(get|put|post|delete|options|head|patch|trace)$/.test(key))
        .map((method) => method.toUpperCase() + ' ' + path),
    );
    const registered = app.routes.map(({ method, path }) => ({
      method,
      path: path.replace(/:([^/]+)/g, '{$1}'),
    }));
    expect(documented.sort()).toEqual(
      registered.map(({ method, path }) => method + ' ' + path).sort(),
    );
    expect(Object.keys(doc.paths).sort()).toEqual(
      [...new Set(registered.map(({ path }) => path))].sort(),
    );
  } finally {
    await app.close();
  }
});
