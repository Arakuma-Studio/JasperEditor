#!/usr/bin/env node
// Electron smoke (WP-3I, ARCHITECTURE §15 item 11): launches the desktop shell headless under xvfb and checks
// that the window loaded the app and rendered it. Connects to Electron over CDP for a screenshot.
//
//   node e2e/desktop-smoke.mjs dev            # starts a dev engine (tsx) + Vite, then `electron .` in dev mode
//   node e2e/desktop-smoke.mjs packaged-like  # Electron forks apps/engine/dist/engine.mjs itself (run `pnpm build`)
//
// Env: DESKTOP_SMOKE_PORT (base port, default 48140: engine = base, Vite = base + 1). Screenshots go to
// test-results/desktop-<mode>.png. Needs xvfb-run; sets ELECTRON_DISABLE_SANDBOX=1 (no SUID sandbox helper).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps/desktop');
const mode = process.argv[2] ?? 'packaged-like';
if (!['dev', 'packaged-like'].includes(mode)) {
	console.error('usage: node e2e/desktop-smoke.mjs dev|packaged-like');
	process.exit(2);
}
const base = Number(process.env.DESKTOP_SMOKE_PORT ?? 48140);
const shot = join(root, 'test-results', `desktop-${mode}.png`);
const children = [];
const temps = [];

function cleanup() {
	for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
	for (const d of temps) rmSync(d, { recursive: true, force: true });
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));

function fail(msg) {
	console.error(`[desktop-smoke] FAIL: ${msg}`);
	process.exit(1);
}

async function waitFor(url, ms) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		try {
			const r = await fetch(url);
			if (r.ok) return;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	fail(`${url} did not come up within ${ms} ms`);
}

/**
 * Loads the app's static module graph once from Node, as a first browser visit to `pnpm dev` would, so the window
 * opens on a warm dev server. A cold Vite transforms several hundred modules on demand, and on a loaded machine the
 * window's first load then takes long enough for Chromium to abort it (net::ERR_NETWORK_CHANGED whenever the host's
 * addresses change, e.g. a Docker container starting; Node's fetch is not affected). The page reloads itself when
 * that happens (apps/web/editor-boot.ts) and that is tested in apps/web; this keeps the smoke about the desktop shell.
 */
async function warmViteGraph(origin, ms) {
	const t0 = Date.now();
	const seen = new Set();
	const queue = ['/', '/src/main.tsx'];
	const importRe = /(?:\bimport\s*(?:[^'"()]*?\bfrom\s*)?|\bexport\s*[^'"()]*?\bfrom\s*)["'](\/[^"']+)["']/g;
	let failures = 0;
	const one = async (path) => {
		try {
			const response = await fetch(origin + path, { signal: AbortSignal.timeout(60_000) });
			const text = await response.text();
			if (!response.ok) return;
			if (path === '/') {
				for (const m of text.matchAll(/<script[^>]+src="(\/[^"]+)"/g)) queue.push(m[1]);
				return;
			}
			for (const m of text.matchAll(importRe)) if (!m[1].startsWith('//')) queue.push(m[1]);
		} catch {
			failures++;
		}
	};
	while (queue.length && Date.now() - t0 < ms) {
		const batch = [];
		while (queue.length && batch.length < 8) {
			const next = queue.shift();
			if (seen.has(next)) continue;
			seen.add(next);
			batch.push(one(next));
		}
		await Promise.all(batch);
	}
	console.log(
		`[desktop-smoke] warmed the dev server: ${seen.size} modules in ${Math.round((Date.now() - t0) / 1000)} s${failures ? ` (${failures} failed)` : ''}`,
	);
}

async function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

// Electron binary (installed by electron's postinstall; a fresh worktree may need
// `node node_modules/.pnpm/electron@*/node_modules/electron/install.js`).
const electron = createRequire(join(desktop, 'package.json'))('electron');
if (typeof electron !== 'string' || !existsSync(electron)) fail(`electron binary missing (${electron})`);
if (spawnSync('which', ['xvfb-run']).status !== 0) fail('xvfb-run is not installed');

const build = spawnSync(process.execPath, [join(desktop, 'scripts/build-main.mjs')], { stdio: 'inherit' });
if (build.status !== 0) fail('building the Electron main/preload failed');

const env = {
	...process.env,
	ELECTRON_DISABLE_SANDBOX: '1',
};

if (mode === 'dev') {
	const appdir = mkdtempSync(join(tmpdir(), 'jasper-desktop-dev-'));
	temps.push(appdir);
	const enginePort = base;
	const webPort = base + 1;
	children.push(
		spawn(
			join(root, 'node_modules/.bin/tsx'),
			[join(root, 'apps/engine/src/cli.ts'), '--port', String(enginePort)],
			{
				cwd: root,
				stdio: 'inherit',
				env: { ...process.env, JASPER_APPDIR: appdir, JASPER_DEV: '1', JASPER_DEV_WEB_PORT: String(webPort) },
			},
		),
	);
	children.push(
		spawn(
			join(root, 'apps/web/node_modules/.bin/vite'),
			['--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
			{
				cwd: join(root, 'apps/web'),
				stdio: 'inherit',
				env: { ...process.env, JASPER_ENGINE_URL: `http://127.0.0.1:${enginePort}` },
			},
		),
	);
	await waitFor(`http://127.0.0.1:${webPort}/health`, 60_000); // Vite up and proxying to the engine
	await warmViteGraph(`http://127.0.0.1:${webPort}`, 300_000);
	env.JASPER_DESKTOP_DEV_URL = `http://127.0.0.1:${webPort}`;
} else {
	for (const f of ['apps/engine/dist/engine.mjs', 'apps/web/dist/index.html'])
		if (!existsSync(join(root, f))) fail(`${f} is missing: run \`pnpm build\` first`);
	const appdir = mkdtempSync(join(tmpdir(), 'jasper-desktop-pkg-'));
	temps.push(appdir);
	env.JASPER_DESKTOP_MODE = 'packaged-like';
	env.JASPER_APPDIR = appdir;
}

mkdirSync(dirname(shot), { recursive: true });
rmSync(shot, { force: true });
const userData = mkdtempSync(join(tmpdir(), 'jasper-desktop-profile-'));
temps.push(userData);
const cdpPort = await freePort();
const t0 = Date.now();
const app = spawn(
	'xvfb-run',
	[
		'-a',
		'-s',
		'-screen 0 1920x1080x24',
		electron,
		desktop,
		`--user-data-dir=${userData}`,
		`--remote-debugging-port=${cdpPort}`,
	],
	{
		cwd: desktop,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
	},
);
children.push(app);
let out = '';
app.stdout.on('data', (d) => {
	out += d;
	process.stdout.write(d);
});
app.stderr.on('data', (d) => {
	out += d;
});
let loaded;
for (let i = 0; i < 600 && !loaded; i++) {
	loaded = /\[desktop\] loaded (http:\/\/127\.0\.0\.1:\d+\/\S*)/.exec(out);
	if (app.exitCode !== null) fail(`the window exited before loading (${app.exitCode})\n${out.slice(-3000)}`);
	if (!loaded) await new Promise((r) => setTimeout(r, 200));
}
if (!loaded) fail(`the window never finished loading\n${out.slice(-3000)}`);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
try {
	const page = browser
		.contexts()[0]
		?.pages()
		.find((p) => p.url().startsWith(loaded[1]));
	if (!page) fail(`no window at ${loaded[1]}`);
	const browserEvents = [];
	page.on('console', (message) => browserEvents.push(`console ${message.type()}: ${message.text()}`));
	page.on('pageerror', (error) => browserEvents.push(`pageerror: ${error.stack ?? error.message}`));
	page.on('requestfailed', (request) =>
		browserEvents.push(
			`request failed: ${request.method()} ${request.url()} ${request.failure()?.errorText}`,
		),
	);
	page.on('response', (response) => {
		if (response.status() >= 400) browserEvents.push(`HTTP ${response.status()}: ${response.url()}`);
	});
	try {
		await expect(page.getByTestId('home')).toBeVisible({ timeout: mode === 'dev' ? 120_000 : 30_000 });
	} catch (error) {
		const dom = await page.evaluate(() => ({
			url: location.href,
			body: document.body?.innerText.slice(0, 4000) ?? '',
			html: document.documentElement?.outerHTML.slice(0, 12000) ?? '',
			viteError: document.querySelector('vite-error-overlay')?.shadowRoot?.textContent?.slice(0, 4000) ?? '',
			resources: performance
				.getEntriesByType('resource')
				.map((entry) => ({ name: entry.name, duration: entry.duration, transferSize: entry.transferSize }))
				.slice(-80),
		}));
		const moduleResponse = await page.evaluate(async () => {
			try {
				const response = await fetch('/src/main.tsx', { signal: AbortSignal.timeout(5000) });
				return { status: response.status, body: (await response.text()).slice(0, 2000) };
			} catch (error) {
				return { error: String(error) };
			}
		});
		const diagnostics = {
			dom,
			moduleResponse,
			browserEvents: browserEvents.slice(-60),
			electronOutput: out.slice(-8000),
		};
		const failureFile = join(root, 'test-results', `desktop-${mode}-failure.json`);
		writeFileSync(failureFile, JSON.stringify(diagnostics, null, 2));
		await page
			.screenshot({ path: join(root, 'test-results', `desktop-${mode}-failure.png`) })
			.catch(() => {});
		throw new Error(`Desktop home did not render; diagnostics in ${failureFile}: ${error}`);
	}
	// The Home screen settles once the project list has loaded (an empty-state guide or the list): the screenshot
	// size check below needs that, not the "Loading projects…" placeholder a starved machine can still show.
	await expect(
		page
			.locator('[data-testid="home-empty"], [data-testid="project-list"], [data-testid="projects-error"]')
			.first(),
	).toBeVisible({
		timeout: mode === 'dev' ? 120_000 : 30_000,
	});
	await page.screenshot({ path: shot });
	// Security review DEV-1 / AGT-2 in the desktop shell: the window is signed in to its engine and is the editor
	// (the engine's /agent relay says so), through cookies the page cannot read; the engine itself answers nothing
	// without its token.
	const authReport = await page.evaluate(async () => {
		const projects = (await fetch('/api/projects')).status;
		const editor = await new Promise((resolve) => {
			const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/agent`);
			const timer = setTimeout(() => resolve('timeout'), 10_000);
			ws.onerror = () => resolve('error');
			ws.onopen = () =>
				ws.send(
					JSON.stringify({ type: 'hello', projectId: 'prj_smoke', sessionId: 'ses_smoke', leaseId: null }),
				);
			ws.onmessage = (ev) => {
				const m = JSON.parse(String(ev.data));
				if (m.type !== 'welcome') return;
				clearTimeout(timer);
				ws.close();
				resolve(m.editor);
			};
		});
		return { projects, editor, cookieVisibleToScripts: /jasper_(session|editor)/.test(document.cookie) };
	});
	const engineOrigin = mode === 'dev' ? `http://127.0.0.1:${base}` : new URL(loaded[1]).origin;
	const withoutToken = (await fetch(`${engineOrigin}/api/projects`)).status;
	writeFileSync(
		join(root, 'test-results', `desktop-${mode}-auth.json`),
		JSON.stringify({ ...authReport, withoutToken }, null, 2),
	);
	expect({ ...authReport, withoutToken }).toEqual({
		projects: 200,
		editor: true,
		cookieVisibleToScripts: false,
		withoutToken: 401,
	});
	const allowed = await page.evaluate(() => window.jasperDesktop?.mcpInfo());
	const payload = {
		json: '{"format":"jasper-clipboard","version":1,"items":[]}',
		html: '<span>Origin check</span>',
		text: 'Origin check',
	};
	const appClipboard = await page.evaluate(
		async (data) => ({
			written: await window.jasperDesktop.clipboard.write(data),
			read: await window.jasperDesktop.clipboard.read(),
		}),
		payload,
	);
	// CDP can navigate the existing renderer beyond the app's normal navigation guard. The preload still runs,
	// so this invokes the actual jasper:mcp-info handler with a hostile senderFrame URL.
	await page.goto('data:text/html,<title>Untrusted page</title>');
	const hostileBridge = await page.evaluate(() => typeof window.jasperDesktop?.mcpInfo);
	const hostileResult =
		hostileBridge === 'function'
			? await page.evaluate(
					async (data) => ({
						mcpInfo: await window.jasperDesktop.mcpInfo(),
						clipboardWrite: await window.jasperDesktop.clipboard.write(data),
						clipboardRead: await window.jasperDesktop.clipboard.read(),
					}),
					payload,
				)
			: undefined;
	const ipcReport = {
		appOriginAllowed: typeof allowed?.command === 'string',
		appClipboardRoundTrip: appClipboard.written && appClipboard.read === payload.json,
		hostileBridgeCallable: hostileBridge === 'function',
		hostileMcpInfoDenied: hostileResult?.mcpInfo === null,
		hostileClipboardWriteDenied: hostileResult?.clipboardWrite === false,
		hostileClipboardReadDenied: hostileResult?.clipboardRead === null,
	};
	writeFileSync(join(root, 'test-results', `desktop-${mode}-ipc.json`), JSON.stringify(ipcReport, null, 2));
	expect(ipcReport).toEqual({
		appOriginAllowed: true,
		appClipboardRoundTrip: true,
		hostileBridgeCallable: true,
		hostileMcpInfoDenied: true,
		hostileClipboardWriteDenied: true,
		hostileClipboardReadDenied: true,
	});
} finally {
	await browser.close();
	app.kill('SIGTERM');
}
if (!existsSync(shot) || statSync(shot).size < 20_000) fail(`screenshot ${shot} is missing or blank`);
// PNG IHDR: width/height at bytes 16..24.
const png = readFileSync(shot);
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
console.log(
	`[desktop-smoke] PASS ${mode}: loaded ${loaded[1]}, screenshot ${shot} ${width}x${height} (${statSync(shot).size} bytes), ${Math.round((Date.now() - t0) / 1000)} s`,
);
process.exit(0);
