// Synthetic markdown collections for the e2e server: an open "Ops logs" folder and a private one.
// Dates are relative to today so the list shows Today / Yesterday groups. All content is made up.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DAY = 86_400_000;

export function seedNotes(dir: string, now = Date.now()): { logs: string; private: string } {
  const day = (n: number) => new Date(now - n * DAY).toISOString().slice(0, 10);
  const logs = path.join(dir, 'notes', 'logs');
  const priv = path.join(dir, 'notes', 'private');
  mkdirSync(path.join(logs, 'drafts'), { recursive: true });
  mkdirSync(priv, { recursive: true });
  const write = (folder: string, name: string, text: string) =>
    writeFileSync(path.join(folder, name), text);

  write(
    logs,
    `${day(0)}-deploy-check.md`,
    [
      '# Deploy check',
      '',
      'Checked the **sample service** after the deploy. Details in the [runbook](https://example.com/runbook).',
      '',
      '## Steps',
      '',
      '1. Pull the build',
      '2. Restart `sample-worker`',
      '   - wait for the health check',
      '3. Watch the queue',
      '',
      '## Follow-ups',
      '',
      '- [x] Rotate the sample log',
      '- [ ] Trim old cache entries',
      '',
      '| Check | Result | Time |',
      '| --- | :---: | ---: |',
      '| health | ok | 0.4 s |',
      '| queue depth | 12 | 1.1 s |',
      '',
      '```sh',
      'sample-cli status --all',
      '```',
      '',
      '> Raw HTML stays text: <script>alert("x")</script>',
      '',
      '---',
      '',
      'Next check tomorrow.',
    ].join('\n'),
  );
  write(
    logs,
    `${day(1)}-queue-review.md`,
    '# Queue review\n\nQueue depth stayed under 20 all day. A long line to check wrapping: ' +
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.\n',
  );
  write(
    logs,
    `${day(1)}-cache.md`,
    '---\ntitle: Cache notes\n---\nThe cache warmed in *four* minutes.\n',
  );
  write(logs, `${day(30)}-older.md`, '# Older summary\n\nNothing to report.\n');
  write(path.join(logs, 'drafts'), 'not-indexed.md', '# Draft (the glob is not recursive)\n');
  write(logs, 'readme.txt', 'Not markdown.');
  write(priv, `${day(0)}-private-retro.md`, '# Private retro\n\nSynthetic private note.\n');
  return { logs, private: priv };
}
