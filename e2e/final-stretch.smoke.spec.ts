// The Burndown final-stretch view ("Last 2 h + next 2 h"): it opens by itself near a reset
// (plan-d resets ~1 h 40 min after the seed; plan-a with a fake clock), switches and round-trips
// through the URL and localStorage, zooms the y axis, draws every reading with a dot, the
// reserve band, launch cutoff and reset, and reads out the newest reading and each projection.
// Light/dark screenshots at 1440 and 390 px run in the 1440-light project only.
import { expect, test, type Page } from '@playwright/test';
import { E2E_BOARD_PORT } from './constants.ts';

// plan-d lives on the second e2e server (e2e/serve.ts board), so the main pages keep three plans.
test.use({ baseURL: `http://127.0.0.1:${E2E_BOARD_PORT}` });

const OUT = 'test-results/final-stretch';
const HOUR = 3600_000;

const svgOf = (page: Page) => page.locator('.weekly svg[role="img"]');

async function geometry(page: Page) {
  return svgOf(page).evaluate((el) => {
    const num = (e: Element | null, a: string) => Number(e?.getAttribute(a));
    const grid = [...el.querySelectorAll('.grid line:not(.vtick)')];
    const ys = grid.map((l) => num(l, 'y1'));
    const xs = grid.map((l) => num(l, 'x1')).concat(grid.map((l) => num(l, 'x2')));
    return {
      top: Math.min(...ys),
      bottom: Math.max(...ys),
      left: Math.min(...xs),
      right: Math.max(...xs),
      yLabels: [...el.querySelectorAll('.grid text')]
        .map((t) => t.textContent ?? '')
        .filter((t) => t.endsWith('%')),
      xLabels: [...el.querySelectorAll('.grid text')]
        .map((t) => t.textContent ?? '')
        .filter((t) => !t.endsWith('%')),
      dots: el.querySelectorAll('.dots circle').length,
      lineEnds: [...el.querySelectorAll('.proj, .proj-line')].map((l) => ({
        x1: num(l, 'x1'),
        x2: num(l, 'x2'),
        y2: num(l, 'y2'),
      })),
      reserve: !!el.querySelector('rect.reserve'),
      reserveLabel: el.querySelector('.reserve-label')?.textContent ?? null,
      cutoff: !!el.querySelector('.cutoff-rule'),
      reset: !!el.querySelector('.reset-rule'),
      now: !!el.querySelector('line.now'),
      target: !!el.querySelector('.target'),
      axisBreak: !!el.querySelector('.axis-break'),
    };
  });
}

test('opens zoomed near the reset and shows the final stretch', async ({ page }) => {
  await page.goto('/#/burndown?plan=plan-d');
  await expect(page.locator('#view-stretch')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#view-week')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.weekly .auto-note')).toContainText('under 3 h');
  // An automatic choice is not written into the URL.
  expect(page.url()).not.toContain('view=');

  const g = await geometry(page);
  // Every reading in the range (one every 5 minutes, about 2 h 20 min of them) has a dot.
  expect(g.dots).toBeGreaterThanOrEqual(22);
  expect(g.dots).toBeLessThanOrEqual(32);
  // The y axis is zoomed (does not start at 0) and says so.
  expect(g.yLabels[0]).not.toBe('0%');
  expect(g.yLabels.at(-1)).toBe('100%');
  expect(g.axisBreak).toBe(true);
  await expect(page.locator('.weekly .axis-note')).toContainText(/Y axis zoomed to \d+–100% used/);
  await expect(svgOf(page)).toHaveAttribute('aria-label', /zoomed/);
  // 15-minute ticks with clock times.
  expect(g.xLabels.length).toBeGreaterThanOrEqual(3);
  expect(g.xLabels.every((t) => /\d:\d\d/.test(t))).toBe(true);
  // Markers: reserve band, target empty, launch cutoff, reset, now.
  expect(g).toMatchObject({ reserve: true, cutoff: true, reset: true, now: true, target: true });
  expect(g.reserveLabel).toBe('Reserve 97–100%');
  // Three projections (mode rate, 2 h, 1 h), each inside the plot.
  expect(g.lineEnds).toHaveLength(3);
  for (const l of g.lineEnds) {
    expect(l.x1).toBeGreaterThan(g.left);
    expect(l.x2).toBeLessThanOrEqual(g.right);
    expect(l.y2).toBeGreaterThanOrEqual(g.top);
    expect(l.y2).toBeLessThanOrEqual(g.bottom);
  }

  // The readout: reading time and age, used, rates, projections at target empty and reset.
  const readout = page.locator('.stretch-readout');
  await expect(readout).toContainText(/Last reading .* · read \d+ min ago/);
  await expect(readout).toContainText(/Used \d+\.\d%/);
  await expect(readout).toContainText(/Off pace: [−+]?\d+\.\d pts/);
  await expect(readout.locator('.stretch-rates')).toContainText(/Last 1 h: \d+\.\d\d%\/h/);
  await expect(readout.locator('.stretch-rates')).toContainText(/Last 2 h: \d+\.\d\d%\/h/);
  await expect(readout.locator('.stale-badge')).toHaveCount(0);
  const rows = readout.locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(readout.locator('thead')).toContainText('At target empty');
  await expect(readout.locator('thead')).toContainText('At reset');
  await expect(rows.first().locator('td').first()).toHaveText(/^(\d+\.\d%|runs out .*)$/);

  // Hover reads out the nearest reading and the projections.
  await svgOf(page).scrollIntoViewIfNeeded();
  const box = (await svgOf(page).boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  const tip = page.locator('.weekly .chart-tip');
  await expect(tip).toContainText('% used');
  await expect(tip).toContainText(/Last 2 h: /);

  // Compare overlays belong to the week view.
  await expect(page.locator('.week-compare')).toBeHidden();
});

test('switches views, keeps the choice in the URL and localStorage', async ({ page }) => {
  await page.goto('/#/burndown?plan=plan-d');
  await expect(page.locator('#view-stretch')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#view-week').click();
  await expect(page.locator('#view-week')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#view-week')).toBeFocused();
  await expect(page).toHaveURL(/view=week/);
  await expect(page.locator('.stretch-readout')).toHaveCount(0);
  await expect(page.locator('.weekly .week-compare')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('mm.burndown.view'))).toBe('week');
  // The week view gets thinned readings (5-minute readings all week would be ~2000 points).
  const dots = await svgOf(page).locator('.dots circle').count();
  expect(dots).toBe(0);

  // The choice wins over the automatic zoom, even near the reset.
  await page.goto('/#/burndown?plan=plan-d');
  await expect(page.locator('#view-week')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.weekly .auto-note')).toHaveCount(0);

  await page.locator('#view-stretch').click();
  await expect(page).toHaveURL(/view=stretch/);
  await expect(page.locator('.stretch-readout')).toBeVisible();
  // A link with view= opens that view regardless of the stored choice.
  await page.evaluate(() => localStorage.setItem('mm.burndown.view', 'week'));
  await page.goto('/#/burndown?plan=plan-d&view=stretch');
  await page.reload();
  await expect(page.locator('#view-stretch')).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/view=stretch/);
  // A past week has no zoomed view (plan D has none; plan A does).
  await page.goto('/#/burndown?plan=plan-a');
  await expect(page.locator('.view-switch')).toHaveCount(1);
  await page.locator('.week-prev').click();
  await expect(page.locator('.weekly .past-badge')).toBeVisible();
  await expect(page.locator('.view-switch')).toHaveCount(0);
});

test('auto-selects the zoomed view under 3 h to the reset (fake clock)', async ({
  page,
  request,
}) => {
  const pace = await (await request.get('/api/v1/plans/pace?plan=plan-a')).json();
  const reset = Date.parse(pace.plans[0].weekly.reset_at);
  // Plan A resets ~2.5 days out: week view.
  await page.goto('/#/burndown');
  await expect(page.locator('#view-week')).toHaveAttribute('aria-pressed', 'true');
  // Two and a half hours before its reset the page zooms in by itself.
  await page.clock.install({ time: reset - 2.5 * HOUR });
  await page.reload();
  await expect(page.locator('#view-stretch')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.weekly .auto-note')).toBeVisible();
  // The newest reading is now days old for this clock: the warning badge shows.
  await expect(page.locator('.stretch-readout .stale-badge')).toContainText(/Reading \d+ min old/);
  // 3.5 h before the reset it stays on the week.
  await page.clock.setFixedTime(reset - 3.5 * HOUR);
  await page.reload();
  await expect(page.locator('#view-week')).toHaveAttribute('aria-pressed', 'true');
});

test('final-stretch screenshots near a reset, light and dark at 1440 and 390', async ({
  page,
}, info) => {
  test.skip(info.project.name !== '1440-light', 'one project takes the four screenshots');
  for (const width of [1440, 390]) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/#/burndown?plan=plan-d&view=stretch');
      await expect(page.locator('.stretch-readout')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
      await page.locator('.weekly').screenshot({ path: `${OUT}/stretch-${width}-${scheme}.png` });
      await page.screenshot({ path: `${OUT}/burndown-${width}-${scheme}.png`, fullPage: true });
    }
  }
  // The week view of the same plan, with the reserve band and the even line ending at 97%.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/#/burndown?plan=plan-d&view=week');
  await expect(page.locator('.weekly rect.reserve')).toHaveCount(1);
  await page.locator('.weekly').screenshot({ path: `${OUT}/week-1440-light.png` });
});
