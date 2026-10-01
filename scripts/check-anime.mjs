#!/usr/bin/env node
// anime.js determinism lint (S11:ANM-006/012, ARCHITECTURE §20.8, D-31). Run by `pnpm lint`. Owner: wp-m2-anime-core.
//
// 1. Dependency rules (S11:ANM-001/022/023, ARCHITECTURE §3.1), over `apps/*/src` and `packages/*/src`: only
//    `packages/motion/src` imports `animejs`; only `packages/compositions/src` (and motion itself) imports
//    `@jasper/motion`. Inside motion, value imports use subpaths (`animejs/timeline`, `animejs/utils`…; the web
//    bundle splits them, ANM-023) except the runtime's own index; `import type` from the root is fine.
// 2. Module and name bans over `packages/motion/src` and `packages/compositions/src` (ANM-006): `animejs/waapi`,
//    `/events`, `/draggable`, `/layout`, `/timer`, `/animation`, `/animatable`, `/text`, `/easings/irregular`,
//    `/adapters` everywhere; `animejs/scope` and `animejs/engine` outside the runtime
//    (`packages/motion/src/runtime`). Imported names (aliases included): `animate`, `createTimer`,
//    `createAnimatable`, `createDraggable`, `onScroll`, `splitText`, `scrambleText`, `random`, `randomPick`,
//    `shuffle`, `irregular`, `waapi` everywhere; `createTimeline`, `createScope`, `engine`, `createSeededRandom`
//    outside the runtime (use `createPausedTimeline`, `useAnimeDom`, `seededRandom`); namespace imports of anime.js
//    outside the runtime (they hide the names above).
// 3. Wall clock / unseeded randomness over the same roots (ANM-003/007): `Math.random`, `Date.now`, `new Date`,
//    `performance.now`.
// 4. anime.js call patterns in files that use anime.js (import `animejs` or `@jasper/motion`, or live in
//    `packages/motion/src`): `animate()` (also `el.animate()`, WAAPI), `createTimer`, `createAnimatable`,
//    `createDraggable`, `onScroll`, `.play()/.resume()/.restart()`, `.reverse()` on a timeline, `autoplay: true`,
//    `utils.random/randomPick/shuffle`, the `irregular` ease, `scrambleText`, `splitText`/`text.split`,
//    `frameRate`, `composition: 'blend'`, `loop`, `.set()`/`.call()` on a timeline or `utils`, writes to
//    `engine.*` and `engine.update()`, `stagger(…)` with `from: 'random'` or `jitter` but no `seed`, timers and
//    animation frames (`setTimeout`, `setInterval`, `requestAnimationFrame`); outside the runtime also a plain
//    `.seek()` (use `seekCanonical`, ANM-002).
//    A timeline is an identifier bound to `createPausedTimeline(…)`/`createTimeline(…)`, one named `tl`/`timeline`/
//    `…Timeline`/`…Tl`, `utils`, or a call chain that started with `.add(` on the same line.
// A line may opt out with `anime-allow: <reason>` in a comment on that line or the line above (the reason is
// required). Comments are ignored when matching.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEP_ROOTS = ['apps', 'packages'];
export const SCAN_ROOTS = ['packages/motion/src', 'packages/compositions/src'];
const RUNTIME_DIR = 'packages/motion/src/runtime/';
const RUNTIME_INDEX = 'packages/motion/src/runtime/index.ts';
const EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;

/** Files under SCAN_ROOTS excused from the wall-clock rule, with the reason. */
export const EXEMPT = {
	'packages/compositions/src/mg-host/protocol.ts':
		'drives the Remotion bundle page of composition clips (wall-clock timeouts while waiting for the iframe); no anime.js',
};

/** Modules banned everywhere under SCAN_ROOTS, and outside the runtime only. */
export const BANNED_MODULES =
	/^animejs\/(?:waapi|events|draggable|layout|timer|animation|animatable|text|easings\/irregular|adapters)(?:\/|$)/;
export const RUNTIME_ONLY_MODULES = /^animejs\/(?:scope|engine)(?:\/|$)/;
/** Imported names banned everywhere, and outside the runtime only (with the replacement). */
export const BANNED_NAMES = new Set([
	'animate',
	'createTimer',
	'createAnimatable',
	'createDraggable',
	'onScroll',
	'splitText',
	'scrambleText',
	'random',
	'randomPick',
	'shuffle',
	'irregular',
	'waapi',
]);
export const RUNTIME_ONLY_NAMES = {
	createTimeline: 'createPausedTimeline',
	createScope: 'useAnimeDom',
	engine: 'nothing (page-global settings)',
	createSeededRandom: 'seededRandom',
};

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

/**
 * Blanks the contents of template literals (keeps line breaks): source code held as data (the scaffolded
 * project's files, ANM-016) is not an import of this file.
 */
export function blankTemplates(code) {
	let out = '';
	let quote = null;
	for (let i = 0; i < code.length; i++) {
		const c = code[i];
		if (quote === '`') {
			if (c === '\\') {
				out += code[++i] === '\n' ? ' \n' : '  ';
			} else if (c === '`') {
				quote = null;
				out += c;
			} else out += c === '\n' ? '\n' : ' ';
		} else if (quote) {
			out += c;
			if (c === '\\') out += code[++i] ?? '';
			else if (c === quote) quote = null;
		} else {
			if (c === "'" || c === '"' || c === '`') quote = c;
			out += c;
		}
	}
	return out;
}

const STATIC_RE =
	/(^|[^\w$.])(import|export)(\s+type)?\s+([\w$*{][^;'"]*?)\s+from\s*(['"])([^'"]+)\5|(^|[^\w$.])import\s*(['"])([^'"]+)\8/g;
const DYNAMIC_RE = /(?:\bimport|\brequire)\s*\(\s*(['"])([^'"]+)\1/g;

/**
 * Imports of a file: `{spec, line, typeOnly, namespace, names: [{imported, local}]}` for static imports and
 * re-exports (multi-line clauses included), dynamic `import()` and `require()`.
 */
export function parseImports(text) {
	const code = blankTemplates(stripComments(text));
	const lineAt = (index) => code.slice(0, index).split('\n').length;
	const out = [];
	STATIC_RE.lastIndex = 0;
	for (let m = STATIC_RE.exec(code); m; m = STATIC_RE.exec(code)) {
		if (m[9] !== undefined) {
			out.push({
				spec: m[9],
				line: lineAt(m.index + m[7].length),
				typeOnly: false,
				namespace: false,
				names: [],
			});
			continue;
		}
		const clause = m[4];
		const names = [];
		const braces = /\{([\s\S]*)\}/.exec(clause);
		if (braces)
			for (const part of braces[1].split(',')) {
				const p = part.trim();
				if (!p || /^type\s/.test(p)) continue;
				const [imported, local] = p.split(/\s+as\s+/);
				names.push({ imported: imported.trim(), local: (local ?? imported).trim() });
			}
		const isImport = m[2] === 'import';
		const def = isImport ? /^([\w$]+)\s*(?:,|$)/.exec(clause.trim()) : null;
		if (def) names.push({ imported: 'default', local: def[1] });
		out.push({
			spec: m[6],
			line: lineAt(m.index + m[1].length),
			typeOnly: !!m[3] || (names.length === 0 && !/\*/.test(clause) && !!braces),
			namespace: /\*\s*as\s+[\w$]+/.test(clause) || (!isImport && /^\*/.test(clause.trim())),
			names,
		});
	}
	DYNAMIC_RE.lastIndex = 0;
	for (let m = DYNAMIC_RE.exec(code); m; m = DYNAMIC_RE.exec(code))
		out.push({ spec: m[2], line: lineAt(m.index), typeOnly: false, namespace: true, names: [] });
	return out.sort((a, b) => a.line - b.line);
}

/** Module specifiers imported by a file (static, dynamic, require). */
export function importsOf(text) {
	return parseImports(text).map((i) => i.spec);
}

const isAnime = (spec) => spec === 'animejs' || spec.startsWith('animejs/');
const isMotion = (spec) => spec === '@jasper/motion' || spec.startsWith('@jasper/motion/');

const WALL_CLOCK = [
	{ id: 'math-random', re: /\bMath\.random\b/g },
	{ id: 'date-now', re: /\bDate\.now\b/g },
	{ id: 'new-date', re: /\bnew\s+Date\b/g },
	{ id: 'performance-now', re: /\bperformance\.now\b/g },
];

const TIMELINE_NAME = /^(?:tl|timeline|[\w$]*Timeline|[\w$]*Tl|utils|add)$/;
const IDENT_CHAR = /[\w$]/;

/**
 * Names along the member/call chain that ends at the `.` at `dot` (`this.tl.add(a).set` → `add`, `tl`, `this`),
 * walking back over balanced `(…)` / `[…]`, whitespace and line breaks.
 */
export function chainNames(code, dot) {
	const names = [];
	let i = dot - 1;
	for (;;) {
		while (i >= 0 && /\s/.test(code[i])) i--;
		if (code[i] === ')' || code[i] === ']') {
			const close = code[i];
			const open = close === ')' ? '(' : '[';
			let depth = 0;
			for (; i >= 0; i--) {
				if (code[i] === close) depth++;
				else if (code[i] === open && --depth === 0) break;
			}
			i--;
			continue;
		}
		let end = i;
		while (i >= 0 && IDENT_CHAR.test(code[i])) i--;
		if (end === i) return names;
		names.push(code.slice(i + 1, end + 1));
		while (i >= 0 && /\s/.test(code[i])) i--;
		if (code[i] !== '.') return names;
		i--;
		end = i;
	}
}

/** The anime.js call-pattern rules; `timelines` are identifiers bound to timelines in this file. */
function animeApiRules(rel, timelines) {
	const inRuntime = rel.startsWith(RUNTIME_DIR);
	const onTimeline = (code, index) =>
		chainNames(code, index).some(
			(n) => timelines.has(n) || TIMELINE_NAME.test(n) || n === 'createPausedTimeline',
		);
	return [
		{ id: 'animate', re: /(?<![\w$])animate\s*\(/g },
		{ id: 'create-timer', re: /\bcreateTimer\b/g },
		{ id: 'create-animatable', re: /\bcreateAnimatable\b/g },
		{ id: 'create-draggable', re: /\bcreateDraggable\b/g },
		{ id: 'on-scroll', re: /\bonScroll\b/g },
		{ id: 'play', re: /\.(?:play|resume|restart)\s*\(/g },
		{ id: 'play', re: /\.reverse\s*\(/g, when: onTimeline },
		{ id: 'autoplay', re: /\bautoplay\s*:\s*true\b/g },
		{ id: 'unseeded-random', re: /\butils\.(?:random|randomPick|shuffle)\b|\brandomPick\b|\bshuffle\s*\(/g },
		{ id: 'irregular', re: /\birregular\b/g },
		{ id: 'scramble-text', re: /\bscrambleText\b/g },
		{ id: 'split-text', re: /\bsplitText\b|\btext\.split\b/g },
		{ id: 'frame-rate', re: /\bframeRate\b/g },
		{ id: 'blend', re: /\bcomposition\s*:\s*['"]blend['"]/g },
		{ id: 'loop', re: /\bloop\s*:/g },
		{ id: 'timeline-set-call', re: /\.(?:set|call)\s*\(/g, when: onTimeline },
		{ id: 'engine-write', re: /\bengine\.(?:[\w$]+\s*=(?!=)|update\s*\()/g },
		{ id: 'timer', re: /\b(?:setTimeout|setInterval|requestAnimationFrame)\s*\(/g },
		...(inRuntime ? [] : [{ id: 'plain-seek', re: /\.seek\s*\(/g }]),
	];
}

/** `stagger(…)` calls whose arguments ask for randomness without a seed (`from: 'random'`, `jitter`). */
function unseededStaggers(lines) {
	const out = [];
	const text = lines.join('\n');
	const re = /\bstagger\s*\(/g;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		let depth = 0;
		let end = m.index + m[0].length - 1;
		for (; end < text.length; end++) {
			if (text[end] === '(') depth++;
			else if (text[end] === ')' && --depth === 0) break;
		}
		const args = text.slice(m.index, end + 1);
		if (/['"]random['"]|\bjitter\b/.test(args) && !/\bseed\s*:/.test(args)) {
			const before = text.slice(0, m.index).split('\n');
			out.push({ line: before.length, column: before[before.length - 1].length + 1, match: 'stagger(' });
		}
	}
	return out;
}

const allowed = (lines, i) => {
	const at = (l) => /anime-allow:\s*\S/.test(l ?? '');
	return at(lines[i]) || at(lines[i - 1]);
};

/** Matches of `rules` in the comment-free code, with 1-based line/column; `when(code, index)` narrows a rule. */
function scan(raw, rules) {
	const out = [];
	const original = raw.split('\n');
	const code = stripComments(raw);
	const starts = [0];
	for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
	const lineOf = (index) => {
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (starts[mid] <= index) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};
	for (const rule of rules) {
		rule.re.lastIndex = 0;
		for (let m = rule.re.exec(code); m; m = rule.re.exec(code)) {
			const i = lineOf(m.index);
			if (allowed(original, i) || (rule.when && !rule.when(code, m.index))) continue;
			out.push({ line: i + 1, column: m.index - starts[i] + 1, rule: rule.id, match: m[0] });
		}
	}
	return out;
}

/** Identifiers bound to a timeline: `const x = createPausedTimeline(…)` / `createTimeline(…)`. */
function timelineIdentifiers(code) {
	const ids = new Set();
	const re =
		/\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:createPausedTimeline|createTimeline)\s*[(<]/g;
	for (let m = re.exec(code); m; m = re.exec(code)) ids.add(m[1]);
	return ids;
}

/**
 * Violations of one file. `rel` is its repo-relative path with `/` separators.
 * @returns {{line: number, column: number, rule: string, match: string}[]}
 */
export function findViolations(rel, text) {
	const out = [];
	const imports = parseImports(text);
	const original = text.split('\n');
	const report = (rule, imp, match = imp.spec) => {
		if (!allowed(original, imp.line - 1)) out.push({ line: imp.line, column: 1, rule, match });
	};
	const inMotion = rel.startsWith('packages/motion/src/');
	const inCompositions = rel.startsWith('packages/compositions/src/');
	const inRuntime = rel.startsWith(RUNTIME_DIR);
	for (const imp of imports) {
		const { spec } = imp;
		if (isAnime(spec) && !inMotion) report('animejs-outside-motion', imp);
		if (isMotion(spec) && !inMotion && !inCompositions) report('motion-outside-compositions', imp);
		if (!inMotion && !inCompositions) continue;
		if (!isAnime(spec)) continue;
		if (BANNED_MODULES.test(spec)) report('banned-module', imp);
		if (RUNTIME_ONLY_MODULES.test(spec) && !inRuntime)
			report(spec.startsWith('animejs/scope') ? 'scope-outside-runtime' : 'engine-outside-runtime', imp);
		if (spec === 'animejs' && !imp.typeOnly && inMotion && rel !== RUNTIME_INDEX)
			report('animejs-root-import', imp);
		if (imp.namespace && !inRuntime) report('namespace-import', imp);
		for (const { imported } of imp.names) {
			if (BANNED_NAMES.has(imported)) report('banned-name', imp, imported);
			else if (Object.hasOwn(RUNTIME_ONLY_NAMES, imported) && !inRuntime)
				report('runtime-only-name', imp, imported);
		}
	}
	if (!inMotion && !inCompositions) return out;
	if (!Object.hasOwn(EXEMPT, rel)) out.push(...scan(text, WALL_CLOCK));
	if (inMotion || imports.some((i) => isAnime(i.spec) || isMotion(i.spec))) {
		const code = stripComments(text);
		out.push(...scan(text, animeApiRules(rel, timelineIdentifiers(code))));
		for (const v of unseededStaggers(code.split('\n')))
			if (!allowed(original, v.line - 1)) out.push({ ...v, rule: 'unseeded-stagger' });
	}
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
