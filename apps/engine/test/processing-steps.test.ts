// jasper-proc steps against the S07 §8 acceptance criteria (tests 2-6) with the LGPL FFmpeg:
//   2 frame count / rate / audio bit-exact for every step on clip-b.mp4
//   3 stabilise shaky.mp4: global inter-frame motion variance (phase correlation) drops ≥ 60 % (vid.stab WASM)
//     and ≥ 40 % (deshake)
//   4 de-judder judder.mp4 (detected, step CV drops ≥ 50 %); steady-pan.mp4 left unchanged in auto mode
//   5 denoise: noise sigma of a flat patch drops ≥ 40 % (medium); deblock: 8x8 blockiness drops ≥ 25 %
//   6 upscale with the generated model: exactly 2×, seamless tiles, `mix` blends linearly
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessStep } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertLgplFilters, GPL_FILTERS } from '../src/processing/proc/filters.ts';
import { listFilters, runProc } from '../src/processing/proc/runner.ts';
import { createStepImpl } from '../src/processing/proc/steps.ts';
import { writeTinySrModel } from '../src/processing/proc/tiny-onnx.ts';
import type { ProcEvent } from '../src/processing/proc/types.ts';
import { createUpscaleStep, openOnnxModel, upscaleTiled } from '../src/processing/proc/upscale.ts';
import { ensureFixtures, fixture, ROOT } from './helpers.ts';

const LGPL = join(ROOT, 'vendor', 'ffmpeg-lgpl', `${process.platform}-${process.arch}`);
const FFMPEG =
	process.env.JASPER_FFMPEG ?? (existsSync(join(LGPL, 'ffmpeg')) ? join(LGPL, 'ffmpeg') : 'ffmpeg');
const FFPROBE =
	process.env.JASPER_FFPROBE ?? (existsSync(join(LGPL, 'ffprobe')) ? join(LGPL, 'ffprobe') : 'ffprobe');

let dir: string;
let tiny: { path: string; sha256: string };

async function proc(
	input: string,
	steps: ProcessStep[],
	name: string,
	range?: { startFrame: number; endFrame: number },
) {
	const output = join(dir, `${name}.mov`);
	const events: ProcEvent[] = [];
	const res = await runProc(
		{
			input,
			output,
			steps,
			...(range ? { range } : {}),
			ffmpeg: FFMPEG,
			ffprobe: FFPROBE,
			models: { tiny: { path: tiny.path, sha256: tiny.sha256, scale: 2 } },
			threads: 4,
			device: 'cpu',
			scratch: join(dir, `scratch-${name}`),
			vidstabEngine: 'wasm',
		},
		{ emit: (e) => events.push(e), signal: new AbortController().signal, createStep: createStepImpl },
	);
	return { output, res, events };
}

function probe(file: string) {
	const r = spawnSync(FFPROBE, ['-v', 'error', '-count_packets', '-show_streams', '-of', 'json', file], {
		encoding: 'utf8',
	});
	return JSON.parse(r.stdout).streams as Array<Record<string, string | number>>;
}

function audioHash(file: string): string {
	const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'data', '-'], {
		maxBuffer: 256 * 1024 * 1024,
	});
	return createHash('sha256').update(r.stdout).digest('hex');
}

/** Grey frames (full range) of a file, optionally scaled. */
function grey(file: string, w: number, h: number, vf = ''): Uint8Array[] {
	const r = spawnSync(
		FFMPEG,
		[
			'-v',
			'error',
			'-i',
			file,
			'-vf',
			`${vf}${vf ? ',' : ''}scale=${w}:${h}:flags=area,format=gray`,
			'-f',
			'rawvideo',
			'-',
		],
		{ maxBuffer: 1024 * 1024 * 1024 },
	);
	const frames: Uint8Array[] = [];
	for (let o = 0; o + w * h <= r.stdout.length; o += w * h)
		frames.push(new Uint8Array(r.stdout.subarray(o, o + w * h)));
	return frames;
}

// ---------------------------------------------------------------- metrics

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array, inverse = false): void {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[re[i], re[j]] = [re[j], re[i]];
			[im[i], im[j]] = [im[j], im[i]];
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const ang = ((inverse ? 2 : -2) * Math.PI) / len;
		const wr = Math.cos(ang);
		const wi = Math.sin(ang);
		for (let i = 0; i < n; i += len) {
			let cr = 1;
			let ci = 0;
			for (let k = 0; k < len / 2; k++) {
				const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
				const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
				re[i + k + len / 2] = re[i + k] - ar;
				im[i + k + len / 2] = im[i + k] - ai;
				re[i + k] += ar;
				im[i + k] += ai;
				const t = cr * wr - ci * wi;
				ci = cr * wi + ci * wr;
				cr = t;
			}
		}
	}
}

function fft2(re: Float64Array, im: Float64Array, n: number, inverse = false): void {
	const rr = new Float64Array(n);
	const ri = new Float64Array(n);
	for (let y = 0; y < n; y++) {
		rr.set(re.subarray(y * n, y * n + n));
		ri.set(im.subarray(y * n, y * n + n));
		fft(rr, ri, inverse);
		re.set(rr, y * n);
		im.set(ri, y * n);
	}
	for (let x = 0; x < n; x++) {
		for (let y = 0; y < n; y++) {
			rr[y] = re[y * n + x];
			ri[y] = im[y * n + x];
		}
		fft(rr, ri, inverse);
		for (let y = 0; y < n; y++) {
			re[y * n + x] = rr[y];
			im[y * n + x] = ri[y];
		}
	}
}

/** Global translation between two frames by phase correlation on the centred n×n window (Hann). */
function phaseShift(a: Uint8Array, b: Uint8Array, w: number, h: number, n = 256): [number, number] {
	const x0 = (w - n) >> 1;
	const y0 = (h - n) >> 1;
	const ar = new Float64Array(n * n);
	const ai = new Float64Array(n * n);
	const br = new Float64Array(n * n);
	const bi = new Float64Array(n * n);
	for (let y = 0; y < n; y++)
		for (let x = 0; x < n; x++) {
			const win =
				(0.5 - 0.5 * Math.cos((2 * Math.PI * x) / n)) * (0.5 - 0.5 * Math.cos((2 * Math.PI * y) / n));
			ar[y * n + x] = a[(y0 + y) * w + x0 + x] * win;
			br[y * n + x] = b[(y0 + y) * w + x0 + x] * win;
		}
	fft2(ar, ai, n);
	fft2(br, bi, n);
	for (let i = 0; i < n * n; i++) {
		const r = ar[i] * br[i] + ai[i] * bi[i];
		const im = ai[i] * br[i] - ar[i] * bi[i];
		const m = Math.hypot(r, im) || 1;
		ar[i] = r / m;
		ai[i] = im / m;
	}
	fft2(ar, ai, n, true);
	let best = 0;
	let bx = 0;
	let by = 0;
	for (let y = 0; y < n; y++)
		for (let x = 0; x < n; x++)
			if (ar[y * n + x] > best) {
				best = ar[y * n + x];
				bx = x;
				by = y;
			}
	return [bx > n / 2 ? bx - n : bx, by > n / 2 ? by - n : by];
}

/** Variance of the per-pair global motion (x and y summed). */
function motionVariance(frames: Uint8Array[], w: number, h: number): number {
	const d: Array<[number, number]> = [];
	for (let i = 1; i < frames.length; i++) d.push(phaseShift(frames[i - 1], frames[i], w, h));
	const v = (k: 0 | 1) => {
		const m = d.reduce((s, x) => s + x[k], 0) / d.length;
		return d.reduce((s, x) => s + (x[k] - m) ** 2, 0) / d.length;
	};
	return v(0) + v(1);
}

/** Temporal noise sigma of a flat region: std of (frame − temporal mean) over the region. */
function noiseSigma(frames: Uint8Array[], w: number, rect: [number, number, number, number]): number {
	const [x0, y0, x1, y1] = rect;
	let s = 0;
	let n = 0;
	for (let y = y0; y < y1; y++)
		for (let x = x0; x < x1; x++) {
			let m = 0;
			for (const f of frames) m += f[y * w + x];
			m /= frames.length;
			for (const f of frames) {
				s += (f[y * w + x] - m) ** 2;
				n++;
			}
		}
	return Math.sqrt(s / n);
}

/** 8×8 blockiness: mean |gradient| across block boundaries over mean |gradient| inside blocks. */
function blockiness(frames: Uint8Array[], w: number, h: number): number {
	let edge = 0;
	let ne = 0;
	let inner = 0;
	let ni = 0;
	for (const f of frames)
		for (let y = 0; y < h; y++)
			for (let x = 1; x < w; x++) {
				const g = Math.abs(f[y * w + x] - f[y * w + x - 1]);
				if (x % 8 === 0) {
					edge += g;
					ne++;
				} else {
					inner += g;
					ni++;
				}
			}
	return edge / ne / (inner / ni);
}

beforeAll(() => {
	ensureFixtures();
	const need = ['shaky.mp4', 'judder.mp4', 'steady-pan.mp4', 'noisy.mkv', 'blocky.mp4'];
	if (!need.every((n) => existsSync(fixture(n)))) {
		const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-fixtures.mjs')], { stdio: 'inherit' });
		if (r.status !== 0) throw new Error('fixture generation failed');
	}
	dir = mkdtempSync(join(tmpdir(), 'jasper-proc-steps-'));
	const path = join(dir, 'tiny.onnx');
	tiny = { path, sha256: writeTinySrModel(path) };
}, 300_000);

afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('LGPL filters only (D-13)', () => {
	it('none of the GPL-only filters exists in the LGPL build; generated text is guarded', async () => {
		const filters = await listFilters(FFMPEG);
		if (FFMPEG.includes('ffmpeg-lgpl')) for (const f of GPL_FILTERS) expect(filters.has(f), f).toBe(false);
		for (const f of ['atadenoise', 'fftdnoiz', 'nlmeans', 'deblock', 'deshake', 'setparams'])
			expect(filters.has(f), f).toBe(true);
		expect(() => assertLgplFilters('scale=1:1,hqdn3d=1')).toThrow(/hqdn3d/);
		expect(() => assertLgplFilters('format=yuv444p,vidstabtransform=input=x')).toThrow();
		expect(() => assertLgplFilters('vidstabtransform=input=x', { allowVidstab: true })).not.toThrow();
	});
});

describe('every step keeps frame count, rate and audio (S07 §8 test 2)', () => {
	const src = () => fixture('clip-b.mp4');
	const cases: Array<[string, ProcessStep[]]> = [
		['deblock', [{ op: 'deblock', filter: 'strong' }]],
		['denoise-atadenoise', [{ op: 'denoise', method: 'atadenoise', strength: 0.5 }]],
		['denoise-fftdnoiz', [{ op: 'denoise', method: 'fftdnoiz', strength: 0.5 }]],
		['stabilize-vidstab', [{ op: 'stabilize', method: 'vidstab', smoothing: 15, borders: 'crop' }]],
		['stabilize-deshake', [{ op: 'stabilize', method: 'deshake', smoothing: 15, borders: 'crop' }]],
		['dejudder', [{ op: 'dejudder', mode: 'force' }]],
		['upscale', [{ op: 'upscale', model: 'tiny', scale: 2 }]],
		[
			'chain',
			[
				{ op: 'deblock', filter: 'weak' },
				{ op: 'stabilize', method: 'vidstab', smoothing: 10, borders: 'keep' },
				{ op: 'denoise', method: 'atadenoise', strength: 0.3 },
			],
		],
	];
	for (const [name, steps] of cases)
		it(name, async () => {
			const { output, res } = await proc(src(), steps, name);
			const [vin] = probe(src()).filter((s) => s.codec_type === 'video');
			const [vout] = probe(output).filter((s) => s.codec_type === 'video');
			expect(vout.nb_read_packets).toBe(vin.nb_read_packets);
			expect(res.frames).toBe(Number(vin.nb_read_packets));
			expect(vout.r_frame_rate).toBe(vin.r_frame_rate);
			expect(vout.codec_name).toBe('prores');
			expect(vout.color_space).toBe('bt709');
			const up = steps.some((s) => s.op === 'upscale');
			expect(Number(vout.width)).toBe(Number(vin.width) * (up ? 2 : 1));
			expect(audioHash(output)).toBe(audioHash(src()));
		}, 600_000);
});

describe('stabilise (S07 §8 test 3)', () => {
	const W = 480;
	const H = 270;
	let before = 0;
	beforeAll(() => {
		before = motionVariance(grey(fixture('shaky.mp4'), W, H), W, H);
	}, 120_000);

	it('vid.stab (WASM): motion variance drops ≥ 60 %', async () => {
		const { output, res } = await proc(
			fixture('shaky.mp4'),
			[{ op: 'stabilize', method: 'vidstab', smoothing: 15, borders: 'crop' }],
			'shaky-vidstab',
		);
		const after = motionVariance(grey(output, W, H), W, H);
		console.log(
			`[stabilise] vid.stab variance ${before.toFixed(2)} → ${after.toFixed(2)}`,
			res.sidecarData.steps[0].info,
		);
		expect(after).toBeLessThanOrEqual(before * 0.4);
	}, 600_000);

	it('deshake: motion variance drops ≥ 40 %', async () => {
		const { output } = await proc(
			fixture('shaky.mp4'),
			[{ op: 'stabilize', method: 'deshake', smoothing: 15, borders: 'crop' }],
			'shaky-deshake',
		);
		const after = motionVariance(grey(output, W, H), W, H);
		console.log(`[stabilise] deshake variance ${before.toFixed(2)} → ${after.toFixed(2)}`);
		expect(after).toBeLessThanOrEqual(before * 0.6);
	}, 600_000);
});

describe('de-judder (S07 §8 test 4)', () => {
	it('judder.mp4 is detected and evened out; steady-pan.mp4 is left unchanged', async () => {
		const { cadenceEvenness } = await import('../src/processing/proc/dejudder/cadence.ts');
		const { CvPool } = await import('../src/processing/proc/dejudder/pool.ts');
		const { measureMotion } = await import('../src/processing/proc/dejudder/cadence.ts');
		const pool = await CvPool.create(3);
		try {
			const spec = (file: string) => ({
				ffmpeg: FFMPEG,
				inputArgs: ['-i', file],
				frames: 60,
				width: 640,
				height: 360,
				fps: { num: 30, den: 1 },
			});
			const j = await proc(fixture('judder.mp4'), [{ op: 'dejudder', mode: 'auto' }], 'judder');
			const info = j.res.sidecarData.steps[0].info as { applied: boolean; consistency: number };
			expect(info.applied).toBe(true);
			expect(info.consistency).toBeGreaterThanOrEqual(0.8);
			const cvBefore = cadenceEvenness((await measureMotion(spec(fixture('judder.mp4')), pool)).motion).cv;
			const cvAfter = cadenceEvenness((await measureMotion(spec(j.output), pool)).motion).cv;
			console.log(`[dejudder] step CV ${cvBefore.toFixed(3)} → ${cvAfter.toFixed(3)}`);
			expect(cvAfter).toBeLessThanOrEqual(cvBefore * 0.5);
			const s = await proc(fixture('steady-pan.mp4'), [{ op: 'dejudder', mode: 'auto' }], 'steady');
			expect(s.res.notes.join()).toMatch(/no cadence found/);
			expect((s.res.sidecarData.steps[0].info as { applied: boolean }).applied).toBe(false);
		} finally {
			await pool.close();
		}
	}, 600_000);
});

describe('denoise and deblock (S07 §8 test 5)', () => {
	const W = 1280;
	const H = 720;
	it('noise sigma of a flat patch drops ≥ 40 % (medium) with every method', async () => {
		const rect: [number, number, number, number] = [760, 100, 1200, 300];
		const before = noiseSigma(grey(fixture('noisy.mkv'), W, H), W, rect);
		for (const method of ['atadenoise', 'fftdnoiz', 'nlmeans'] as const) {
			const { output } = await proc(
				fixture('noisy.mkv'),
				[{ op: 'denoise', method, strength: 0.5 }],
				`noisy-${method}`,
				{
					startFrame: 0,
					endFrame: method === 'nlmeans' ? 12 : 50,
				},
			);
			const after = noiseSigma(grey(output, W, H), W, rect);
			console.log(`[denoise] ${method} sigma ${before.toFixed(2)} → ${after.toFixed(2)}`);
			expect(after, method).toBeLessThanOrEqual(before * 0.6);
		}
	}, 900_000);

	it('deblock reduces 8x8 blockiness ≥ 25 %', async () => {
		const full = (f: string) => grey(f, 1280, 720);
		const before = blockiness(full(fixture('blocky.mp4')), 1280, 720) - 1;
		const { output } = await proc(fixture('blocky.mp4'), [{ op: 'deblock', filter: 'strong' }], 'blocky');
		const after = blockiness(full(output), 1280, 720) - 1;
		console.log(`[deblock] excess boundary gradient ${before.toFixed(3)} → ${after.toFixed(3)}`);
		expect(after).toBeLessThanOrEqual(before * 0.75);
	}, 600_000);
});

describe('upscale (S07 §8 test 6)', () => {
	it('tiles are seamless on a gradient and mix blends linearly', async () => {
		const m = await openOnnxModel(tiny.path, { threads: 2, device: 'cpu', scale: 2 });
		const w = 700;
		const h = 333;
		const src = new Float32Array(w * h * 3);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++)
				for (let c = 0; c < 3; c++)
					src[(y * w + x) * 3 + c] = (x / (w - 1)) * 0.6 + (y / (h - 1)) * 0.3 + c * 0.03;
		const out = await upscaleTiled(m, src, w, h);
		let seam = 0;
		for (let y = 0; y < 2 * h; y++)
			for (let x = 0; x < 2 * w; x++)
				for (let c = 0; c < 3; c++)
					seam = Math.max(
						seam,
						Math.abs(out[(y * 2 * w + x) * 3 + c] - src[((y >> 1) * w + (x >> 1)) * 3 + c]),
					);
		expect(seam).toBeLessThan(1 / 255);
		// mix: the step output is linear between the model result (mix 1) and the Lanczos upscale (mix 0).
		const ctx = {
			ffmpeg: FFMPEG,
			ffprobe: FFPROBE,
			threads: 2,
			device: 'cpu' as const,
			scratch: dir,
			width: 96,
			height: 64,
			frames: 1,
			fps: { num: 25, den: 1 },
			models: {},
			note: () => {},
			info: () => {},
			analysisProgress: () => {},
			signal: new AbortController().signal,
		};
		const frame = { index: 0, width: 96, height: 64, data: new Uint16Array(96 * 64 * 3) };
		for (let i = 0; i < frame.data.length; i++) frame.data[i] = (i * 7919) % 65536;
		const run = async (mix: number) => {
			const step = createUpscaleStep({ op: 'upscale', model: 'tiny', scale: 2, mix }, { model: m });
			await step.open(ctx);
			const [out] = await step.push({ ...frame, data: frame.data.slice() });
			return out.data;
		};
		const [o1, o0, oh] = [await run(1), await run(0), await run(0.5)];
		let err = 0;
		let diff = 0;
		for (let i = 0; i < o1.length; i++) {
			err = Math.max(err, Math.abs(oh[i] - (o1[i] + o0[i]) / 2));
			diff += Math.abs(o1[i] - o0[i]);
		}
		expect(diff / o1.length).toBeGreaterThan(100);
		// Lanczos overshoot is clamped per input; allow a couple of 16-bit codes for rounding.
		expect(err).toBeLessThanOrEqual(2);
		await m.release();
	}, 600_000);
});
