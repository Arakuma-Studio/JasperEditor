// vid.stab WASM step (S07 PST-001/002, D-25): the module loads, the transform math, the 16-bit SIMD warp
// against its TypeScript reference and against vid.stab's own 8-bit transform, the worker pool, and a
// synthetic shaky clip (a still panned by a seeded random walk, made with the LGPL ffmpeg) whose inter-frame
// motion variance must drop by at least 60 %.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeFrames, u16 } from '../src/processing/proc/ffio.ts';
import type { DecodeSpec, StepContext } from '../src/processing/proc/types.ts';
import {
	backwardAffine,
	createVidstabStep,
	cubicWeights,
	detectionSize,
	LM_STRIDE,
	loadVidstabModule,
	resolveVidstabWasm,
	rowBands,
	scaleTransform,
	sourcePoint,
	sourceRows,
	VidstabWasm,
	type VsTransform,
	vidstabWasmAvailable,
	WarpPool,
	warpRgb48Reference,
} from '../src/processing/proc/vidstab/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FFMPEG = join(ROOT, 'vendor', 'ffmpeg-lgpl', 'linux-x64', 'ffmpeg');
const HAVE_FFMPEG = process.platform === 'linux' && process.arch === 'x64' && existsSync(FFMPEG);

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A smooth but textured 8-bit test image (gradients + sinusoids), so interpolation differences stay small. */
function pattern(width: number, height: number): Uint8Array {
	const out = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const v =
				128 +
				50 * Math.sin(x / 7.3 + y / 11.1) +
				40 * Math.cos(y / 5.7 - x / 13.9) +
				((x + 2 * y) % 64) / 4 -
				8;
			out[y * width + x] = Math.max(0, Math.min(255, Math.round(v)));
		}
	}
	return out;
}

describe('vid.stab WASM module', () => {
	it('resolves, compiles and reports version + SIMD', async () => {
		const path = resolveVidstabWasm();
		expect(path).toMatch(/vidstab\.wasm$/);
		expect(await vidstabWasmAvailable()).toBe(true);
		const vs = await VidstabWasm.create();
		expect(vs.version()).toBe('v1.4.0');
		vs.detectInit(64, 48, { shakiness: 5, accuracy: 15, stepSize: 4, minContrast: 0.2 });
		expect(vs.simd()).toBe('wasm-simd128');
		const imports = WebAssembly.Module.imports(await loadVidstabModule()).map((i) => i.module);
		expect(new Set(imports)).toEqual(new Set(['wasi_snapshot_preview1']));
	});

	it('honours JASPER_VIDSTAB_WASM and falls back when the override is missing', () => {
		const real = resolveVidstabWasm() as string;
		expect(resolveVidstabWasm({ JASPER_VIDSTAB_WASM: real })).toBe(real);
		expect(resolveVidstabWasm({ JASPER_VIDSTAB_WASM: '/nonexistent/vidstab.wasm' })).toBe(real);
	});

	it('SIMD and scalar motion detection give identical local motions', async () => {
		const w = 320;
		const h = 180;
		const base = pattern(w + 16, h + 16);
		const frame = (dx: number, dy: number) => {
			const f = new Uint8Array(w * h);
			for (let y = 0; y < h; y++)
				f.set(base.subarray((y + dy) * (w + 16) + dx, (y + dy) * (w + 16) + dx + w), y * w);
			return f;
		};
		const run = async (simd: boolean) => {
			const vs = await VidstabWasm.create();
			vs.setSimd(simd);
			vs.detectInit(w, h, { shakiness: 5, accuracy: 15, stepSize: 4, minContrast: 0.2 });
			return [frame(8, 8), frame(11, 6), frame(5, 9)].map((f) => Array.from(vs.detectFrame(f)));
		};
		const [a, b] = [await run(true), await run(false)];
		expect(a).toEqual(b);
		expect(a[1].length / LM_STRIDE).toBeGreaterThan(10);
		// the frame moved by (-3, +2): the median field vector says so (vid.stab: v = shift of the content)
		const vx = a[1].filter((_, i) => i % LM_STRIDE === 0).sort((p, q) => p - q);
		const vy = a[1].filter((_, i) => i % LM_STRIDE === 1).sort((p, q) => p - q);
		expect(Math.abs(vx[vx.length >> 1])).toBe(3);
		expect(Math.abs(vy[vy.length >> 1])).toBe(2);
	});
});

describe('transform math (pure)', () => {
	const W = 101;
	const H = 60;
	it('identity, translation and rotation about the frame centre', () => {
		expect(sourcePoint({ x: 0, y: 0, alpha: 0, zoom: 0 }, W, H, 7, 9)).toEqual([7, 9]);
		expect(sourcePoint({ x: 3, y: -2, alpha: 0, zoom: 0 }, W, H, 7, 9)).toEqual([4, 11]);
		const [cx, cy] = sourcePoint({ x: 0, y: 0, alpha: 0.3, zoom: 5 }, W, H, 50, 30);
		expect(cx).toBeCloseTo(50, 12);
		expect(cy).toBeCloseTo(30, 12);
		const [x1, y1] = sourcePoint({ x: 0, y: 0, alpha: Math.PI / 2, zoom: 0 }, W, H, 60, 30);
		expect(x1).toBeCloseTo(50, 12); // (10, 0) from the centre rotates to (0, 10)
		expect(y1).toBeCloseTo(40, 12);
		const [x2] = sourcePoint({ x: 0, y: 0, alpha: 0, zoom: 10 }, W, H, 60, 30);
		expect(x2).toBeCloseTo(59, 12); // zoom in 10 %: source distances shrink by 0.9
	});

	it('the affine matrix is the same map', () => {
		const t = { x: 2.5, y: -1.25, alpha: 0.02, zoom: 1.5 };
		const m = backwardAffine(t, W, H);
		for (const [x, y] of [
			[0, 0],
			[100, 59],
			[37, 12],
		]) {
			const [xs, ys] = sourcePoint(t, W, H, x, y);
			expect(m[0] * x + m[1] * y + m[2]).toBeCloseTo(xs, 10);
			expect(m[3] * x + m[4] * y + m[5]).toBeCloseTo(ys, 10);
		}
	});

	it('scales detection transforms, sizes detection frames, splits bands', () => {
		expect(scaleTransform({ x: 1, y: 2, alpha: 0.1, zoom: 3 }, 2, 2)).toEqual({
			x: 2,
			y: 4,
			alpha: 0.1,
			zoom: 3,
		});
		expect(detectionSize(1920, 1080, 960)).toEqual({ width: 960, height: 540 });
		expect(detectionSize(848, 480, 960)).toEqual({ width: 848, height: 480 });
		expect(detectionSize(3840, 1600, 960)).toEqual({ width: 960, height: 400 });
		const bands = rowBands(1080, 7);
		expect(bands[0][0]).toBe(0);
		expect(bands.at(-1)?.[1]).toBe(1080);
		for (let i = 1; i < bands.length; i++) expect(bands[i][0]).toBe(bands[i - 1][1]);
	});

	it('source rows of a band cover every bicubic tap', () => {
		const t = { x: 5.5, y: -7.25, alpha: 0.05, zoom: -3 };
		const [y0, y1] = [20, 35];
		const [r0, r1] = sourceRows(t, W, H, y0, y1);
		for (let y = y0; y < y1; y++) {
			for (let x = 0; x < W; x++) {
				const iy = Math.floor(sourcePoint(t, W, H, x, y)[1]);
				for (let k = -1; k <= 2; k++) {
					const r = Math.min(H - 1, Math.max(0, iy + k));
					expect(r >= r0 && r < r1).toBe(true);
				}
			}
		}
	});

	it("vid.stab's bicubic kernel: partition of unity, interpolating", () => {
		expect(cubicWeights(0)).toEqual([0, 1, 0, 0]);
		for (const t of [0.1, 0.5, 0.77]) {
			const w = cubicWeights(t);
			expect(w[0] + w[1] + w[2] + w[3]).toBeCloseTo(1, 12);
			expect(w[1] * 1 + w[2] * 2 + w[3] * 3).toBeCloseTo(1 + t, 12); // reproduces linear ramps
		}
	});
});

describe('16-bit warp', () => {
	const transforms: VsTransform[] = [
		{ x: 3.3, y: -2.7, alpha: 0.01, zoom: 2 },
		{ x: -12.5, y: 8.25, alpha: -0.04, zoom: 0 },
		{ x: 0.5, y: 0.5, alpha: 0, zoom: -4 },
	];

	it('WASM SIMD warp equals the TypeScript reference (±1 code value)', async () => {
		const w = 67;
		const h = 41;
		const r = rng(7);
		const src = new Uint16Array(w * h * 3).map(() => Math.floor(r() * 65536));
		const pool = await WarpPool.create(await loadVidstabModule(), 1);
		for (const t of transforms) {
			for (const border of [0, 1] as const) {
				const out = src.slice();
				await pool.warp(out, w, h, t, border);
				const ref = warpRgb48Reference(src, w, h, t, border === 0 ? 'black' : 'replicate');
				let max = 0;
				for (let i = 0; i < out.length; i++) max = Math.max(max, Math.abs(out[i] - ref[i]));
				expect(max).toBeLessThanOrEqual(1);
			}
		}
		await pool.close();
	});

	it("matches vid.stab's own 8-bit transform (same geometry and kernel)", async () => {
		const w = 160;
		const h = 96;
		const gray = pattern(w, h);
		const rgb = new Uint16Array(w * h * 3);
		for (let i = 0; i < w * h; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = gray[i] * 257;
		const vs = await VidstabWasm.create();
		const pool = await WarpPool.create(await loadVidstabModule(), 1);
		for (const t of transforms) {
			const ref = vs.referenceTransform(gray, w, h, t, 1);
			const out = rgb.slice();
			await pool.warp(out, w, h, t, 0);
			let sum = 0;
			let max = 0;
			let n = 0;
			for (let y = 12; y < h - 12; y++) {
				for (let x = 12; x < w - 12; x++) {
					const [xs, ys] = sourcePoint(t, w, h, x, y);
					if (xs < 2 || ys < 2 || xs > w - 4 || ys > h - 4) continue; // vid.stab's bilinear border strip
					const d = Math.abs(out[(y * w + x) * 3] / 257 - ref[y * w + x]);
					sum += d;
					max = Math.max(max, d);
					n++;
				}
			}
			expect(n).toBeGreaterThan(5000);
			expect(sum / n).toBeLessThan(0.6); // 8-bit fixed point rounding vs float
			expect(max).toBeLessThanOrEqual(2);
		}
		await pool.close();
	});

	it('the worker pool gives the same result as the calling thread', async () => {
		const w = 320;
		const h = 181;
		const r = rng(3);
		const src = new Uint16Array(w * h * 3).map(() => Math.floor(r() * 65536));
		const mod = await loadVidstabModule();
		const one = await WarpPool.create(mod, 1);
		const four = await WarpPool.create(mod, 4);
		for (const t of transforms) {
			const a = src.slice();
			const b = src.slice();
			await one.warp(a, w, h, t, 1);
			await four.warp(b, w, h, t, 1);
			expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
		}
		await one.close();
		await four.close();
	});
});

/** Per-pair global translation by SAD block matching (4× coarse search, full-resolution refinement). */
function globalShift(a: Uint8Array, b: Uint8Array, w: number, h: number): [number, number] {
	const sad = (f: number, dx: number, dy: number, x0: number, y0: number, x1: number, y1: number) => {
		let s = 0;
		for (let y = y0; y < y1; y += f) {
			for (let x = x0; x < x1; x += f) s += Math.abs(a[y * w + x] - b[(y + dy) * w + (x + dx)]);
		}
		return s;
	};
	let best = [0, 0];
	let bestS = Number.POSITIVE_INFINITY;
	const m = 48; // margin > the largest expected shift
	for (let dy = -40; dy <= 40; dy += 4) {
		for (let dx = -40; dx <= 40; dx += 4) {
			const s = sad(4, dx, dy, m, m, w - m, h - m);
			if (s < bestS) [bestS, best] = [s, [dx, dy]];
		}
	}
	const [cx, cy] = best;
	bestS = Number.POSITIVE_INFINITY;
	for (let dy = cy - 4; dy <= cy + 4; dy++) {
		for (let dx = cx - 4; dx <= cx + 4; dx++) {
			const s = sad(2, dx, dy, m, m, w - m, h - m);
			if (s < bestS) [bestS, best] = [s, [dx, dy]];
		}
	}
	return best as [number, number];
}

function motionVariance(shifts: Array<[number, number]>): number {
	const mean = (k: 0 | 1) => shifts.reduce((s, v) => s + v[k], 0) / shifts.length;
	const [mx, my] = [mean(0), mean(1)];
	return shifts.reduce((s, [x, y]) => s + (x - mx) ** 2 + (y - my) ** 2, 0) / shifts.length;
}

describe.skipIf(!HAVE_FFMPEG)('stabilising a synthetic shaky clip (LGPL ffmpeg)', () => {
	const W = 640;
	const H = 360;
	const N = 60;
	const PAD = 24;
	let dir = '';
	let raw = '';

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'jasper-vidstab-'));
		// one still of testsrc2 (static texture), panned by a seeded random walk of ±24 px
		const still = join(dir, 'still.rgb');
		const SW = W + 2 * PAD;
		const SH = H + 2 * PAD;
		const r = spawnSync(FFMPEG, [
			'-v',
			'error',
			'-f',
			'lavfi',
			'-i',
			`testsrc2=size=${SW}x${SH}:rate=1,format=rgb24`,
			'-frames:v',
			'1',
			'-f',
			'rawvideo',
			still,
		]);
		expect(r.status).toBe(0);
		const img = readFileSync(still);
		const next = rng(42);
		let px = 0;
		let py = 0;
		const frames = Buffer.alloc(W * H * 3 * N);
		for (let i = 0; i < N; i++) {
			px = Math.max(-PAD, Math.min(PAD, px + Math.round((next() - 0.5) * 16)));
			py = Math.max(-PAD, Math.min(PAD, py + Math.round((next() - 0.5) * 16)));
			for (let y = 0; y < H; y++) {
				const s = ((y + PAD + py) * SW + PAD + px) * 3;
				img.copy(frames, (i * H + y) * W * 3, s, s + W * 3);
			}
		}
		raw = join(dir, 'shaky.rgb');
		writeFileSync(raw, frames);
	});

	afterAll(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it('reduces the inter-frame motion variance by ≥ 60 % and keeps the frame count', async () => {
		const spec: DecodeSpec = {
			ffmpeg: FFMPEG,
			inputArgs: ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', '30', '-i', raw],
			frames: N,
			width: W,
			height: H,
			fps: { num: 30, den: 1 },
		};
		const notes: string[] = [];
		const facts: Record<string, unknown> = {};
		const ctx: StepContext = {
			ffmpeg: FFMPEG,
			ffprobe: FFMPEG.replace(/ffmpeg$/, 'ffprobe'),
			threads: 3,
			device: 'cpu',
			scratch: dir,
			width: W,
			height: H,
			frames: N,
			fps: spec.fps,
			models: {},
			note: (m) => notes.push(m),
			info: (k, v) => {
				facts[k] = v;
			},
			analysisProgress: () => {},
			signal: new AbortController().signal,
		};
		const step = createVidstabStep({ method: 'vidstab', smoothing: 15, borders: 'crop' });
		await step.analyse?.(spec, ctx);
		expect(await step.open(ctx)).toEqual({ width: W, height: H });

		const lumaIn: Uint8Array[] = [];
		const lumaOut: Uint8Array[] = [];
		const toLuma = (d: Uint16Array) => {
			const l = new Uint8Array(W * H);
			for (let i = 0; i < W * H; i++)
				l[i] = (d[i * 3] * 0.2126 + d[i * 3 + 1] * 0.7152 + d[i * 3 + 2] * 0.0722) / 257;
			return l;
		};
		let index = 0;
		let outCount = 0;
		for await (const buf of decodeFrames(spec, { pixFmt: 'rgb48le' })) {
			const data = u16(buf);
			lumaIn.push(toLuma(data));
			const out = await step.push({ index: index++, width: W, height: H, data });
			for (const f of out) {
				expect(f.width).toBe(W);
				lumaOut.push(toLuma(f.data));
			}
			outCount += out.length;
		}
		outCount += (await step.end()).length;
		await step.close?.();
		expect(index).toBe(N);
		expect(outCount).toBe(N);

		const shifts = (ls: Uint8Array[]) => ls.slice(1).map((l, i) => globalShift(ls[i], l, W, H));
		const before = motionVariance(shifts(lumaIn));
		const after = motionVariance(shifts(lumaOut));
		expect(before).toBeGreaterThan(20);
		expect(after).toBeLessThan(before * 0.4);

		expect(facts.engine).toBe('vidstab-wasm');
		expect(facts.zoomPercent).toBeGreaterThan(0);
		expect((facts.vidstab as { simd: string }).simd).toBe('wasm-simd128');
		expect((facts.warp as { frames: number }).frames).toBeGreaterThan(N / 2);
	}, 60_000);
});
