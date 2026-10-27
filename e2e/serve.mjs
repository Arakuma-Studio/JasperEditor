#!/usr/bin/env node
// E2E server: runs the *built* engine (apps/engine/dist/engine.mjs) with the built web app
// (apps/web/dist) on 127.0.0.1:<E2E_PORT> and a throwaway appdir, so every `pnpm e2e` run starts from an
// empty project list. Playwright's `webServer` starts this script and stops it with SIGTERM.
// The engine is authenticated: playwright.config.ts passes JASPER_LOCAL_TOKEN and
// JASPER_EDITOR_KEY and gives the browser the matching cookies. Started by hand without them, the engine makes its
// own and prints the pairing link to open in a browser.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
// Speech models provisioned by scripts/e2e-prepare.mjs (pinned, sha256-verified): linked into the appdir's models
// directory, so the engine lists them installed without downloading anything during a spec.
const speechCache = process.env.JASPER_SPEECH_MODELS_DIR ?? join(root, 'target', 'speech-models');
if (existsSync(speechCache)) {
	const into = join(appdir, 'models', 'speech');
	mkdirSync(into, { recursive: true });
	for (const id of readdirSync(speechCache, { withFileTypes: true }))
		if (id.isDirectory() && !existsSync(join(into, id.name)))
			symlinkSync(join(speechCache, id.name), join(into, id.name), 'dir');
}
// The specs read this file to find the appdir (e.g. to inspect the project store on disk).
const infoFile = join(root, 'test-results', 'e2e-server.json');
mkdirSync(dirname(infoFile), { recursive: true });
writeFileSync(infoFile, JSON.stringify({ port: Number(port), appdir }));

// Sound packs (spec 12 P6-R1): E2E never downloads. The engine's pack catalogue is a file in the throwaway appdir
// (empty here); a spec writes its own catalogue there, with file:// URLs, and the engine reads it on every request.
const soundCatalog = process.env.JASPER_SOUND_CATALOG ?? join(appdir, 'e2e-sound-catalog.json');
if (!process.env.JASPER_SOUND_CATALOG) writeFileSync(soundCatalog, JSON.stringify({ version: 1, packs: [] }));

const child = spawn(process.execPath, [engineBundle, '--port', port, '--appdir', appdir], {
	cwd: root,
	stdio: 'inherit',
	env: {
		...process.env,
		JASPER_APPDIR: appdir,
		JASPER_WEB_DIR: webDir,
		// sound-design: one Jasper Synth variant per type (19 sounds) keeps the first index of the throwaway appdir short;
		// the bundled starter kit is indexed in full.
		JASPER_SOUND_SYNTH_VARIANTS: process.env.JASPER_SOUND_SYNTH_VARIANTS ?? '1',
		JASPER_SOUND_CATALOG: soundCatalog,
	},
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
