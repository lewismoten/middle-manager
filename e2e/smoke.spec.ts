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

for (const tab of TABS) {
  test(`${tab.id} renders without overflow or errors`, async ({ page, baseURL }, info) => {
    const problems = watch(page, baseURL as string);
    await page.goto(`/#/${tab.id}`);
    await expect(page.locator('h1#page-title')).toHaveText(tab.title);
    await expect(page.locator('#site-name')).toHaveText('Test fleet');
    await expect(page.locator(`.tabs a[aria-current="page"]`)).toHaveText(tab.label);
    if (tab.id !== 'board') await expect(page.locator('.coming li')).toHaveCount(tab.coming.length);
    if (tab.id === 'settings')
      await expect(page.locator('.kv dt', { hasText: 'Size' })).toBeVisible();
    else if (tab.id === 'board')
      await expect(page.getByRole('button', { name: /Review queue metrics/ })).toBeVisible();
    else await expect(page.locator('.box h3', { hasText: 'From your config' })).toBeVisible();

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
