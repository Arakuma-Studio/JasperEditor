// scripts/check-layers.mjs (ARCHITECTURE §3.1, D-37): the dependency table over package.json edges and imports.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkRepo, fileViolations, LAYERS } from './check-layers.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A miniature workspace: `{ 'packages/project': {pkg, files: {'src/x.ts': text}} }`. */
function workspace(spec) {
	const root = mkdtempSync(join(tmpdir(), 'jasper-layers-'));
	for (const [dir, { pkg, files = {} }] of Object.entries(spec)) {
		mkdirSync(join(root, dir, 'src'), { recursive: true });
		writeFileSync(join(root, dir, 'package.json'), JSON.stringify(pkg));
		for (const [f, text] of Object.entries(files)) {
			mkdirSync(dirname(join(root, dir, f)), { recursive: true });
			writeFileSync(join(root, dir, f), text);
		}
	}
	return root;
}
const rules = (root) => checkRepo(root).map((p) => `${p.file} ${p.rule} ${p.spec}`);
const PROJECT = {
	pkg: { name: '@jasper/project', exports: { '.': './src/index.ts' } },
	files: { 'src/index.ts': '' },
};

describe('check-layers', () => {
	it('allows the edges of the table', () => {
		const root = workspace({
			'packages/project': PROJECT,
			'packages/api': {
				pkg: { name: '@jasper/api', dependencies: { '@jasper/project': 'workspace:*', zod: '^4' } },
				files: { 'src/index.ts': "import { z } from 'zod';\nimport type { X } from '@jasper/project';\n" },
			},
		});
		expect(rules(root)).toEqual([]);
	});

	it('fails on a forbidden edge in package.json and in source', () => {
		const root = workspace({
			'packages/project': {
				pkg: { name: '@jasper/project', dependencies: { '@jasper/api': 'workspace:*' } },
				files: { 'src/a.ts': "import { x } from '@jasper/api';\n" },
			},
			'packages/api': { pkg: { name: '@jasper/api' } },
		});
		expect(rules(root)).toEqual([
			'packages/project/package.json forbidden-edge @jasper/api',
			'packages/project/src/a.ts forbidden-edge @jasper/api',
		]);
	});

	it('fails on an undeclared workspace import and on a subpath the target does not export', () => {
		const root = workspace({
			'packages/project': PROJECT,
			'packages/api': {
				pkg: { name: '@jasper/api' },
				files: {
					'src/a.ts':
						"import { x } from '@jasper/project';\nimport { y } from '@jasper/project/src/ids.ts';\n",
				},
			},
		});
		expect(rules(root)).toEqual([
			'packages/api/src/a.ts undeclared-dependency @jasper/project',
			'packages/api/src/a.ts undeclared-dependency @jasper/project/src/ids.ts',
			'packages/api/src/a.ts not-exported @jasper/project/src/ids.ts',
		]);
	});

	it('fails on deep relative imports across package roots, and packages importing apps', () => {
		const root = workspace({
			'packages/project': PROJECT,
			'packages/api': {
				pkg: { name: '@jasper/api', dependencies: { '@jasper/project': 'workspace:*' } },
				files: {
					'src/deep/a.ts':
						"import { x } from '../../../project/src/index.ts';\nimport { y } from './b.ts';\n",
					'src/b.ts': "export { z } from '../../../apps/web/src/z.ts';\nimport { w } from '@jasper/web';\n",
				},
			},
			'apps/web': { pkg: { name: '@jasper/web' } },
		});
		expect(rules(root)).toEqual([
			'packages/api/src/b.ts package-imports-app ../../../apps/web/src/z.ts',
			'packages/api/src/b.ts package-imports-app @jasper/web',
			'packages/api/src/deep/a.ts relative-outside-package ../../../project/src/index.ts',
		]);
	});

	it('keeps Node built-ins, React, Remotion and anime.js out of the pure model', () => {
		const ctx = {
			dir: 'packages/project',
			layer: LAYERS['packages/project'],
			declared: new Set(),
			exportsOf: () => null,
		};
		const found = (text) => fileViolations('packages/project/src/x.ts', text, ctx).map((v) => v.spec);
		expect(
			found(
				[
					"import { readFileSync } from 'node:fs';",
					"import path from 'path';",
					"import type { FC } from 'react';",
					"import { AbsoluteFill } from 'remotion';",
					"import { stagger } from 'animejs/utils';",
					"import { produce } from 'immer';",
				].join('\n'),
			),
		).toEqual(['node:fs', 'path', 'react', 'remotion', 'animejs/utils']);
		// the opt-out needs a reason
		expect(found("// layers-allow: types only, erased\nimport type { Stats } from 'node:fs';")).toEqual([]);
	});

	it('allows React in @jasper/session only under src/react', () => {
		const ctx = {
			dir: 'packages/session',
			layer: LAYERS['packages/session'],
			declared: new Set(),
			exportsOf: () => null,
		};
		expect(
			fileViolations('packages/session/src/react/hooks.ts', "import { useState } from 'react';", ctx),
		).toEqual([]);
		expect(
			fileViolations('packages/session/src/session.ts', "import { useState } from 'react';", ctx).map(
				(v) => v.rule,
			),
		).toEqual(['forbidden-external']);
	});

	it('fails on an unknown workspace package', () => {
		const root = workspace({
			'packages/project': PROJECT,
			'packages/newthing': { pkg: { name: '@jasper/newthing' } },
		});
		expect(rules(root)).toEqual(['packages/newthing/package.json unknown-package newthing']);
	});

	it('the repository passes', () => {
		expect(checkRepo(repo)).toEqual([]);
	});
});
