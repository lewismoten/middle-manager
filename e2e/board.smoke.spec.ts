// Board with a large synthetic board (e2e/fixtures/board.ts, served on E2E_BOARD_PORT):
// the page stays one screen, each column scrolls its own list, cards render in pages of 40.

import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { E2E_BOARD_PORT } from './constants.ts';
import { BOARD_COUNTS } from './fixtures/board.ts';

const SHOTS = 'test-results/screenshots';
mkdirSync(SHOTS, { recursive: true });
const ORIGIN = `http://127.0.0.1:${E2E_BOARD_PORT}`;
test.use({ baseURL: ORIGIN });

function watch(page: Page) {
  const problems: string[] = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()}: ${r.url()}`));
  page.on('request', (r) => {
    if (!r.url().startsWith(ORIGIN) && !r.url().startsWith('data:'))
      problems.push(`off-origin request: ${r.url()}`);
  });
  return problems;
}
const column = (page: Page, status: string) =>
  page.locator(`.board-column[data-status="${status}"]`);
const pageFits = (page: Page) =>
  page.evaluate(() => ({
    scroll: document.documentElement.scrollHeight,
    view: window.innerHeight,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));

test('large board stays one screen with columns that scroll inside', async ({ page }, info) => {
  const problems = watch(page);
  const phone = (page.viewportSize()?.width ?? 0) <= 600;
  await page.goto('/#/board');
  await expect(column(page, 'todo').locator('.board-card').first()).toBeAttached();
  await expect(column(page, 'todo').locator('.count')).toHaveText(String(BOARD_COUNTS.todo));
  await expect(column(page, 'blocked').locator('.count')).toHaveText(String(BOARD_COUNTS.blocked));
  // Done: the last 14 days, newest first (seeded every 5 hours: about 67 recent).
  await expect(column(page, 'done').locator('.count')).toHaveText(/^\d+ of 573$/);
  // Empty columns collapse to a strip.
  for (const s of ['backlog', 'doing', 'review'])
    await expect(column(page, s)).toHaveClass(/collapsed/);
  // Imported cards show their board, never the placeholder project "default".
  const meta = await page.locator('.board-card .meta').allTextContents();
  expect(meta.some((m) => /alpha-board|beta-board/.test(m))).toBe(true);
  expect(meta.some((m) => /\bdefault\b/.test(m))).toBe(false);

  let fit = await pageFits(page);
  expect(fit.scroll).toBeLessThanOrEqual(fit.view + 2);
  expect(fit.overflowX).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/board-large-${info.project.name}.png` });

  for (const status of ['todo', 'blocked', 'done']) {
    if (phone) await page.getByLabel('Column', { exact: true }).selectOption(status);
    const list = column(page, status).locator('.board-list');
    await expect(list).toBeVisible();
    // Never all cards up front.
    expect(await list.locator('.board-card').count()).toBeLessThanOrEqual(60);
    const box = await list.evaluate((el) => ({
      scrolls: el.scrollHeight > el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
      height: el.getBoundingClientRect().height,
    }));
    expect(box.overflowY).toBe('auto');
    expect(box.scrolls).toBe(true);
    // The column is no taller than the screen.
    expect(box.height).toBeLessThan(page.viewportSize()!.height);
    // The header stays at the top of its column while the list scrolls.
    await list.evaluate((el) => el.scrollBy(0, 300));
    await expect(column(page, status).locator('.board-col-head')).toBeInViewport();
  }

  // Scrolling the done list to its end loads the next page.
  const done = column(page, 'done').locator('.board-list');
  const before = await done.locator('.board-card').count();
  await done.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect.poll(() => done.locator('.board-card').count()).toBeGreaterThan(before);
  // Show older: the whole done column, still in pages.
  await done.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await column(page, 'done').getByRole('button', { name: /older/ }).click();
  await expect(column(page, 'done').locator('.count')).toHaveText('573');
  expect(await done.locator('.board-card').count()).toBeLessThanOrEqual(60);

  fit = await pageFits(page);
  expect(fit.scroll).toBeLessThanOrEqual(fit.view + 2);
  expect(problems).toEqual([]);
});

test('board search, compact density, empty columns and lanes', async ({ page }, info) => {
  const problems = watch(page);
  const phone = (page.viewportSize()?.width ?? 0) <= 600;
  await page.goto('/#/board');
  await expect(column(page, 'todo').locator('.board-card').first()).toBeAttached();
  // Search covers every card, not just rendered ones; the count shows the filtered total.
  await page.getByLabel('Search cards').fill('blocked card 07');
  await expect(column(page, 'blocked').locator('.count')).toHaveText('10');
  await expect(column(page, 'todo')).toHaveClass(/collapsed/);
  await page.getByLabel('Search cards').fill('');
  await expect(column(page, 'todo').locator('.count')).toHaveText('53');
  // Board filter: imported cards are filed under their board name.
  await page.getByLabel('Project').selectOption('alpha-board');
  await expect(column(page, 'blocked').locator('.count')).toHaveText('40');
  await page.getByLabel('Project').selectOption('');

  // Compact density is remembered.
  await page.getByLabel('Compact').check();
  await page.reload();
  await expect(page.getByLabel('Compact')).toBeChecked();
  const card = column(page, phone ? 'todo' : 'blocked')
    .locator('.board-card')
    .first();
  const style = await card.evaluate((el) => getComputedStyle(el).whiteSpace);
  expect(style).toBe('nowrap');
  await page.getByLabel('Compact').uncheck();

  if (!phone) {
    // Pressing a strip shows empty columns at full width.
    await column(page, 'doing').getByRole('button').click();
    await expect(column(page, 'doing')).not.toHaveClass(/collapsed/);
    await page.getByRole('checkbox', { name: 'Empty columns' }).uncheck();
    await expect(column(page, 'doing')).toHaveClass(/collapsed/);
  }

  // Assignee lanes: same rules per lane, page still one screen.
  await page.getByLabel('Assignee lanes').check();
  await expect(page.locator('.board-lane')).toHaveCount(4);
  const lane = page.locator('.board-lane').first();
  expect(await lane.locator('.board-card').count()).toBeLessThanOrEqual(6 * 60);
  await expect(lane.locator('.board-column[data-status="review"]')).toHaveClass(/collapsed/);
  const fit = await pageFits(page);
  expect(fit.scroll).toBeLessThanOrEqual(fit.view + 2);
  expect(fit.overflowX).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/board-lanes-${info.project.name}.png` });
  expect(problems).toEqual([]);
});

test('no horizontal overflow at 320 px', async ({ page }) => {
  test.skip(page.viewportSize()?.width !== 375, 'phone projects only');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/#/board');
  await expect(column(page, 'todo').locator('.board-card').first()).toBeVisible();
  const fit = await pageFits(page);
  expect(fit.overflowX).toBeLessThanOrEqual(0);
  expect(fit.scroll).toBeLessThanOrEqual(fit.view + 2);
});
