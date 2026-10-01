// Desktop (Electron) runtime checks driven by Playwright over CDP (wp-clipboard-2): the apps are launched by the
// specs themselves (packaged-like, each forks its own engine), so there is no web server. Needs an X display:
// run through `pnpm e2e:desktop-clipboard` (e2e/desktop-clipboard.mjs wraps it in xvfb-run).
import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './e2e/desktop',
	testMatch: '**/*.desktop.ts',
	outputDir: './test-results/e2e-desktop',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 180_000,
	expect: { timeout: 15_000 },
	reporter: [['list']],
});
