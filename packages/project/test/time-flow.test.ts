import { describe, expect, it } from 'vitest';
import {
	analysisFactor,
	analysisLuma,
	blendFrames,
	blockFlow,
	computeFlowPair,
	type FlowImage,
	flowAt,
	interpolateEffectcraft,
	interpolateFlow,
	pyramid,
	pyramidLevels,
} from '../src/index.ts';

/** Smooth value noise (non-periodic), seeded. */
function noise(x: number, y: number, seed: number): number {
	const h = (i: number, j: number) => {
		let n = (i * 374761393 + j * 668265263 + seed * 1442695041) | 0;
		n = Math.imul(n ^ (n >>> 13), 1274126177);
		return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
	};
	const sm = (t: number) => t * t * (3 - 2 * t);
	let v = 0;
	let amp = 0.5;
	let f = 1 / 32;
	for (let o = 0; o < 6; o++) {
		const X = x * f;
		const Y = y * f;
		const i = Math.floor(X);
		const j = Math.floor(Y);
		const tx = sm(X - i);
		const ty = sm(Y - j);
		const a = h(i, j) + (h(i + 1, j) - h(i, j)) * tx;
		const b = h(i, j + 1) + (h(i + 1, j + 1) - h(i, j + 1)) * tx;
		v += amp * (a + (b - a) * ty);
		amp *= 0.5;
		f *= 2.1;
	}
	return v / (1 - 0.5 ** 6);
}

/** A textured picture (RGBA floats 0…1) shifted by (dx, dy). */
function texture(w: number, h: number, dx: number, dy = 0, seed = 1): FlowImage {
	const data = new Float32Array(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const s = noise(x - dx, y - dy, seed);
			const o = (y * w + x) * 4;
			data[o] = s;
			data[o + 1] = s * 0.8;
			data[o + 2] = 1 - s;
			data[o + 3] = 1;
		}
	return { width: w, height: h, data };
}

/** A textured square (side 64) at x = sx over a different static texture: occlusions at its edges. */
function square(w: number, h: number, sx: number): FlowImage {
	const bg = texture(w, h, 0, 0);
	const fg = texture(w, h, sx, 0, 7);
	const data = new Float32Array(bg.data as Float32Array);
	for (let y = 48; y < 112; y++)
		for (let x = Math.max(0, Math.round(sx)); x < Math.min(w, Math.round(sx) + 64); x++) {
			const o = (y * w + x) * 4;
			for (let c = 0; c < 4; c++) data[o + c] = (fg.data as Float32Array)[o + c]!;
		}
	return { width: w, height: h, data };
}

function mae(a: ArrayLike<number>, b: ArrayLike<number>, w: number, h: number, margin: number): number {
	let s = 0;
	let n = 0;
	for (let y = margin; y < h - margin; y++)
		for (let x = margin; x < w - margin; x++)
			for (let c = 0; c < 3; c++) {
				const o = (y * w + x) * 4 + c;
				s += Math.abs(a[o]! - b[o]!);
				n++;
			}
	return s / n;
}

describe('block flow', () => {
	it('finds a translation with sub-pixel accuracy', () => {
		const a = texture(128, 96, 0);
		const b = texture(128, 96, 6.4, -2.2);
		const k = analysisFactor(128, 96);
		const f = blockFlow(pyramid(analysisLuma(a, k)), pyramid(analysisLuma(b, k)));
		const v = flowAt(f, 64, 48, [0, 0]);
		expect(v[0]).toBeCloseTo(6.4, 0);
		expect(Math.abs(v[0] - 6.4)).toBeLessThan(0.3);
		expect(Math.abs(v[1] + 2.2)).toBeLessThan(0.3);
	});

	it('finds large motion through the pyramid', () => {
		const a = texture(320, 180, 0);
		const b = texture(320, 180, 27);
		const pair = computeFlowPair(a, b);
		expect(pyramidLevels(320, 180)).toBe(4);
		const v = flowAt(pair.ab, 160, 90, [0, 0]);
		expect(Math.abs(v[0] - 27)).toBeLessThan(0.5);
		const g = flowAt(pair.ba, 160, 90, [0, 0]);
		expect(Math.abs(g[0] + 27)).toBeLessThan(0.5);
	});

	it('analyses large frames at ≤ 1024 px', () => {
		expect(analysisFactor(1920, 1080)).toBe(2);
		expect(analysisFactor(3840, 2160)).toBe(4);
		expect(analysisFactor(1024, 576)).toBe(1);
	});
});

describe('interpolation', () => {
	it('beats a frame mix by far on a translation', () => {
		const a = texture(128, 96, 0);
		const b = texture(128, 96, 6);
		const truth = texture(128, 96, 3);
		const pair = computeFlowPair(a, b);
		const flow = mae(interpolateFlow(a, b, 0.5, pair), truth.data, 128, 96, 12);
		const mix = mae(blendFrames(a, b, 0.5), truth.data, 128, 96, 12);
		expect(flow).toBeLessThan(mix * 0.25);
	});

	it('handles occlusions better than effectcraft’s single-field cross-fade', () => {
		const W = 256;
		const H = 160;
		const a = square(W, H, 80);
		const b = square(W, H, 92);
		const truth = square(W, H, 86);
		const pair = computeFlowPair(a, b);
		// Measured over the band the square crosses (where the occlusions are).
		const band = (img: ArrayLike<number>) => {
			let s = 0;
			let n = 0;
			for (let y = 48; y < 112; y++)
				for (let x = 72; x < 164; x++)
					for (let c = 0; c < 3; c++) {
						const o = (y * W + x) * 4 + c;
						s += Math.abs(img[o]! - (truth.data as Float32Array)[o]!);
						n++;
					}
			return s / n;
		};
		const ours = band(interpolateFlow(a, b, 0.5, pair));
		const ec = band(interpolateEffectcraft(a, b, 0.5, pair.ab, pair.k));
		const mix = band(blendFrames(a, b, 0.5));
		expect(ours).toBeLessThan(ec * 0.8);
		expect(ours).toBeLessThan(mix * 0.25);
	});

	it('w = 0 and w = 1 reproduce the frames; 8-bit output is rounded', () => {
		const a = texture(64, 48, 0);
		const b = texture(64, 48, 3);
		const pair = computeFlowPair(a, b);
		expect(mae(interpolateFlow(a, b, 0, pair), a.data, 64, 48, 4)).toBeLessThan(1e-6);
		expect(mae(interpolateFlow(a, b, 1, pair), b.data, 64, 48, 4)).toBeLessThan(1e-6);
		const a8 = { ...a, data: Uint8ClampedArray.from(a.data as Float32Array, (v) => v * 255) };
		const b8 = { ...b, data: Uint8ClampedArray.from(b.data as Float32Array, (v) => v * 255) };
		const p8 = computeFlowPair(a8, b8, 255);
		const out = interpolateFlow(a8, b8, 0.5, p8, { data: new Uint8ClampedArray(64 * 48 * 4) });
		expect(out).toBeInstanceOf(Uint8ClampedArray);
	});
});
