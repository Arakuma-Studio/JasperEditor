import { describe, expect, it } from 'vitest';
import { ModelParseError, parseModel } from '../src/three-d/gltf.ts';
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
	it.each(Object.entries(HOSTILE_MODELS))(
		'%s is refused with a reason, without the allocation',
		(_name, make) => {
			const r = attempt(make());
			expect(r.error).toBeInstanceOf(ModelParseError);
			expect(r.ms).toBeLessThan(LIMIT_MS);
			expect(r.grownMiB).toBeLessThan(1024);
		},
	);

	it('a mesh shown by more nodes than the allowance covers is refused before any of it is decoded', () => {
		const r = attempt(manyInstances());
		expect(r.error).toBeInstanceOf(ModelParseError);
		expect((r.error as Error).message).toMatch(/too large/);
		expect(r.grownMiB).toBeLessThan(16);
		expect(r.ms).toBeLessThan(2000);
	});

	it('refuses non-finite, fractional, negative and out-of-range indices', () => {
		for (const values of [
			[0, 1, Number.NaN],
			[0, 1, 3],
			[0, 1, -0.5],
			[0, 1, 1e12],
		]) {
			expect(attempt(badIndices(values)).error).toBeInstanceOf(ModelParseError);
		}
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

	it('a tree as deep as the limit reads; shared children at any depth do not', () => {
		const chain = triangleDocument();
		chain.nodes = Array.from({ length: 60 }, (_, i) => (i === 59 ? { mesh: 0 } : { children: [i + 1] }));
		expect(attempt(enc(chain)).error).toBeUndefined();
		expect(attempt(sharedChildren(2, 3)).error).toBeInstanceOf(ModelParseError);
		const twice = triangleDocument();
		twice.scenes[0].nodes = [0, 0];
		expect((attempt(enc(twice)).error as Error).message).toMatch(/used twice/);
	});
});
