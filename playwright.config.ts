// Runs against the built engine serving the built web app with a temporary appdir.
// `pnpm e2e` prepares fixtures, binaries, and builds before Playwright starts.
import { randomBytes } from 'node:crypto';
import { defineConfig } from '@playwright/test';
import { e2eServerTimeoutMs } from './e2e/server-timeout';

const port = Number(process.env.E2E_PORT ?? 48110);
const baseURL = `http://127.0.0.1:${port}`;

// Security review DEV-1 / AGT-2: the E2E engine is authenticated like a packaged one. The harness plays the desktop
// shell: it makes the per-run token and editor key, starts the engine with them, and gives the browser (and the
// `request` fixture) both as cookies, so pages are the editor. Workers re-evaluate this file: the secrets are kept in
// the environment the workers inherit. Specs that talk to the engine as an agent (jasper-mcp) find the token in
// the engine's runtime file, like a user's; `E2E_TOKEN` is there for a spec that needs it directly.
process.env.E2E_TOKEN ??= randomBytes(24).toString('base64url');
process.env.E2E_EDITOR_KEY ??= randomBytes(24).toString('base64url');
const token = process.env.E2E_TOKEN;
const editorKey = process.env.E2E_EDITOR_KEY;
const cookie = (name: string, value: string) => ({
	name: `${name}_${port}`,
	value,
	domain: '127.0.0.1',
	path: '/',
	expires: -1,
	httpOnly: true,
	secure: false,
	sameSite: 'Strict' as const,
});

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
		storageState: {
			cookies: [cookie('jasper_session', token), cookie('jasper_editor', editorKey)],
			origins: [],
		},
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
		// Start-up of the built engine + web app; `E2E_SERVER_TIMEOUT_MS` overrides the 180 s default on a loaded host.
		timeout: e2eServerTimeoutMs(),
		stdout: 'pipe',
		stderr: 'pipe',
		env: { E2E_PORT: String(port), JASPER_LOCAL_TOKEN: token, JASPER_EDITOR_KEY: editorKey },
	},
});
