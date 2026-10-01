#!/usr/bin/env node
// THIRD_PARTY_NOTICES.md (S11:FIX-010, spec 04 LC-005): the JavaScript packages shipped in the web build
// (`apps/web`) and in the Remotion bundle (`packages/compositions`) — the production dependency closure of both,
// through the workspace packages they use — with name, version, licence and licence text.
//
//   pnpm notices           regenerate THIRD_PARTY_NOTICES.md
//   pnpm notices --check   fail when the checked-in file is not current (CI / packaging)
//
// Closure: `dependencies` and non-optional `peerDependencies`, resolved the way Node does from each dependent's
// real directory. Optional dependencies (platform binaries) never ship in these bundles and are skipped, so the
// output does not depend on the platform. Workspace packages are traversed but not listed (our own code).
// Owner: wp-m2-anime-core.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOTS = ['apps/web', 'packages/compositions'];
export const OUTPUT = 'THIRD_PARTY_NOTICES.md';
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-_.][\w.-]*)?$/i;

/** Node's lookup: `<dir>/node_modules/<name>` walking up from `fromDir`; the real directory, or null. */
export function resolvePackageDir(name, fromDir) {
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
export function licenseTexts(dir) {
	return readdirSync(dir)
		.filter((f) => LICENSE_FILE.test(f))
		.sort()
		.map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n').trimEnd() }));
}

/**
 * The external packages in the production closure of `roots` (repo-relative package directories), sorted by
 * name then version: `[{name, version, license, homepage, dir, texts}]`.
 */
export function collectNotices(repo, roots = ROOTS) {
	const repoReal = realpathSync(repo);
	const isWorkspace = (dir) => !relative(repoReal, dir).split(sep).includes('node_modules');
	const found = new Map();
	const seen = new Set();
	const queue = roots.map((r) => realpathSync(join(repo, r)));
	while (queue.length) {
		const dir = queue.shift();
		if (seen.has(dir)) continue;
		seen.add(dir);
		const pkg = readJson(join(dir, 'package.json'));
		if (!isWorkspace(dir)) {
			const key = `${pkg.name}@${pkg.version}`;
			let license = licenseOf(pkg);
			let texts = licenseTexts(dir);
			// Remotion monorepo packages that declare nothing are covered by the Remotion License.
			const remotion =
				license === 'UNKNOWN' && pkg.name.startsWith('@remotion/') && resolvePackageDir('remotion', dir);
			if (remotion) {
				license = 'SEE LICENSE IN remotion/LICENSE.md (Remotion License)';
				if (texts.length === 0) texts = licenseTexts(remotion);
			}
			if (!found.has(key))
				found.set(key, {
					name: pkg.name,
					version: pkg.version,
					license,
					homepage:
						typeof pkg.repository === 'string'
							? pkg.repository
							: (pkg.repository?.url ?? pkg.homepage ?? null),
					dir,
					texts,
				});
		}
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
	return [...found.values()].sort((a, b) =>
		a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
	);
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
		'Remotion composition bundle (the production dependency closure of `apps/web` and `packages/compositions`).',
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
	if (process.argv.includes('--check')) {
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
