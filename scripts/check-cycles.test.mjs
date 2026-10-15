import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { cycleViolations, cyclicComponents, dependencyGraph, moduleReferences } from './check-cycles.mjs';

const roots = [];
const workspace = (files) => {
	const root = mkdtempSync(join(tmpdir(), 'jasper-cycles-'));
	roots.push(root);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
};
const manifest = JSON.stringify({ name: '@jasper/example', type: 'module' });
const cycles = (root) =>
	cyclicComponents(dependencyGraph(root)).map((files) => files.map((file) => relative(root, file)));
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runtime dependency cycles', () => {
	it('reads imports, exports, dynamic imports and require calls from syntax, excluding comments and strings', () => {
		const references = moduleReferences(
			'example.ts',
			[
				'// import "ignored-comment";',
				'const text = "import ignored from \'ignored-string\'";',
				'import type { A } from "types";',
				'import { type B } from "inline-types";',
				'import { type C, value } from "mixed";',
				'export type { D } from "export-types";',
				'export { type E } from "inline-export-types";',
				'export * from "values";',
				'import alias = require("commonjs");',
				'const load = () => import(`dynamic`);',
				'const loaded = require("required");',
				'type Remote = import("import-type").Remote;',
			].join('\n'),
		);
		expect(references.map(({ spec, line, typeOnly }) => [spec, line, typeOnly])).toEqual([
			['types', 3, true],
			['inline-types', 4, true],
			['mixed', 5, false],
			['export-types', 6, true],
			['inline-export-types', 7, true],
			['values', 8, false],
			['commonjs', 9, false],
			['dynamic', 10, false],
			['required', 11, false],
			['import-type', 12, true],
		]);
	});

	it('ignores import-like text inside JSX children', () => {
		expect(moduleReferences('example.tsx', `export const view = <p>import fake from 'node:fs'</p>;`)).toEqual(
			[],
		);
	});

	it('detects relative .js imports resolving to TypeScript source and emits actionable locations', () => {
		const root = workspace({
			'packages/example/package.json': manifest,
			'packages/example/src/a.ts': 'import "./b.js"; export const a = 1;',
			'packages/example/src/b.ts': 'export { a } from "./a.js";',
		});
		expect(cycles(root)).toEqual([['packages/example/src/a.ts', 'packages/example/src/b.ts']]);
		expect(cycleViolations(root)).toEqual([
			expect.objectContaining({
				file: 'packages/example/src/a.ts',
				line: 1,
				rule: 'runtime-cycle',
				message: expect.stringContaining('packages/example/src/b.ts:1 -> packages/example/src/a.ts'),
			}),
		]);
	});

	it('excludes explicit and inferred type-only imports erased by the compiler', () => {
		const root = workspace({
			'packages/example/package.json': manifest,
			'packages/example/src/a.ts':
				'import { B } from "./b"; import type { C } from "./c"; export type A = B | C;',
			'packages/example/src/b.ts': 'import "./a"; export interface B { value: number }',
			'packages/example/src/c.ts': 'import { type A } from "./a"; export type C = A[];',
		});
		expect(cycles(root)).toEqual([]);
	});

	it('retains the side effect of inline type imports under verbatimModuleSyntax', () => {
		const root = workspace({
			'packages/example/package.json': manifest,
			'packages/example/tsconfig.json': JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }),
			'packages/example/src/a.ts': 'import { type B } from "./b"; export const a = 1;',
			'packages/example/src/b.ts': 'import "./a"; export interface B { value: number }',
		});
		expect(cycles(root)).toHaveLength(1);
	});

	it('includes literal dynamic imports and CommonJS import assignments', () => {
		const root = workspace({
			'packages/example/package.json': manifest,
			'packages/example/src/a.cts': 'import b = require("./b.cjs"); export = b;',
			'packages/example/src/b.cts': 'export const load = () => import("./a.cjs");',
		});
		expect(cycles(root)).toHaveLength(1);
	});

	it('excludes tests, fixture directories, declarations and benchmarks from production cycles', () => {
		const root = workspace({
			'packages/example/package.json': manifest,
			...Object.fromEntries(
				[
					'test/a.ts',
					'tests/a.ts',
					'__tests__/a.ts',
					'fixtures/a.ts',
					'__fixtures__/a.ts',
					'bench/a.ts',
					'a.test.ts',
					'a.spec.ts',
					'a.bench.ts',
					'a.d.ts',
				].map((file) => [
					`packages/example/src/${file}`,
					`import "./${file.includes('/') ? 'a' : file.split('.')[0]}";`,
				]),
			),
			'packages/example/src/main.ts': 'export const value = 1;',
		});
		expect(cycles(root)).toEqual([]);
	});

	it('resolves package subpaths across the workspace and aliases in inherited tsconfig files', () => {
		const root = workspace({
			'tsconfig.base.json': JSON.stringify({
				compilerOptions: { baseUrl: '.', paths: { '#first': ['packages/first/src/index.ts'] } },
			}),
			'packages/first/package.json': JSON.stringify({ name: '@jasper/first', exports: './src/index.ts' }),
			'packages/first/src/index.ts': 'export { b } from "@jasper/second/feature"; export const a = 1;',
			'packages/second/package.json': JSON.stringify({
				name: '@jasper/second',
				exports: { './feature': './src/feature.ts' },
			}),
			'packages/second/tsconfig.json': JSON.stringify({ extends: '../../tsconfig.base.json' }),
			'packages/second/src/feature.ts': 'export { a } from "#first"; export const b = 2;',
		});
		mkdirSync(join(root, 'packages/first/node_modules/@jasper'), { recursive: true });
		symlinkSync(
			join(root, 'packages/second'),
			join(root, 'packages/first/node_modules/@jasper/second'),
			'dir',
		);
		expect(cycles(root)).toEqual([['packages/first/src/index.ts', 'packages/second/src/feature.ts']]);
	});

	it('follows import and require export conditions instead of declaration entries', () => {
		const root = workspace({
			'packages/first/package.json': manifest,
			'packages/first/src/index.ts':
				'import "@jasper/second"; export const required = require("@jasper/second");',
			'packages/second/package.json': JSON.stringify({
				name: '@jasper/second',
				exports: { types: './types.d.ts', import: './src/import.ts', require: './src/require.cts' },
			}),
			'packages/second/types.d.ts': 'export declare const value: number;',
			'packages/second/src/import.ts': 'import "../../first/src/index.ts";',
			'packages/second/src/require.cts': 'require("../../first/src/index.ts");',
		});
		mkdirSync(join(root, 'packages/first/node_modules/@jasper'), { recursive: true });
		symlinkSync(
			join(root, 'packages/second'),
			join(root, 'packages/first/node_modules/@jasper/second'),
			'dir',
		);
		expect(cycles(root)).toEqual([
			['packages/first/src/index.ts', 'packages/second/src/import.ts', 'packages/second/src/require.cts'],
		]);
	});

	it('follows workspace source dependencies outside the initial src directories', () => {
		const root = workspace({
			'packages/example/package.json': manifest,
			'packages/example/src/index.ts': 'import "../helper.js";',
			'packages/example/helper.ts': 'import "./src/index.js";',
		});
		expect(cycles(root)).toEqual([['packages/example/helper.ts', 'packages/example/src/index.ts']]);
	});

	it('reports invalid project configuration instead of silently inspecting a different graph', () => {
		const root = workspace({
			'packages/example/package.json': manifest,
			'packages/example/tsconfig.json': '{ "extends": "./missing.json" }',
			'packages/example/src/index.ts': 'export const value = 1;',
		});
		expect(() => dependencyGraph(root)).toThrow(/missing\.json/);
	});

	it('matches mutual reachability for generated directed graphs', () => {
		fc.assert(
			fc.property(
				fc.array(fc.tuple(fc.integer({ min: 0, max: 7 }), fc.integer({ min: 0, max: 7 })), { maxLength: 40 }),
				(edges) => {
					const graph = new Map(Array.from({ length: 8 }, (_, index) => [String(index), []]));
					for (const [from, to] of edges) graph.get(String(from)).push({ target: String(to) });
					const reachable = new Map(
						[...graph].map(([file, outgoing]) => {
							const found = new Set();
							const pending = outgoing.map(({ target }) => target);
							while (pending.length) {
								const next = pending.pop();
								if (found.has(next)) continue;
								found.add(next);
								pending.push(...graph.get(next).map(({ target }) => target));
							}
							return [file, found];
						}),
					);
					const cycles = cyclicComponents(graph);
					for (const from of graph.keys())
						for (const to of graph.keys()) {
							expect(cycles.some((component) => component.includes(from) && component.includes(to))).toBe(
								reachable.get(from).has(to) && reachable.get(to).has(from),
							);
						}
				},
			),
			{ numRuns: 100 },
		);
	});

	it('finds every independent component and self-loop without overflowing on long graphs', () => {
		const graph = new Map(
			Array.from({ length: 20_000 }, (_, i) => [String(i), i < 19_999 ? [{ target: String(i + 1) }] : []]),
		);
		graph.get('19999').push({ target: '19990' });
		graph.set('self', [{ target: 'self' }]);
		expect(
			cyclicComponents(graph)
				.map((component) => component.length)
				.sort((a, b) => a - b),
		).toEqual([1, 10]);
	});
});
