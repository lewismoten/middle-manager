// Past weeks on the Burndown page: picking a past week (its own chart, no "now" or projections),
// Prev / Next and the [ ] keys, overlaying last week ("Compare with"), the average line, legend
// toggles, the hover readout, the past-weeks table, and the state round-tripping through the URL
// and localStorage. Plus light/dark screenshots at 1440 and 390 (1440-light project only).
import { expect, test, type Page } from '@playwright/test';

const OUT = 'test-results/past-weeks';

interface Win {
  id: string;
  current: boolean;
  final_pct: number;
  ran_out: boolean;
}

async function windows(page: Page): Promise<Win[]> {
  const res = await page.request.get('/api/v1/plans/plan-a/windows');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { windows: Win[] }).windows;
}

test('pick a past week: its own chart with the final value and ran-out marker', async ({
  page,
}) => {
  const ws = await windows(page);
  const past = ws.filter((w) => !w.current);
  expect(past).toHaveLength(2);
  await page.goto('/#/burndown');
  await expect(page.locator('.weekly .now')).toHaveCount(1);
  await page.locator('#week-pick').selectOption(past[0]!.id);
  await expect(page.locator('#weekly-title')).toContainText('week of');
  await expect(page).toHaveURL(new RegExp(`week=${encodeURIComponent(past[0]!.id)}`));
  const svg = page.locator('.weekly svg[role="img"]');
  await expect(svg.locator('.final-mark')).toHaveCount(1);
  await expect(svg.locator('.final-label')).toHaveText(`${Math.round(past[0]!.final_pct)}%`);
  await expect(svg.locator('.now, .proj, .proj-short')).toHaveCount(0);
  await expect(svg.locator('.ran-out')).toHaveCount(0);
  await expect(page.locator('.five-hour')).toHaveCount(0);
  await expect(page.locator(`.past-weeks tr[data-week="${past[0]!.id}"]`)).toHaveAttribute(
    'aria-current',
    'true',
  );

  // Prev week: the oldest one ran out, so it has the marker; Prev is then disabled.
  await page.locator('.week-prev').click();
  await expect(page.locator('#week-pick')).toHaveValue(past[1]!.id);
  await expect(svg.locator('.ran-out')).toHaveCount(1);
  await expect(svg.locator('.ran-out-label')).toHaveText('ran out');
  await expect(page.locator('.weekly .summary')).toContainText('Ran out');
  await expect(page.locator('.week-prev')).toBeDisabled();

  // Keyboard: ] goes to the newer week, twice back to Current.
  await page.locator('.week-next').focus();
  await page.keyboard.press(']');
  await expect(page.locator('#week-pick')).toHaveValue(past[0]!.id);
  await page.keyboard.press(']');
  await expect(page.locator('#week-pick')).toHaveValue('current');
  await expect(page.locator('.weekly .now')).toHaveCount(1);
  await expect(page).toHaveURL(/#\/burndown$/);
  await page.keyboard.press('[');
  await expect(page.locator('#week-pick')).toHaveValue(past[0]!.id);

  // A row in the past-weeks table opens its week too.
  await page.locator(`.past-weeks tr[data-week="${past[1]!.id}"] button`).click();
  await expect(page.locator('#week-pick')).toHaveValue(past[1]!.id);
});

test('overlay last week: aligned line, end label, legend toggle and hover readout', async ({
  page,
}) => {
  const ws = await windows(page);
  const last = ws.find((w) => !w.current)!;
  await page.goto('/#/burndown');
  const svg = page.locator('.weekly svg[role="img"]');
  await expect(svg.locator('.overlay')).toHaveCount(0);
  await page.locator('#week-compare').selectOption('last');
  await expect(svg.locator('.overlay')).toHaveCount(1);
  const ov = svg.locator(`.overlay[data-overlay="${last.id}"]`);
  // Full label on wide charts ("Nov 9–16: 61%"), compact on narrow ones ("Nov 9: 61%").
  await expect(ov.locator('.ov-label')).toHaveText(
    new RegExp(`^\\w{3} \\d+(–(\\w{3} )?\\d+)?: ${Math.round(last.final_pct)}%$`),
  );
  expect(await ov.locator('.ov-line').getAttribute('stroke-dasharray')).toBeTruthy();
  // Thinner than the readings line.
  const widths = await svg.evaluate((el) => ({
    ov: parseFloat(getComputedStyle(el.querySelector('.ov-line')!).strokeWidth),
    used: parseFloat(getComputedStyle(el.querySelector('.used')!).strokeWidth),
  }));
  expect(widths.ov).toBeLessThan(widths.used);
  // Aligned by time since start: the overlay starts at the left edge with the readings.
  const starts = await svg.evaluate((el) => {
    const first = (sel: string) =>
      Number(el.querySelector(sel)!.getAttribute('points')!.split(' ')[0]!.split(',')[0]);
    return { ov: first('.ov-line'), used: first('.used') };
  });
  expect(Math.abs(starts.ov - starts.used)).toBeLessThan(1);
  await expect(page).toHaveURL(/compare=last/);
  expect(await page.evaluate(() => localStorage.getItem('mm.burndown.compare'))).toContain(
    '"compare":"last"',
  );

  // Hover readout names the overlaid week's value at the same point.
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  const tip = page.locator('.weekly .chart-tip');
  await expect(tip.locator('.tip-overlay')).toHaveText(/^\w{3} \d+–(\w{3} )?\d+: \d+\.\d%$/);

  // Legend toggle hides the overlay (line and readout).
  const toggle = page.locator('.weekly .legend-toggle').filter({ has: page.locator('.key-ov-0') });
  await toggle.click();
  await expect(ov).toBeHidden();
  await toggle.click();
  await expect(ov.locator('.ov-line')).toBeVisible();

  // Average of past weeks (two finished weeks in the seed).
  await page.locator('#week-avg').check();
  await expect(svg.locator('.overlay.ov-avg .ov-label')).toHaveText(/^Avg( of 2 weeks)?: \d+%$/);
  await expect(page).toHaveURL(/avg=1/);
});

test('the week and comparison round-trip through the URL', async ({ page }) => {
  const ws = await windows(page);
  const past = ws.filter((w) => !w.current);
  const hash = `#/burndown?plan=plan-a&week=${encodeURIComponent(past[0]!.id)}&compare=last&avg=0`;
  await page.goto(`/${hash}`);
  await expect(page.locator('#week-pick')).toHaveValue(past[0]!.id);
  await expect(page.locator('#week-compare')).toHaveValue('last');
  const svg = page.locator('.weekly svg[role="img"]');
  // Last week relative to the shown week is the older one.
  await expect(svg.locator(`.overlay[data-overlay="${past[1]!.id}"]`)).toHaveCount(1);
  await page.reload();
  await expect(page.locator('#week-pick')).toHaveValue(past[0]!.id);
  await expect(svg.locator('.overlay')).toHaveCount(1);
  // A chosen week, then back to none: the URL follows.
  await page.locator('#week-compare').selectOption(`week:${ws[0]!.id}`);
  await expect(page).toHaveURL(new RegExp(`compare=week%3A${encodeURIComponent(ws[0]!.id)}`));
  if ((page.viewportSize()?.width ?? 0) >= 640) {
    await expect(svg.locator('.overlay .ov-label')).toContainText('so far');
  }
  await page.locator('#week-compare').selectOption('none');
  await expect(svg.locator('.overlay')).toHaveCount(0);
  // An unknown week in the URL falls back to the current week.
  await page.goto('/#/burndown?week=2020-01-01T00:00:00.000Z');
  await expect(page.locator('#week-pick')).toHaveValue('current');
  await expect(page.locator('.weekly .now')).toHaveCount(1);
});

test('past weeks screenshots, light and dark at 1440 and 390', async ({ page }, info) => {
  test.skip(info.project.name !== '1440-light', 'one project takes the screenshots');
  const ws = await windows(page);
  const past = ws.filter((w) => !w.current);
  const views = {
    compare: '#/burndown?compare=last2&avg=1',
    past: `#/burndown?week=${encodeURIComponent(past[1]!.id)}&compare=week%3A${encodeURIComponent(past[0]!.id)}`,
  };
  for (const width of [1440, 390]) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: scheme });
      for (const [name, hash] of Object.entries(views)) {
        await page.goto(`/${hash}`);
        await expect(page.locator('.weekly svg .overlay').first()).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(0);
        await page.screenshot({
          path: `${OUT}/burndown-${name}-${width}-${scheme}.png`,
          fullPage: true,
        });
        await page
          .locator('.weekly')
          .screenshot({ path: `${OUT}/weekly-${name}-${width}-${scheme}.png` });
      }
    }
  }
});
