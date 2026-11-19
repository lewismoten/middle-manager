// Agents page with seeded runs (e2e/fixtures/agents.ts), at every width and theme.

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

test('agents: active runs grouped by machine with sub-agents nested', async ({
  page,
  baseURL,
}, info) => {
  const problems = watch(page, baseURL as string);
  await page.goto('/#/agents');
  await expect(page.locator('h1#page-title')).toHaveText('Agents');

  const groups = page.locator('table.runs tr.group th');
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toContainText('Build server');
  await expect(groups.nth(1)).toContainText('laptop-2');

  // Active now: the finished review is hidden; the codex sub-agent sits under its orchestrator.
  const rows = page.locator('table.runs tr.run');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute('data-depth', '0');
  await expect(rows.nth(0)).toContainText('orchestrator');
  await expect(rows.nth(1)).toHaveAttribute('data-depth', '1');
  await expect(rows.nth(1)).toContainText('sub-agent');
  await expect(rows.nth(0).locator('.tokens')).toContainText('2.5M');
  await expect(rows.nth(0).locator('a[href^="#/board?task="]')).toContainText('login-fix');
  await expect(rows.nth(0)).toContainText('Coordinate the login fix');
  await expect(rows.nth(0)).not.toContainText('Split the work');
  await expect(rows.nth(0)).toContainText('owner/repo');
  await expect(rows.nth(0)).toContainText('feature/login-fix');
  await expect(page.locator('#agents-summary')).toContainText('3 running on 2 machines');

  // Durations are live.
  const dur = rows.nth(2).locator('time.dur');
  const first = await dur.textContent();
  await expect(dur).not.toHaveText(first ?? '', { timeout: 3000 });

  await page.evaluate(() => document.fonts.ready);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  // The list scrolls inside its panel; the panel never runs past the screen bottom by much.
  const panel = await page.locator('.runs-panel').evaluate((el) => getComputedStyle(el).overflowY);
  expect(panel).toBe('auto');
  await page.screenshot({ path: `${SHOTS}/agents-${info.project.name}.png`, fullPage: true });
  expect(problems).toEqual([]);
});

test('agents: detail sheet, finished window and filters', async ({ page, baseURL }, info) => {
  test.skip(
    info.project.name !== '1440-light' && info.project.name !== '375-dark',
    'twice is enough',
  );
  const problems = watch(page, baseURL as string);
  await page.goto('/#/agents');
  const orch = page.locator('table.runs tr.run').first();

  // Keyboard: open the detail sheet, read the full prompt, close with Escape.
  await orch.locator('button.run-open').focus();
  await page.keyboard.press('Enter');
  const sheet = page.locator('#run-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('pre.prompt-full')).toContainText('Split the work into a fix');
  await expect(sheet.locator('ul.children li')).toHaveCount(2);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/agents-sheet-${info.project.name}.png` });
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // Finished in the last hour brings back the finished review, nested and marked done.
  await page.locator('#f-hours').selectOption('1');
  const rows = page.locator('table.runs tr.run');
  await expect(rows).toHaveCount(4);
  const review = page.locator('tr.run', { hasText: 'review' }).filter({ hasText: 'done' });
  await expect(review).toHaveAttribute('data-depth', '1');

  await page.locator('#f-role').selectOption('review');
  await expect(rows).toHaveCount(1);
  await page.locator('#f-role').selectOption('');
  await page.locator('#f-machine').selectOption('laptop-2');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Tidy the README');
  await page.locator('#f-model').selectOption('large');
  await expect(page.locator('.runs-empty')).toContainText('No agent runs in the last 1 h');

  // Filters are kept when leaving the page and coming back.
  await page.locator('.tabs a', { hasText: 'Board' }).click();
  await page.locator('.tabs a', { hasText: 'Agents' }).click();
  await expect(page.locator('#f-machine')).toHaveValue('laptop-2');
  expect(problems).toEqual([]);
});
