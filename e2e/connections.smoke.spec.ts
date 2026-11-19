// Connections page with synthetic sources (e2e/fixtures/connections.ts) at every width and theme;
// then paths and "Read now" while signed in.

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

const card = (page: Page, id: string) => page.locator(`.conn-card[data-conn="${id}"]`);

test('connections: plans and local models with status checks and last readings', async ({
  page,
  baseURL,
}, info) => {
  const problems = watch(page, baseURL as string);
  await page.goto('/#/connections');
  await expect(page.locator('h1#page-title')).toHaveText('Connections');

  // Claude: login file present and fresh readings.
  const a = card(page, 'plan-a');
  await expect(a.locator('.conn-status')).toHaveText('working');
  await expect(a.locator('.conn-kind')).toHaveText('Claude subscription');
  await expect(a.locator('.conn-checks')).toContainText('Claude Code login');
  await expect(a.locator('.conn-readings li[data-window="weekly"]')).toContainText('% used');
  await expect(a.locator('.conn-readings li[data-window="five_hour"]')).toBeVisible();

  // Codex: session log found, but the last reading is stale.
  const b = card(page, 'plan-b');
  await expect(b.locator('.conn-status')).toHaveText('check');
  await expect(b.locator('.conn-checks')).toContainText('newest session log');
  await expect(b.locator('.conn-readings .stale')).toHaveText('stale');

  await expect(card(page, 'plan-c').locator('.conn-status')).toHaveText('manual');

  // Local models: a live fake Ollama and a closed port.
  const local = card(page, 'local');
  await expect(local.locator('.conn-status')).toHaveText('working');
  await expect(local).toContainText('tiny-model:1b, small-coder:7b');
  const offline = card(page, 'offline');
  await expect(offline.locator('.conn-status')).toHaveText('not connected');
  await expect(offline.locator('.conn-summary')).toHaveText('Connection refused (is it running?)');

  // Signed out: no file paths or URLs, no Read now.
  await expect(page.locator('.conn-path')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('127.0.0.1');
  await expect(page.locator('button.read-now')).toHaveCount(0);
  await expect(page.locator('#connections-summary')).toHaveText(
    '2 working · 1 to check · 1 not connected · 1 manual',
  );

  await page.evaluate(() => document.fonts.ready);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  // One screen at laptop size: the how-to panels start closed.
  if (info.project.name.startsWith('1440'))
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(
      900,
    );
  await page.screenshot({ path: `${SHOTS}/connections-${info.project.name}.png`, fullPage: true });

  // How to connect, with the privacy note for the Claude login.
  await a.locator('.conn-how summary').click();
  await expect(a.locator('.conn-note')).toContainText('The login never leaves this host');
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(problems).toEqual([]);
});

test('connections: signed in shows paths and reads a plan now', async ({ page, baseURL }, info) => {
  test.skip(
    info.project.name !== '1440-light' && info.project.name !== '375-dark',
    'twice is enough',
  );
  const problems = watch(page, baseURL as string);
  await page.addInitScript((t) => localStorage.setItem('mm.token', t), E2E_TOKEN);
  await page.goto('/#/connections');
  await expect(card(page, 'plan-a').locator('.conn-path code')).toContainText(
    'claude-credentials.json',
  );
  await expect(card(page, 'plan-b').locator('.conn-path')).toContainText('sessions_dir:');
  await expect(card(page, 'local').locator('dd code')).toContainText('http://127.0.0.1:');
  // Codex reads only local session logs, so it is safe to run here (the fixture has no limits).
  await card(page, 'plan-b').locator('button.read-now').click();
  await expect(card(page, 'plan-b').locator('.conn-ok')).toHaveText('Nothing new');
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/connections-signed-in-${info.project.name}.png` });
  await page.locator('#connections-refresh').click();
  await expect(card(page, 'local').locator('.conn-status')).toHaveText('working');
  expect(problems).toEqual([]);
});
