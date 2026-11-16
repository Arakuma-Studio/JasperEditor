#!/usr/bin/env node
// Desktop packaging (ARCHITECTURE §12, D-13): stages everything electron-builder copies into the app's
// resources and guards the result against shipping a GPL/nonfree FFmpeg.
//
//   node scripts/package.mjs [--dir] [--platform linux|win32|darwin] [--arch x64|arm64] [--skip-build]
//                            [--stage-only]
//
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(desktop, '..', '..');
const engine = join(root, 'apps', 'engine');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const platform = opt('platform') ?? process.platform;
const arch = opt('arch') ?? process.arch;
const key = `${platform}-${arch}`;
const log = (m) => console.log(`[package] ${m}`);
const fail = (m) => {
	console.error(`[package] ERROR: ${m}`);
	process.exit(1);
};
function run(cmd, args, cwd = root) {
	log(`$ ${cmd} ${args.join(' ')}`);
	const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
	if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed (${r.status ?? r.signal})`);
}

if (!['linux', 'win32', 'darwin'].includes(platform)) fail(`unknown --platform ${platform}`);

const os = { linux: 'linux', win32: 'win', darwin: 'mac' }[platform]; // electron-builder's ${os}

run('node', ['scripts/ffmpeg/fetch-or-build-lgpl.mjs', '--platform', key]);
const lgplDir = join(root, 'vendor', 'ffmpeg-lgpl', key);
// electron-builder's file macros know the target as ${os}-${arch} (its ${platform} is the HOST platform),
// so the directory is staged under that name for the extraResources entry.
const lgplStage = join(root, 'vendor', 'ffmpeg-lgpl', '.package', `${os}-${arch}`);
rmSync(lgplStage, { recursive: true, force: true });
mkdirSync(dirname(lgplStage), { recursive: true });
cpSync(lgplDir, lgplStage, { recursive: true, verbatimSymlinks: true });

if (!flag('skip-build')) {
	run('pnpm', ['build']);
	run('pnpm', ['--filter', '@jasper/engine', 'build:remotion']);
}
for (const f of ['dist/engine.mjs', 'dist/remotion-bundle/index.html', 'dist/fonts'])
	if (!existsSync(join(engine, f))) fail(`apps/engine/${f} is missing (run without --skip-build)`);
if (!existsSync(join(root, 'apps/web/dist/index.html'))) fail('apps/web/dist is missing');
// S11:FIX-010: the JavaScript third-party notices must be current; the web build ships them (Help ▸ About).
run('node', ['scripts/third-party-notices.mjs', '--check']);
if (!existsSync(join(root, 'apps/web/dist/THIRD_PARTY_NOTICES.md')))
	fail('apps/web/dist/THIRD_PARTY_NOTICES.md is missing (rebuild the web app)');

const deploy = join(engine, 'dist-deploy');
rmSync(deploy, { recursive: true, force: true });
mkdirSync(deploy, { recursive: true });
cpSync(join(engine, 'dist', 'engine.mjs'), join(deploy, 'engine.mjs'));
cpSync(join(engine, 'dist', 'remotion-bundle'), join(deploy, 'remotion-bundle'), { recursive: true });
cpSync(join(engine, 'dist', 'fonts'), join(deploy, 'fonts'), { recursive: true });
cpSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(deploy, 'THIRD_PARTY_NOTICES.md'));
for (const f of [
	'jasper-proc.mjs',
	'jasper-proc.package.json',
	'jasper-speech.mjs',
	'jasper-clap.mjs',
	'jasper-roto.mjs',
	'jasper-camtrack.mjs',
	'sound-worker.mjs',
	'sd-measure-worker.mjs',
	'voice-worker.mjs',
	'dejudder-worker.mjs',
	'vidstab.wasm',
	'VIDSTAB-WASM.json',
	'LICENSE-vidstab.txt',
	'NOTICE-vidstab.txt',
	'rubberband.wasm',
	'RUBBERBAND-WASM.json',
	'LICENSE-rubberband.txt',
	'NOTICE-rubberband.txt',
	'models',
	'third-party',
	// The sound library's bundled starter kit (spec 12 §2.1).
	'sounds',
])
	if (existsSync(join(engine, 'dist', f)))
		cpSync(join(engine, 'dist', f), join(deploy, f), { recursive: true });

/** Node's lookup: `<dir>/node_modules/<name>` walking up from the (real) directory of the dependent. */
function resolvePackage(name, fromDir) {
	let dir = fromDir;
	for (;;) {
		const cand = join(dir, 'node_modules', name);
		if (existsSync(join(cand, 'package.json'))) return realpathSync(cand);
		const up = dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

/**
 * Copies `roots` and their dependency closure into `<dest>/node_modules` (flat; a second version of a
 * package is nested under its dependent). Optional dependencies are never followed.
 */
function copyRuntimeClosure(roots, fromDir, dest) {
	const placed = new Map(); // name → version at the top level
	const queue = roots.map((name) => ({ name, from: fromDir, parent: dest, required: true }));
	const seen = new Set();
	let count = 0;
	while (queue.length) {
		const { name, from, parent, required } = queue.shift();
		const src = resolvePackage(name, from);
		if (!src) {
			if (required) fail(`cannot resolve ${name} from ${from}`);
			continue;
		}
		const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
		if (/^@remotion\/compositor-/.test(pkg.name))
			fail(`${pkg.name} must not be staged: it bundles a GPL FFmpeg`);
		let target = join(dest, 'node_modules', name);
		if (placed.has(name) && placed.get(name) !== pkg.version) target = join(parent, 'node_modules', name);
		else placed.set(name, pkg.version);
		const id = `${target}@${pkg.version}`;
		if (seen.has(id)) continue;
		seen.add(id);
		if (!existsSync(target)) {
			// pnpm keeps a package's dependencies beside it, not inside it: a nested node_modules would only
			// hold stray bin links.
			cpSync(src, target, {
				recursive: true,
				dereference: true,
				filter: (p) =>
					!p.startsWith(join(src, 'node_modules')) &&
					!(pkg.name === 'onnxruntime-node' && ORT_EXCLUDED_DLLS.has(basename(p).toLowerCase())),
			});
			count++;
		}
		const optionalPeers = Object.entries(pkg.peerDependenciesMeta ?? {})
			.filter(([, m]) => m?.optional)
			.map(([n]) => n);
		for (const dep of Object.keys(pkg.dependencies ?? {}))
			queue.push({ name: dep, from: src, parent: target, required: true });
		for (const dep of Object.keys(pkg.peerDependencies ?? {}))
			queue.push({ name: dep, from: src, parent: target, required: !optionalPeers.includes(dep) });
	}
	return count;
}

// Spec 16 SG-007: onnxruntime-node's Windows binaries include DirectML.dll (proprietary Microsoft licence, outside
// the licence allowlist) and the DirectX shader compiler pair dxcompiler.dll / dxil.dll (dxil.dll's licence could not
// be established). JasperEditor does not use DirectML (Windows runs WebGPU → CPU) and does not ship them; WebGPU's
// D3D12 backend then compiles shaders with the system's FXC (docs/wp-notes/speech.md §11; untested on Windows here).
const ORT_EXCLUDED_DLLS = new Set(['directml.dll', 'dxil.dll', 'dxcompiler.dll']);

// onnxruntime-node (MIT): the super-resolution runtime of jasper-proc and the speech-to-text runtime of
// jasper-speech (native binding, loaded lazily). pdfjs-dist (Apache-2.0): PDF / Illustrator page sizes (imports), kept
// external because it loads its worker module from its own package directory.
const packages = copyRuntimeClosure(
	['@remotion/renderer', '@techstark/opencv-js', 'onnxruntime-node', 'pdfjs-dist'],
	engine,
	deploy,
);
const enginePkg = JSON.parse(readFileSync(join(engine, 'package.json'), 'utf8'));
writeFileSync(
	join(deploy, 'package.json'),
	`${JSON.stringify({ name: 'jasper-engine-runtime', version: enginePkg.version, private: true, type: 'module' }, null, 2)}\n`,
);
log(`staged ${deploy} (${packages} runtime packages, no optional dependencies)`);

const mgExe = platform === 'win32' ? 'jasper-mg.exe' : 'jasper-mg';
const mgBuilt = join(root, 'native', 'mg', 'target', 'release', mgExe);
const binDir = join(root, 'native', 'bin', `${os}-${arch}`);
rmSync(binDir, { recursive: true, force: true });
mkdirSync(binDir, { recursive: true });
if (key === `${process.platform}-${process.arch}` && existsSync(mgBuilt)) {
	cpSync(mgBuilt, join(binDir, mgExe));
	log(`staged ${mgExe}`);
} else {
	log(
		`no ${mgExe} for ${key} (run \`pnpm mg:build\` on that platform): motion graphics fall back to Remotion`,
	);
}

const guard = join(root, 'scripts', 'ffmpeg', 'check-lgpl.mjs');
run('node', [guard, lgplStage]);
run('node', [guard, '--allow-empty', deploy, binDir, join(root, 'apps', 'web', 'dist')]);
if (flag('stage-only')) {
	log('staged (--stage-only): electron-builder not run');
	process.exit(0);
}
const builderPlatform = { linux: '--linux', win32: '--win', darwin: '--mac' }[platform];
run(
	'pnpm',
	[
		'dlx',
		'electron-builder@^26.15',
		builderPlatform,
		`--${arch}`,
		...(flag('dir') ? ['--dir'] : []),
		'--publish',
		'never',
	],
	desktop,
);
log('done: apps/desktop/release');
