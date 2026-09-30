#!/usr/bin/env node
// Electron smoke (WP-3I, ARCHITECTURE §15 item 11): launches the desktop shell headless under xvfb and checks
// that the window loaded the app and rendered it (screenshot captured by main.ts' JASPER_DESKTOP_SCREENSHOT hook).
//
//   node e2e/desktop-smoke.mjs dev            # starts a dev engine (tsx) + Vite, then `electron .` in dev mode
//   node e2e/desktop-smoke.mjs packaged-like  # Electron forks apps/engine/dist/engine.mjs itself (run `pnpm build`)
//
// Env: DESKTOP_SMOKE_PORT (base port, default 48140: engine = base, Vite = base + 1). Screenshots go to
// test-results/desktop-<mode>.png. Needs xvfb-run; sets ELECTRON_DISABLE_SANDBOX=1 (no SUID sandbox helper).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
	JASPER_DESKTOP_SCREENSHOT: shot,
	JASPER_DESKTOP_SCREENSHOT_DELAY_MS: '4000',
	JASPER_DESKTOP_EXIT: '1',
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
const t0 = Date.now();
const app = spawn(
	'xvfb-run',
	['-a', '-s', '-screen 0 1920x1080x24', electron, desktop, `--user-data-dir=${userData}`],
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
const code = await new Promise((resolve) => {
	const timer = setTimeout(() => {
		app.kill('SIGKILL');
		resolve('timeout');
	}, 120_000);
	app.once('exit', (c) => {
		clearTimeout(timer);
		resolve(c);
	});
});

const loaded = /\[desktop\] loaded (http:\/\/127\.0\.0\.1:\d+\/\S*)/.exec(out);
if (!loaded) fail(`the window never finished loading (exit ${code})\n${out.slice(-3000)}`);
if (!/\[desktop\] screenshot /.test(out)) fail(`no screenshot was captured (exit ${code})`);
if (!existsSync(shot) || statSync(shot).size < 20_000) fail(`screenshot ${shot} is missing or blank`);
// PNG IHDR: width/height at bytes 16..24.
const png = readFileSync(shot);
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
console.log(
	`[desktop-smoke] PASS ${mode}: loaded ${loaded[1]}, screenshot ${shot} ${width}x${height} (${statSync(shot).size} bytes), ${Math.round((Date.now() - t0) / 1000)} s`,
);
process.exit(0);
