// The 1 h / 2 h projections on the Burndown chart: drawn inside the plot when they run out,
// toggled from the legend (remembered), read out on hover, plus light/dark screenshots at 1440
// and 390 px. Runs once per smoke project; the screenshot loop only in the 1440-light project.
import { expect, test, type Page } from '@playwright/test';

const OUT = 'test-results/short-rate';
const HOUR = 3600_000;

/** Pace with a fast 1 h burn that runs out tomorrow and a 2 h burn that lasts to the reset. */
async function mockShortProjections(page: Page) {
  await page.route('**/api/v1/plans/pace', async (route) => {
    const response = await route.fetch();
    const pace = await response.json();
    const w = pace.plans[0].weekly;
    const out = new Date(Date.now() + 20 * HOUR).toISOString();
    w.projection_1h = {
      ...w.projection_1h,
      rate_pct_per_h: 4,
      projected_pct: 100,
      runs_out_at: out,
      reason: null,
      reason_text: null,
    };
    w.projection_2h = {
      ...w.projection_2h,
      rate_pct_per_h: 0.8,
      projected_pct: 87.5,
      runs_out_at: null,
      reason: null,
      reason_text: null,
    };
    await route.fulfill({ response, json: pace });
  });
}

test('short projections stay inside the plot and stop at 100% when they run out', async ({
  page,
}) => {
  await mockShortProjections(page);
  await page.goto('/#/burndown');
  const svg = page.locator('.weekly svg[role="img"]');
  await expect(svg.locator('.proj-1h .proj-line')).toHaveCount(1);
  const geo = await svg.evaluate((el) => {
    const num = (e: Element | null, a: string) => Number(e?.getAttribute(a));
    const grid = [...el.querySelectorAll('.grid line:not(.vtick)')];
    const top = Math.min(...grid.map((l) => num(l, 'y1')));
    const right = Math.max(...grid.map((l) => num(l, 'x2')));
    const line = (k: string) => el.querySelector(`.proj-${k} .proj-line`);
    return {
      top,
      right,
      one: { y2: num(line('1h'), 'y2'), x2: num(line('1h'), 'x2') },
      two: { y2: num(line('2h'), 'y2'), x2: num(line('2h'), 'x2') },
      oneMark: !!el.querySelector('.proj-1h circle.runs-out'),
      twoMark: !!el.querySelector('.proj-2h path.end-mark'),
      tags: [...el.querySelectorAll('.proj-tag')].map((t) => t.textContent),
    };
  });
  // 1 h: ends on the 100% line before the right edge, with the runs-out marker.
  expect(geo.one.y2).toBe(geo.top);
  expect(geo.one.x2).toBeLessThan(geo.right);
  expect(geo.oneMark).toBe(true);
  // 2 h: ends at the reset (right edge) below 100%, with its own end marker.
  expect(geo.two.x2).toBe(geo.right);
  expect(geo.two.y2).toBeGreaterThan(geo.top);
  expect(geo.twoMark).toBe(true);
  expect(geo.tags).toEqual(['2 h', '1 h out']);
  // Distinct dash patterns, not color alone.
  const dash = (k: string) =>
    svg.locator(`.proj-${k} .proj-line`).evaluate((l) => getComputedStyle(l).strokeDasharray);
  const dashes = new Set([
    await dash('1h'),
    await dash('2h'),
    await svg.locator('.proj').evaluate((l) => getComputedStyle(l).strokeDasharray),
  ]);
  expect(dashes.size).toBe(3);

  // Hover readout names each projection's value at the reset.
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  const tip = page.locator('.weekly .chart-tip');
  await expect(tip).toContainText('% used');
  await expect(tip).toContainText('Last 2 h: 88% at reset');
  await expect(tip).toContainText(/Last 1 h: runs out \w{3} \d/);
  await expect(tip).toContainText(/Projection \(last \d+ h\)/);
});

test('legend toggles hide a short projection and are remembered', async ({ page }) => {
  await page.goto('/#/burndown');
  const toggle = page.locator('.weekly .legend-toggle', { hasText: 'Last 1 h rate' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.weekly .proj-1h .proj-line')).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.weekly .proj-1h .proj-line')).toBeHidden();
  await expect(page.locator('.weekly .proj-2h .proj-line')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('mm.burndown.shortProjections'))).toContain(
    '"1h":false',
  );
  await page.reload();
  await expect(
    page.locator('.weekly .legend-toggle', { hasText: 'Last 1 h rate' }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.weekly .proj-1h .proj-line')).toBeHidden();
  await page.locator('.weekly .legend-toggle', { hasText: 'Last 1 h rate' }).click();
  await expect(page.locator('.weekly .proj-1h .proj-line')).toBeVisible();
});

test('burndown screenshots with short projections, light and dark at 1440 and 390', async ({
  page,
}, info) => {
  test.skip(info.project.name !== '1440-light', 'one project takes the four screenshots');
  for (const width of [1440, 390]) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/#/burndown');
      await expect(page.locator('.weekly .proj-2h .proj-line')).toHaveCount(1);
      await page.evaluate(() => document.fonts.ready);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `${OUT}/burndown-${width}-${scheme}.png`, fullPage: true });
      await page.locator('.weekly').screenshot({ path: `${OUT}/weekly-${width}-${scheme}.png` });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/#/overview');
  await expect(page.locator('.plan-gauge .short-projections').first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/overview-1440-light.png` });
});
