// Schedules page with seeded jobs and mirrored schedulers (e2e/fixtures/schedules.ts), at every
// width and theme; then run-now, the detail sheet and the job form while signed in.

import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { E2E_TOKEN } from './constants.ts';

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

const row = (page: Page, name: string) =>
  page.locator('table.jobs tr.job', { has: page.locator('.job-open', { hasText: name }) });

test('schedules: own jobs with last runs, next to the read-only mirror', async ({
  page,
  baseURL,
}, info) => {
  const problems = watch(page, baseURL as string);
  await page.goto('/#/schedules');
  await expect(page.locator('h1#page-title')).toHaveText('Schedules');

  const mirror = row(page, 'Mirror Hermes cron');
  await expect(mirror).toContainText('collector · hermes-cron');
  await expect(mirror).toContainText('*/10 * * * *');
  await expect(mirror.locator('.chip.st-done')).toHaveText('ok');
  await expect(mirror.locator('time.rel').first()).toHaveText(/^in \d/); // next run

  const cleanup = row(page, 'Nightly cleanup');
  await expect(cleanup.locator('.chip.st-block')).toHaveText('failed · 2');
  await expect(cleanup).toContainText('1m 35s'); // last run duration
  await expect(row(page, 'Weekly report')).toContainText('disabled');
  // Signed out: run now is visible but needs a token.
  await expect(cleanup.locator('button.run-now')).toBeDisabled();
  await expect(page.locator('#job-new')).toBeHidden();

  const list = page.locator('#external-jobs-list');
  const rows = list.locator('li.ext');
  await expect(rows.nth(0)).toHaveAttribute('data-external-id', 'sample-poll.timer');
  await expect(rows.nth(1)).toHaveAttribute('data-external-id', 'sample-index.timer');
  if (info.project.name === '1440-light') {
    for (const row of [rows.nth(0), rows.nth(1)]) await expect(row).toBeInViewport({ ratio: 1 });
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
  }
  await expect(page.locator('#external-jobs-title')).toContainText('1 failing - 1 stuck');
  await expect(list.locator('details summary')).toHaveText('Paused (5)');
  await expect(list.locator('details li.ext:visible')).toHaveCount(0);
  const response = await page.request.get('/api/v1/external-jobs');
  expect(response.ok()).toBe(true);
  const { jobs } = await response.json();
  expect(jobs).toHaveLength(10);
  for (const job of jobs) {
    const expected =
      job.external_id === 'sample-poll.timer'
        ? 'failed'
        : job.external_id === 'sample-index.timer'
          ? 'stuck'
          : null;
    expect(job.attention).toBe(expected);
  }
  await expect(page.locator('li.ext[data-external-id="h2"]')).toContainText('paused');
  await expect(
    page.locator('li.ext[data-external-id="sample-poll.timer"] .chip.st-block'),
  ).toHaveText('failed (exit 1)');
  await expect(page.locator('#external-jobs .chip.ro')).toHaveText('read-only');
  await expect(page.locator('#schedules-summary')).toContainText('1 failed run in 24 h');
  await expect(page.locator('#schedules-summary')).toContainText('10 mirrored');

  await page.evaluate(() => document.fonts.ready);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  for (const id of ['#own-jobs-list', '#external-jobs-list']) {
    expect(await page.locator(id).evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
  }
  await page.screenshot({ path: `${SHOTS}/schedules-${info.project.name}.png`, fullPage: true });
  await list.locator('summary').click();
  await expect(list.locator('details li.ext:visible')).toHaveCount(5);
  expect(problems).toEqual([]);
});

test('schedules: create a job, run it now, read its output', async ({ page, baseURL }, info) => {
  test.skip(
    info.project.name !== '1440-light' && info.project.name !== '375-dark',
    'twice is enough',
  );
  const problems = watch(page, baseURL as string);
  await page.addInitScript((t) => localStorage.setItem('mm.token', t), E2E_TOKEN);
  await page.goto('/#/schedules');
  const name = `Mirror check ${info.project.name}`;

  // Create a collector job through the form; the schedule preview lists the next runs.
  await page.locator('#job-new').click();
  const form = page.locator('#job-form-dialog');
  await expect(form).toBeVisible();
  await page.locator('#jf-name').fill(name);
  await expect(page.locator('#jf-kind option[value="shell"]')).toBeDisabled(); // no jobs:shell
  await page.locator('#jf-collector').selectOption('hermes-cron');
  await page.locator('#jf-schedule').fill('not cron');
  await expect(form.locator('.bad')).toBeVisible();
  await page.locator('#jf-schedule').fill('*/30 * * * *');
  await expect(form).toContainText('Next:');
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/schedules-form-${info.project.name}.png` });
  await page.locator('#jf-save').click();

  // The new job's sheet opens; run it now and read the collector report.
  const sheet = page.locator('#job-sheet');
  await expect(sheet.locator('#job-sheet-title')).toHaveText(name);
  await expect(sheet).toContainText('This job has not run yet.');
  await sheet.locator('button.run-now').click();
  const run = sheet.locator('ul.job-runs li').first();
  await expect(run.locator('.chip')).toHaveText('ok', { timeout: 10_000 });
  await expect(run).toContainText('manual by e2e');
  await run.locator('summary').click();
  await expect(run.locator('pre.job-output')).toContainText('"jobs": 3');
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/schedules-sheet-${info.project.name}.png` });

  // Disable, then delete it.
  await sheet.locator('#job-toggle').click();
  await expect(sheet.locator('#job-toggle')).toHaveText('Enable');
  page.once('dialog', (d) => void d.accept());
  await sheet.locator('#job-delete').click();
  await expect(sheet).toBeHidden();
  await expect(row(page, name)).toHaveCount(0);

  // A seeded shell job runs from the table with a plain write token (no jobs:shell needed).
  if (info.project.name === '1440-light') {
    const hello = row(page, 'Say hello');
    await hello.locator('button.run-now').click();
    await expect(hello.locator('.last .chip')).toHaveText('ok', { timeout: 10_000 });
    await hello.locator('.job-open').click();
    await sheet.locator('ul.job-runs summary').first().click();
    await expect(sheet.locator('pre.job-output').first()).toHaveText('hello from the sample job');
    // Write-only tokens cannot edit shell jobs.
    await expect(sheet.locator('#job-edit')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  }
  expect(problems).toEqual([]);
});
