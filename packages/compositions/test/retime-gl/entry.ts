import {
	analysisFactor,
	analysisSize,
	blendFrames,
	computeFlowPair,
	type FlowImage,
	interpolateFlow,
} from '@jasper/project';
import { RetimeCompositor } from '../../src/retime/flow-gl.ts';

/** Smooth multi-octave value noise (the CPU flow test's texture), seeded. */
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

/** A frame: background texture shifted by bg, a 64 px square of another texture at x = sx (8-bit RGBA). */
function frame(w: number, h: number, bg: number, sx: number): FlowImage {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const inSq = y >= 48 && y < 112 && x >= Math.round(sx) && x < Math.round(sx) + 64;
			const s = inSq ? noise(x - sx, y, 7) : noise(x - bg, y, 1);
			const o = (y * w + x) * 4;
			data[o] = Math.round(s * 255);
			data[o + 1] = Math.round(s * 0.8 * 255);
			data[o + 2] = Math.round((1 - s) * 255);
			data[o + 3] = 255;
		}
	return { width: w, height: h, data };
}

function toCanvas(img: FlowImage): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = img.width;
	c.height = img.height;
	const ctx = c.getContext('2d')!;
	ctx.putImageData(
		new ImageData(new Uint8ClampedArray(img.data as Uint8ClampedArray), img.width, img.height),
		0,
		0,
	);
	return c;
}

function readCanvas(c: HTMLCanvasElement | OffscreenCanvas, w: number, h: number): Uint8ClampedArray {
	const t = document.createElement('canvas');
	t.width = w;
	t.height = h;
	const ctx = t.getContext('2d')!;
	ctx.drawImage(c as CanvasImageSource, 0, 0);
	return ctx.getImageData(0, 0, w, h).data;
}

function stats(a: ArrayLike<number>, b: ArrayLike<number>) {
	let sum = 0;
	let max = 0;
	let within = 0;
	let n = 0;
	for (let i = 0; i < a.length; i++) {
		if (i % 4 === 3) continue;
		const d = Math.abs(a[i]! - b[i]!);
		sum += d;
		max = Math.max(max, d);
		if (d <= 3) within++;
		n++;
	}
	return { mean: sum / n, max, within: within / n };
}

const api = {
	/** GPU vs CPU optical flow on a pan + moving square (w in 0…1). */
	flow(arg?: string) {
		const { w = 0.5, bg = 3, sq = 12, W = 256, H = 160 } = arg ? JSON.parse(arg) : {};
		const a = frame(W, H, 0, 80);
		const b = frame(W, H, bg, 80 + sq);
		const truth = frame(W, H, bg * w, 80 + sq * w);
		const comp = new RetimeCompositor();
		const k = analysisFactor(W, H);
		const analysis = analysisSize(W, H, k);
		const out = readCanvas(comp.flow(toCanvas(a), toCanvas(b), w, W, H, analysis, 'p'), W, H);
		const pair = computeFlowPair(a, b, 255);
		const cpu = interpolateFlow(a, b, w, pair, { data: new Uint8ClampedArray(W * H * 4) });
		const blend = blendFrames(a, b, w, { data: new Uint8ClampedArray(W * H * 4) });
		comp.dispose();
		return {
			gpuVsCpu: stats(out, cpu),
			gpuVsTruth: stats(out, truth.data),
			cpuVsTruth: stats(cpu, truth.data),
			mixVsTruth: stats(blend, truth.data),
		};
	},
	blend(arg?: string) {
		const { w = 0.3 } = arg ? JSON.parse(arg) : {};
		const W = 64;
		const H = 40;
		const a = frame(W, H, 0, 10);
		const b = frame(W, H, 5, 20);
		const comp = new RetimeCompositor();
		const out = readCanvas(comp.blend(toCanvas(a), toCanvas(b), w, W, H), W, H);
		const cpu = blendFrames(a, b, w, { data: new Uint8ClampedArray(W * H * 4) });
		const sampled = readCanvas(comp.blend(toCanvas(a), null, 0, W, H), W, H);
		comp.dispose();
		return { blend: stats(out, cpu), sampling: stats(sampled, a.data) };
	},
};
(window as unknown as { __retime: typeof api }).__retime = api;
