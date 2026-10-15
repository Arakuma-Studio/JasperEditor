// Roto algorithms ported from EffectCraft; independent brute-force and analytic oracles check numerical behavior.
import { describe, expect, it } from 'vitest';
import { closedForm, distance, guidedFilter, signedDistance } from '../src/roto/core/matting.ts';
import { Graph, SOURCE } from '../src/roto/core/maxflow.ts';
import { DEFAULT_SEG_OPTS, matteAlpha, type Stroke, segment } from '../src/roto/core/segment.ts';

function xorshift(seed: number) {
	let s = seed >>> 0 || 1;
	return (m: number) => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s % m;
	};
}

function brute(n: number, t: [number, number][], e: [number, number, number, number][]): number {
	let best = Number.POSITIVE_INFINITY;
	for (let m = 0; m < 1 << n; m++) {
		const src = (i: number) => (m & (1 << i)) !== 0;
		let c = 0;
		t.forEach(([s, k], i) => {
			c += src(i) ? k : s;
		});
		for (const [i, j, a, b] of e) {
			if (src(i) && !src(j)) c += a;
			if (src(j) && !src(i)) c += b;
		}
		best = Math.min(best, c);
	}
	return best;
}

describe('maxflow (Boykov–Kolmogorov)', () => {
	it('matches brute force on 400 random graphs and the labeling realises the cut', () => {
		const rnd = xorshift(12345);
		for (let k = 0; k < 400; k++) {
			const n = 2 + rnd(10);
			const t: [number, number][] = Array.from({ length: n }, () => [rnd(20), rnd(20)]);
			const e: [number, number, number, number][] = [];
			const ne = rnd(24);
			for (let q = 0; q < ne; q++) {
				const i = rnd(n);
				const j = rnd(n);
				if (i !== j) e.push([i, j, rnd(15), rnd(15)]);
			}
			const g = new Graph(n, e.length);
			t.forEach(([a, b], i) => {
				g.addTWeights(i, a, b);
			});
			for (const [i, j, a, b] of e) g.addEdge(i, j, a, b);
			const f = g.maxflow();
			expect(f).toBe(brute(n, t, e));
			const src = (i: number) => g.segment(i) === SOURCE;
			let c = 0;
			t.forEach(([a, b], i) => {
				c += src(i) ? b : a;
			});
			for (const [i, j, a, b] of e) {
				if (src(i) && !src(j)) c += a;
				if (src(j) && !src(i)) c += b;
			}
			expect(c).toBe(f);
		}
	});
});

describe('matting utilities', () => {
	it('distance transform matches brute force', () => {
		const w = 23;
		const h = 17;
		const seed = new Uint8Array(w * h);
		for (let i = 0; i < w * h; i++) if ((i * 7919) % 31 === 0) seed[i] = 1;
		const d = distance(seed, w, h);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				let b = Number.POSITIVE_INFINITY;
				for (let j = 0; j < h; j++)
					for (let i = 0; i < w; i++) if (seed[j * w + i]) b = Math.min(b, Math.hypot(x - i, y - j));
				expect(Math.abs(d[y * w + x]! - b)).toBeLessThan(1e-3);
			}
		const sd = signedDistance(seed, w, h);
		for (let i = 0; i < w * h; i++) expect(Math.sign(sd[i]!)).toBe(seed[i] ? 1 : -1);
	});

	it('guided filter and closed-form matting recover a linear blend', () => {
		const w = 64;
		const h = 8;
		const alpha = Float32Array.from({ length: w * h }, (_, i) =>
			Math.min(1, Math.max(0, ((i % w) - 26) / 12)),
		);
		const F = [0.9, 0.2, 0.1];
		const B = [0.1, 0.3, 0.8];
		const img = new Float32Array(w * h * 3);
		for (let i = 0; i < w * h; i++)
			for (let k = 0; k < 3; k++) img[i * 3 + k] = alpha[i]! * F[k]! + (1 - alpha[i]!) * B[k]!;
		const p = Float32Array.from(alpha, (a) => (a >= 0.5 ? 1 : 0));
		const q = guidedFilter(img, p, w, h, 8, 1e-5);
		let err = 0;
		for (let i = 0; i < w * h; i++) err += Math.abs(Math.min(1, Math.max(0, q[i]!)) - alpha[i]!);
		expect(err / (w * h)).toBeLessThan(0.03);
		const known = Uint8Array.from(alpha, (a) => (a <= 0 || a >= 1 ? 1 : 0));
		const cf = closedForm(img, p, known, w, h, 1, 1e-5, 200);
		let err2 = 0;
		for (let i = 0; i < w * h; i++) err2 += Math.abs(cf[i]! - alpha[i]!);
		expect(err2 / (w * h)).toBeLessThan(0.02);
	});
});

/** A red disk (radius 15, textured) over a blue/green background, centre x = 40 + 2·frame. */
function diskFrame(frame: number, w = 100, h = 80): Float32Array {
	const cx = 40 + 2 * frame;
	const cy = 40;
	const img = new Float32Array(w * h * 3);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - 15;
			const a = Math.min(1, Math.max(0, 0.5 - d));
			const tex = ((x * 7 + y * 13) % 9) / 60;
			const fg = [0.85 + tex, 0.2, 0.1];
			const bg = [0.1, 0.4 + tex, 0.7];
			for (let k = 0; k < 3; k++) img[(y * w + x) * 3 + k] = fg[k]! * a + bg[k]! * (1 - a);
		}
	return img;
}

function wrongPixels(matte: Uint8Array, frame: number, w = 100, h = 80): number {
	const cx = 40 + 2 * frame;
	let wrong = 0;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const d = Math.hypot(x + 0.5 - cx, y + 0.5 - 40);
			const m = matte[y * w + x];
			if ((d < 14 && !m) || (d > 16 && m)) wrong++;
		}
	return wrong;
}

describe('segmentation and propagation', () => {
	const strokes: Stroke[] = [
		{
			kind: 'fg',
			radius: 3,
			points: [
				[35, 40],
				[45, 40],
			],
		},
		{
			kind: 'bg',
			radius: 3,
			points: [
				[5, 5],
				[95, 5],
				[95, 75],
			],
		},
	];

	it('segments the disk from a box alone', () => {
		const boxed = segment(diskFrame(0), 100, 80, [], [20, 20, 60, 60], null, DEFAULT_SEG_OPTS, 0);
		expect(wrongPixels(boxed.matte, 0)).toBeLessThan(30);
	});

	it('edge refinement softens the boundary towards the true coverage', () => {
		const img = diskFrame(0);
		const seg = segment(img, 100, 80, strokes, null, null, DEFAULT_SEG_OPTS, 0);
		const a = matteAlpha(img, seg, { mode: 'closed-form', radius: 3, smooth: 1 }, 0);
		let err = 0;
		let errBin = 0;
		let n = 0;
		for (let y = 0; y < 80; y++)
			for (let x = 0; x < 100; x++) {
				const d = Math.hypot(x + 0.5 - 40, y + 0.5 - 40) - 15;
				if (Math.abs(d) > 2) continue;
				const truth = Math.min(1, Math.max(0, 0.5 - d));
				err += Math.abs(a[y * 100 + x]! - truth);
				errBin += Math.abs(seg.matte[y * 100 + x]! - truth);
				n++;
			}
		expect(err / n).toBeLessThan(errBin / n);
		expect(a[40 * 100 + 40]).toBe(1);
		expect(a[5 * 100 + 5]).toBe(0);
	});
});
