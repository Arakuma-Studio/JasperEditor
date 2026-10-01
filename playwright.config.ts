// Runs against the built engine serving the built web app with a temporary appdir.
// `pnpm e2e` prepares fixtures, binaries, and builds before Playwright starts.
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
