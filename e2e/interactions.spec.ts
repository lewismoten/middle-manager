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

  test('no horizontal overflow at 320 px on any tab', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    for (const tab of TABS) {
      await page.goto(`/#/${tab.id}`);
      await expect(page.locator('h1#page-title')).toHaveText(tab.title);
      expect(await horizontalOverflow(page), tab.id).toBeLessThanOrEqual(0);
    }
  });
});
