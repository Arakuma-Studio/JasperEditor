import { describe, expect, it } from 'vitest';
import {
	detectSceneCuts,
	type FlowImage,
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

describe('scene edit detection', () => {
	const { frames, cuts } = reel();
	const sigs = frames.map((f) => sceneSignature(f));
	const scores = sceneScores(sigs);

	it('finds every hard cut exactly and nothing at dissolves, flashes, fast pans or lighting changes', () => {
		const found = detectSceneCuts(scores, { sensitivity: 50, minShotFrames: 3 }, sigs);
		expect(found).toEqual(cuts);
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
		// Green levels 59–73 straddle the histogram's 64-bin edge; hard bins can mistake the last dissolve
		// step for a cut even though the image changes smoothly.
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
		expect(detectSceneCuts(sc, { sensitivity: 50, minShotFrames: 2 }, s)).toEqual([]);
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
