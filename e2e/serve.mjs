#!/usr/bin/env node
// E2E server (WP-3I): runs the *built* engine (apps/engine/dist/engine.mjs) with the built web app
// (apps/web/dist) on 127.0.0.1:<E2E_PORT> and a throwaway appdir, so every `pnpm e2e` run starts from an
// empty project list. Playwright's `webServer` starts this script and stops it with SIGTERM.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.E2E_PORT ?? '48110';
const engineBundle = join(root, 'apps/engine/dist/engine.mjs');
const webDir = join(root, 'apps/web/dist');

for (const [what, file] of [
	['engine bundle', engineBundle],
	['web build', join(webDir, 'index.html')],
]) {
	if (!existsSync(file)) {
		console.error(`[e2e] missing ${what} (${file}); run \`pnpm build\` first`);
		process.exit(1);
	}
}

const appdir = process.env.E2E_APPDIR ?? mkdtempSync(join(tmpdir(), 'jasper-e2e-'));
mkdirSync(appdir, { recursive: true });
// The specs read this file to find the appdir (e.g. to inspect the project store on disk).
const infoFile = join(root, 'test-results', 'e2e-server.json');
mkdirSync(dirname(infoFile), { recursive: true });
writeFileSync(infoFile, JSON.stringify({ port: Number(port), appdir }));

const child = spawn(process.execPath, [engineBundle, '--port', port, '--appdir', appdir], {
	cwd: root,
	stdio: 'inherit',
	env: { ...process.env, JASPER_APPDIR: appdir, JASPER_WEB_DIR: webDir },
});

let stopping = false;
function stop(code = 0) {
	if (stopping) return;
	stopping = true;
	child.kill('SIGTERM');
	const force = setTimeout(() => child.kill('SIGKILL'), 5000);
	child.once('exit', () => {
		clearTimeout(force);
		if (!process.env.E2E_APPDIR && !process.env.E2E_KEEP_APPDIR)
			rmSync(appdir, { recursive: true, force: true });
		process.exit(code);
	});
}
child.once('exit', (code) => {
	if (!stopping) {
		console.error(`[e2e] engine exited early (${code})`);
		process.exit(1);
	}
});
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
process.on('SIGHUP', () => stop());
