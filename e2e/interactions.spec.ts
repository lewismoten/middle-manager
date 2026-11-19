import { expect, test, type Page } from '@playwright/test';
import { TABS } from '../web/src/tabs.ts';
import { E2E_TOKEN } from './constants.ts';

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('interactions', () => {
  test('tabs work from the keyboard with visible focus', async ({ page }) => {
    await page.goto('/#/overview');
    await expect(page.locator('h1#page-title')).toHaveText('Overview');
    const board = page.locator('.tabs a', { hasText: 'Board' });
    await board.focus();
    const outline = await board.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/board$/);
    await expect(page.locator('h1#page-title')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('.tabs a').last()).toBeFocused();
  });

  test('unknown routes fall back to Overview', async ({ page }) => {
    await page.goto('/#/nowhere');
    await expect(page).toHaveURL(/#\/overview$/);
  });

  test('theme toggle cycles auto, light, dark and persists', async ({ page }) => {
    await page.goto('/#/overview');
    const toggle = page.locator('#theme-toggle');
    await expect(toggle).toContainText('Auto');
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(17, 21, 29)');
    await toggle.click();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  });

  test('sign in rejects a bad token, stores a good one, and signs out', async ({ page }) => {
    await page.goto('/#/settings');
    await page.locator('#sign-in').click();
    await page.locator('#token-input').fill('mm_wrong');
    await page.keyboard.press('Enter');
    await expect(page.locator('#token-error')).toHaveText(/not valid/);
    await page.locator('#token-input').fill(E2E_TOKEN);
    await page.keyboard.press('Enter');
    await expect(page.locator('#sign-in')).toHaveText('e2e');
    expect(await page.evaluate(() => localStorage.getItem('mm.token'))).toBe(E2E_TOKEN);
    await page.reload();
    await expect(page.locator('#sign-in')).toHaveText('e2e');
    await page.locator('#sign-in').click();
    await page.locator('#sign-out').click();
    await expect(page.locator('#sign-in')).toHaveText('Sign in');
    expect(await page.evaluate(() => localStorage.getItem('mm.token'))).toBeNull();
  });

  test('burndown: plan picker, hover read-out and posting a reading', async ({ page, request }) => {
    await page.goto('/#/burndown');
    await expect(page.locator('#weekly-title')).toContainText('Plan A');
    const svg = page.locator('.weekly svg[role="img"]');
    const box = (await svg.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2);
    await expect(page.locator('.weekly .chart-tip')).toContainText('% used');

    await page.locator('.plan-picker button', { hasText: 'Plan C' }).click();
    await expect(page.locator('#weekly-title')).toContainText('Plan C');
    await expect(page.locator('.weekly')).toContainText('No weekly readings yet');
    await expect(page.locator('.plan-picker button[aria-pressed="true"]')).toHaveText('Plan C');

    const res = await request.post('/api/v1/plans/plan-c/readings', {
      headers: { authorization: `Bearer ${E2E_TOKEN}` },
      data: {
        used_pct: 50,
        resets_at: new Date(Date.now() + 48 * 3600_000).toISOString(),
      },
    });
    expect(res.status()).toBe(201);
    await page.reload();
    await expect(page.locator('#weekly-title')).toContainText('Plan C');
    await expect(page.locator('.weekly .mode')).toHaveText('burn');
    await page.locator('.plan-picker button', { hasText: 'Plan A' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#weekly-title')).toContainText('Plan A');
  });

  test('no horizontal overflow at 320 px on any tab', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    for (const tab of TABS) {
      await page.goto(`/#/${tab.id}`);
      await expect(page.locator('h1#page-title')).toHaveText(tab.title);
      expect(await horizontalOverflow(page), tab.id).toBeLessThanOrEqual(0);
    }
  });
});
test('board filters, card history, edits and sprint totals', async ({ page }) => {
  await page.addInitScript((token) => localStorage.setItem('mm.token', token), E2E_TOKEN);
  await page.goto('/#/board');
  await page.getByRole('button', { name: 'Create card' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Synthetic interaction card');
  await page.getByLabel('Body', { exact: true }).fill('A **bold** <img src=x> example');
  await page.getByRole('button', { name: 'Save card' }).click();
  const sheet = page.getByRole('dialog', { name: 'Card details' });
  await expect(sheet.locator('strong')).toHaveText('bold');
  await expect(sheet.locator('img')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Edit card' }).click();
  await sheet.getByLabel('Status').selectOption('blocked');
  await sheet.getByRole('button', { name: 'Save card' }).click();
  await expect(sheet.getByText('backlog → blocked')).toBeVisible();
  await sheet.getByLabel('Local note').fill('Check fixture');
  await sheet.getByRole('button', { name: 'Add note' }).click();
  await expect(sheet.getByText('Check fixture')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByLabel('Search cards').fill('queue metrics');
  await page.getByLabel('Assignee lanes').check();
  await expect(page.locator('.board-card')).toHaveCount(1);
  await page.locator('.board-card').click();
  await expect(sheet.getByRole('button', { name: 'Edit card' })).toHaveCount(0);
  await sheet.getByLabel('Local note').fill('Imported card note');
  await sheet.getByRole('button', { name: 'Add note' }).click();
  await expect(sheet.getByText('Imported card note')).toBeVisible();
  await page.screenshot({ path: 'test-results/screenshots/board-card.png' });
  await page.keyboard.press('Escape');
  await page.getByLabel('Search cards').fill('');
  await page.getByRole('button', { name: 'Sprint', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Iteration A', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/screenshots/board-sprint.png' });
  await page.getByRole('button', { name: 'Velocity' }).click();
  await expect(page.locator('.velocity-row').filter({ hasText: 'Iteration A' })).toHaveText(
    'Iteration A1',
  );
  await page.screenshot({ path: 'test-results/screenshots/board-velocity.png' });
});
