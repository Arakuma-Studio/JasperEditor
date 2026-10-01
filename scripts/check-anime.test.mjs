// scripts/check-anime.mjs (S11:ANM-012): every ANM-006 pattern, the dependency rules (ANM-001/022/023), the
// `anime-allow:` escape, and the Biome `noRestrictedImports` mirror.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	BANNED_NAMES,
	blankTemplates,
	chainNames,
	checkRepo,
	findViolations,
	importsOf,
	parseImports,
	RUNTIME_ONLY_NAMES,
	stripComments,
} from './check-anime.mjs';

const rules = (rel, text) => findViolations(rel, text).map((v) => v.rule);
const MOTION = 'packages/motion/src/text/fade.ts';
const RUNTIME = 'packages/motion/src/runtime/x.ts';
const COMP = 'packages/compositions/src/layers/TextLayer.tsx';
const USES = "import { createPausedTimeline } from '@jasper/motion';\n";
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('check-anime dependency rules (S11:ANM-001/022/023)', () => {
	it('only motion imports animejs; only compositions imports @jasper/motion', () => {
		expect(rules(MOTION, "import { stagger } from 'animejs/utils';")).toEqual([]);
		expect(rules(COMP, "import { stagger } from 'animejs/utils';")).toEqual(['animejs-outside-motion']);
		expect(rules('apps/web/src/x.tsx', "const a = await import('animejs');")).toEqual([
			'animejs-outside-motion',
		]);
		expect(rules(COMP, "import { seekCanonical } from '@jasper/motion';")).toEqual([]);
		expect(rules('apps/engine/src/x.ts', "export { hash32 } from '@jasper/motion';")).toEqual([
			'motion-outside-compositions',
		]);
		expect(
			rules('packages/project/src/x.ts', "import type { UnitValues } from '@jasper/motion/text';"),
		).toEqual(['motion-outside-compositions']);
		// mentioning the package name is not importing it
		expect(rules('apps/engine/src/x.ts', "resolve('@jasper/motion'); // see animejs")).toEqual([]);
		// nor is source code held as data in a template literal (the scaffolded project, ANM-016)
		expect(rules('apps/engine/src/x.ts', "const f = `import { x } from 'animejs/timeline';`;")).toEqual([]);
	});
	it('motion uses anime.js subpaths; root value imports only in the runtime index (ANM-023)', () => {
		expect(rules(MOTION, "import { stagger } from 'animejs';")).toEqual(['animejs-root-import']);
		expect(rules(MOTION, "import type { EasingParam } from 'animejs';")).toEqual([]);
		expect(rules(MOTION, "import { type EasingParam, type Target } from 'animejs';")).toEqual([]);
		expect(rules(RUNTIME, "import { stagger } from 'animejs';")).toEqual(['animejs-root-import']);
		expect(rules('packages/motion/src/runtime/index.ts', "export { stagger } from 'animejs';")).toEqual([]);
	});
	it('bans the wall-clock / DOM-rewriting modules everywhere, scope and engine outside the runtime', () => {
		for (const m of [
			'waapi',
			'events',
			'draggable',
			'layout',
			'timer',
			'animation',
			'animatable',
			'text',
			'easings/irregular',
			'adapters/three',
		])
			expect(rules(MOTION, `import 'animejs/${m}';`).slice(0, 1), m).toEqual(['banned-module']);
		expect(rules(MOTION, "import { steps } from 'animejs/easings';")).toEqual([]);
		expect(rules(MOTION, "import { createScope } from 'animejs/scope';")).toEqual([
			'scope-outside-runtime',
			'runtime-only-name',
		]);
		expect(rules(MOTION, "import { engine } from 'animejs/engine';")).toEqual([
			'engine-outside-runtime',
			'runtime-only-name',
		]);
		expect(rules(RUNTIME, "import { createScope } from 'animejs/scope';")).toEqual([]);
	});
	it('bans names whatever their alias or module; runtime-only names outside the runtime', () => {
		expect(findViolations(MOTION, "import { animate as go } from 'animejs/animation';")).toEqual([
			{ line: 1, column: 1, rule: 'banned-module', match: 'animejs/animation' },
			{ line: 1, column: 1, rule: 'banned-name', match: 'animate' },
		]);
		expect(rules(MOTION, "import {\n\tstagger,\n\trandom as r,\n} from 'animejs/utils';")).toEqual([
			'banned-name',
		]);
		expect(rules(MOTION, "import { createTimeline } from 'animejs/timeline';")).toEqual([
			'runtime-only-name',
		]);
		expect(rules(MOTION, "import { createSeededRandom } from 'animejs/utils';")).toEqual([
			'runtime-only-name',
		]);
		expect(rules(RUNTIME, "import { createSeededRandom } from 'animejs/utils';")).toEqual([]);
		expect(rules(MOTION, "import * as utils from 'animejs/utils';")).toEqual(['namespace-import']);
		expect(rules(MOTION, "const m = await import('animejs/svg');")).toEqual(['namespace-import']);
		expect(rules(RUNTIME, "import * as svg from 'animejs/svg';")).toEqual([]);
		expect([...BANNED_NAMES]).toEqual(
			expect.arrayContaining(['animate', 'splitText', 'irregular', 'shuffle']),
		);
		expect(Object.keys(RUNTIME_ONLY_NAMES)).toEqual([
			'createTimeline',
			'createScope',
			'engine',
			'createSeededRandom',
		]);
	});
});

describe('check-anime determinism rules (S11:ANM-006)', () => {
	it('bans wall-clock time and Math.random in motion and compositions sources', () => {
		expect(rules(COMP, 'const t = performance.now();')).toEqual(['performance-now']);
		expect(rules(MOTION, 'const r = Math.random() + Date.now();')).toEqual(['math-random', 'date-now']);
		expect(rules(MOTION, 'const d = new Date();')).toEqual(['new-date']);
		expect(rules('apps/web/src/x.ts', 'const t = Date.now();')).toEqual([]);
		expect(rules('packages/compositions/src/mg-host/protocol.ts', 'const until = Date.now() + 1;')).toEqual(
			[],
		);
	});
	it('bans playback, unseeded randomness and the risky timeline APIs where anime.js is used', () => {
		const src = [
			"import { createPausedTimeline } from '@jasper/motion';",
			'tl.play();',
			'tl.reverse();',
			'const t = createPausedTimeline({ autoplay: true });',
			"tl.add(o, { x: [0, 1], composition: 'blend', loop: 2 });",
			'tl.set(o, { x: 1 }).call(() => {});',
			'utils.shuffle(list); randomPick(list);',
			'engine.timeUnit = "s";',
			'const parts = splitText(el);',
		].join('\n');
		expect(rules(COMP, src)).toEqual([
			'play',
			'play',
			'autoplay',
			'blend',
			'loop',
			'timeline-set-call',
			'timeline-set-call',
			'unseeded-random',
			'unseeded-random',
			'engine-write',
			'split-text',
		]);
		// files that do not use anime.js keep their Maps, loops and arrays
		expect(rules(COMP, 'cache.set(k, v); xs.reverse(); const o = { loop: true };')).toEqual([]);
		expect(rules(MOTION, 'createPausedTimeline({ autoplay: false }); if (engine.reqId === 0) {}')).toEqual(
			[],
		);
	});
	it('tells timelines from Maps, arrays and functions (.set / .call / .reverse)', () => {
		const src = [
			USES.trim(),
			'const intro = createPausedTimeline();',
			'cache.set(k, v); order.reverse(); fn.call(this, 1); [...xs].reverse();',
			'intro.set(o, { x: 1 });',
			'this.timeline.call(() => {});',
			'build().tl.reverse();',
			'intro',
			'\t.add(o, { x: [0, 1] }, 0)',
			'\t.set(o, { y: 2 });',
			'createPausedTimeline().call(f);',
			'utils.set(el, { x: 1 });',
		].join('\n');
		expect(findViolations(COMP, src).map((v) => [v.line, v.rule])).toEqual([
			[4, 'timeline-set-call'],
			[5, 'timeline-set-call'],
			[6, 'play'],
			[9, 'timeline-set-call'],
			[10, 'timeline-set-call'],
			[11, 'timeline-set-call'],
		]);
	});
	it('bans animate() (also WAAPI el.animate), engine.update, timers, plain seeks outside the runtime', () => {
		expect(rules(MOTION, 'animate(o, { x: 1 }); el.animate([], 100);')).toEqual(['animate', 'animate']);
		expect(rules(MOTION, 'engine.update();')).toEqual(['engine-write']);
		expect(rules(MOTION, 'setTimeout(f, 1); setInterval(f, 1); requestAnimationFrame(f);')).toEqual([
			'timer',
			'timer',
			'timer',
		]);
		expect(rules(MOTION, 'tl.seek(500, true);')).toEqual(['plain-seek']);
		expect(rules(RUNTIME, 'tl.seek(500, true);')).toEqual([]);
		expect(rules(MOTION, 'seekCanonical(tl, 500);')).toEqual([]);
		expect(rules(COMP, 'video.seek(1);')).toEqual([]);
		expect(rules(COMP, `${USES}video.seek(1);`)).toEqual(['plain-seek']);
	});
	it('bans unseeded random staggers and jitter (ANM-007)', () => {
		expect(rules(MOTION, "tl.add(t, { y: stagger(10, { from: 'random' }) });")).toEqual(['unseeded-stagger']);
		expect(rules(MOTION, 'const d = stagger(\n\t50,\n\t{ jitter: 4 },\n);')).toEqual(['unseeded-stagger']);
		expect(rules(MOTION, "stagger(10, { from: 'random', seed: hash32(id, 'order') });")).toEqual([]);
		expect(rules(MOTION, "stagger(10, { from: 'center' });")).toEqual([]);
		expect(findViolations(MOTION, "a;\nb = stagger(1, { from: 'random' });")[0]).toMatchObject({
			line: 2,
			column: 5,
		});
	});
	it('ignores comments and honours anime-allow with a reason', () => {
		expect(rules(MOTION, '// never Math.random or tl.play()\n/* Date.now */ const x = 1;')).toEqual([]);
		expect(rules(MOTION, '// anime-allow: test fixture clock\nconst t = Date.now();')).toEqual([]);
		expect(rules(MOTION, 'const t = Date.now(); // anime-allow: why not')).toEqual([]);
		expect(rules(MOTION, 'const t = Date.now(); // anime-allow:')).toEqual(['date-now']);
		expect(rules(MOTION, "const s = 'Math.random';")).toEqual(['math-random']);
		expect(
			rules(MOTION, "// anime-allow: fixture of the lint test\nimport { animate } from 'animejs/animation';"),
		).toEqual([]);
		expect(rules(MOTION, "// anime-allow: seeded below\nconst s = stagger(1, { from: 'random' });")).toEqual(
			[],
		);
	});
	it('helpers: imports, template blanking, chains and comment stripping keep line numbers', () => {
		expect(importsOf("import a from 'x';\nexport * from \"y\";\nconst z = require('z');")).toEqual([
			'x',
			'y',
			'z',
		]);
		expect(parseImports("import D, { a as b, type T } from 'm';\nexport * from 'n';")).toEqual([
			{
				spec: 'm',
				line: 1,
				typeOnly: false,
				namespace: false,
				names: [
					{ imported: 'a', local: 'b' },
					{ imported: 'default', local: 'D' },
				],
			},
			{ spec: 'n', line: 2, typeOnly: false, namespace: true, names: [] },
		]);
		expect(stripComments('a // b\n/* c\nd */ e').split('\n')).toEqual(['a ', '', ' e']);
		expect(blankTemplates("x = `a\nimport 'b'` + 'c`d'")).toBe("x = ` \n          ` + 'c`d'");
		const code = 'this.tl.add(a, { b: [1] })\n\t.set(';
		expect(chainNames(code, code.lastIndexOf('.'))).toEqual(['add', 'tl', 'this']);
	});
});

describe('Biome noRestrictedImports mirrors the import bans (ANM-012)', () => {
	const biome = JSON.parse(readFileSync(join(root, 'biome.json'), 'utf8'));
	const restricted = (glob) =>
		biome.overrides.find((o) => o.includes[0] === glob).linter.rules.style.noRestrictedImports.options.paths;
	it('motion outside the runtime: every banned module, banned and runtime-only names', () => {
		const p = restricted('packages/motion/src/**');
		for (const m of ['waapi', 'events', 'draggable', 'layout', 'timer', 'animation', 'animatable', 'text'])
			expect(p[`animejs/${m}`], m).toBeTypeOf('string');
		for (const m of ['easings/irregular', 'adapters', 'adapters/three', 'scope', 'engine'])
			expect(p[`animejs/${m}`], m).toBeTypeOf('string');
		expect(p.animejs.importNames).toEqual(
			expect.arrayContaining([...BANNED_NAMES, ...Object.keys(RUNTIME_ONLY_NAMES)]),
		);
		expect(p['animejs/timeline'].importNames).toEqual(['createTimeline']);
		expect(p['animejs/utils'].importNames).toEqual(['random', 'randomPick', 'shuffle', 'createSeededRandom']);
	});
	it('the runtime may use scope, engine-free timelines and the seeded generator', () => {
		const p = restricted('packages/motion/src/runtime/**');
		expect(p['animejs/scope']).toBeUndefined();
		expect(p['animejs/timeline']).toBeUndefined();
		expect(p['animejs/utils'].importNames).toEqual(['random', 'randomPick', 'shuffle']);
		expect(p['animejs/waapi']).toBeTypeOf('string');
	});
	it('other sources never import anime.js', () => {
		const o = biome.overrides.find((x) => x.includes[0] === 'apps/**/src/**');
		expect(o.includes).toContain('!packages/motion/**');
		expect(o.linter.rules.style.noRestrictedImports.options.paths.animejs).toMatch(/ANM-001/);
	});
});

describe('check-anime over a tree', () => {
	it('finds problems with file and line', () => {
		const tree = mkdtempSync(join(tmpdir(), 'check-anime-'));
		mkdirSync(join(tree, 'packages/motion/src/text'), { recursive: true });
		mkdirSync(join(tree, 'apps/web/src'), { recursive: true });
		writeFileSync(join(tree, 'packages/motion/src/text/x.ts'), 'const a = 1;\nconst r = Math.random();\n');
		writeFileSync(join(tree, 'apps/web/src/y.ts'), "import { animate } from 'animejs';\n");
		writeFileSync(join(tree, 'packages/motion/src/text/x.test.ts'), 'Math.random();\n');
		expect(checkRepo(tree)).toEqual([
			{ file: 'apps/web/src/y.ts', line: 1, column: 1, rule: 'animejs-outside-motion', match: 'animejs' },
			{
				file: 'packages/motion/src/text/x.ts',
				line: 2,
				column: 11,
				rule: 'math-random',
				match: 'Math.random',
			},
		]);
	});
	it('the repository is clean', () => {
		expect(checkRepo(root)).toEqual([]);
	});
});
