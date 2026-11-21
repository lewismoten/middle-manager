// Notes page with synthetic collections (e2e/fixtures/notes.ts) at every width and theme; then
// the private collection while signed in.

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

test('notes: documents by date, rendered markdown, private collection locked', async ({
  page,
  baseURL,
}, info) => {
  const problems = watch(page, baseURL as string);
  await page.goto('/#/notes');
  await expect(page.locator('h1#page-title')).toHaveText('Notes');

  // Newest first, grouped by date; the non-recursive glob skips drafts/ and .txt files.
  const groups = page.locator('.date-group');
  await expect(groups).toHaveCount(3);
  await expect(groups.nth(0).locator('h3')).toHaveText('Today');
  await expect(groups.nth(1).locator('h3')).toHaveText('Yesterday');
  await expect(page.locator('.doc-open')).toHaveCount(4);
  await expect(page.locator('.doc-open', { hasText: 'Cache notes' })).toBeVisible(); // frontmatter
  await expect(page.locator('.doc-open', { hasText: 'Draft' })).toHaveCount(0);
  await expect(page.locator('#notes-summary')).toHaveText('4 documents in 1 collection · 1 locked');

  // The newest document opens on its own, rendered from markdown.
  const doc = page.locator('#notes-doc');
  await expect(doc.locator('#notes-doc-title')).toHaveText('Deploy check');
  await expect(page.locator('.doc-open[aria-current="true"]')).toContainText('Deploy check');
  await expect(doc.locator('.md h3', { hasText: 'Steps' })).toBeVisible(); // levels shift under h2
  await expect(doc.locator('.md h2')).toHaveCount(0); // the repeated title is dropped
  await expect(doc.locator('.md ol > li')).toHaveCount(3);
  await expect(doc.locator('.md li.task input[checked]')).toHaveCount(1);
  await expect(doc.locator('.md table th')).toHaveCount(3);
  await expect(doc.locator('.md pre code')).toHaveText('sample-cli status --all');
  await expect(doc.locator('.md a[href="https://example.com/runbook"]')).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  // Raw HTML shows as text and never becomes an element.
  await expect(doc.locator('.md blockquote')).toContainText('<script>alert("x")</script>');
  await expect(doc.locator('.md script')).toHaveCount(0);

  // Private collection: a lock, no titles, and a disabled option in the picker.
  const locked = page.locator('.notes-locked[data-collection="private"]');
  await expect(locked).toContainText('Private notes is private.');
  await expect(locked.locator('button')).toHaveText('Sign in');
  await expect(page.locator('#notes-collection option[value="private"]')).toBeDisabled();
  await expect(page.locator('.doc-open', { hasText: 'Private retro' })).toHaveCount(0);

  await page.evaluate(() => document.fonts.ready);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(await page.locator('#notes-list').evaluate((el) => getComputedStyle(el).overflowY)).toBe(
    'auto',
  );
  await page.screenshot({ path: `${SHOTS}/notes-${info.project.name}.png`, fullPage: true });

  // Title search filters the list; picking a result opens it.
  await page.locator('#notes-search').fill('queue');
  await expect(page.locator('.doc-open')).toHaveCount(1);
  await page.locator('.doc-open', { hasText: 'Queue review' }).click();
  await expect(doc.locator('#notes-doc-title')).toHaveText('Queue review');
  await page.locator('#notes-search').fill('nothing like this');
  await expect(page.locator('#notes-none')).toHaveText('No titles match.');
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(problems).toEqual([]);
});

test('notes: private collection opens after sign-in, and stays closed to the API without one', async ({
  page,
  baseURL,
  request,
}, info) => {
  test.skip(
    info.project.name !== '1440-light' && info.project.name !== '375-dark',
    'twice is enough',
  );
  const problems = watch(page, baseURL as string);
  await page.addInitScript((t) => localStorage.setItem('mm.token', t), E2E_TOKEN);
  await page.goto('/#/notes');
  await expect(page.locator('.notes-locked')).toHaveCount(0);
  await expect(page.locator('#notes-summary')).toHaveText('5 documents in 2 collections');
  await page.locator('#notes-collection').selectOption('private');
  await expect(page.locator('.doc-open')).toHaveCount(1);
  await page.locator('.doc-open', { hasText: 'Private retro' }).click();
  await expect(page.locator('#notes-doc-title')).toHaveText('Private retro');
  await expect(page.locator('#notes-doc .lock')).toHaveText('private');
  await page.screenshot({ path: `${SHOTS}/notes-private-${info.project.name}.png` });

  const id = await page.locator('.doc-open[aria-current="true"]').getAttribute('data-doc');
  expect((await request.get(`/api/v1/documents/${id}`)).status()).toBe(401);
  expect((await request.get('/api/v1/documents?collection=private')).status()).toBe(401);
  const anon = (await (await request.get('/api/v1/documents')).json()) as {
    documents: { title: string }[];
  };
  expect(anon.documents.map((d) => d.title)).not.toContain('Private retro');
  expect(problems).toEqual([]);
});
