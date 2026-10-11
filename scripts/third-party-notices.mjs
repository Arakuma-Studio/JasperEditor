#!/usr/bin/env node
// THIRD_PARTY_NOTICES.md: the JavaScript packages shipped in the web build
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
//
// Ported source code (AGENTS.md §3.4, ARCHITECTURE D-36): every record in `licenses/ported/*.md` (except its
// README) is copied into the file after the packages, between `<!-- ported-source:start -->` and
// `<!-- ported-source:end -->` (Help ▸ About ▸ Licenses shows that part on its own), followed by the text of every
// licence the records name (`licenses/texts/<SPDX id>.txt`). An incomplete record (no upstream URL, licence or
// copyright line) or a licence without its text fails generation and `--check`.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOTS = ['apps/web', 'packages/compositions'];
const OUTPUT = 'THIRD_PARTY_NOTICES.md';
const PORTED_DIR = 'licenses/ported';
const LICENSE_TEXTS_DIR = 'licenses/texts';
export const PORTED_START = '<!-- ported-source:start -->';
export const PORTED_END = '<!-- ported-source:end -->';

/**
 * Build-time packages (devDependencies of the roots, or the bundlers' own dependencies) whose output ships in the
 * web build or the Remotion bundle, found by `--audit` over the sourcemaps of `vite build` (apps/web) and
 * `build:remotion` (apps/engine) and by reading the emitted CSS. Each is listed alone — its dependencies are not
 * traversed (only the modules named in `ships` end up in the bundles; those that pull in more are listed too).
 * `from` is the repo directory, or an earlier entry, the package is resolved from.
 */
const SHIPPED_BUILD_OUTPUT = [
	{ name: 'tailwindcss', from: 'apps/web', ships: 'preflight, theme variables and utilities (the CSS)' },
	{
		name: 'vite',
		from: 'apps/web',
		ships:
			'modulepreload polyfill, preload helper, CommonJS interop helpers (its bundled @rollup/plugin-commonjs)',
	},
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
	{ name: '@fontsource-variable/inter', from: 'apps/engine', ships: 'variable font files served at /fonts' },
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
function licenseOf(pkg) {
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

/**
 * The ported-source records in `licenses/ported/` (sorted by file name, README excluded):
 * `[{file, title, upstream, license, licenseIds, copyright, body}]`. Throws, naming the file and the fix, when a
 * record lacks an upstream URL, a licence or a copyright line, or names a licence without a text in licenses/texts.
 */
export function collectPorted(repo) {
	const dir = join(repo, PORTED_DIR);
	if (!existsSync(dir)) return [];
	const records = [];
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith('.md') || name.toLowerCase() === 'readme.md') continue;
		const rel = `${PORTED_DIR}/${name}`;
		const text = readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n').trim();
		const field = (key) => {
			const m = new RegExp(String.raw`^[-*\s]*\**${key}\**\s*:\s*\**\s*(.+?)\s*$`, 'im').exec(text);
			return m ? m[1].replace(/\*+$/, '').trim() : null;
		};
		const upstream = /https?:\/\/[^\s)>\]`]+/.exec(field('Upstream') ?? text)?.[0] ?? null;
		// `Licence: MIT OR Apache-2.0`, also `Licence of the ported code: **MIT OR Apache-2.0** (we use it under MIT)`
		const licenseLine =
			field('Licen[cs]e') ?? /^[-*\s]*\**licen[cs]e\b[^:\n]{0,60}:\s*(.+)$/im.exec(text)?.[1] ?? '';
		const license =
			/^[A-Za-z0-9.+-]+(?:\s+(?:OR|AND|WITH)\s+[A-Za-z0-9.+-]+)*/.exec(
				licenseLine.replace(/^[\s*"'`(]+/, ''),
			)?.[0] ?? null;
		// One record can name several holders (`A; B` on the field, or several copyright lines): each once.
		const copyrights = [
			...new Set(
				(field('Copyright')
					? field('Copyright')
							.split(/\s*;\s*/)
							.map((c) => c.replace(/^(?!copyright)/i, 'Copyright '))
					: [...text.matchAll(/^.*\bcopyright\s*(?:\(c\)|©).*$/gim)].map((m) => m[0].replace(/^[-*\s]+/, ''))
				)
					.map(normalizeCopyright)
					.filter(Boolean),
			),
		];
		const copyright = copyrights.join('; ') || null;
		const missing = [
			!upstream && 'an upstream URL (`- **Upstream:** https://…`)',
			!license && 'a licence (`- **Licence:** MIT OR Apache-2.0`)',
			!copyright && 'a copyright line (`- **Copyright:** Copyright (c) …`)',
		].filter(Boolean);
		if (missing.length)
			throw new Error(`${rel}: missing ${missing.join(', ')}. Format: ${PORTED_DIR}/README.md`);
		const licenseIds = license
			.replace(/[()]/g, ' ')
			.split(/\s+(?:OR|AND|WITH)\s+|\s*\/\s*|\s*,\s*/)
			.map((x) => x.trim())
			.filter(Boolean);
		for (const id of licenseIds)
			if (!existsSync(join(repo, LICENSE_TEXTS_DIR, `${id}.txt`)))
				throw new Error(
					`${rel}: no text for licence "${id}": add ${LICENSE_TEXTS_DIR}/${id}.txt (use SPDX ids such as MIT, Apache-2.0, BSD-3-Clause)`,
				);
		const title = /^#\s+(.+)$/m.exec(text)?.[1].trim() ?? name.slice(0, -3);
		const body = text.replace(/^#\s+.+\n*/, '').trim();
		records.push({ file: rel, title, upstream, license, licenseIds, copyright, copyrights, body });
	}
	return records;
}

/** One spelling per copyright line: single spaces, no trailing full stop. */
function normalizeCopyright(line) {
	return line
		.replace(/\s+/g, ' ')
		.replace(/[.\s]+$/, '')
		.trim();
}

/**
 * The distinct copyright lines of the records, each once, with the records it covers (per-record attribution
 * without repeating the same line for every record ported from one project): `[{copyright, records}]`, sorted.
 */
export function portedCopyrightHolders(records) {
	const by = new Map();
	for (const r of records)
		for (const c of r.copyrights ?? [r.copyright]) {
			if (!by.has(c)) by.set(c, []);
			by.get(c).push(`\`${r.file.split('/').pop().replace(/\.md$/, '')}\``);
		}
	return [...by.entries()]
		.map(([copyright, titles]) => ({ copyright, records: titles }))
		.sort((a, b) => a.copyright.localeCompare(b.copyright));
}

/** Licence texts of the ids the records use: `[{id, text, copyrights}]` (each copyright line once). */
export function portedLicenseTexts(repo, records) {
	const ids = [...new Set(records.flatMap((r) => r.licenseIds))].sort();
	return ids.map((id) => ({
		id,
		text: readFileSync(join(repo, LICENSE_TEXTS_DIR, `${id}.txt`), 'utf8')
			.replace(/\r\n/g, '\n')
			.trimEnd(),
		copyrights: portedCopyrightHolders(records.filter((r) => r.licenseIds.includes(id))).map(
			(h) => h.copyright,
		),
	}));
}

const cleanUrl = (u) =>
	u
		?.replace(/^git\+/, '')
		.replace(/^git:\/\//, 'https://')
		.replace(/\.git$/, '')
		.replace(/^github:/, 'https://github.com/') ?? null;

/** The Markdown file (deterministic: no dates, no absolute paths). */
export function renderNotices(notices, ported = [], portedTexts = []) {
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
	if (ported.length)
		lines.splice(
			lines.indexOf('| Package | Version | Licence |') - 2,
			0,
			`${ported.length} ported source record${ported.length === 1 ? '' : 's'} (code and algorithms ported from other projects, \`licenses/ported/\`) follow the packages.`,
			'',
		);
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
	if (ported.length) {
		const holders = portedCopyrightHolders(ported);
		const holderNo = new Map(holders.map((h, i) => [h.copyright, i + 1]));
		lines.push(
			PORTED_START,
			'',
			'# Ported source code',
			'',
			'JasperEditor contains code and algorithms ported from these open-source projects (records in `licenses/ported/`,',
			'licence texts below).',
			'',
			'| Record | Upstream | Licence | Copyright |',
			'|---|---|---|---|',
			...ported.map(
				(r) =>
					`| ${r.title} | ${r.upstream} | ${r.license} | ${(r.copyrights ?? [r.copyright]).map((c) => `[${holderNo.get(c)}]`).join(' ')} |`,
			),
			'',
			'Copyright holders (the numbers in the table), with the records (`licenses/ported/<name>.md`) each covers:',
			'',
			...holders.map((h, i) => `${i + 1}. ${h.copyright}: ${h.records.join(', ')}`),
			'',
		);
		for (const r of ported) lines.push(`## ${r.title}`, '', `Record: \`${r.file}\``, '', r.body, '');
		for (const t of portedTexts) {
			lines.push(`## Licence text: ${t.id}`, '', 'Applies to:', '', ...t.copyrights.map((c) => `- ${c}`), '');
			lines.push('```text', t.text.replaceAll('```', '`​``'), '```', '');
		}
		lines.push(PORTED_END, '');
	}
	return `${lines.join('\n').trimEnd()}\n`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
	const file = join(repo, OUTPUT);
	const notices = collectNotices(repo);
	let ported;
	try {
		ported = collectPorted(repo);
	} catch (e) {
		console.error(`ported source records: ${e.message}`);
		process.exit(1);
	}
	const text = renderNotices(notices, ported, portedLicenseTexts(repo, ported));
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
			console.error(
				`${OUTPUT} is out of date (packages or licenses/ported/*.md changed): run \`pnpm notices\` and commit the result.`,
			);
			process.exit(1);
		}
		console.log(
			`${OUTPUT}: current (${notices.length} packages, ${ported.length} ported source record${ported.length === 1 ? '' : 's'})`,
		);
	} else {
		writeFileSync(file, text);
		console.log(
			`wrote ${OUTPUT} (${notices.length} packages, ${ported.length} ported source record${ported.length === 1 ? '' : 's'})`,
		);
	}
}
