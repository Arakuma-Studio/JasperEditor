// Deterministic mutation fuzzing and fast-check properties for every parser and loader.
//
// The rule: a parser given ANY input either succeeds or fails with its typed error (an error class it declares, or a
// result object it documents) — never an uncaught TypeError / RangeError / SyntaxError, never a hang. A target is
// registered with a one-liner in the package's `test/fuzz.test.ts`:
//
//   describeFuzz('@jasper/project parsers', [
//     textTarget('cube LUT', CUBE_SEEDS, parseCube, CubeParseError),
//     jsonTarget('effect preset', PRESET_SEEDS, parseEffectPreset),           // returns a result object, never throws
//   ]);
//
// Each target runs (1) every seed as is, (2) truncations of every seed, (3) seeded xorshift mutations of the seeds
// (byte, text-token or JSON-structure mutations by kind) and (4) a fast-check property over arbitrary inputs of its
// kind. `FUZZ=1` runs 20× more cases; `FUZZ_SEED=<n>` changes the seed (printed on failure, with the failing input
// written to test-results/fuzz-failures/). FilmCraft's `*/tests/fuzz.rs` (xorshift64*, extreme-value overwrites,
// truncation) is the model (MIT OR Apache-2.0; licenses/ported/golden-fuzz.md).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, it } from 'vitest';
// layers-allow: the test-only fuzz harness shares the repository's CPU budget clock.
import { threadCpuMs } from '../../../scripts/perf/cpu.ts';
import { envFlag, testResultsDir } from './env.ts';

/** xorshift128 (Marsaglia) seeded through splitmix32: fast, deterministic, 32-bit outputs. */
export class Rng {
	private s: Uint32Array;
	constructor(seed: number) {
		let x = seed >>> 0 || 0x9e3779b9;
		const next = () => {
			x = (x + 0x9e3779b9) >>> 0;
			let z = x;
			z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
			z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
			return (z ^ (z >>> 16)) >>> 0;
		};
		this.s = Uint32Array.of(next(), next(), next(), next() || 1);
	}
	/** Uniform 32-bit unsigned integer. */
	next(): number {
		const s = this.s;
		let t = s[3]!;
		const u = s[0]!;
		s[3] = s[2]!;
		s[2] = s[1]!;
		s[1] = u;
		t ^= t << 11;
		t ^= t >>> 8;
		s[0] = (t ^ u ^ (u >>> 19)) >>> 0;
		return s[0]!;
	}
	/** Uniform integer in [0, n) (0 when n ≤ 1). */
	below(n: number): number {
		return n <= 1 ? 0 : this.next() % Math.floor(n);
	}
	/** True with probability p. */
	chance(p: number): boolean {
		return this.next() / 0x1_0000_0000 < p;
	}
	pick<T>(xs: readonly T[]): T {
		return xs[this.below(xs.length)]!;
	}
}

const EXTREME_U32 = [0, 1, 0xffffffff, 0x80000000, 0x7fffffff, 0xffff, 0x10000];

/** One to four byte-level edits: bit flips, random bytes, extreme 32-bit fields, truncation, span delete/insert/copy. */
export function mutateBytes(rng: Rng, input: Uint8Array, others: readonly Uint8Array[] = []): Uint8Array {
	let d = Uint8Array.from(input);
	const edits = 1 + rng.below(4);
	for (let e = 0; e < edits; e++) {
		if (!d.length) {
			d = Uint8Array.from({ length: 1 + rng.below(16) }, () => rng.below(256));
			continue;
		}
		const pos = rng.below(d.length);
		switch (rng.below(9)) {
			case 0:
				d[pos] = d[pos]! ^ (1 << rng.below(8));
				break;
			case 1:
				d[pos] = rng.below(256);
				break;
			case 2:
			case 3: {
				const v = rng.chance(0.8) ? rng.pick(EXTREME_U32) : rng.next();
				const be = rng.chance(0.5);
				for (let k = 0; k < 4 && pos + k < d.length; k++)
					d[pos + k] = (v >>> (be ? 24 - 8 * k : 8 * k)) & 0xff;
				break;
			}
			case 4:
				d = d.slice(0, pos);
				break;
			case 5: {
				const n = Math.min(d.length - pos, 1 + rng.below(32));
				d = Uint8Array.from([...d.subarray(0, pos), ...d.subarray(pos + n)]);
				break;
			}
			case 6: {
				const ins = Uint8Array.from({ length: 1 + rng.below(16) }, () => rng.below(256));
				d = Uint8Array.from([...d.subarray(0, pos), ...ins, ...d.subarray(pos)]);
				break;
			}
			case 7: {
				const from = rng.below(d.length);
				const n = Math.min(d.length - from, 1 + rng.below(64));
				const span = d.slice(from, from + n);
				d = Uint8Array.from([...d.subarray(0, pos), ...span, ...d.subarray(pos)]);
				break;
			}
			default: {
				const other = others.length ? rng.pick(others) : d;
				const cut = rng.below(other.length + 1);
				d = Uint8Array.from([...d.subarray(0, pos), ...other.subarray(cut)]);
			}
		}
	}
	return d;
}

/** Values that break number parsing and range checks. */
export const INTERESTING_NUMBERS = [
	'0',
	'-0',
	'-1',
	'1',
	'NaN',
	'nan',
	'Infinity',
	'-Infinity',
	'inf',
	'1e309',
	'-1e309',
	'1e-400',
	'4294967296',
	'2147483648',
	'-2147483649',
	'9007199254740993',
	'0x10',
	'1.5',
	'.',
	'-',
	'1e',
	'',
	'999999999',
	'65537',
];

const INTERESTING_TEXT = [
	'\0',
	'\r\n',
	'\n\n\n',
	'\t',
	'"',
	'\\',
	'#',
	'{',
	'}',
	'[',
	']',
	':',
	',',
	'é',
	'﻿',
	'\ud800',
	'\u{1f600}',
	'__proto__',
	'constructor',
	'x'.repeat(300),
];

/** Text edits at line and token level (numbers swapped for INTERESTING_NUMBERS, lines dropped / duplicated / swapped). */
export function mutateText(rng: Rng, input: string, others: readonly string[] = []): string {
	let s = input;
	const edits = 1 + rng.below(4);
	for (let e = 0; e < edits; e++) {
		const lines = s.split('\n');
		switch (rng.below(10)) {
			case 0:
				lines.splice(rng.below(lines.length), 1);
				s = lines.join('\n');
				break;
			case 1: {
				const i = rng.below(lines.length);
				const n = rng.chance(0.2) ? 50 + rng.below(500) : 1;
				lines.splice(i, 0, ...Array.from({ length: n }, () => lines[i]!));
				s = lines.join('\n');
				break;
			}
			case 2: {
				const i = rng.below(lines.length);
				const j = rng.below(lines.length);
				[lines[i], lines[j]] = [lines[j]!, lines[i]!];
				s = lines.join('\n');
				break;
			}
			case 3:
			case 4: {
				const nums = [...s.matchAll(/-?\d+(\.\d+)?([eE][-+]?\d+)?/g)];
				if (!nums.length) {
					s += rng.pick(INTERESTING_NUMBERS);
					break;
				}
				const m = rng.pick(nums);
				s = s.slice(0, m.index) + rng.pick(INTERESTING_NUMBERS) + s.slice(m.index! + m[0].length);
				break;
			}
			case 5: {
				const words = [...s.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)];
				if (!words.length) break;
				const m = rng.pick(words);
				const other = rng.pick(words)[0];
				s = s.slice(0, m.index) + (rng.chance(0.5) ? other : '') + s.slice(m.index! + m[0].length);
				break;
			}
			case 6:
				s = s.slice(0, rng.below(s.length + 1));
				break;
			case 7: {
				const at = rng.below(s.length + 1);
				s = s.slice(0, at) + rng.pick(INTERESTING_TEXT) + s.slice(at);
				break;
			}
			case 8: {
				const at = rng.below(s.length + 1);
				s = s.slice(0, at) + s.slice(at + 1 + rng.below(16));
				break;
			}
			default: {
				const other = others.length ? rng.pick(others) : s;
				s = s.slice(0, rng.below(s.length + 1)) + other.slice(rng.below(other.length + 1));
			}
		}
	}
	return s;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const INTERESTING_JSON: Json[] = [
	null,
	true,
	false,
	0,
	-1,
	-0,
	0.5,
	1e308,
	-1e308,
	2 ** 53 + 2,
	4294967296,
	'',
	'x',
	'0',
	'NaN',
	'__proto__',
	'a'.repeat(1000),
	'\u0000',
	[],
	{},
	[null],
	{ __proto__: null },
];

/** Every path to a node of a JSON value (bounded), root first. */
function paths(v: unknown, limit = 2000): (string | number)[][] {
	const out: (string | number)[][] = [];
	const walk = (x: unknown, p: (string | number)[]) => {
		if (out.length >= limit) return;
		out.push(p);
		if (Array.isArray(x)) for (let i = 0; i < x.length; i++) walk(x[i], [...p, i]);
		else if (x && typeof x === 'object')
			for (const k of Object.keys(x)) walk((x as Record<string, unknown>)[k], [...p, k]);
	};
	walk(v, []);
	return out;
}

function getAt(v: unknown, p: (string | number)[]): unknown {
	let x = v;
	for (const k of p) x = (x as Record<string | number, unknown>)[k];
	return x;
}

function setAt(root: Json, p: (string | number)[], value: Json | undefined): Json {
	if (!p.length) return value === undefined ? null : value;
	const parent = getAt(root, p.slice(0, -1)) as Record<string | number, unknown>;
	const k = p[p.length - 1]!;
	if (value === undefined) {
		if (Array.isArray(parent)) parent.splice(k as number, 1);
		else delete parent[k];
	} else Object.defineProperty(parent, k, { value, enumerable: true, writable: true, configurable: true });
	return root;
}

/**
 * Structure-aware JSON edits: a node replaced by an interesting value or another node, deleted, its type changed,
 * an array grown or emptied, junk / prototype-named keys added, deep nesting. Some mutants go through the text
 * mutator and back through JSON.parse.
 */
export function mutateJson(rng: Rng, input: unknown, others: readonly unknown[] = []): unknown {
	if (rng.chance(0.08)) {
		const text = mutateText(rng, JSON.stringify(input) ?? 'null');
		try {
			return JSON.parse(text);
		} catch {
			// fall through to a structural mutation
		}
	}
	let root = structuredClone(input) as Json;
	const edits = 1 + rng.below(3);
	for (let e = 0; e < edits; e++) {
		const ps = paths(root);
		const p = rng.pick(ps);
		const node = getAt(root, p) as Json;
		switch (rng.below(9)) {
			case 0:
			case 1:
				root = setAt(root, p, structuredClone(rng.pick(INTERESTING_JSON)));
				break;
			case 2:
				if (p.length) root = setAt(root, p, undefined);
				break;
			case 3: {
				const src = rng.chance(0.7) || !others.length ? root : (others[rng.below(others.length)] as Json);
				const sp = paths(src);
				root = setAt(root, p, structuredClone(getAt(src, rng.pick(sp)) as Json) ?? null);
				break;
			}
			case 4:
				root = setAt(
					root,
					p,
					typeof node === 'number'
						? String(node)
						: typeof node === 'string'
							? Number(node) || node.length
							: Array.isArray(node)
								? Object.fromEntries(node.map((v, i) => [String(i), v]))
								: node && typeof node === 'object'
									? Object.values(node)
									: [node],
				);
				break;
			case 5:
				if (Array.isArray(node) && node.length)
					root = setAt(
						root,
						p,
						rng.chance(0.5)
							? []
							: Array.from({ length: 50 + rng.below(400) }, (_, i) =>
									structuredClone(node[i % node.length]!),
								),
					);
				else if (typeof node === 'number') root = setAt(root, p, rng.chance(0.5) ? -node : node * 1e9 + 0.5);
				break;
			case 6:
				if (node && typeof node === 'object' && !Array.isArray(node)) {
					const key = rng.pick([
						'__proto__',
						'constructor',
						'prototype',
						'toString',
						'hasOwnProperty',
						'x',
						'',
					]);
					Object.defineProperty(node, key, {
						value: structuredClone(rng.pick(INTERESTING_JSON)),
						enumerable: true,
						writable: true,
						configurable: true,
					});
				}
				break;
			case 7: {
				let deep: Json = node;
				for (let i = 0, n = 20 + rng.below(200); i < n; i++) deep = rng.chance(0.5) ? [deep] : { a: deep };
				root = setAt(root, p, deep);
				break;
			}
			default:
				if (typeof node === 'string') {
					root = setAt(root, p, mutateText(rng, node));
				} else if (typeof node === 'number')
					root = setAt(root, p, rng.pick([0, -1, 0.1, 1e6, -1e6, 2 ** 31]));
		}
	}
	return root;
}

export type FuzzKind = 'bytes' | 'text' | 'json';
type InputOf<K extends FuzzKind> = K extends 'bytes' ? Uint8Array : K extends 'text' ? string : unknown;
type ErrorClass = abstract new (...args: never[]) => Error;
/** Accepted failures: error classes, or a predicate on the thrown value. */
export type Expected = ErrorClass | readonly ErrorClass[] | ((e: unknown) => boolean);

export type FuzzTarget<K extends FuzzKind = FuzzKind> = {
	name: string;
	kind: K;
	/** Valid (and interesting invalid) inputs the mutations start from. */
	seeds: readonly InputOf<K>[] | (() => readonly InputOf<K>[] | Promise<readonly InputOf<K>[]>);
	/** The parser / loader under test (sync or async). */
	run: (input: InputOf<K>) => unknown;
	/** Typed failures it may throw (omit when it must never throw, e.g. result-object parsers). */
	expected?: Expected;
	/** Extra check on a successful result (throw to fail), e.g. "a result object with ok:false has a code". */
	check?: (result: unknown, input: InputOf<K>) => void;
	/** Mutation iterations (default 300; ×20 with FUZZ=1). */
	iterations?: number;
	/** fast-check runs (default 100; ×20 with FUZZ=1). */
	properties?: number;
	/** Per-input budget (ms; default 2000): CPU in the sync runner, elapsed time in the async runner. */
	slowMs?: number;
};

export const bytesTarget = (
	name: string,
	seeds: FuzzTarget<'bytes'>['seeds'],
	run: FuzzTarget<'bytes'>['run'],
	expected?: Expected,
	more: Partial<FuzzTarget<'bytes'>> = {},
): FuzzTarget<'bytes'> => ({ name, kind: 'bytes', seeds, run, expected, ...more });

export const textTarget = (
	name: string,
	seeds: FuzzTarget<'text'>['seeds'],
	run: FuzzTarget<'text'>['run'],
	expected?: Expected,
	more: Partial<FuzzTarget<'text'>> = {},
): FuzzTarget<'text'> => ({ name, kind: 'text', seeds, run, expected, ...more });

export const jsonTarget = (
	name: string,
	seeds: FuzzTarget<'json'>['seeds'],
	run: FuzzTarget<'json'>['run'],
	expected?: Expected,
	more: Partial<FuzzTarget<'json'>> = {},
): FuzzTarget<'json'> => ({ name, kind: 'json', seeds, run, expected, ...more });

/** Whether a thrown value is an accepted typed failure. */
function isExpected(e: unknown, expected: Expected | undefined): boolean {
	if (!expected) return false;
	if (Array.isArray(expected)) return expected.some((c) => e instanceof c);
	if (typeof expected === 'function' && expected.prototype instanceof Error)
		return e instanceof (expected as ErrorClass);
	if (typeof expected === 'function' && expected === Error) return e instanceof Error;
	return (expected as (e: unknown) => boolean)(e);
}

export function fuzzSeed(): number {
	const s = process.env.FUZZ_SEED;
	return s && /^\d+$/.test(s) ? Number(s) >>> 0 : 0x5eed;
}

export const fuzzScale = () => (envFlag('FUZZ') ? 20 : 1);

export type FuzzFailure = {
	phase: string;
	index: number;
	error: string;
	file?: string;
	artifactError?: string;
};

const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '');

function saveInput(
	target: string,
	tag: string,
	input: unknown,
	kind: FuzzKind,
): Pick<FuzzFailure, 'file' | 'artifactError'> {
	try {
		const dir = testResultsDir('fuzz-failures');
		mkdirSync(dir, { recursive: true });
		const file = join(
			dir,
			`${slug(target)}-${tag}.${kind === 'bytes' ? 'bin' : kind === 'text' ? 'txt' : 'json'}`,
		);
		writeFileSync(
			file,
			kind === 'bytes'
				? (input as Uint8Array)
				: kind === 'text'
					? (input as string)
					: (JSON.stringify(input) ?? 'undefined'),
		);
		return { file };
	} catch (error) {
		return { artifactError: `Could not save failing input: ${describeError(error)}` };
	}
}

function describeError(e: unknown): string {
	if (e instanceof Error)
		return `${e.name}: ${e.message}\n${(e.stack ?? '').split('\n').slice(1, 6).join('\n')}`;
	return `non-Error thrown: ${String(e)}`;
}

/** Classifies one finished run of an input: a failure description, or undefined when the outcome is allowed. */
function verdict<K extends FuzzKind>(
	t: FuzzTarget<K>,
	input: InputOf<K>,
	t0: number,
	run: () => unknown,
	clock: () => number = () => performance.now(),
): string | undefined {
	let failure: string | undefined;
	try {
		// (not `t.check?.(run(), …)`: optional-call short-circuits its arguments, so `run` would never run)
		const result = run();
		t.check?.(result, input);
	} catch (e) {
		if (!isExpected(e, t.expected)) failure = describeError(e);
	}
	const ms = clock() - t0;
	if (!failure && ms > (t.slowMs ?? 2000))
		failure = `took ${ms.toFixed(0)} ms (limit ${t.slowMs ?? 2000} ms)`;
	return failure;
}

/** Runs one input (async targets awaited). */
async function exercise<K extends FuzzKind>(
	t: FuzzTarget<K>,
	input: InputOf<K>,
): Promise<string | undefined> {
	const t0 = performance.now();
	let result: unknown;
	let thrown: { e: unknown } | undefined;
	try {
		result = await t.run(input);
	} catch (e) {
		thrown = { e };
	}
	return verdict(t, input, t0, () => {
		if (thrown) throw thrown.e;
		return result;
	});
}

/** Runs one input of a synchronous target. */
function exerciseSync<K extends FuzzKind>(t: FuzzTarget<K>, input: InputOf<K>): string | undefined {
	const t0 = threadCpuMs();
	return verdict(
		t,
		input,
		t0,
		() => {
			const r = t.run(input);
			if (r instanceof Promise) throw new Error('runFuzzTargetSync: the target returned a Promise');
			return r;
		},
		threadCpuMs,
	);
}

function arbitraryOf(kind: FuzzKind): fc.Arbitrary<unknown> {
	if (kind === 'bytes') return fc.uint8Array({ maxLength: 2048 });
	if (kind === 'text')
		return fc.oneof(fc.string({ maxLength: 512 }), fc.string({ unit: 'binary', maxLength: 512 }), fc.lorem());
	return fc.oneof(fc.jsonValue({ maxDepth: 6 }), fc.anything({ maxDepth: 4, withNullPrototype: true }));
}

export type FuzzOptions = { seed?: number; scale?: number; maxFailures?: number };

/** Phases 1–3 (seeds, truncations, seeded mutations) as a deterministic stream of inputs. */
function* fuzzInputs<K extends FuzzKind>(
	t: FuzzTarget<K>,
	seeds: readonly InputOf<K>[],
	seed: number,
	scale: number,
): Generator<{ phase: string; index: number; input: InputOf<K> }> {
	for (let i = 0; i < seeds.length; i++) yield { phase: 'seed', index: i, input: seeds[i]! };
	// Truncations (bytes and text): up to 32 evenly spaced cut points per seed, plus the empty input.
	if (t.kind !== 'json')
		for (let i = 0; i < seeds.length; i++) {
			const s = seeds[i] as Uint8Array | string;
			const cuts = new Set<number>([0, 1, s.length - 1]);
			for (let k = 1; k < 32; k++) cuts.add(Math.floor((s.length * k) / 32));
			for (const c of cuts)
				if (c >= 0 && c < s.length)
					yield { phase: 'truncate', index: i * 1000 + c, input: s.slice(0, c) as InputOf<K> };
		}
	const rng = new Rng(seed ^ hashName(t.name));
	const n = (t.iterations ?? 300) * scale;
	for (let i = 0; i < n; i++) {
		const base = seeds.length
			? seeds[rng.below(seeds.length)]!
			: t.kind === 'bytes'
				? new Uint8Array(0)
				: t.kind === 'text'
					? ''
					: null;
		const input =
			t.kind === 'bytes'
				? mutateBytes(rng, base as Uint8Array, seeds as readonly Uint8Array[])
				: t.kind === 'text'
					? mutateText(rng, base as string, seeds as readonly string[])
					: mutateJson(rng, base, seeds);
		yield { phase: 'mutate', index: i, input: input as InputOf<K> };
	}
}

/**
 * Fuzzes one target; returns every failure (empty = pass). Deterministic for a given `seed`. Exported so targets
 * can be exercised outside vitest (e.g. a long soak run).
 */
export async function runFuzzTarget<K extends FuzzKind>(
	t: FuzzTarget<K>,
	opts: FuzzOptions = {},
): Promise<FuzzFailure[]> {
	const seed = opts.seed ?? fuzzSeed();
	const scale = opts.scale ?? fuzzScale();
	const maxFailures = opts.maxFailures ?? 5;
	const seeds = [...(typeof t.seeds === 'function' ? await t.seeds() : t.seeds)];
	const failures: FuzzFailure[] = [];
	for (const { phase, index, input } of fuzzInputs(t, seeds, seed, scale)) {
		if (failures.length >= maxFailures) break;
		const error = await exercise(t, input);
		if (error)
			failures.push({
				phase,
				index,
				error,
				...saveInput(t.name, `${seed}-${phase}-${index}`, input, t.kind),
			});
	}
	if (failures.length < maxFailures) {
		const result = await fc.check(
			fc.asyncProperty(
				arbitraryOf(t.kind),
				async (input) => (await exercise(t, input as InputOf<K>)) === undefined,
			),
			{ numRuns: (t.properties ?? 100) * scale, seed },
		);
		if (result.failed) {
			const input = result.counterexample?.[0] as InputOf<K>;
			failures.push({
				phase: 'property',
				index: result.numRuns,
				error: `${(await exercise(t, input)) ?? 'flaky failure'} (fast-check seed ${seed}, path ${result.counterexamplePath})`,
				...saveInput(t.name, `${seed}-property`, input, t.kind),
			});
		}
	}
	return failures;
}

/** `runFuzzTarget` for synchronous targets (seeds given as values): usable inside a synchronous test body. */
export function runFuzzTargetSync<K extends FuzzKind>(
	t: FuzzTarget<K>,
	opts: FuzzOptions = {},
): FuzzFailure[] {
	const seed = opts.seed ?? fuzzSeed();
	const scale = opts.scale ?? fuzzScale();
	const maxFailures = opts.maxFailures ?? 5;
	const given = typeof t.seeds === 'function' ? t.seeds() : t.seeds;
	if (given instanceof Promise) throw new Error('runFuzzTargetSync: seeds must not be a Promise');
	const seeds = [...given];
	const failures: FuzzFailure[] = [];
	for (const { phase, index, input } of fuzzInputs(t, seeds, seed, scale)) {
		if (failures.length >= maxFailures) break;
		const error = exerciseSync(t, input);
		if (error)
			failures.push({
				phase,
				index,
				error,
				...saveInput(t.name, `${seed}-${phase}-${index}`, input, t.kind),
			});
	}
	if (failures.length < maxFailures) {
		const result = fc.check(
			fc.property(arbitraryOf(t.kind), (input) => exerciseSync(t, input as InputOf<K>) === undefined),
			{ numRuns: (t.properties ?? 100) * scale, seed },
		);
		if (result.failed) {
			const input = result.counterexample?.[0] as InputOf<K>;
			failures.push({
				phase: 'property',
				index: result.numRuns,
				error: `${exerciseSync(t, input) ?? 'flaky failure'} (fast-check seed ${seed}, path ${result.counterexamplePath})`,
				...saveInput(t.name, `${seed}-property`, input, t.kind),
			});
		}
	}
	return failures;
}

/** Throws the formatted failures of a synchronous target (for use inside any test body). */
export function assertFuzzSync<K extends FuzzKind>(t: FuzzTarget<K>, opts: FuzzOptions = {}): void {
	const failures = runFuzzTargetSync(t, opts);
	if (failures.length) throw new Error(formatFailures(t as FuzzTarget, failures));
}

function hashName(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
	return h >>> 0;
}

export function formatFailures(t: FuzzTarget, failures: FuzzFailure[]): string {
	return `${t.name}: ${failures.length} failing input(s) (FUZZ_SEED=${fuzzSeed()}):\n${failures
		.map(
			(f) =>
				`  [${f.phase} #${f.index}]${f.file ? ` input: ${f.file}` : ''}\n    ${[f.error, f.artifactError].filter(Boolean).join('\n').replace(/\n/g, '\n    ')}`,
		)
		.join('\n')}`;
}

/** Registers one vitest test per target. */
export function describeFuzz(title: string, targets: readonly FuzzTarget[], timeoutMs = 120_000): void {
	describe(`fuzz: ${title}`, () => {
		for (const t of targets)
			it(`${t.name}: never an untyped throw or a hang`, { timeout: timeoutMs * fuzzScale() }, async () => {
				const failures = await runFuzzTarget(t);
				if (failures.length) throw new Error(formatFailures(t, failures));
			});
	});
}
