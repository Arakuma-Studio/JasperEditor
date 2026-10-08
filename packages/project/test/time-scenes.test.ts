// Scene Edit Detection accuracy (workstream `time`): synthetic footage with known hard cuts plus the false-positive
// guards — cross dissolves, one- and two-frame flashes, fast camera pans and a slow lighting change. Reports precision
// and recall (exact frame) and compares with filmcraft's grid/histogram difference on the same frames.
import { describe, expect, it } from 'vitest';
import {
	cutAccuracy,
	detectSceneCuts,
	type FlowImage,
	sceneDissimilarity,
	sceneScores,
	sceneSignature,
	sceneThreshold,
} from '../src/index.ts';

const W = 128;
const H = 72;

function noise(x: number, y: number, seed: number): number {
	const h = (i: number, j: number) => {
		let n = (i * 374761393 + j * 668265263 + seed * 1442695041) | 0;
		n = Math.imul(n ^ (n >>> 13), 1274126177);
		return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
	};
	const sm = (t: number) => t * t * (3 - 2 * t);
	let v = 0;
	let amp = 0.5;
	let f = 1 / 24;
	for (let o = 0; o < 5; o++) {
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
	return v / (1 - 0.5 ** 5);
}

const PALETTES: [number, number, number][][] = [
	[
		[0.9, 0.5, 0.2],
		[0.1, 0.2, 0.4],
	],
	[
		[0.2, 0.8, 0.3],
		[0.05, 0.1, 0.05],
	],
	[
		[0.95, 0.95, 0.9],
		[0.4, 0.1, 0.5],
	],
	[
		[0.3, 0.6, 0.95],
		[0.6, 0.3, 0.1],
	],
	[
		[0.8, 0.8, 0.2],
		[0.2, 0.2, 0.25],
	],
];

/** One frame of shot `shot` panned by (dx, dy), brightness × `gain`. 8-bit RGBA. */
function shotFrame(shot: number, dx: number, dy: number, gain = 1): FlowImage {
	const data = new Uint8ClampedArray(W * H * 4);
	const [p, q] = PALETTES[shot % PALETTES.length]!;
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const t = noise(x + dx, y + dy, 17 + shot * 31);
			const o = (y * W + x) * 4;
			for (let c = 0; c < 3; c++) data[o + c] = 255 * gain * (q![c]! + (p![c]! - q![c]!) * t);
			data[o + 3] = 255;
		}
	return { width: W, height: H, data };
}

function mix(a: FlowImage, b: FlowImage, w: number): FlowImage {
	const data = new Uint8ClampedArray(W * H * 4);
	for (let i = 0; i < data.length; i++) data[i] = (a.data[i] as number) * (1 - w) + (b.data[i] as number) * w;
	return { width: W, height: H, data };
}

const white = (): FlowImage => ({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });

/** The test reel: frames and the true cut frames. */
function reel(): { frames: FlowImage[]; cuts: number[] } {
	const frames: FlowImage[] = [];
	const cuts: number[] = [];
	const shot = (s: number, n: number, pan: (i: number) => [number, number], gain?: (i: number) => number) => {
		for (let i = 0; i < n; i++) {
			const [dx, dy] = pan(i);
			frames.push(shotFrame(s, dx, dy, gain?.(i) ?? 1));
		}
	};
	const cut = () => cuts.push(frames.length);
	shot(0, 20, (i) => [i * 2, 0]); // slow pan
	cut();
	shot(1, 18, (i) => [0, i]); // tilt
	// one-frame white flash inside shot 1
	frames.push(white());
	shot(1, 12, (i) => [0, 18 + i]);
	cut();
	shot(2, 24, (i) => [i * 7, i * 2]); // fast pan, 7 px/frame on a 128 px frame
	cut();
	shot(
		3,
		15,
		() => [0, 0],
		(i) => 0.6 + 0.4 * (i / 14),
	); // slow lighting change
	// 12-frame cross dissolve 3 → 4 (no hard cut)
	for (let i = 1; i <= 12; i++) frames.push(mix(shotFrame(3, 0, 0), shotFrame(4, i, 0), i / 13));
	shot(4, 14, (i) => [13 + i, 0]);
	// a two-frame flash of another shot inside shot 4 (Premiere's min shot length merges it)
	frames.push(shotFrame(0, 0, 0), shotFrame(0, 2, 0));
	shot(4, 10, (i) => [27 + i, 0]);
	cut();
	shot(0, 16, (i) => [-i * 3, 0]);
	return { frames, cuts };
}

/** filmcraft scene.rs `difference` (32×18 grid luma + 16-bin per-channel histograms), for comparison. */
function filmcraftScores(frames: FlowImage[]): number[] {
	const GW = 32;
	const GH = 18;
	const sig = (f: FlowImage) => {
		const grid = new Float32Array(GW * GH);
		const cnt = new Float32Array(GW * GH);
		const hist = new Float32Array(48);
		const d = f.data as Uint8ClampedArray;
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const o = (y * W + x) * 4;
				const gi = Math.floor((y * GH) / H) * GW + Math.floor((x * GW) / W);
				grid[gi]! += 0.2126 * d[o]! + 0.7152 * d[o + 1]! + 0.0722 * d[o + 2]!;
				cnt[gi]! += 1;
				for (let c = 0; c < 3; c++) hist[c * 16 + Math.floor((d[o + c]! * 16) / 256)]! += 1;
			}
		for (let i = 0; i < grid.length; i++) grid[i] = grid[i]! / cnt[i]! / 255;
		for (let i = 0; i < 48; i++) hist[i] = hist[i]! / (W * H);
		return { grid, hist };
	};
	const s = frames.map(sig);
	const out = [0];
	for (let i = 1; i < s.length; i++) {
		let hh = 0;
		for (let k = 0; k < 48; k++) hh += Math.abs(s[i]!.hist[k]! - s[i - 1]!.hist[k]!);
		hh /= 6;
		let g = 0;
		for (let k = 0; k < GW * GH; k++) g += Math.abs(s[i]!.grid[k]! - s[i - 1]!.grid[k]!);
		g /= GW * GH;
		out.push(Math.min(1, Math.max(0, 0.5 * hh + 0.5 * Math.min(1, 2 * g))));
	}
	return out;
}

/** filmcraft `detect_cuts` (sensitivity 50, min shot 6). */
function filmcraftCuts(d: number[], minShot = 6): number[] {
	const thr = 0.45 - 0.33 * 0.5;
	const cuts: number[] = [];
	for (let i = 1; i < d.length; i++) {
		const v = d[i]!;
		if (v < thr) continue;
		const around = d
			.slice(Math.max(1, i - 5), Math.min(d.length, i + 6))
			.filter((_, k) => Math.max(1, i - 5) + k !== i);
		around.sort((a, b) => a - b);
		const med = around[around.length >> 1] ?? 0;
		if (v < 2.5 * med + 0.05) continue;
		if ((d[i + 1] ?? 0) > v || (i > 1 && d[i - 1]! > v && cuts[cuts.length - 1] !== i - 1)) continue;
		if (i - (cuts[cuts.length - 1] ?? 0) < minShot) continue;
		cuts.push(i);
	}
	return cuts;
}

describe('scene edit detection', () => {
	const { frames, cuts } = reel();
	const sigs = frames.map((f) => sceneSignature(f));
	const scores = sceneScores(sigs);

	it('finds every hard cut exactly and nothing at dissolves, flashes, fast pans or lighting changes', () => {
		const found = detectSceneCuts(scores, { sensitivity: 50, minShotFrames: 3 }, sigs);
		const acc = cutAccuracy(found, cuts);
		expect(found).toEqual(cuts);
		expect(acc).toMatchObject({ precision: 1, recall: 1 });
		// effectcraft cuts.rs = the same scores without the flash test.
		const ec = detectSceneCuts(scores, { sensitivity: 50, minShotFrames: 3 });
		const ecAcc = cutAccuracy(ec, cuts);
		const fc = filmcraftCuts(filmcraftScores(frames));
		const fcAcc = cutAccuracy(fc, cuts);
		// Reported in docs/wp-notes/time.md: ours P = R = 1; filmcraft's difference on the same reel below.
		if (process.env.SCENE_REPORT)
			console.info(
				JSON.stringify({
					ours: { found, ...acc },
					effectcraft: { found: ec, ...ecAcc },
					filmcraft: { found: fc, ...fcAcc },
					cuts,
				}),
			);
		expect(ecAcc.recall).toBe(1);
		expect(fcAcc.precision + fcAcc.recall).toBeLessThanOrEqual(acc.precision + acc.recall);
	});

	it('motion compensation keeps a fast pan far below a cut', () => {
		const pan = sceneDissimilarity(sceneSignature(shotFrame(2, 0, 0)), sceneSignature(shotFrame(2, 7, 2)));
		const cut = sceneDissimilarity(sceneSignature(shotFrame(2, 0, 0)), sceneSignature(shotFrame(3, 0, 0)));
		expect(pan).toBeLessThan(0.1);
		expect(cut).toBeGreaterThan(0.3);
	});

	it('sensitivity moves the threshold; minimum shot length merges close cuts', () => {
		expect(sceneThreshold(0)).toBeGreaterThan(sceneThreshold(50));
		expect(sceneThreshold(100)).toBeLessThan(sceneThreshold(50));
		const s = [0, 0.01, 0.9, 0.01, 0.8, 0.01, 0.01, 0.01, 0.01, 0.01];
		expect(detectSceneCuts(s, { sensitivity: 50, minShotFrames: 1 })).toEqual([2, 4]);
		expect(detectSceneCuts(s, { sensitivity: 50, minShotFrames: 3 })).toEqual([2]);
		expect(detectSceneCuts([], { sensitivity: 50, minShotFrames: 2 })).toEqual([]);
	});

	it('a dissolve onto a flat colour at a histogram bin edge does not end in a cut (soft bins)', () => {
		// Regression (verify workstream): scenes.mp4 dissolves a binary cellular automaton onto a flat gradient; one
		// random instance had green at 59–73, across the 64 bin edge, and the hard-binned histogram scored the last
		// dissolve step 0.6 → a false cut at the end of the dissolve.
		const flat: [number, number, number] = [67, 59, 253];
		const texture = (x: number, y: number) => (noise(x * 3, y * 3, 5) > 0.5 ? 235 : 20);
		const frame = (w: number, shift: number): FlowImage => {
			const data = new Uint8ClampedArray(W * H * 4);
			for (let y = 0; y < H; y++)
				for (let x = 0; x < W; x++) {
					const o = (y * W + x) * 4;
					const t = texture(x, y + shift);
					for (let c = 0; c < 3; c++) data[o + c] = Math.round(t * (1 - w) + flat[c]! * w);
					data[o + 3] = 255;
				}
			return { width: W, height: H, data };
		};
		const seq: FlowImage[] = [];
		for (let i = 0; i < 10; i++) seq.push(frame(0, i));
		for (let i = 1; i <= 12; i++) seq.push(frame(i / 13, 10 + i));
		for (let i = 0; i < 10; i++) seq.push(frame(1, 0));
		const s = seq.map((f) => sceneSignature(f));
		const sc = sceneScores(s);
		expect(sc[22]!).toBeLessThan(sceneThreshold(50));
		expect(detectSceneCuts(sc, { sensitivity: 50, minShotFrames: 2 }, s)).toEqual([]);
	});

	it('soft bins: the histogram sums to 1 and a colour drifting across a bin edge moves it continuously', () => {
		const flat = (r: number, g: number, b: number): FlowImage => {
			const data = new Uint8ClampedArray(W * H * 4);
			for (let i = 0; i < W * H; i++) data.set([r, g, b, 255], i * 4);
			return { width: W, height: H, data };
		};
		const sig = sceneSignature(flat(67, 59, 253));
		expect(sig.hist.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 3);
		const h = (a: FlowImage, b: FlowImage) => {
			const x = sceneSignature(a).hist;
			const y = sceneSignature(b).hist;
			let d = 0;
			for (let i = 0; i < x.length; i++) d += Math.abs(x[i]! - y[i]!);
			return d / 2;
		};
		// 2 levels across the 64 edge: a hard bin would move everything (distance 1).
		expect(h(flat(67, 63, 253), flat(67, 65, 253))).toBeLessThan(0.05);
		// Far apart colours are still fully distinct.
		expect(h(flat(10, 10, 10), flat(245, 245, 245))).toBeGreaterThan(0.99);
	});

	it('the flash test: a one-frame flash is not a cut, a real cut is kept', () => {
		const a = sceneSignature(shotFrame(1, 0, 0));
		const flash = sceneSignature(white());
		const b = sceneSignature(shotFrame(1, 1, 0));
		const seq = [a, a, a, flash, b, b, b];
		expect(detectSceneCuts(sceneScores(seq), { sensitivity: 50, minShotFrames: 1 }, seq)).toEqual([]);
		const c = sceneSignature(shotFrame(3, 0, 0));
		const real = [a, a, a, c, c, c, c];
		expect(detectSceneCuts(sceneScores(real), { sensitivity: 50, minShotFrames: 1 }, real)).toEqual([3]);
	});
});
