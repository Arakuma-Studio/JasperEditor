// Playwright E2E smoke (WP-3I, ARCHITECTURE §15 item 13). Runs headless against the *built* engine, which
// also serves the built web app (`e2e/serve.mjs`), on 127.0.0.1:${E2E_PORT:-48110} with a temp appdir.
// Uses the system Chrome (`channel: 'chrome'`, D-16). Run `pnpm build && pnpm fixtures` first
// (`pnpm e2e` does both when the outputs are missing, see scripts/e2e-prepare.mjs).
import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 48110);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.spec.ts',
	outputDir: './test-results/e2e',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 180_000,
	expect: { timeout: 15_000 },
	reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
	use: {
		baseURL,
		channel: 'chrome',
		headless: true,
		viewport: { width: 1600, height: 1000 },
		acceptDownloads: true,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'off',
	},
	webServer: {
		command: 'node e2e/serve.mjs',
		url: `${baseURL}/health`,
		reuseExistingServer: false,
		timeout: 60_000,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { E2E_PORT: String(port) },
	},
});
