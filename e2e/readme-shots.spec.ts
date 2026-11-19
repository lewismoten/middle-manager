// README screenshots (docs/images/*.png) from the e2e server's synthetic data.
// Opt-in so `npm run test:e2e` never rewrites them: `npm run screenshots`.

import { expect, test } from '@playwright/test';
import { TABS } from '../web/src/tabs.ts';

const OUT = 'docs/images';

/** What tells us each page has finished loading (same as the axe pass). */
const READY: Record<string, string> = {
  overview: '.plan-gauge[data-plan="plan-a"] svg.gauge',
  burndown: '.weekly svg[role="img"]',
  board: '.board-card',
  agents: 'table.runs',
  usage: '#usage-daily-chart svg',
  schedules: 'table.jobs',
  notes: '#notes-doc-title',
  connections: '.conn-status',
  settings: '.kv dt',
};

test.skip(!process.env.MM_README_SHOTS, 'set MM_README_SHOTS=1 (npm run screenshots)');

async function shoot(page: import('@playwright/test').Page, id: string, file: string) {
  await page.goto(`/#/${id}`);
  await expect(page.locator(READY[id] ?? 'h1#page-title').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300); // let charts finish their resize pass
  await page.screenshot({ path: `${OUT}/${file}.png` });
}

for (const tab of TABS) {
  test(`readme: ${tab.id}`, async ({ page }) => {
    await shoot(page, tab.id, tab.id);
  });
}

test('readme: usage, dark', async ({ browser }) => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
  });
  await shoot(page, 'usage', 'usage-dark');
  await page.close();
});

test('readme: overview, phone', async ({ browser }) => {
  const page = await browser.newPage({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  await shoot(page, 'overview', 'overview-phone');
  await page.close();
});
