import { beforeEach, describe, expect, it, vi } from 'vitest';

// Count real coefficient work without exposing the private cache or retaining per-tap mock calls.
const work = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../src/oversample.ts', async (importOriginal) => {
	const original = await importOriginal<typeof import('../src/oversample.ts')>();
	return {
		...original,
		besselI0: (x: number) => {
			work.calls++;
			return original.besselI0(x);
		},
	};
});

beforeEach(() => {
	vi.resetModules();
	work.calls = 0;
});

describe('resampler kernel reuse', () => {
	it('reuses coefficients while reading fresh channel data and separating rates and quality', async () => {
		const { resample } = await import('../src/resample.ts');
		const input = Float32Array.from({ length: 256 }, (_, i) => Math.sin(i * 0.3));
		const first = resample([input], 44100, 48000, 'fast')[0]!;
		work.calls = 0;
		expect(resample([input], 44100, 48000, 'fast')[0]).toEqual(first);
		expect(work.calls).toBe(0);
		input.fill(0);
		const silent = resample([input, input], 44100, 48000, 'fast');
		expect(silent).toHaveLength(2);
		expect(silent.every((channel) => channel.every((x) => x === 0))).toBe(true);
		expect(silent[0]).not.toBe(silent[1]);
		expect(work.calls).toBe(0);
		resample([input], 44100, 48000, 'high');
		expect(work.calls).toBeGreaterThan(0);
		work.calls = 0;
		resample([input], 48000, 44100, 'fast');
		expect(work.calls).toBeGreaterThan(0);
	});

	it('bounds the retained entry count as a speed ramp visits different ratios', async () => {
		const { resample } = await import('../src/resample.ts');
		const input = new Float32Array([1, 0, -1, 0]);
		const expected = resample([input], 96000, 48000, 'fast');
		for (let n = 2; n <= 12; n++) resample([input], 48000 * n, 48000, 'fast');
		work.calls = 0;
		expect(resample([input], 96000, 48000, 'fast')).toEqual(expected);
		expect(work.calls).toBeGreaterThan(0);
	});

	it('bounds retained bytes and does not retain oversized tables', async () => {
		const { resample } = await import('../src/resample.ts');
		const input = new Float32Array([1, -1, 0, 0]);
		const expected = resample([input], 48000, 44100.5, 'high');
		for (let n = 1; n <= 4; n++) resample([input], 48000, 44100.5 + n, 'high');
		work.calls = 0;
		expect(resample([input], 48000, 44100.5, 'high')).toEqual(expected);
		expect(work.calls).toBeGreaterThan(0);
		const big = resample([input], 480000.5, 48000, 'fast');
		work.calls = 0;
		expect(resample([input], 480000.5, 48000, 'fast')).toEqual(big);
		expect(work.calls).toBeGreaterThan(0);
	});
});
