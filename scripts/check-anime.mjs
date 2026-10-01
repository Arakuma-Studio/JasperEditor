#!/usr/bin/env node
// anime.js determinism lint (S11:ANM-006/012, ARCHITECTURE §20.8, D-31). Run by `pnpm lint`.
// Owner: wp-m2-anime-core (this is the contracts skeleton; core extends the rules).
//
// 1. Dependency rules (S11:ANM-001/022, ARCHITECTURE §3.1), over `apps/*/src` and `packages/*/src`: only
//    `packages/motion/src` imports `animejs`; only `packages/compositions/src` (and motion itself) imports
//    `@jasper/motion`.
// 2. Import bans over `packages/motion/src` and `packages/compositions/src`: `animejs/waapi`, `/events`,
//    `/draggable`, `/layout` everywhere; `animejs/scope` outside the runtime (`packages/motion/src/runtime`).
// 3. Wall-clock / unseeded randomness over the same roots: `Math.random`, `Date.now`, `performance.now`.
// 4. anime.js API bans in files that use anime.js (import `animejs` or `@jasper/motion`, or live in
//    `packages/motion/src`): autoplaying `animate()`, `createTimer`, `createAnimatable`, `createDraggable`,
//    `onScroll`, `.play()/.resume()/.restart()/.reverse()`, `autoplay: true`, `utils.random/randomPick/shuffle`,
//    the `irregular` ease, `scrambleText`, `splitText`/`text.split`, `frameRate`, `composition: 'blend'`, `loop`,
//    `.set()`/`.call()` (timeline), writes to `engine.*`.
// A line may opt out with `anime-allow: <reason>` in a comment on that line or the line above (the reason is
// required). Comments are ignored when matching.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEP_ROOTS = ['apps', 'packages'];
export const SCAN_ROOTS = ['packages/motion/src', 'packages/compositions/src'];
const RUNTIME_DIR = 'packages/motion/src/runtime/';
const EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;

/** Files under SCAN_ROOTS excused from the wall-clock rule, with the reason. */
export const EXEMPT = {
	'packages/compositions/src/mg-host/protocol.ts':
		'drives the Remotion bundle page of composition clips (wall-clock timeouts while waiting for the iframe); no anime.js',
};

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/g;

/** Module specifiers imported by a file (static, dynamic, require). */
export function importsOf(text) {
	const out = [];
	for (const line of stripComments(text).split('\n')) {
		IMPORT_RE.lastIndex = 0;
		for (let m = IMPORT_RE.exec(line); m; m = IMPORT_RE.exec(line)) out.push(m[1]);
	}
	return out;
}

/** Blanks out comments (keeps line numbers); string contents stay. Approximate but enough for this lint. */
export function stripComments(text) {
	let out = '';
	let i = 0;
	let quote = null;
	while (i < text.length) {
		const c = text[i];
		const n = text[i + 1];
		if (quote) {
			out += c;
			if (c === '\\') {
				out += n ?? '';
				i += 2;
				continue;
			}
			if (c === quote) quote = null;
			i++;
		} else if (c === "'" || c === '"' || c === '`') {
			quote = c;
			out += c;
			i++;
		} else if (c === '/' && n === '/') {
			while (i < text.length && text[i] !== '\n') i++;
		} else if (c === '/' && n === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
				if (text[i] === '\n') out += '\n';
				i++;
			}
			i += 2;
		} else {
			out += c;
			i++;
		}
	}
	return out;
}

const isAnime = (spec) => spec === 'animejs' || spec.startsWith('animejs/');
const isMotion = (spec) => spec === '@jasper/motion' || spec.startsWith('@jasper/motion/');

const WALL_CLOCK = [
	{ id: 'math-random', re: /\bMath\.random\b/g },
	{ id: 'date-now', re: /\bDate\.now\b/g },
	{ id: 'performance-now', re: /\bperformance\.now\b/g },
];

const ANIME_API = [
	{ id: 'animate', re: /(?<![\w$.])animate\s*\(/g },
	{ id: 'create-timer', re: /\bcreateTimer\b/g },
	{ id: 'create-animatable', re: /\bcreateAnimatable\b/g },
	{ id: 'create-draggable', re: /\bcreateDraggable\b/g },
	{ id: 'on-scroll', re: /\bonScroll\b/g },
	{ id: 'play', re: /\.(?:play|resume|restart|reverse)\s*\(/g },
	{ id: 'autoplay', re: /\bautoplay\s*:\s*true\b/g },
	{ id: 'unseeded-random', re: /\butils\.(?:random|randomPick|shuffle)\b|\brandomPick\b|\bshuffle\s*\(/g },
	{ id: 'irregular', re: /\birregular\b/g },
	{ id: 'scramble-text', re: /\bscrambleText\b/g },
	{ id: 'split-text', re: /\bsplitText\b|\btext\.split\b/g },
	{ id: 'frame-rate', re: /\bframeRate\b/g },
	{ id: 'blend', re: /\bcomposition\s*:\s*['"]blend['"]/g },
	{ id: 'loop', re: /\bloop\s*:/g },
	{ id: 'timeline-set-call', re: /\.(?:set|call)\s*\(/g },
	{ id: 'engine-write', re: /\bengine\.\w+\s*=(?!=)/g },
];

const allowed = (lines, i) => {
	const at = (l) => /anime-allow:\s*\S/.test(l ?? '');
	return at(lines[i]) || at(lines[i - 1]);
};

function scan(raw, rules) {
	const out = [];
	const original = raw.split('\n');
	const lines = stripComments(raw).split('\n');
	lines.forEach((line, i) => {
		if (allowed(original, i)) return;
		for (const rule of rules) {
			rule.re.lastIndex = 0;
			for (let m = rule.re.exec(line); m; m = rule.re.exec(line))
				out.push({ line: i + 1, column: m.index + 1, rule: rule.id, match: m[0] });
		}
	});
	return out;
}

/**
 * Violations of one file. `rel` is its repo-relative path with `/` separators.
 * @returns {{line: number, column: number, rule: string, match: string}[]}
 */
export function findViolations(rel, text) {
	const out = [];
	const imports = importsOf(text);
	const original = text.split('\n');
	const importLine = (spec) => {
		const i = original.findIndex((l) => l.includes(`'${spec}'`) || l.includes(`"${spec}"`));
		return { line: i + 1, allowed: i >= 0 && allowed(original, i) };
	};
	const report = (rule, spec) => {
		const at = importLine(spec);
		if (!at.allowed) out.push({ line: at.line, column: 1, rule, match: spec });
	};
	const inMotion = rel.startsWith('packages/motion/src/');
	const inCompositions = rel.startsWith('packages/compositions/src/');
	for (const spec of imports) {
		if (isAnime(spec) && !inMotion) report('animejs-outside-motion', spec);
		if (isMotion(spec) && !inMotion && !inCompositions) report('motion-outside-compositions', spec);
		if (!inMotion && !inCompositions) continue;
		if (/^animejs\/(?:waapi|events|draggable|layout)(?:\/|$)/.test(spec)) report('banned-module', spec);
		if (/^animejs\/scope(?:\/|$)/.test(spec) && !rel.startsWith(RUNTIME_DIR))
			report('scope-outside-runtime', spec);
	}
	if (!inMotion && !inCompositions) return out;
	if (!Object.hasOwn(EXEMPT, rel)) out.push(...scan(text, WALL_CLOCK));
	if (inMotion || imports.some((s) => isAnime(s) || isMotion(s))) out.push(...scan(text, ANIME_API));
	return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

function walk(dir, files) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return files;
	}
	for (const name of entries) {
		if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, files);
		else if (EXTENSIONS.test(name) && !/\.test\.[cm]?[jt]sx?$/.test(name) && !name.endsWith('.d.ts'))
			files.push(full);
	}
	return files;
}

/** `src` directories of every workspace package and app. */
function sourceDirs(root) {
	const dirs = [];
	for (const top of DEP_ROOTS) {
		let names = [];
		try {
			names = readdirSync(join(root, top));
		} catch {
			continue;
		}
		for (const n of names) dirs.push(join(root, top, n, 'src'));
	}
	return dirs;
}

export function checkRepo(root) {
	const problems = [];
	for (const dir of sourceDirs(root)) {
		for (const file of walk(dir, [])) {
			const rel = relative(root, file).split(sep).join('/');
			for (const v of findViolations(rel, readFileSync(file, 'utf8'))) problems.push({ file: rel, ...v });
		}
	}
	return problems;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	const root = join(dirname(fileURLToPath(import.meta.url)), '..');
	const problems = checkRepo(root);
	if (problems.length > 0) {
		for (const p of problems) console.error(`${p.file}:${p.line}:${p.column}  ${p.rule}  ${p.match}`);
		console.error(
			`\ncheck-anime: ${problems.length} problem(s). anime.js is seek-driven only (S11:ANM-006); add \`anime-allow: <reason>\` for a justified exception.`,
		);
		process.exit(1);
	}
	console.log('check-anime: ok');
}
