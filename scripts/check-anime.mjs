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
//    (`packages/motion/src/runtime`). Imported value names (aliases included; `import type` is fine): `animate`,
//    `createTimer`, `createAnimatable`, `createDraggable`, `onScroll`, `splitText`, `scrambleText`, `random`,
//    `randomPick`, `shuffle`, `irregular`, `waapi`, `set`, `sync`, `keepTime`, the classes behind the banned
//    modules (`Timer`, `JSAnimation`…) and the `text`/`utils` namespace objects everywhere; `createTimeline`,
//    `Timeline`, `createScope`, `Scope`, `engine`, `globals`, `createSeededRandom` outside the runtime (use
//    `createPausedTimeline`, `useAnimeDom`, `seededRandom`); namespace imports of anime.js outside the runtime
//    (they hide the names above).
// 3. Wall clock / unseeded randomness over the same roots (ANM-003/007): `Math.random`, `Date.now`, `new Date`,
//    `performance.now` (also through `?.` and `['now']`).
// 4. anime.js call patterns in files that use anime.js (import `animejs` or `@jasper/motion`, or live in
//    `packages/motion/src`): `animate()` (also `el.animate()`, WAAPI), `createTimer`, `createAnimatable`,
//    `createDraggable`, `onScroll`, `.play()/.resume()/.restart()`, `.reverse()` on a timeline, `autoplay` other
//    than a literal `false` (the shorthand `{ autoplay }` included), `new Timeline/Timer/JSAnimation/…`,
//    `utils.random/randomPick/shuffle/sync/keepTime`, the `irregular` ease, `scrambleText`, `splitText`/
//    `text.split`, `frameRate`, `composition: 'blend'`, `loop` (the shorthand `{ duration, loop }` included),
//    `.set()`/`.call()` on a timeline or `utils`, writes to `engine.*` and `engine.update()`, `stagger(…)` with
//    `from: 'random'` or `jitter` but no seed (or a literal `false`/`undefined`/`0`/`true`/`null` one), timers and
//    animation frames (`setTimeout`, `setInterval`, `requestAnimationFrame`); outside the runtime also a plain
//    `.seek()` (use `seekCanonical`, ANM-002).
//    A timeline (`timelineIdentifiers`) is an identifier bound to a call of a `…Timeline`/`…timeline` function
//    (`createPausedTimeline`, `templateTimeline`…) or of a function of the file declared to return `Timeline`, one
//    annotated `Timeline`/`ReturnType<typeof …Timeline>`, one named `tl`/`timeline`/`…Timeline`/`…Tl`, `utils`, or
//    a call chain through one of these or `.add(`.
// A line may opt out with `anime-allow: <reason>` in a comment on that line or the line above (the reason is
// required). Comments are ignored when matching.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEP_ROOTS = ['apps', 'packages'];
const RUNTIME_DIR = 'packages/motion/src/runtime/';
const RUNTIME_INDEX = 'packages/motion/src/runtime/index.ts';
const EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;

/** Files under motion/compositions source excused from the wall-clock rule, with the reason. */
const EXEMPT = {
	'packages/compositions/src/mg-host/protocol.ts':
		'drives the Remotion bundle page of composition clips (wall-clock timeouts while waiting for the iframe); no anime.js',
};

/** Modules banned everywhere under motion/compositions source, and outside the runtime only. */
const BANNED_MODULES =
	/^animejs\/(?:waapi|events|draggable|layout|timer|animation|animatable|text|easings\/irregular|adapters)(?:\/|$)/;
const RUNTIME_ONLY_MODULES = /^animejs\/(?:scope|engine)(?:\/|$)/;
/** Imported names banned everywhere, and outside the runtime only (with the replacement). */
const BANNED_NAMES = new Set([
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
	// `set()` = `new JSAnimation(…).resume()`, `sync()` = `new Timer(…).resume()`; `keepTime` tracks live tickables
	'set',
	'sync',
	'keepTime',
	// the classes behind the banned modules and functions (the root module exports them), and the `text` /
	// `utils` namespace objects (they hide the names above)
	'Timer',
	'JSAnimation',
	'Animatable',
	'Draggable',
	'WAAPIAnimation',
	'ScrollObserver',
	'TextSplitter',
	'AutoLayout',
	'createLayout',
	'split',
	'scrollContainers',
	'text',
	'utils',
]);
const RUNTIME_ONLY_NAMES = {
	createTimeline: 'createPausedTimeline',
	Timeline: 'createPausedTimeline',
	createScope: 'useAnimeDom',
	Scope: 'useAnimeDom',
	engine: 'nothing (page-global settings)',
	globals: 'nothing (page-global defaults)',
	createSeededRandom: 'seededRandom',
};

/** Blanks out comments (keeps line numbers); string contents stay. Approximate but enough for this lint. */
function stripComments(text) {
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
function blankTemplates(code) {
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
 * Imports of a file: `{spec, line, typeOnly, namespace, names: string[]}` for static imports and
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
				names.push(p.split(/\s+as\s+/)[0].trim());
			}
		const isImport = m[2] === 'import';
		const def = isImport ? /^([\w$]+)\s*(?:,|$)/.exec(clause.trim()) : null;
		if (def) names.push('default');
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

const isAnime = (spec) => spec === 'animejs' || spec.startsWith('animejs/');
const isMotion = (spec) => spec === '@jasper/motion' || spec.startsWith('@jasper/motion/');

/** `object.name`, `object?.name`, `object['name']` and `object?.['name']`, whitespace allowed. */
const member = (object, name) =>
	new RegExp(String.raw`\b${object}\s*(?:\??\.\s*${name}\b|(?:\?\.)?\s*\[\s*(['"\x60])${name}\1\s*\])`, 'g');

const WALL_CLOCK = [
	{ id: 'math-random', re: member('Math', 'random') },
	{ id: 'date-now', re: member('Date', 'now') },
	{ id: 'new-date', re: /\bnew\s+Date\b/g },
	{ id: 'performance-now', re: member('performance', 'now') },
];

const TIMELINE_NAME = /^(?:tl|timeline|[\w$]*Timeline|[\w$]*Tl|utils|add)$/;
const IDENT_CHAR = /[\w$]/;

/**
 * Names along the member/call chain that ends at the `.` at `dot` (`this.tl.add(a).set` → `add`, `tl`, `this`),
 * walking back over balanced `(…)` / `[…]`, whitespace and line breaks.
 */
function chainNames(code, dot) {
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
		const end = i;
		while (i >= 0 && IDENT_CHAR.test(code[i])) i--;
		if (end === i) return names;
		names.push(code.slice(i + 1, end + 1));
		while (i >= 0 && /\s/.test(code[i])) i--;
		if (code[i] !== '.') return names;
		i--;
	}
}

/** The anime.js call-pattern rules; `timelines` are identifiers bound to timelines in this file. */
function animeApiRules(rel, timelines) {
	const inRuntime = rel.startsWith(RUNTIME_DIR);
	const onTimeline = (code, index) =>
		chainNames(code, index).some((n) => timelines.has(n) || TIMELINE_NAME.test(n));
	return [
		{ id: 'animate', re: /(?<![\w$])animate\s*\(/g },
		{ id: 'create-timer', re: /\bcreateTimer\b/g },
		{ id: 'create-animatable', re: /\bcreateAnimatable\b/g },
		{ id: 'create-draggable', re: /\bcreateDraggable\b/g },
		{ id: 'on-scroll', re: /\bonScroll\b/g },
		{ id: 'play', re: /\.(?:play|resume|restart)\s*\(/g },
		{ id: 'play', re: /\.reverse\s*\(/g, when: onTimeline },
		// anything but a literal `false` (a variable may hold `true`), the shorthand `{ autoplay }` included
		{ id: 'autoplay', re: /\bautoplay\s*:(?!\s*false\b)|(?<=[{,]\s*)autoplay(?=\s*[,}])/g },
		// these classes autoplay or run on the wall clock (`new Timeline()` defaults to `autoplay: true`)
		{
			id: 'new-tickable',
			re: /\bnew\s+(?:Timeline|Timer|JSAnimation|Animatable|Draggable|WAAPIAnimation|ScrollObserver|TextSplitter|AutoLayout|Scope)\b/g,
		},
		{ id: 'unseeded-random', re: /\butils\.(?:random|randomPick|shuffle)\b|\brandomPick\b|\bshuffle\s*\(/g },
		{ id: 'utils-sync', re: /\butils\s*\??\.\s*(?:sync|keepTime)\b/g },
		{ id: 'irregular', re: /\birregular\b/g },
		{ id: 'scramble-text', re: /\bscrambleText\b/g },
		{ id: 'split-text', re: /\bsplitText\b|\btext\.split\b/g },
		{ id: 'frame-rate', re: /\bframeRate\b/g },
		{ id: 'blend', re: /\bcomposition\s*:\s*['"]blend['"]/g },
		// `loop: …` and the shorthand `{ duration, loop }`
		{ id: 'loop', re: /\bloop\s*:|(?<=[{,]\s*)loop(?=\s*[,}])/g },
		{ id: 'timeline-set-call', re: /\.(?:set|call)\s*\(/g, when: onTimeline },
		{ id: 'engine-write', re: /\bengine\.(?:[\w$]+\s*=(?!=)|update\s*\()/g },
		{ id: 'timer', re: /\b(?:setTimeout|setInterval|requestAnimationFrame)\s*\(/g },
		...(inRuntime ? [] : [{ id: 'plain-seek', re: /\.seek\s*\(/g }]),
	];
}

/**
 * Whether `stagger(…)` arguments carry a seed: `seed: <expression>` or the shorthand `{ seed }`. A literal
 * `false`/`undefined`/`void 0` is unseeded for anime.js (`Math.random`); `0`/`true`/`null` are one constant seed
 * for every clip, not `hash32(clipId, …)` (ANM-007).
 */
function hasSeed(args) {
	if (/(?<=[{,]\s*)seed(?=\s*[,}])/.test(args)) return true;
	const m = /\bseed\s*:\s*([^,}]*)/.exec(args);
	return !!m && !/^(?:false|true|null|undefined|void\s+0|[+-]?0+(?:\.0*)?|0[xob]0+|0n)$/.test(m[1].trim());
}

/** `stagger(…)` calls whose arguments ask for randomness without a seed (`from: 'random'`, `jitter`). */
function unseededStaggers(text) {
	const out = [];
	const re = /\bstagger\s*\(/g;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		let depth = 0;
		let end = m.index + m[0].length - 1;
		for (; end < text.length; end++) {
			if (text[end] === '(') depth++;
			else if (text[end] === ')' && --depth === 0) break;
		}
		const args = text.slice(m.index, end + 1);
		if (/['"]random['"]|\bjitter\b/.test(args) && !hasSeed(args)) {
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

/**
 * Identifiers bound to a timeline in comment-free `code` (no types: heuristics). Timeline factories are functions
 * named `…Timeline`/`…timeline` (`createPausedTimeline`, `createTimeline`, `templateTimeline`, `new Timeline`) and
 * the functions of this file declared to return `Timeline` (those names count too: `make().set(…)`). Bound are
 * variables and members assigned a factory call (`const t = templateTimeline()`, `this.intro = …`, `t = …`),
 * names annotated `Timeline` or `ReturnType<typeof …Timeline>` (parameters, fields), and `t` in
 * `{ timeline: t }` / `{ tl: t }` (destructuring renames).
 */
function timelineIdentifiers(code) {
	const ids = new Set();
	const factories = [String.raw`[\w$]*[Tt]imeline`];
	const returning =
		/\bfunction\s*\*?\s*([\w$]+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*:\s*Timeline\b|\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*:\s*Timeline\s*=>/g;
	for (let m = returning.exec(code); m; m = returning.exec(code)) {
		const name = m[1] ?? m[2];
		factories.push(name.replaceAll('$', '\\$'));
		ids.add(name);
	}
	const patterns = [
		new RegExp(
			String.raw`(?<![\w$])([\w$]+)\s*(?::[^=;{}()\n]+)?=(?![=>])\s*(?:await\s+)?(?:new\s+)?(?:[\w$]+\s*\.\s*)*(?:${factories.join('|')})\s*[(<]`,
			'g',
		),
		/(?<![\w$])([\w$]+)\s*\??\s*:\s*(?:ReturnType\s*<\s*typeof\s+[\w$]*[Tt]imeline\s*>|(?:[\w$]+\.)?Timeline\b)/g,
		/[{,]\s*(?:tl|timeline)\s*:\s*([\w$]+)\s*(?=[,}=])/g,
	];
	for (const re of patterns) for (let m = re.exec(code); m; m = re.exec(code)) ids.add(m[1]);
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
		for (const imported of imp.typeOnly ? [] : imp.names) {
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
		for (const v of unseededStaggers(code))
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
