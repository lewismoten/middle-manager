import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { TABS } from '../web/src/tabs.ts';

const SHOTS = 'test-results/screenshots';
mkdirSync(SHOTS, { recursive: true });

/** Collects console errors, page errors, failed requests and any request off this origin. */
function watch(page: Page, origin: string) {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`failed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  page.on('request', (r) => {
    if (!r.url().startsWith(origin) && !r.url().startsWith('data:')) {
      problems.push(`off-origin request: ${r.url()}`);
    }
  });
  return problems;
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

// Pages that are built have their own <page>.smoke.spec.ts.
const BUILT = new Set(['agents', 'schedules', 'notes', 'connections']);

for (const tab of TABS.filter((t) => !BUILT.has(t.id))) {
  test(`${tab.id} renders without overflow or errors`, async ({ page, baseURL }, info) => {
    const problems = watch(page, baseURL as string);
    await page.goto(`/#/${tab.id}`);
    await expect(page.locator('h1#page-title')).toHaveText(tab.title);
    await expect(page.locator('#site-name')).toHaveText('Test fleet');
    await expect(page.locator(`.tabs a[aria-current="page"]`)).toHaveText(tab.label);
    if (tab.id === 'burndown') {
      // Populated from e2e/seed.ts: Plan A has a live week, past weeks and a 5-hour window.
      await expect(page.locator('.weekly svg[role="img"]')).toBeVisible();
      await expect(page.locator('.weekly .used')).toHaveCount(1);
      await expect(page.locator('.weekly .even')).toHaveCount(1);
      await expect(page.locator('.weekly .proj')).toHaveCount(1);
      await expect(page.locator('.weekly .now')).toHaveCount(1);
      await expect(page.locator('.weekly .target')).toHaveCount(1);
      await expect(page.locator('.five-hour svg[role="img"]')).toBeVisible();
      await expect(page.locator('.past-weeks tbody tr')).toHaveCount(2);
      await expect(page.locator('table.pacing tbody tr')).toHaveCount(3);
      await expect(page.locator('table.pacing tr[data-plan="plan-b"] .stale')).toBeVisible();
    } else if (tab.id === 'board') {
      await expect(page.getByRole('button', { name: /Review queue metrics/ })).toBeVisible();
    } else {
      await expect(page.locator('.coming li')).toHaveCount(tab.coming.length);
      if (tab.id === 'settings')
        await expect(page.locator('.kv dt', { hasText: 'Size' })).toBeVisible();
      else await expect(page.locator('.box h3', { hasText: 'From your config' })).toBeVisible();
    }
    if (tab.id === 'overview') {
      await expect(page.locator('.plan-gauge')).toHaveCount(3);
      await expect(page.locator('.plan-gauge[data-plan="plan-a"] .mode')).toHaveText(
        /burn|steady|conserve|stop/,
      );
      await expect(page.locator('.plan-gauge[data-plan="plan-a"] svg.gauge')).toBeVisible();
      await expect(page.locator('.plan-gauge[data-plan="plan-b"] .stale')).toContainText('stale');
      await expect(page.locator('.plan-gauge[data-plan="plan-c"]')).toContainText('No readings');
    }

    const fontsLoaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((f) => f.status === 'loaded')
        .map((f) => f.family.replace(/["']/g, ''));
    });
    expect(fontsLoaded).toContain('IBM Plex Sans');

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOTS}/${tab.id}-${info.project.name}.png`, fullPage: true });
    expect(problems).toEqual([]);
  });
}
