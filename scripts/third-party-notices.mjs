#!/usr/bin/env node
// THIRD_PARTY_NOTICES.md (S11:FIX-010, spec 04 LC-005): the JavaScript packages shipped in the web build
// (`apps/web`) and in the Remotion bundle (`packages/compositions`) — the production dependency closure of both,
// through the workspace packages they use, plus the build-time packages whose output ships
// (`SHIPPED_BUILD_OUTPUT`) — with name, version, licence and licence text.
//
//   pnpm notices                 regenerate THIRD_PARTY_NOTICES.md
//   pnpm notices --check         fail when the checked-in file is not current (CI / packaging)
//   pnpm notices --audit <dir>…  after `vite build` / `build:remotion`: packages in the sourcemaps of the built
//                                bundles that the file does not list (keep `SHIPPED_BUILD_OUTPUT` complete)
//
// Closure: `dependencies` and non-optional `peerDependencies`, resolved the way Node does from each dependent's
// real directory. Optional dependencies (platform binaries) never ship in these bundles and are skipped, so the
// output does not depend on the platform. Workspace packages are traversed but not listed (our own code).
// Owner: wp-m2-anime-core.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOTS = ['apps/web', 'packages/compositions'];
export const OUTPUT = 'THIRD_PARTY_NOTICES.md';

/**
 * Build-time packages (devDependencies of the roots, or the bundlers' own dependencies) whose output ships in the
 * web build or the Remotion bundle, found by `--audit` over the sourcemaps of `vite build` (apps/web) and
 * `build:remotion` (apps/engine) and by reading the emitted CSS. Each is listed alone — its dependencies are not
 * traversed (only the modules named in `ships` end up in the bundles; those that pull in more are listed too).
 * `from` is the repo directory, or an earlier entry, the package is resolved from.
 */
export const SHIPPED_BUILD_OUTPUT = [
	// web build (Vite)
	{ name: 'tailwindcss', from: 'apps/web', ships: 'preflight, theme variables and utilities (the CSS)' },
	{
		name: 'vite',
		from: 'apps/web',
		ships:
			'modulepreload polyfill, preload helper, CommonJS interop helpers (its bundled @rollup/plugin-commonjs)',
	},
	// Remotion bundle (`@remotion/bundler`'s webpack build run by apps/engine `build:remotion`)
	{ name: '@remotion/bundler', from: 'apps/engine', ships: 'environment setup and React shim entries' },
	{ name: 'webpack', from: '@remotion/bundler', ships: 'webpack runtime (bootstrap, chunk loading)' },
	{ name: '@remotion/studio', from: '@remotion/bundler', ships: 'renderEntry, the bundle entry' },
	{ name: '@remotion/studio-shared', from: '@remotion/bundler', ships: 'imported by renderEntry' },
	{ name: '@remotion/timeline-utils', from: '@remotion/bundler', ships: 'imported by renderEntry' },
	{
		name: '@remotion/renderer',
		from: '@remotion/studio',
		ships: 'browser-safe helpers imported by the studio',
	},
	{ name: '@remotion/web-renderer', from: '@remotion/studio', ships: 'imported by the studio' },
	{ name: '@remotion/media-utils', from: '@remotion/studio', ships: 'imported by the studio' },
	{ name: '@remotion/zod-types', from: '@remotion/studio', ships: 'imported by the studio' },
	{ name: '@remotion/canvas-capture', from: '@remotion/studio', ships: 'imported by the studio' },
	{ name: '@jridgewell/trace-mapping', from: '@remotion/studio', ships: 'stack-trace symbolication' },
	{ name: '@jridgewell/resolve-uri', from: '@jridgewell/trace-mapping', ships: 'imported by trace-mapping' },
	{
		name: '@jridgewell/sourcemap-codec',
		from: '@jridgewell/trace-mapping',
		ships: 'imported by trace-mapping',
	},
	{ name: '@mediabunny/aac-encoder', from: '@remotion/web-renderer', ships: 'imported by the web renderer' },
	{ name: '@mediabunny/flac-encoder', from: '@remotion/web-renderer', ships: 'imported by the web renderer' },
	{ name: '@mediabunny/mp3-encoder', from: '@remotion/web-renderer', ships: 'imported by the web renderer' },
	// Font files the engine serves at /fonts (copied to dist/fonts by `build:remotion`, packaged with the engine; the
	// packages' own LICENSE files travel with them) — keep in sync with FONT_IDS in apps/engine/scripts/build-remotion.mjs.
	{ name: '@fontsource/inter', from: 'apps/engine', ships: 'font files served at /fonts' },
	{ name: '@fontsource/source-sans-3', from: 'apps/engine', ships: 'font files served at /fonts' },
	{ name: '@fontsource/roboto', from: 'apps/engine', ships: 'font files served at /fonts' },
	{ name: '@fontsource/montserrat', from: 'apps/engine', ships: 'font files served at /fonts' },
	{ name: '@fontsource/open-sans', from: 'apps/engine', ships: 'font files served at /fonts' },
	{ name: '@fontsource/lato', from: 'apps/engine', ships: 'font files served at /fonts' },
	{ name: '@fontsource/poppins', from: 'apps/engine', ships: 'font files served at /fonts' },
	{ name: '@fontsource/oswald', from: 'apps/engine', ships: 'font files served at /fonts' },
	{ name: '@fontsource/playfair-display', from: 'apps/engine', ships: 'font files served at /fonts' },
	{ name: '@fontsource/jetbrains-mono', from: 'apps/engine', ships: 'font files served at /fonts' },
];
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-_.][\w.-]*)?$/i;

/** Node's lookup: `<dir>/node_modules/<name>` walking up from `fromDir`; the real directory, or null. */
function resolvePackageDir(name, fromDir) {
	let dir = fromDir;
	for (;;) {
		const cand = join(dir, 'node_modules', name);
		if (existsSync(join(cand, 'package.json'))) return realpathSync(cand);
		const up = dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** SPDX-ish licence of a package.json (`license`, legacy `licenses`), or `UNKNOWN`. */
export function licenseOf(pkg) {
	if (typeof pkg.license === 'string') return pkg.license;
	if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
	if (Array.isArray(pkg.licenses))
		return pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ') || 'UNKNOWN';
	return 'UNKNOWN';
}

/** Licence/notice files at the root of a package directory, sorted by name: `[{file, text}]`. */
function licenseTexts(dir) {
	return readdirSync(dir)
		.filter((f) => LICENSE_FILE.test(f))
		.sort()
		.map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n').trimEnd() }));
}

/** The notice of the external package in `dir`. */
function noticeOf(dir, pkg) {
	let license = licenseOf(pkg);
	let texts = licenseTexts(dir);
	// Remotion monorepo packages that declare nothing are covered by the Remotion License.
	const remotion =
		license === 'UNKNOWN' && pkg.name.startsWith('@remotion/') && resolvePackageDir('remotion', dir);
	if (remotion) {
		license = 'SEE LICENSE IN remotion/LICENSE.md (Remotion License)';
		if (texts.length === 0) texts = licenseTexts(remotion);
	}
	return {
		name: pkg.name,
		version: pkg.version,
		license,
		homepage:
			typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? pkg.homepage ?? null),
		dir,
		texts,
	};
}

/**
 * The external packages in the production closure of `roots` (repo-relative package directories) and the
 * `buildOutput` entries (see `SHIPPED_BUILD_OUTPUT`), sorted by name then version:
 * `[{name, version, license, homepage, dir, texts}]`.
 */
export function collectNotices(repo, roots = ROOTS, buildOutput = SHIPPED_BUILD_OUTPUT) {
	const repoReal = realpathSync(repo);
	const isWorkspace = (dir) => !relative(repoReal, dir).split(sep).includes('node_modules');
	const found = new Map();
	const add = (dir, pkg) => {
		const key = `${pkg.name}@${pkg.version}`;
		if (!found.has(key)) found.set(key, noticeOf(dir, pkg));
	};
	const seen = new Set();
	const queue = roots.map((r) => realpathSync(join(repo, r)));
	while (queue.length) {
		const dir = queue.shift();
		if (seen.has(dir)) continue;
		seen.add(dir);
		const pkg = readJson(join(dir, 'package.json'));
		if (!isWorkspace(dir)) add(dir, pkg);
		const optionalPeers = new Set(
			Object.entries(pkg.peerDependenciesMeta ?? {})
				.filter(([, m]) => m?.optional)
				.map(([n]) => n),
		);
		const deps = [
			...Object.keys(pkg.dependencies ?? {}),
			...Object.keys(pkg.peerDependencies ?? {}).filter((n) => !optionalPeers.has(n)),
		];
		for (const name of deps) {
			const next = resolvePackageDir(name, dir);
			if (next) queue.push(next);
			else if (!(pkg.peerDependencies && name in pkg.peerDependencies))
				throw new Error(`cannot resolve ${name} from ${relative(repoReal, dir) || '.'}`);
		}
	}
	const resolved = new Map();
	for (const { name, from } of buildOutput) {
		const fromDir = resolved.get(from) ?? join(repo, from);
		const dir = existsSync(fromDir) ? resolvePackageDir(name, fromDir) : null;
		if (!dir) throw new Error(`cannot resolve ${name} (shipped build output) from ${from}`);
		resolved.set(name, dir);
		add(dir, readJson(join(dir, 'package.json')));
	}
	return [...found.values()].sort((a, b) =>
		a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
	);
}

/**
 * `name@version` of every `node_modules` package among the sources of the sourcemaps (`*.map`) under `dirs`
 * (Vite: relative paths; webpack: `webpack://` URLs). The version comes from the pnpm store path
 * (`.pnpm/<name>@<version>…/node_modules/<name>/`), else from the package.json next to the map.
 */
export function packagesInSourcemaps(dirs) {
	const out = new Set();
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith('.map')) {
				const map = readJson(p);
				for (const s of map.sources ?? []) {
					const at = s.lastIndexOf('node_modules/');
					if (at < 0) continue;
					const parts = s.slice(at + 'node_modules/'.length).split('/');
					const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
					const re = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
					const store = new RegExp(
						String.raw`\.pnpm/${re.replace('/', '\\+')}@([^_/]+)[^/]*/node_modules/${re}/`,
					).exec(s);
					let version = store?.[1];
					if (!version && !s.includes('://')) {
						const pkg = resolve(dirname(p), map.sourceRoot ?? '', s.slice(0, at), 'node_modules', name);
						if (existsSync(join(pkg, 'package.json'))) version = readJson(join(pkg, 'package.json')).version;
					}
					out.add(`${name}@${version ?? '?'}`);
				}
			}
		}
	};
	for (const d of dirs) walk(d);
	return [...out].sort();
}

const cleanUrl = (u) =>
	u
		?.replace(/^git\+/, '')
		.replace(/^git:\/\//, 'https://')
		.replace(/\.git$/, '')
		.replace(/^github:/, 'https://github.com/') ?? null;

/** The Markdown file (deterministic: no dates, no absolute paths). */
export function renderNotices(notices) {
	const lines = [
		'# Third-party notices',
		'',
		'JasperEditor ships the following third-party JavaScript packages in its web application and in its',
		'Remotion composition bundle (the production dependency closure of `apps/web` and `packages/compositions`,',
		'the build tools whose output ships in them: CSS, bundler runtimes and entry code — and the font files the',
		'engine serves).',
		'Native components (FFmpeg, Remotion binaries, models) are listed in Help ▸ About ▸ Licenses.',
		'',
		'Generated by `pnpm notices` (scripts/third-party-notices.mjs); do not edit. `pnpm notices --check` verifies it.',
		'',
		`${notices.length} packages:`,
		'',
		'| Package | Version | Licence |',
		'|---|---|---|',
		...notices.map((n) => `| ${n.name} | ${n.version} | ${n.license} |`),
		'',
	];
	for (const n of notices) {
		lines.push(`## ${n.name} ${n.version}`, '', `Licence: ${n.license}`);
		const url = cleanUrl(n.homepage);
		if (url) lines.push(`Source: ${url}`);
		lines.push('');
		if (n.texts.length === 0)
			lines.push('(The package ships no licence file; see its licence identifier above.)', '');
		for (const t of n.texts)
			lines.push(`### ${t.file}`, '', '```text', t.text.replaceAll('```', '`​``'), '```', '');
	}
	return `${lines.join('\n').trimEnd()}\n`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
	const file = join(repo, OUTPUT);
	const notices = collectNotices(repo);
	const text = renderNotices(notices);
	const audit = process.argv.indexOf('--audit');
	if (audit >= 0) {
		const dirs = process.argv.slice(audit + 1).map((d) => resolve(d));
		const listed = new Set(notices.map((n) => `${n.name}@${n.version}`));
		const missing = packagesInSourcemaps(dirs).filter((p) => !listed.has(p));
		if (missing.length > 0) {
			console.error(
				`shipped but not in ${OUTPUT} (add them to SHIPPED_BUILD_OUTPUT):\n  ${missing.join('\n  ')}`,
			);
			process.exit(1);
		}
		console.log(`${OUTPUT}: lists every package in the sourcemaps of ${dirs.length} build(s)`);
	} else if (process.argv.includes('--check')) {
		const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
		if (current !== text) {
			console.error(`${OUTPUT} is out of date: run \`pnpm notices\` and commit the result.`);
			process.exit(1);
		}
		console.log(`${OUTPUT}: current (${notices.length} packages)`);
	} else {
		writeFileSync(file, text);
		console.log(`wrote ${OUTPUT} (${notices.length} packages)`);
	}
}
