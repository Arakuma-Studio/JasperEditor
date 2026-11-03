// @vitest-environment node
// The parity metric of the Title Looks tests (AGENTS §4): colour SSIM fails a picture whose lightness is right and whose hue
// is wrong (a colourway, gradient map or tint error), which luma SSIM passes.
import { describe, expect, it } from 'vitest';
import { ssim, ssimRgb } from './title-look-harness.ts';

const W = 64;
const H = 48;

/** A test card: a horizontal ramp of one hue, bars of others, and noise, so every window has structure. */
function card(hue: (x: number, y: number) => [number, number, number]): Uint8Array {
	const out = new Uint8Array(W * H * 3);
	let seed = 7;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) >>> 0;
		return (seed >>> 16) / 65536;
	};
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const [r, g, b] = hue(x, y);
			const n = (rnd() - 0.5) * 30;
			out.set(
				[r + n, g + n, b + n].map((v) => Math.max(0, Math.min(255, Math.round(v)))),
				(y * W + x) * 3,
			);
		}
	return out;
}

const luma = (rgb: Uint8Array) => {
	const out = new Float64Array(W * H);
	for (let i = 0; i < out.length; i++)
		out[i] = 0.2126 * rgb[i * 3]! + 0.7152 * rgb[i * 3 + 1]! + 0.0722 * rgb[i * 3 + 2]!;
	return out;
};

describe('colour SSIM (title-look-harness)', () => {
	// The same lightness in opposite hues: BT.709 Y'CbCr with the chroma negated, so luma matches pixel for pixel (to 8-bit
	// rounding) and every colour is its complement.
	const ycc = (sign: number) =>
		card((x, y) => {
			const Y = 70 + (110 * x) / (W - 1);
			const cb = sign * 30 * Math.sin((y / H) * Math.PI * 2);
			const cr = sign * 30 * Math.cos((x / W) * Math.PI * 3);
			return [Y + 1.5748 * cr, Y - 0.1873 * cb - 0.4681 * cr, Y + 1.8556 * cb];
		});
	const warm = ycc(1);
	const cool = ycc(-1);

	it('is 1 for the same picture', () => {
		expect(ssimRgb(warm, warm, W, H).min).toBeCloseTo(1, 6);
	});

	it('fails a hue error that luma SSIM passes', () => {
		expect(ssim(luma(warm), luma(cool), W, H)).toBeGreaterThan(0.98);
		expect(ssimRgb(warm, cool, W, H).min).toBeLessThan(0.9);
	});

	it('reads RGBA with its stride', () => {
		const rgba = new Uint8Array(W * H * 4);
		for (let i = 0; i < W * H; i++) rgba.set([warm[i * 3]!, warm[i * 3 + 1]!, warm[i * 3 + 2]!, 255], i * 4);
		expect(ssimRgb(rgba, rgba, W, H, 4).min).toBeCloseTo(1, 6);
	});
});
