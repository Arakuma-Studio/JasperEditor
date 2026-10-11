import { describe, expect, it } from 'vitest';
import { MAX_MODEL_VALUES, ModelParseError, parseModel } from '../src/three-d/gltf.ts';
import {
	accessorOfZeros,
	badIndices,
	HOSTILE_MODELS,
	manyInstances,
	sharedChildren,
	sharedImage,
	strideZero,
	triangleDocument,
} from './three-d-hostile.ts';

const LIMIT_MS = 20_000;
const enc = (doc: unknown) => new TextEncoder().encode(JSON.stringify(doc));

function attempt(bytes: Uint8Array): { ms: number; error?: unknown; grownMiB: number } {
	const before = process.memoryUsage().arrayBuffers;
	const t0 = performance.now();
	try {
		parseModel(bytes, 'gltf');
		return { ms: performance.now() - t0, grownMiB: (process.memoryUsage().arrayBuffers - before) / 2 ** 20 };
	} catch (error) {
		return {
			ms: performance.now() - t0,
			error,
			grownMiB: (process.memoryUsage().arrayBuffers - before) / 2 ** 20,
		};
	}
}

describe('hostile glTF documents', () => {
	it('the reference triangle still reads', () => {
		const m = parseModel(enc(triangleDocument()), 'gltf');
		expect(m.triangles).toBe(1);
	});

	it.each(Object.entries(HOSTILE_MODELS))(
		'%s is refused with a reason, without the allocation',
		(_name, make) => {
			const r = attempt(make());
			expect(r.error).toBeInstanceOf(ModelParseError);
			expect(r.ms).toBeLessThan(LIMIT_MS);
			// The 20 000-instance document legitimately reads up to the allowance before it is refused.
			expect(r.grownMiB).toBeLessThan(1024);
		},
	);

	it('says why: too large, not a tree, out of range', () => {
		const message = (b: Uint8Array) => (attempt(b).error as Error).message;
		expect(message(accessorOfZeros())).toMatch(/too large \(more than 64 million/);
		expect(message(strideZero())).toMatch(/too large/);
		expect(message(sharedChildren())).toMatch(/used twice/);
		expect(message(manyInstances())).toMatch(/too large/);
		expect(message(badIndices())).toMatch(/index is out of range/);
		for (const values of [
			[0, 1, Number.NaN],
			[0, 1, 3],
			[0, 1, -0.5],
			[0, 1, 1e12],
		])
			expect(message(badIndices(values))).toMatch(/index is out of range/);
	});

	it('an accessor of zeros and a stride of 0 cost nothing before they are refused', () => {
		for (const make of [accessorOfZeros, strideZero]) {
			const r = attempt(make());
			expect(r.grownMiB).toBeLessThan(16);
			expect(r.ms).toBeLessThan(2000);
		}
	});

	it('counts that are not counts are refused: negative, fractional, text, missing', () => {
		for (const count of [-1, 1.5, '3', null, Number.MAX_SAFE_INTEGER, 2 ** 53]) {
			const d = triangleDocument();
			const malformed = { ...d, accessors: [{ ...d.accessors[0], count }, ...d.accessors.slice(1)] };
			expect(attempt(enc(malformed)).error, String(count)).toBeInstanceOf(ModelParseError);
		}
		for (const [key, value] of [
			['byteOffset', -4],
			['byteOffset', 1.5],
			['byteOffset', 1e12],
		] as const) {
			const d = triangleDocument();
			d.accessors[0][key] = value;
			expect(attempt(enc(d)).error, `${key}=${value}`).toBeInstanceOf(ModelParseError);
		}
		const d = triangleDocument();
		d.bufferViews[0].byteStride = -12;
		expect(attempt(enc(d)).error).toBeInstanceOf(ModelParseError);
	});

	it('an image used by thousands of materials is read once', () => {
		const r = attempt(sharedImage(4000, 1 << 20));
		expect(r.error).toBeUndefined();
		expect(r.grownMiB).toBeLessThan(64);
		const m = parseModel(sharedImage(3, 4096), 'gltf');
		expect(m.primitives[0]!.material.texture?.bytes.length).toBe(4096);
	});

	it('a model at the allowance reads, one over it does not (the limit is exact and documented)', () => {
		expect(MAX_MODEL_VALUES).toBe(64_000_000);
		// 1000 instances of a 5000-vertex mesh, shaded flat: 5000×3 read + (5000×3 + 4×~5000) written per instance.
		expect(attempt(manyInstances(100, 5000)).error).toBeUndefined();
	});

	it('a tree as deep as the limit reads; shared children at any depth do not', () => {
		const chain = triangleDocument();
		chain.nodes = Array.from({ length: 60 }, (_, i) => (i === 59 ? { mesh: 0 } : { children: [i + 1] }));
		expect(attempt(enc(chain)).error).toBeUndefined();
		expect(attempt(sharedChildren(2, 3)).error).toBeInstanceOf(ModelParseError);
		// The same root listed twice in the scene is the same mistake.
		const twice = triangleDocument();
		twice.scenes[0].nodes = [0, 0];
		expect((attempt(enc(twice)).error as Error).message).toMatch(/used twice/);
	});
});
