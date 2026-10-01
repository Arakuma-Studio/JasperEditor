// De-judder step (S07:PST-010…014): cadence math, the auto/force decision, and the OpenCV.js flow-warp
// retiming on synthetic pans made with the LGPL ffmpeg (a 50 fps pan decimated 2-2-1 to 30 fps, and a steady
// 30 fps pan that must pass through untouched).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	analyseMotion,
	analysisSize,
	cadenceEvenness,
	localMean,
	measureMotion,
} from '../src/processing/proc/dejudder/cadence.ts';
import {
	ffv1Writer,
	fileSpec,
	makeStepContext,
	runFrameStep,
} from '../src/processing/proc/dejudder/harness.ts';
import { CvPool, resolveWorkerUrl } from '../src/processing/proc/dejudder/pool.ts';
import { createDejudderStep, decideDejudder, isCut } from '../src/processing/proc/dejudder/step.ts';
import { decodeFrames } from '../src/processing/proc/ffio.ts';
import type { RgbFrame } from '../src/processing/proc/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FFMPEG = join(
	ROOT,
	'vendor',
	'ffmpeg-lgpl',
	'linux-x64',
	process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
);
const HAVE_FFMPEG = process.platform === 'linux' && process.arch === 'x64' && existsSync(FFMPEG);

/** Motion of a 2-2-1 cadence: the step INTO frame n is short when n % 3 == shortPhase. */
function cadenceMotion(pairs: number, shortPhase: number, first = 0, long = 8, short = 4): number[] {
	return Array.from({ length: pairs }, (_, i) => ((first + i + 1) % 3 === shortPhase ? short : long));
}

describe('cadence analysis (PST-011, pure)', () => {
	it('3-tap moving mean with zero padding (np.convolve same)', () => {
		expect(localMean([3, 6, 9])).toEqual([3, 6, 5]);
	});

	it('finds the short phase, ratio and consistency of a 2-2-1 pattern', () => {
		for (const phase of [0, 1, 2]) {
			const r = analyseMotion(cadenceMotion(60, phase));
			expect(r.shortPhase).toBe(phase);
			expect(r.consistency).toBe(1);
			expect(r.shortToLongRatio).toBeCloseTo(0.5, 5); // relative steps 0.6 vs 1.2
			expect(r.pairs).toBe(60);
			expect(r.movingPairs).toBe(58); // first and last pair are never valid
			expect(r.triples).toBe(56);
			expect(r.meanMotionPx1080p).toBeCloseTo(((8 * 2 + 4) / 3) * (1920 / 424), 0);
		}
	});

	it('reports the phase in absolute frame indices when a sub-range is analysed', () => {
		// Absolute pattern: short step into frames with n % 3 == 2; the analysed input starts at frame 1000.
		const motion = cadenceMotion(45, 2, 1000);
		expect(analyseMotion(motion, { firstFrameIndex: 1000 }).shortPhase).toBe(2);
		// Relative to the input (first = 0) the same data has phase (2 - 1000) mod 3 = 1.
		expect(analyseMotion(motion).shortPhase).toBe(1);
	});

	it('static input: no phase, NaN ratio and consistency', () => {
		const r = analyseMotion(new Array(30).fill(0.1));
		expect(r.shortPhase).toBeNull();
		expect(r.movingPairs).toBe(0);
		expect(Number.isNaN(r.consistency)).toBe(true);
		expect(decideDejudder(r, 'force').apply).toBe(false);
	});

	it('scales the moving threshold with the proxy width', () => {
		const m = new Array(20).fill(0.3);
		expect(analyseMotion(m).movingPairs).toBe(0);
		expect(analyseMotion(m, { proxyWidth: 212 }).movingPairs).toBe(18);
	});

	it('evenness: CV of the relative steps and phase min/max', () => {
		const uneven = cadenceEvenness(cadenceMotion(60, 1));
		expect(uneven.cv).toBeGreaterThan(0.25);
		expect(uneven.minOverMax).toBeCloseTo(0.5, 5);
		const even = cadenceEvenness(new Array(60).fill(6.5));
		expect(even.cv).toBeCloseTo(0, 6);
		expect(even.minOverMax).toBeCloseTo(1, 6);
	});

	it('analysis proxy ≤ 424 px wide with even sizes', () => {
		expect(analysisSize(848, 480)).toEqual({ w: 424, h: 240 });
		expect(analysisSize(1920, 1080)).toEqual({ w: 424, h: 238 });
		expect(analysisSize(320, 240)).toEqual({ w: 320, h: 240 });
	});
});

describe('auto / force decision (PST-012)', () => {
	const base = analyseMotion(cadenceMotion(60, 0));
	it('applies a clear, moving cadence', () => {
		expect(decideDejudder(base, 'auto').apply).toBe(true);
	});
	it('rejects each failed threshold with a reason', () => {
		const lowCons = decideDejudder({ ...base, consistency: 0.7 }, 'auto');
		expect(lowCons).toMatchObject({ apply: false });
		expect(lowCons.reason).toMatch(/no cadence found.*consistency 70 %/);
		expect(decideDejudder({ ...base, shortToLongRatio: 0.85 }, 'auto').reason).toMatch(/short\/long 0.85/);
		expect(decideDejudder({ ...base, movingShare: 0.2 }, 'auto').reason).toMatch(/too little motion.*moving/);
		expect(decideDejudder({ ...base, meanMotionPx1080p: 3 }, 'auto').reason).toMatch(/mean motion 3.0/);
		expect(decideDejudder({ ...base, meanMotionPx1080p: 3, consistency: 0.5 }, 'force').apply).toBe(true);
	});
});

describe('scene-cut guard', () => {
	const frame = (v: number): RgbFrame => ({
		index: 0,
		width: 16,
		height: 16,
		data: new Uint16Array(16 * 16 * 3).fill(v),
	});
	it('trips above a mean absolute difference of 0.10', () => {
		expect(isCut(frame(0), frame(Math.round(0.09 * 65535)))).toBe(false);
		expect(isCut(frame(0), frame(Math.round(0.11 * 65535)))).toBe(true);
	});
	it('a fast pan over fine texture is not a cut; a different picture is', () => {
		// 1-px random texture (mean |Δ| of point samples between shifted copies ≈ 0.33).
		let s = 7;
		const rnd = () => {
			s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
			return s / 2 ** 32;
		};
		const W = 256;
		const tex = Float64Array.from({ length: (W + 16) * W }, rnd);
		const view = (dx: number, gain = 1): RgbFrame => {
			const data = new Uint16Array(W * W * 3);
			for (let y = 0; y < W; y++)
				for (let x = 0; x < W; x++)
					data.fill(
						Math.round(tex[y * (W + 16) + x + dx] * gain * 65535),
						(y * W + x) * 3,
						(y * W + x) * 3 + 3,
					);
			return { index: 0, width: W, height: W, data };
		};
		expect(isCut(view(0), view(12))).toBe(false);
		// A different shot: the dark half-gain texture against a bright flat frame.
		const bright: RgbFrame = { index: 0, width: W, height: W, data: new Uint16Array(W * W * 3).fill(60000) };
		expect(isCut(view(0, 0.5), bright)).toBe(true);
	});
});

describe('worker script resolution', () => {
	it('honours the env override and resolves the source worker by default', () => {
		expect(resolveWorkerUrl({ JASPER_DEJUDDER_WORKER: '/opt/x/w.mjs' }).pathname).toBe('/opt/x/w.mjs');
		expect(resolveWorkerUrl({}).pathname.endsWith('/dejudder/worker.mjs')).toBe(true);
	});
});

describe.skipIf(!HAVE_FFMPEG)('flow-warp retiming on synthetic pans (PST-013/014)', () => {
	const W = 640;
	const H = 360;
	const N = 45;
	let dir = '';
	let decimated = '';
	let steady = '';
	let pool: CvPool;

	const ff = (args: string[]) => {
		const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
		if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
	};

	const motionOf = async (file: string) =>
		(await measureMotion(fileSpec(FFMPEG, file, N, W, H), pool)).motion;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'jasper-dejudder-'));
		const still = join(dir, 'still.png');
		// A wide still with smooth two-octave noise texture (bicubic-upscaled frozen noise at 8× and 2×) that
		// the pans crop from. Pixel-level noise or flat test bars defeat Farnebäck at 8 px/frame.
		const octave = (w: number, h: number, tag: string) =>
			`color=gray:s=${w}x${h},noise=alls=100:allf=u,scale=2400:360:flags=bicubic[${tag}]`;
		ff([
			'-f',
			'lavfi',
			'-i',
			`${octave(300, 45, 'a')};${octave(1200, 180, 'b')};[a][b]blend=all_mode=average`,
			'-frames:v',
			'1',
			still,
		]);
		decimated = join(dir, 'decimated.mkv');
		// 50 fps pan at 6 px/frame, decimated to 30 fps keeping source frames 0,2,4,5,7,9,… (steps 2-2-1).
		ff([
			'-loop',
			'1',
			'-framerate',
			'50',
			'-i',
			still,
			'-vf',
			`crop=${W}:${H}:'n*6':0,select='eq(mod(n\\,5)\\,0)+eq(mod(n\\,5)\\,2)+eq(mod(n\\,5)\\,4)',setpts=N/(30*TB)`,
			'-r',
			'30',
			'-frames:v',
			String(N),
			'-c:v',
			'ffv1',
			'-pix_fmt',
			'gbrp',
			decimated,
		]);
		steady = join(dir, 'steady.mkv');
		ff([
			'-loop',
			'1',
			'-framerate',
			'30',
			'-i',
			still,
			'-vf',
			`crop=${W}:${H}:'n*10':0`,
			'-frames:v',
			String(N),
			'-c:v',
			'ffv1',
			'-pix_fmt',
			'gbrp',
			steady,
		]);
		pool = await CvPool.create(3);
	}, 60_000);

	afterAll(async () => {
		await pool?.close();
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it('detects the 2-2-1 cadence and evens it out, frame count preserved', async () => {
		const spec = fileSpec(FFMPEG, decimated, N, W, H);
		const ctx = makeStepContext(spec, { threads: 3 });
		const step = createDejudderStep({ op: 'dejudder', mode: 'auto' });
		const out = join(dir, 'out.mkv');
		const writer = ffv1Writer(FFMPEG, out, W, H, spec.fps);
		const t0 = performance.now();
		const r = await runFrameStep(step, spec, ctx, (f) =>
			writer.write(new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength)),
		);
		const elapsed = performance.now() - t0;
		await writer.close();

		expect(r.inputFrames).toBe(N);
		expect(r.outputFrames).toBe(N);
		expect(step.cadence!.consistency).toBeGreaterThanOrEqual(0.8);
		expect(step.cadence!.shortToLongRatio).toBeLessThan(0.8);
		expect(step.decision!.apply).toBe(true);
		expect(ctx.facts.applied).toBe(true);
		expect(ctx.facts.interpolated).toBeGreaterThanOrEqual(28);
		expect(ctx.facts.copied).toBe(15);
		expect(ctx.notes[0]).toMatch(/uneven cadence found/);

		const before = cadenceEvenness(await motionOf(decimated));
		const after = cadenceEvenness(await motionOf(out));
		console.log(
			`dejudder synthetic: cv ${before.cv.toFixed(3)} → ${after.cv.toFixed(3)}, phase min/max ${before.minOverMax.toFixed(2)} → ${after.minOverMax.toFixed(2)}, ${(elapsed / N).toFixed(0)} ms/frame wall`,
		);
		expect(after.cv).toBeLessThanOrEqual(before.cv * 0.5);
		expect(after.minOverMax).toBeGreaterThan(0.85);
	}, 60_000);

	it('leaves a steady 30 fps pan untouched in auto mode', async () => {
		const spec = fileSpec(FFMPEG, steady, N, W, H);
		const ctx = makeStepContext(spec, { threads: 2 });
		const step = createDejudderStep({ op: 'dejudder', mode: 'auto' });
		const r = await runFrameStep(step, spec, ctx);
		expect(r.outputFrames).toBe(N);
		expect(step.decision!.apply).toBe(false);
		expect(ctx.notes.join('\n')).toMatch(/no cadence found/);
		expect(ctx.facts.applied).toBe(false);
		let i = 0;
		for await (const buf of decodeFrames(spec, { pixFmt: 'rgb48le' })) {
			expect(
				Buffer.compare(
					Buffer.from(r.frames[i].data.buffer, r.frames[i].data.byteOffset, r.frames[i].data.byteLength),
					buf,
				),
			).toBe(0);
			i++;
		}
		expect(i).toBe(N);
	}, 60_000);

	it('force mode retimes the steady pan too, and copies frames whose neighbour is missing', async () => {
		const spec = fileSpec(FFMPEG, steady, 7, W, H);
		const ctx = makeStepContext(spec, { threads: 2 });
		const step = createDejudderStep({ op: 'dejudder', mode: 'force' });
		const r = await runFrameStep(step, spec, ctx);
		expect(r.outputFrames).toBe(7);
		expect(step.decision!.apply).toBe(true);
		const s = step.stats;
		expect(s.copied + s.interpolated + s.cutGuard + s.edge).toBe(7);
		expect(s.cutGuard).toBe(0);
	}, 60_000);
});
