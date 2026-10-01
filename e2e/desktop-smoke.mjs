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
	await expect(page.getByTestId('home')).toBeVisible({ timeout: 30_000 });
	await page.screenshot({ path: shot });
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
