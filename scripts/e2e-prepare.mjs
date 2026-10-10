#!/usr/bin/env node
// `pnpm e2e` pre-step: the E2E server runs the built engine and web app, including a current Remotion bundle;
// the agent spec runs the built jasper-mcp server. Build them unless E2E_SKIP_BUILD=1 (jasper-mg too, when cargo is
// installed), make sure fixtures exist and are current, and that the LGPL FFmpeg + Remotion binaries directory is
// there (ARCHITECTURE D-13).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args) => {
	const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
	if (r.status !== 0) process.exit(r.status ?? 1);
};

// Creates missing fixtures and regenerates ones whose recipe changed (a no-op when they are current).
run('node', ['scripts/make-fixtures.mjs']);
// D-13: the E2E engine is a built (non-dev) engine, which only renders through Remotion with the LGPL
// FFmpeg directory. Fetch it when a pinned prebuilt exists for this platform (a no-op when it is current);
// elsewhere (macOS) it has to be built once with `pnpm ffmpeg:lgpl`. E2E_SKIP_LGPL=1 skips this step.
if (process.env.E2E_SKIP_LGPL !== '1') {
	const manifest = JSON.parse(readFileSync(join(root, 'scripts/ffmpeg/manifest.json'), 'utf8'));
	const key = `${process.platform}-${process.arch}`;
	if (manifest.prebuilt.platforms[key]) run('node', ['scripts/ffmpeg/fetch-or-build-lgpl.mjs']);
	else if (!existsSync(join(root, 'vendor/ffmpeg-lgpl', key, 'BUILDINFO.json')))
		console.warn(
			`[e2e] no LGPL FFmpeg for ${key} (vendor/ffmpeg-lgpl/${key}): run \`pnpm ffmpeg:lgpl\` once, ` +
				'otherwise the Remotion export spec fails (built engines never use the bundled GPL FFmpeg)',
		);
}
if (process.env.E2E_SKIP_BUILD !== '1') {
	// jasper-mg (native/mg, the fframes renderer of motion-graphic clips) is an optional native tool: built here when
	// cargo is installed (incremental, a no-op when it is current); without cargo `mg:build` prints why it skipped
	// and exits 0, the engine reports `render.fframes = "unavailable"`, and the smoke spec's native motion-graphic
	// export skips with that reason. E2E_SKIP_MG=1 leaves the binary as it is.
	if (process.env.E2E_SKIP_MG !== '1') run('node', ['scripts/mg-build.mjs']);
	run('pnpm', ['--filter', '@jasper/engine', 'build']);
	run('pnpm', ['--filter', '@jasper/engine', 'build:remotion']);
	run('pnpm', ['--filter', '@jasper/web', 'build']);
	// e2e/agent.spec.ts drives the editor through the built MCP server, like an external coding agent.
	run('pnpm', ['--filter', '@jasper/mcp', 'build']);
}
