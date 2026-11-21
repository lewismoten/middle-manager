// Accessibility pass (S7): axe-core on every page at 1440 and 375 px, light and dark.
// Fails on any violation of WCAG 2.0/2.1/2.2 A and AA rules plus axe best practices.

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { TABS } from '../web/src/tabs.ts';

/** What tells us each page has finished loading its data. */
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

for (const tab of TABS) {
  test(`a11y: ${tab.id} has no axe violations`, async ({ page }, info) => {
    test.skip(info.project.name.startsWith('768'), 'axe runs at 1440 and 375');
    await page.goto(`/#/${tab.id}`);
    await expect(page.locator('h1#page-title')).toHaveText(tab.title);
    const ready = READY[tab.id];
    if (ready) await expect(page.locator(ready).first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    const found = results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')} :: ${n.failureSummary ?? ''}`),
    }));
    expect(found, JSON.stringify(found, null, 2)).toEqual([]);
  });
}

test('a11y: board with assignee lanes has no axe violations', async ({ page }, info) => {
  test.skip(info.project.name.startsWith('768'), 'axe runs at 1440 and 375');
  await page.goto('/#/board');
  await expect(page.locator('.board-card').first()).toBeVisible();
  await page.getByLabel('Assignee lanes').check();
  await expect(page.locator('.board-lane h2').first()).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  const found = results.violations.map((v) => [v.id, ...v.nodes.map((n) => n.target.join(' '))]);
  expect(found, JSON.stringify(found, null, 2)).toEqual([]);
});

test('a11y: sign-in dialog has no axe violations', async ({ page }, info) => {
  test.skip(info.project.name.startsWith('768'), 'axe runs at 1440 and 375');
  await page.goto('/#/overview');
  await page.locator('#sign-in').click();
  await expect(page.locator('#sign-in-dialog')).toBeVisible();
  const results = await new AxeBuilder({ page })
    .include('#sign-in-dialog')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});
