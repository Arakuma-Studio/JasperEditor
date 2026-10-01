import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkRepo, findViolations, importsOf, stripComments } from './check-anime.mjs';

const rules = (rel, text) => findViolations(rel, text).map((v) => v.rule);
const MOTION = 'packages/motion/src/text/fade.ts';
const RUNTIME = 'packages/motion/src/runtime/x.ts';
const COMP = 'packages/compositions/src/layers/TextLayer.tsx';

describe('check-anime dependency rules (S11:ANM-001/022)', () => {
	it('only motion imports animejs; only compositions imports @jasper/motion', () => {
		expect(rules(MOTION, "import { createTimeline } from 'animejs/timeline';")).toEqual([]);
		expect(rules(COMP, "import { createTimeline } from 'animejs/timeline';")).toEqual([
			'animejs-outside-motion',
		]);
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
	});
	it('bans WAAPI/events/draggable/layout, and scope outside the runtime', () => {
		expect(rules(MOTION, "import { waapi } from 'animejs/waapi';")).toEqual(['banned-module']);
		expect(rules(MOTION, "import 'animejs/layout';")).toEqual(['banned-module']);
		expect(rules(MOTION, "import { createScope } from 'animejs/scope';")).toEqual(['scope-outside-runtime']);
		expect(rules(RUNTIME, "import { createScope } from 'animejs/scope';")).toEqual([]);
	});
});

describe('check-anime determinism rules (S11:ANM-006)', () => {
	it('bans wall-clock time and Math.random in motion and compositions sources', () => {
		expect(rules(COMP, 'const t = performance.now();')).toEqual(['performance-now']);
		expect(rules(MOTION, 'const r = Math.random() + Date.now();')).toEqual(['math-random', 'date-now']);
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
	it('ignores comments and honours anime-allow with a reason', () => {
		expect(rules(MOTION, '// never Math.random or tl.play()\n/* Date.now */ const x = 1;')).toEqual([]);
		expect(rules(MOTION, '// anime-allow: test fixture clock\nconst t = Date.now();')).toEqual([]);
		expect(rules(MOTION, 'const t = Date.now(); // anime-allow: why not')).toEqual([]);
		expect(rules(MOTION, 'const t = Date.now(); // anime-allow:')).toEqual(['date-now']);
		expect(rules(MOTION, "const s = 'Math.random';")).toEqual(['math-random']);
	});
	it('helpers: imports and comment stripping keep line numbers', () => {
		expect(importsOf("import a from 'x';\nexport * from \"y\";\nconst z = require('z');")).toEqual([
			'x',
			'y',
			'z',
		]);
		expect(stripComments('a // b\n/* c\nd */ e').split('\n')).toEqual(['a ', '', ' e']);
	});
});

describe('check-anime over a tree', () => {
	it('finds problems with file and line', () => {
		const root = mkdtempSync(join(tmpdir(), 'check-anime-'));
		mkdirSync(join(root, 'packages/motion/src/text'), { recursive: true });
		mkdirSync(join(root, 'apps/web/src'), { recursive: true });
		writeFileSync(join(root, 'packages/motion/src/text/x.ts'), 'const a = 1;\nconst r = Math.random();\n');
		writeFileSync(join(root, 'apps/web/src/y.ts'), "import { animate } from 'animejs';\n");
		writeFileSync(join(root, 'packages/motion/src/text/x.test.ts'), 'Math.random();\n');
		expect(checkRepo(root)).toEqual([
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
		const root = join(dirname(fileURLToPath(import.meta.url)), '..');
		expect(checkRepo(root)).toEqual([]);
	});
});
