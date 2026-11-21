// Usage page with seeded runs (e2e/fixtures/usage.ts and agents.ts), at every width and theme:
// stacked token charts, runs per day, the plan/model table, cost notes and the measure toggle.

import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const SHOTS = 'test-results/screenshots';
mkdirSync(SHOTS, { recursive: true });

function watch(page: Page, origin: string) {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  page.on('request', (r) => {
    if (!r.url().startsWith(origin) && !r.url().startsWith('data:'))
      problems.push(`off-origin request: ${r.url()}`);
  });
  return problems;
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('usage: tokens by plan and model, runs per day, cost notes', async ({
  page,
  baseURL,
}, info) => {
  const problems = watch(page, baseURL as string);
  await page.goto('/#/usage');
  await expect(page.locator('h1#page-title')).toHaveText('Usage');
  await expect(page.locator('.tabs a[aria-current="page"]')).toHaveText('Usage');

  // Seeded: plan-a large and small (claude-code + agents fixture), plan-b medium (codex).
  const rows = page.locator('table.usage-table tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Plan A');
  const codex = page.locator('tr[data-key="plan-b|medium"]');
  await expect(codex).toContainText('Plan B');
  expect(Number(await codex.locator('td').nth(1).textContent())).toBeGreaterThanOrEqual(20);
  await expect(page.locator('#usage-summary')).toContainText(
    /tokens \(in \+ out\) · \d+ runs started · 2 plans/,
  );

  const daily = page.locator('#usage-daily-chart svg[role="img"]');
  await expect(daily).toBeVisible();
  await expect(daily).toHaveAttribute('aria-label', /per day for the last 14 days/);
  expect(await page.locator('#usage-daily-chart rect.seg').count()).toBeGreaterThan(10);
  await expect(page.locator('#usage-daily .usage-legend li')).toHaveCount(3);
  await expect(page.locator('#usage-hourly-chart svg[role="img"]')).toBeVisible();
  await expect(page.locator('#usage-runs-chart svg[role="img"]')).toBeVisible();
  await expect(page.locator('#usage-runs .usage-legend li')).toHaveCount(2); // claude-code, codex
  await expect(page.locator('.cost-notes li')).toHaveCount(2);
  await expect(page.locator('.cost-notes')).toContainText('Retried twice after a rate limit.');

  // Hovering a bar shows its breakdown.
  const hits = page.locator('#usage-daily-chart rect.hit');
  await expect(hits).toHaveCount(14);
  await hits.nth(13).hover();
  await expect(page.locator('#usage-daily-chart .usage-tip')).toBeVisible();
  await expect(page.locator('#usage-daily-chart .usage-tip')).toContainText('Total');

  // The measure toggle re-counts without reloading; with cache the totals are far larger.
  const counted = page.locator('tr[data-key="plan-b|medium"] td.strong');
  const before = Number((await counted.textContent())?.replace(/,/g, ''));
  await page.getByLabel('All, with cache').check();
  await expect(page.locator('#usage-summary')).toContainText('(with cache)');
  const after = Number((await counted.textContent())?.replace(/,/g, ''));
  expect(after).toBeGreaterThan(before * 5);

  // Range: 7 days has fewer daily bars.
  await page.locator('#usage-days').selectOption('7');
  await expect(page.locator('#usage-daily-chart rect.hit')).toHaveCount(7);

  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/usage-${info.project.name}.png`, fullPage: true });
  expect(problems).toEqual([]);
});
