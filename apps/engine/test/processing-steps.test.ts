import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessStep } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { assertLgplFilters } from '../src/processing/proc/filters.ts';
import { runProc } from '../src/processing/proc/runner.ts';
import { createStepImpl } from '../src/processing/proc/steps.ts';
import { createUpscaleStep } from '../src/processing/proc/upscale.ts';
import { ensureFixtures, fixture, ROOT } from './fixtures.ts';
import { writeTinySrModel } from './tiny-model.ts';

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
	const controller = new AbortController();
	const running = runProc(
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
		{ emit: () => {}, signal: controller.signal, createStep: createStepImpl },
	);
	onTestFinished(async () => {
		// Vitest's timeout alone leaves the processing operation running.
		controller.abort();
		await Promise.allSettled([running]);
	});
	const res = await running;
	return { output, res };
}

function probe(file: string) {
	const r = spawnSync(FFPROBE, ['-v', 'error', '-count_packets', '-show_streams', '-of', 'json', file], {
		encoding: 'utf8',
	});
	if (r.status !== 0) throw new Error(r.stderr);
	return JSON.parse(r.stdout).streams as Array<Record<string, string | number>>;
}

function audioHash(file: string): string {
	const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'data', '-'], {
		maxBuffer: 256 * 1024 * 1024,
	});
	if (r.status !== 0) throw new Error(r.stderr.toString());
	if (!r.stdout.length) throw new Error(`No audio packets decoded from ${file}`);
	return createHash('sha256').update(r.stdout).digest('hex');
}

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
	if (r.status !== 0) throw new Error(r.stderr.toString());
	const frames: Uint8Array[] = [];
	for (let o = 0; o + w * h <= r.stdout.length; o += w * h)
		frames.push(new Uint8Array(r.stdout.subarray(o, o + w * h)));
	return frames;
}

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
	const need = ['shaky.mp4', 'judder.mp4', 'noisy.mkv', 'blocky.mp4'];
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
	it('rejects GPL-only filters and requires explicit approval for vidstab', () => {
		expect(() => assertLgplFilters('scale=1:1,hqdn3d=1')).toThrow(/hqdn3d/);
		expect(() => assertLgplFilters('format=yuv444p,vidstabtransform=input=x')).toThrow();
		expect(() => assertLgplFilters('vidstabtransform=input=x', { allowVidstab: true })).not.toThrow();
	});
});

describe('every step keeps frame count, rate and audio (S07 §8 test 2)', () => {
	let source: string;
	let vin: ReturnType<typeof probe>[number];
	let sourceAudioHash: string;
	beforeAll(() => {
		// Conservation needs multiple frames beyond the 9-frame temporal denoise window,
		// not six seconds of 720p inference. Keep the original AAC packets unchanged.
		source = join(dir, 'conservation.mp4');
		const made = spawnSync(FFMPEG, [
			'-v',
			'error',
			'-i',
			fixture('clip-b.mp4'),
			'-vf',
			'scale=320:180',
			'-frames:v',
			'18',
			'-t',
			'0.72',
			'-c:v',
			'mpeg4',
			'-q:v',
			'2',
			'-c:a',
			'copy',
			source,
		]);
		if (made.status !== 0) throw new Error(made.stderr.toString());
		vin = probe(source).find((s) => s.codec_type === 'video')!;
		if (Number(vin.nb_read_packets) !== 18 || vin.r_frame_rate !== '25/1')
			throw new Error('Invalid conservation fixture');
		sourceAudioHash = audioHash(source);
	});
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
			const { output, res } = await proc(source, steps, name);
			const [vout] = probe(output).filter((s) => s.codec_type === 'video');
			expect(vout.nb_read_packets).toBe(vin.nb_read_packets);
			expect(res.frames).toBe(Number(vin.nb_read_packets));
			expect(vout.r_frame_rate).toBe(vin.r_frame_rate);
			expect(vout.codec_name).toBe('prores');
			expect(vout.color_space).toBe('bt709');
			const up = steps.some((s) => s.op === 'upscale');
			expect(Number(vout.width)).toBe(Number(vin.width) * (up ? 2 : 1));
			expect(audioHash(output), 'original encoded audio packets').toBe(sourceAudioHash);
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
		const { output } = await proc(
			fixture('shaky.mp4'),
			[{ op: 'stabilize', method: 'vidstab', smoothing: 15, borders: 'crop' }],
			'shaky-vidstab',
		);
		const after = motionVariance(grey(output, W, H), W, H);
		expect(after).toBeLessThanOrEqual(before * 0.4);
	}, 600_000);

	it('deshake: motion variance drops ≥ 40 %', async () => {
		const { output } = await proc(
			fixture('shaky.mp4'),
			[{ op: 'stabilize', method: 'deshake', smoothing: 15, borders: 'crop' }],
			'shaky-deshake',
		);
		const after = motionVariance(grey(output, W, H), W, H);
		expect(after).toBeLessThanOrEqual(before * 0.6);
	}, 600_000);
});

describe('de-judder (S07 §8 test 4)', () => {
	it('reduces uneven frame-to-frame motion by at least 50%', async () => {
		const cv = (file: string) => {
			const frames = grey(file, 640, 360);
			const distances = frames
				.slice(1)
				.map((frame, i) => Math.hypot(...phaseShift(frames[i], frame, 640, 360)));
			const mean = distances.reduce((sum, d) => sum + d, 0) / distances.length;
			return Math.sqrt(distances.reduce((sum, d) => sum + (d - mean) ** 2, 0) / distances.length) / mean;
		};
		const before = cv(fixture('judder.mp4'));
		expect(before).toBeGreaterThan(0.1);
		const { output } = await proc(fixture('judder.mp4'), [{ op: 'dejudder', mode: 'auto' }], 'judder');
		expect(cv(output)).toBeLessThanOrEqual(before * 0.5);
	}, 600_000);
});

// A processed range needs one context frame on either side so boundary frames are retimed as in a whole-file run.
describe('de-judder of a range reads context frames (PST-013)', () => {
	it('ranges starting mid-motion retime their edge frames like the whole file does', async () => {
		const whole = await proc(fixture('judder.mp4'), [{ op: 'dejudder', mode: 'force' }], 'judder-whole');
		const W = 320;
		const H = 180;
		const ref = grey(whole.output, W, H);
		const src = grey(fixture('judder.mp4'), W, H);
		const mad = (a: Uint8Array, b: Uint8Array) => {
			let d = 0;
			for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!);
			return d / a.length;
		};
		let retimedEdges = 0;
		// Three offsets: the 3-frame cycle puts a frame that needs its outside neighbour at the edge of at least one.
		for (const start of [20, 21, 22]) {
			const end = start + 24;
			const r = await proc(fixture('judder.mp4'), [{ op: 'dejudder', mode: 'force' }], `judder-${start}`, {
				startFrame: start,
				endFrame: end,
			});
			const out = grey(r.output, W, H);
			expect(out).toHaveLength(24);
			for (const [i, abs] of [
				[0, start],
				[23, end - 1],
			] as const) {
				const vsWhole = mad(out[i]!, ref[abs]!);
				const vsSource = mad(src[abs]!, ref[abs]!);
				// Same as the whole-file output (ProRes noise only); the source frame differs where it was retimed.
				expect(vsWhole).toBeLessThan(1);
				if (vsSource > 2) {
					retimedEdges++;
					expect(vsWhole).toBeLessThan(vsSource / 3);
				}
			}
		}
		expect(retimedEdges).toBeGreaterThanOrEqual(1);
	}, 600_000);
});

describe('denoise and deblock (S07 §8 test 5)', () => {
	it('noise sigma of a flat patch drops ≥ 40 % (medium) with every method', async () => {
		// Preserve the original 440×200 measured patch and its noise bytes, with 64 px
		// of context on every side (beyond the spatial filters' support). Full-frame
		// dimensions/rate/audio remain independently checked by the conservation cases.
		const W = 568;
		const H = 328;
		const input = join(dir, 'noise-patch.mkv');
		const cropped = spawnSync(FFMPEG, [
			'-v',
			'error',
			'-i',
			fixture('noisy.mkv'),
			'-vf',
			'crop=568:328:696:36',
			'-c:v',
			'ffv1',
			'-level',
			'3',
			'-an',
			input,
		]);
		expect(cropped.status, cropped.stderr.toString()).toBe(0);
		const rect: [number, number, number, number] = [64, 64, 504, 264];
		const before = noiseSigma(grey(input, W, H), W, rect);
		expect(before).toBeGreaterThan(2);
		for (const method of ['atadenoise', 'fftdnoiz', 'nlmeans'] as const) {
			const { output } = await proc(input, [{ op: 'denoise', method, strength: 0.5 }], `noisy-${method}`, {
				startFrame: 0,
				endFrame: method === 'nlmeans' ? 12 : 50,
			});
			const after = noiseSigma(grey(output, W, H), W, rect);
			expect(after, method).toBeLessThanOrEqual(before * 0.6);
		}
	}, 900_000);

	it('deblock reduces 8x8 blockiness ≥ 25 %', async () => {
		const full = (f: string) => grey(f, 1280, 720);
		const before = blockiness(full(fixture('blocky.mp4')), 1280, 720) - 1;
		const { output } = await proc(fixture('blocky.mp4'), [{ op: 'deblock', filter: 'strong' }], 'blocky');
		const after = blockiness(full(output), 1280, 720) - 1;
		expect(after).toBeLessThanOrEqual(before * 0.75);
	}, 600_000);
});

describe('upscale (S07 §8 test 6)', () => {
	it('tiles are seamless on a gradient and mix blends linearly', async () => {
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
			models: { tiny },
			note: () => {},
			info: () => {},
			analysisProgress: () => {},
			signal: new AbortController().signal,
		};
		const run = async (mix: number, width: number, height: number, data: Uint16Array) => {
			const step = createUpscaleStep({ op: 'upscale', model: 'tiny', scale: 2, mix });
			try {
				await step.open({ ...ctx, width, height });
				const [out] = await step.push({ index: 0, width, height, data });
				return out.data;
			} finally {
				await step.close?.();
			}
		};
		// Large enough for the runtime's bounded-memory tiled path; the real ONNX model
		// specifies nearest-neighbour duplication, independently of the tile implementation.
		const w = 1200;
		const h = 1000;
		const gradient = new Uint16Array(w * h * 3);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++)
				for (let c = 0; c < 3; c++) gradient[(y * w + x) * 3 + c] = x * 30 + y * 15 + c * 1000;
		const tiled = await run(1, w, h, gradient);
		let seam = 0;
		for (let y = 0; y < 2 * h; y++)
			for (let x = 0; x < 2 * w; x++)
				for (let c = 0; c < 3; c++)
					seam = Math.max(
						seam,
						Math.abs(
							tiled[(y * 2 * w + x) * 3 + c] - gradient[(Math.floor(y / 2) * w + Math.floor(x / 2)) * 3 + c],
						),
					);
		expect(seam).toBeLessThanOrEqual(1);
		const data = new Uint16Array(96 * 64 * 3);
		for (let i = 0; i < data.length; i++) data[i] = (i * 7919) % 65536;
		const [o1, o0, oh] = [
			await run(1, 96, 64, data),
			await run(0, 96, 64, data),
			await run(0.5, 96, 64, data),
		];
		let err = 0;
		let diff = 0;
		for (let i = 0; i < o1.length; i++) {
			err = Math.max(err, Math.abs(oh[i] - (o1[i] + o0[i]) / 2));
			diff += Math.abs(o1[i] - o0[i]);
		}
		expect(diff / o1.length).toBeGreaterThan(100);
		// Lanczos overshoot is clamped per input; allow a couple of 16-bit codes for rounding.
		expect(err).toBeLessThanOrEqual(2);
	}, 600_000);
});
