import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Fft, fft } from '../src/fft.ts';

describe('complex FFT', () => {
	it('agrees with the discrete Fourier transform for complex input', () => {
		fc.assert(
			fc.property(
				fc.array(fc.tuple(fc.integer({ min: -100, max: 100 }), fc.integer({ min: -100, max: 100 })), {
					minLength: 8,
					maxLength: 8,
				}),
				(input) => {
					const re = Float64Array.from(input, ([r]) => r);
					const im = Float64Array.from(input, ([, i]) => i);
					fft(re, im);
					for (let k = 0; k < input.length; k++) {
						let real = 0;
						let imaginary = 0;
						for (const [n, [r, i]] of input.entries()) {
							const phase = (-2 * Math.PI * k * n) / input.length;
							real += r * Math.cos(phase) - i * Math.sin(phase);
							imaginary += r * Math.sin(phase) + i * Math.cos(phase);
						}
						expect(re[k]).toBeCloseTo(real, 9);
						expect(im[k]).toBeCloseTo(imaginary, 9);
					}
					fft(re, im, true);
					for (const [n, [r, i]] of input.entries()) {
						expect(re[n]! / input.length).toBeCloseTo(r, 9);
						expect(im[n]! / input.length).toBeCloseTo(i, 9);
					}
				},
			),
			{ seed: 7349, numRuns: 40 },
		);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -2, 0, 1, 2.5, 3, 2 ** 32])(
		'rejects invalid plan size %s before allocating',
		(size) => expect(() => new Fft(size)).toThrow(RangeError),
	);

	it('rejects mismatched buffers before changing either buffer', () => {
		const plan = new Fft(4);
		const re = Float64Array.of(1, 2, 3, 4);
		const im = Float64Array.of(5, 6);
		expect(() => plan.forward(re, im)).toThrow(RangeError);
		expect(() => plan.inverse(im, re)).toThrow(RangeError);
		expect([...re]).toEqual([1, 2, 3, 4]);
		expect([...im]).toEqual([5, 6]);
	});
});
