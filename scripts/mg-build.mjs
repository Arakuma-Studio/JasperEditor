#!/usr/bin/env node
// `pnpm mg:build`: release build of the jasper-mg motion-graphics renderer (native/mg, ARCHITECTURE
// §10.2). When cargo is not installed it prints a skip notice and exits 0 — the binary is optional:
// without it the engine reports `render.fframes = 'unavailable'` and previews use the TS twins.
//
// Flags: --dev (dev profile, faster incremental builds), --quiet (only the result line).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = join(root, 'native', 'mg', 'Cargo.toml');
const exe = process.platform === 'win32' ? 'jasper-mg.exe' : 'jasper-mg';
const args = process.argv.slice(2);
const dev = args.includes('--dev');
const quiet = args.includes('--quiet');

/** Resolves the cargo executable (CARGO env, PATH, then ~/.cargo/bin). */
function findCargo(env = process.env) {
	const candidates = [env.CARGO, 'cargo'];
	const home = env.CARGO_HOME ?? (env.HOME ? join(env.HOME, '.cargo') : null);
	if (home) candidates.push(join(home, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'));
	for (const c of candidates) {
		if (!c) continue;
		const probe = spawnSync(c, ['--version'], { encoding: 'utf8' });
		if (probe.status === 0) return { cargo: c, version: probe.stdout.trim() };
	}
	return null;
}

function main() {
	if (!existsSync(manifest)) {
		console.log(`[mg:build] skipped: ${manifest} not found`);
		return 0;
	}
	const found = findCargo();
	if (!found) {
		console.log(
			'[mg:build] skipped: cargo was not found on PATH. Motion graphics still preview through the ' +
				'TypeScript twins; the engine reports render.fframes = "unavailable" until jasper-mg is built ' +
				'(install Rust from https://rustup.rs and run `pnpm mg:build`).',
		);
		return 0;
	}
	const profile = dev ? 'debug' : 'release';
	const cargoArgs = ['build', '--manifest-path', manifest, '--bin', 'jasper-mg', '--locked'];
	if (!dev) cargoArgs.push('--release');
	if (!quiet) console.log(`[mg:build] ${found.version}: cargo ${cargoArgs.join(' ')}`);
	const started = Date.now();
	return new Promise((resolve) => {
		const child = spawn(found.cargo, cargoArgs, { cwd: root, stdio: quiet ? 'ignore' : 'inherit' });
		child.on('error', (e) => {
			console.error(`[mg:build] failed to start cargo: ${e.message}`);
			resolve(1);
		});
		child.on('close', (code) => {
			if (code !== 0) {
				console.error(`[mg:build] cargo exited with ${code}`);
				resolve(code ?? 1);
				return;
			}
			const bin = join(root, 'native', 'mg', 'target', profile, exe);
			const secs = ((Date.now() - started) / 1000).toFixed(1);
			console.log(`[mg:build] built ${bin} in ${secs} s`);
			resolve(0);
		});
	});
}

const code = await main();
process.exit(code);
