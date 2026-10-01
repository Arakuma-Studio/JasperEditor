#!/usr/bin/env node
// Desktop clipboard runtime check (wp-clipboard-2, S01:CLB-002/010): runs e2e/desktop/clipboard.desktop.ts, which
// starts two packaged-like desktop apps and a helper "other app" under one headless X server and checks copy →
// paste across them through application/x-jasper-clipboard plus external text, image and file pastes.
//
//   pnpm e2e:desktop-clipboard          # builds Electron main/preload, engine and web (E2E_SKIP_BUILD=1: reuse)
//
// Needs xvfb-run and the Electron binary (`node node_modules/.pnpm/electron@*/node_modules/electron/install.js`
// when a fresh checkout lacks it). Sets ELECTRON_DISABLE_SANDBOX=1 (no SUID sandbox helper).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps/desktop');
const fail = (msg) => {
	console.error(`[desktop-clipboard] FAIL: ${msg}`);
	process.exit(1);
};
const run = (cmd, args, opts = {}) => {
	const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
	if (r.status !== 0) process.exit(r.status ?? 1);
};

const electron = createRequire(join(desktop, 'package.json'))('electron');
if (typeof electron !== 'string' || !existsSync(electron))
	fail(
		`electron binary missing (${electron}); run node node_modules/.pnpm/electron@*/node_modules/electron/install.js`,
	);
if (spawnSync('which', ['xvfb-run']).status !== 0) fail('xvfb-run is not installed');

run(process.execPath, [join(desktop, 'scripts/build-main.mjs')]);
run('node', ['scripts/make-fixtures.mjs']);
// The packaged-like apps load the built engine + web app (E2E_SKIP_BUILD=1 reuses existing builds).
const skipBuild = process.env.E2E_SKIP_BUILD === '1';
if (!skipBuild || !existsSync(join(root, 'apps/engine/dist/engine.mjs')))
	run('pnpm', ['--filter', '@jasper/engine', 'build']);
if (!skipBuild || !existsSync(join(root, 'apps/web/dist/index.html')))
	run('pnpm', ['--filter', '@jasper/web', 'build']);

run(
	'xvfb-run',
	[
		'-a',
		'-s',
		'-screen 0 1920x1080x24',
		join(root, 'node_modules/.bin/playwright'),
		'test',
		'-c',
		'playwright.desktop.config.ts',
		...process.argv.slice(2),
	],
	{ env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } },
);
console.log('[desktop-clipboard] PASS');
