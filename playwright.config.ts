import { defineConfig } from '@playwright/test';
import { E2E_BOARD_PORT, E2E_PORT } from './e2e/constants.ts';

const widths = [1440, 768, 375] as const;
const schemes = ['light', 'dark'] as const;
const heightFor = (w: number) => (w >= 1024 ? 900 : w >= 700 ? 1024 : 812);

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/playwright',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    // Bundled Chromium from Playwright; never a system browser channel.
    browserName: 'chromium',
    trace: 'off',
  },
  projects: [
    // Every page at three widths, light and dark.
    ...widths.flatMap((width) =>
      schemes.map((colorScheme) => ({
        name: `${width}-${colorScheme}`,
        testMatch: /smoke\.spec\.ts$/, // smoke.spec.ts plus <page>.smoke.spec.ts
        use: { viewport: { width, height: heightFor(width) }, colorScheme },
      })),
    ),
    // Behaviour (keyboard, theme, sign-in): once is enough.
    {
      name: 'interactions',
      testMatch: 'interactions.spec.ts',
      use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
    },
  ],
  webServer: [
    {
      command: `node e2e/serve.ts`,
      url: `http://127.0.0.1:${E2E_PORT}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      // The large synthetic board (e2e/fixtures/board.ts) for board.smoke.spec.ts.
      command: `node e2e/serve.ts board`,
      url: `http://127.0.0.1:${E2E_BOARD_PORT}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
  ],
});
