// Smooth-path stabiliser (S07:PST-005): the pure math (similarity fit, RANSAC with a moving subject, Gaussian /
// straight-line path smoothing, the static zoom and its cap, the fallback to the largest smoothing that fits,
// the conversion to the shared vid.stab warp kernel) and, with the LGPL FFmpeg, the whole step on
// `reframe.mp4` (a jerky operator reframe + a subject crossing the frame on its own).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessStep } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProc } from '../src/processing/proc/runner.ts';
import {
	backwardToVsTransform,
	bordersHidden,
	cameraPath,
	corrections,
	fitSimilarity,
	gaussSmooth,
	lineFit,
	type Mat3,
	minimalZoom,
	planSegmentedSmoothPath,
	planSmoothPath,
	ransacSimilarity,
	type Similarity,
	smoothCameraPath,
} from '../src/processing/proc/smoothpath/math.ts';
import { createStepImpl } from '../src/processing/proc/steps.ts';
import type { ProcEvent } from '../src/processing/proc/types.ts';
import { backwardAffine, sourcePoint } from '../src/processing/proc/vidstab/math.ts';
import { fixture, ROOT } from './helpers.ts';

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

const apply = (s: Similarity, x: number, y: number): [number, number] => [
	s.a * x - s.b * y + s.tx,
	s.b * x + s.a * y + s.ty,
];

const sim = (angle: number, scale: number, tx: number, ty: number): Similarity => ({
	a: Math.cos(angle) * scale,
	b: Math.sin(angle) * scale,
	tx,
	ty,
});

describe('similarity fit', () => {
	it('recovers an exact similarity by least squares', () => {
		const truth = sim(0.03, 1.02, 5.5, -3.25);
		const src: number[] = [];
		const dst: number[] = [];
		const r = rng(1);
		for (let i = 0; i < 50; i++) {
			const x = r() * 848;
			const y = r() * 480;
			src.push(x, y);
			dst.push(...apply(truth, x, y));
		}
		const s = fitSimilarity(src, dst)!;
		expect(s.a).toBeCloseTo(truth.a, 9);
		expect(s.b).toBeCloseTo(truth.b, 9);
		expect(s.tx).toBeCloseTo(truth.tx, 6);
		expect(s.ty).toBeCloseTo(truth.ty, 6);
		expect(fitSimilarity([1, 1], [2, 2])).toBeNull();
	});

	it('RANSAC follows the background and ignores a moving subject (40 % of the points)', () => {
		const camera = sim(-0.004, 1, -12.3, 1.7);
		const subject = sim(0, 1, 9, 0);
		const r = rng(7);
		const src: number[] = [];
		const dst: number[] = [];
		for (let i = 0; i < 600; i++) {
			const x = r() * 848;
			const y = r() * 480;
			const onSubject = i % 5 < 2;
			const [u, v] = apply(onSubject ? subject : camera, x, y);
			// tracking noise ±0.2 px
			src.push(x, y);
			dst.push(u + (r() - 0.5) * 0.4, v + (r() - 0.5) * 0.4);
		}
		const fit = ransacSimilarity(src, dst, { threshold: 1.5 })!;
		expect(fit.inliers).toBeGreaterThanOrEqual(340);
		expect(fit.inliers).toBeLessThanOrEqual(365);
		const [cx, cy] = apply(fit.sim, 424, 240);
		const [tx, ty] = apply(camera, 424, 240);
		expect(Math.hypot(cx - tx, cy - ty)).toBeLessThan(0.05);
		// deterministic
		const again = ransacSimilarity(src, dst, { threshold: 1.5 })!;
		expect(again.sim).toEqual(fit.sim);
		expect(ransacSimilarity([1, 2], [3, 4])).toBeNull();
	});
});

describe('path smoothing', () => {
	it('gaussSmooth keeps constants and holds the edges; sigma 0 copies', () => {
		const c = gaussSmooth([5, 5, 5, 5, 5], 3);
		for (const v of c) expect(v).toBeCloseTo(5, 12);
		const step = Array.from({ length: 41 }, (_, i) => (i < 20 ? 0 : 10));
		const s = gaussSmooth(step, 4);
		expect(s[0]).toBeCloseTo(0, 3);
		expect(s[40]).toBeCloseTo(10, 3);
		expect(s[20]).toBeGreaterThan(4);
		expect(s[20]).toBeLessThan(6);
		for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThanOrEqual(s[i - 1] - 1e-12);
		expect(Array.from(gaussSmooth([1, 2, 3], 0))).toEqual([1, 2, 3]);
	});

	it('lineFit is the least-squares line', () => {
		const l = lineFit([1, 3, 2, 4]);
		// slope 0.8, intercept 1.3
		expect(Array.from(l).map((v) => Number(v.toFixed(6)))).toEqual([1.3, 2.1, 2.9, 3.7]);
		expect(Array.from(lineFit([7]))).toEqual([7]);
	});

	it('cameraPath accumulates frame-to-frame motion about the centre', () => {
		const pairs = [sim(0, 1, -4, 1), sim(0, 1, -6, -1), sim(0.01, 1, 0, 0)];
		const p = cameraPath(pairs, 848, 480);
		expect(p.tx[0]).toBe(0);
		expect(p.tx[2]).toBeCloseTo(-10, 9);
		expect(p.ty[2]).toBeCloseTo(0, 9);
		expect(p.angle[3]).toBeCloseTo(0.01, 9);
		expect(p.scale[3]).toBeCloseTo(1, 9);
	});

	it('corrections map the actual camera onto the smoothed one (identity for an already smooth path)', () => {
		const pairs = Array.from({ length: 30 }, () => sim(0, 1, -2, 0));
		const p = cameraPath(pairs, 640, 360);
		// a linear pan is its own straight line: locking y / roll and smoothing x leaves the middle untouched
		const s = smoothCameraPath(p, { sigma: 2, lockVertical: true, lockRotation: true });
		const k = corrections(p, s);
		for (const i of [10, 15, 20]) {
			expect(k[i][2]).toBeCloseTo(0, 6);
			expect(k[i][5]).toBeCloseTo(0, 6);
		}
	});
});

describe('zoom and plan', () => {
	const W = 848;
	const H = 480;
	/** A still shot with one jerky 120 px reframe over frames 20…35 and a 6 px vertical bump. */
	const jerk = (): Similarity[] => {
		const xs: number[] = [];
		const ys: number[] = [];
		for (let i = 0; i < 90; i++) {
			const u = Math.min(1, Math.max(0, (i - 20) / 15));
			xs.push(120 * u * u * (3 - 2 * u) + (i > 20 && i < 35 ? (i % 2 ? 2 : -2) : 0));
			ys.push(6 * Math.sin(Math.PI * u));
		}
		return xs.slice(1).map((x, i) => sim(0, 1, -(x - xs[i]), -(ys[i + 1] - ys[i])));
	};

	it('bordersHidden / minimalZoom find the smallest zoom, never above the cap', () => {
		const shift: Mat3 = [1, 0, 10, 0, 1, 0, 0, 0, 1];
		expect(bordersHidden([shift], 1, W, H)).toBe(false);
		const z = minimalZoom([shift], W, H, 1.2);
		// a 10 px shift needs 424 / (424 − 10 − 0.5) (half a pixel of margin), + 0.2 %
		const exact = W / 2 / (W / 2 - 10 - 0.5);
		expect(z.zoom!).toBeGreaterThan(exact);
		expect(z.zoom!).toBeLessThan(exact * 1.0025);
		expect(bordersHidden([shift], z.zoom!, W, H)).toBe(true);
		expect(minimalZoom([shift], W, H, 1.01)).toEqual({ zoom: null, needed: expect.any(Number) });
		expect(minimalZoom([shift], W, H, exact + 1e-4).zoom!).toBeLessThanOrEqual(exact + 1e-4);
	});

	it('smooths a jerky reframe into an even move within the zoom cap', () => {
		const plan = planSmoothPath(jerk(), W, H, {
			sigma: 20,
			lockVertical: true,
			lockRotation: true,
			maxZoom: 1.2,
			borders: 'crop',
		});
		expect(plan.fallback).toBeNull();
		expect(plan.zoom).toBeGreaterThan(1);
		expect(plan.zoom).toBeLessThanOrEqual(1.2);
		expect(plan.stats.travelPx[0]).toBeCloseTo(-120, 6);
		expect(plan.stats.rawSpeedMax1080).toBeGreaterThan(30);
		expect(plan.stats.smoothedSpeedMax1080).toBeLessThan(plan.stats.rawSpeedMax1080 / 3);
		expect(plan.backward).toHaveLength(90);
	});

	it('falls back to the largest smoothing that fits when the cap is too small, and says so', () => {
		const plan = planSmoothPath(jerk(), W, H, {
			sigma: 40,
			lockVertical: false,
			lockRotation: false,
			maxZoom: 1.05,
			borders: 'crop',
		});
		expect(plan.fallback).not.toBeNull();
		expect(plan.fallback!.requestedSigma).toBe(40);
		expect(plan.fallback!.neededZoom).toBeGreaterThan(1.05);
		expect(plan.sigma).toBeGreaterThan(0);
		expect(plan.sigma).toBeLessThan(40);
		expect(plan.zoom).toBeLessThanOrEqual(1.05);
		// a slightly larger sigma would not fit
		const more = planSmoothPath(jerk(), W, H, {
			sigma: plan.sigma * 1.1,
			lockVertical: false,
			lockRotation: false,
			maxZoom: 1.05,
			borders: 'crop',
		});
		expect(more.fallback).not.toBeNull();
	});

	it('releases the locks only when even a tiny smoothing with them needs more than the cap', () => {
		// a steady 3 px/frame tilt: a vertical line lock is the path itself (fits); a 2-frame wobble around it
		// makes the locked line need more than a 1 % zoom
		const pairs = Array.from({ length: 60 }, (_, i) => sim(0, 1, 0, i % 20 < 10 ? -8 : 8));
		const plan = planSmoothPath(pairs, W, H, {
			sigma: 10,
			lockVertical: true,
			lockRotation: false,
			maxZoom: 1.01,
			borders: 'crop',
		});
		expect(plan.fallback?.locksReleased).toBe(true);
		expect(plan.lockVertical).toBe(false);
		expect(plan.zoom).toBeLessThanOrEqual(1.01);
	});

	it('a cut splits the shot: each segment gets its own path and zoom (a jump across the cut would not fit)', () => {
		const a = jerk();
		// second shot: a slow 0.5 px/frame drift; between them a "pair" that is really a cut (400 px jump)
		const b = Array.from({ length: 59 }, () => sim(0, 1, -0.5, 0));
		const pairs = [...a.slice(0, 44), sim(0, 1, -400, 0), ...b];
		const o = { sigma: 20, lockVertical: true, lockRotation: true, maxZoom: 1.2, borders: 'crop' as const };
		const whole = planSmoothPath(pairs, W, H, o);
		expect(whole.fallback).not.toBeNull(); // treating the cut as camera motion needs far more zoom
		const seg = planSegmentedSmoothPath(pairs, new Set([44]), W, H, o);
		expect(seg.segments.map((s) => [s.firstFrame, s.stats.frames])).toEqual([
			[0, 45],
			[45, 60],
		]);
		expect(seg.backward).toHaveLength(pairs.length + 1);
		expect(seg.segments.every((s) => s.fallback === null)).toBe(true);
		expect(seg.segments[1]!.zoom).toBeLessThan(seg.segments[0]!.zoom); // own zoom per shot
		expect(seg.zoom).toBe(seg.segments[0]!.zoom);
		expect(seg.segments[1]!.stats.travelPx[0]).toBeCloseTo(-29.5, 6);
		// the cut pair is not a camera move: the second shot starts on its own path
		expect(seg.stats.rawSpeedMax1080).toBeLessThan(400);
		expect(planSegmentedSmoothPath(pairs, new Set(), W, H, o).segments).toHaveLength(1);
	});

	it("borders 'keep' never zooms", () => {
		const plan = planSmoothPath(jerk(), W, H, {
			sigma: 30,
			lockVertical: true,
			lockRotation: true,
			maxZoom: 1.01,
			borders: 'keep',
		});
		expect(plan.zoom).toBe(1);
		expect(plan.fallback).toBeNull();
		expect(plan.sigma).toBe(30);
	});

	it('backward maps convert exactly to the vid.stab warp transform', () => {
		for (const [w, h] of [
			[848, 480],
			[1921, 1081],
		]) {
			const fwd = sim(0.02, 1.11, 7.5, -4.25);
			const det = fwd.a * fwd.a + fwd.b * fwd.b;
			// inverse similarity
			const ia = fwd.a / det;
			const ib = -fwd.b / det;
			const back = [ia, -ib, -(ia * fwd.tx + ib * fwd.ty), ib, ia, -(-ib * fwd.tx + ia * fwd.ty)];
			const t = backwardToVsTransform(back, w, h);
			const m = backwardAffine(t, w, h);
			for (let i = 0; i < 6; i++) expect(m[i]).toBeCloseTo(back[i], 9);
			const [sx, sy] = sourcePoint(t, w, h, 100, 50);
			expect(sx).toBeCloseTo(back[0] * 100 + back[1] * 50 + back[2], 9);
			expect(sy).toBeCloseTo(back[3] * 100 + back[4] * 50 + back[5], 9);
		}
	});
});

// ---------------------------------------------------------------- the whole step (LGPL FFmpeg)

const LGPL = join(ROOT, 'vendor', 'ffmpeg-lgpl', `${process.platform}-${process.arch}`);
const FFMPEG =
	process.env.JASPER_FFMPEG ?? (existsSync(join(LGPL, 'ffmpeg')) ? join(LGPL, 'ffmpeg') : 'ffmpeg');
const FFPROBE =
	process.env.JASPER_FFPROBE ?? (existsSync(join(LGPL, 'ffprobe')) ? join(LGPL, 'ffprobe') : 'ffprobe');

/** Ground truth of reframe.mp4 (scripts/fixtures/process.mjs `reframePath`). */
async function truth(): Promise<{ xs: number[]; ys: number[] }> {
	const m = (await import(join(ROOT, 'scripts', 'fixtures', 'process.mjs'))) as {
		reframePath(n: number): { xs: number[]; ys: number[] };
	};
	return m.reframePath(90);
}

/** Per-pair global x motion of a file by integer phase correlation of the grey frames' column means. */
function columnShifts(file: string): number[] {
	const w = 848;
	const h = 480;
	const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', 'format=gray', '-f', 'rawvideo', '-'], {
		maxBuffer: 512 * 1024 * 1024,
	});
	const frames: Float64Array[] = [];
	for (let o = 0; o + w * h <= r.stdout.length; o += w * h) {
		// column profile of the top band (rows 0…140: above the crossing subject)
		const col = new Float64Array(w);
		for (let y = 0; y < 140; y++) for (let x = 0; x < w; x++) col[x] += r.stdout[o + y * w + x];
		frames.push(col);
	}
	const out: number[] = [];
	for (let i = 1; i < frames.length; i++) {
		const a = frames[i - 1];
		const b = frames[i];
		let best = Number.POSITIVE_INFINITY;
		let arg = 0;
		for (let d = -40; d <= 40; d++) {
			let s = 0;
			let n = 0;
			for (let x = 60; x < w - 60; x++) {
				s += Math.abs(a[x] - b[x + d]);
				n++;
			}
			if (s / n < best) {
				best = s / n;
				arg = d;
			}
		}
		out.push(-arg);
	}
	return out;
}

describe('smooth path on reframe.mp4 (jerky reframe + independent subject)', () => {
	let dir: string;
	beforeAll(() => {
		if (!existsSync(fixture('reframe.mp4'))) {
			const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-fixtures.mjs')], {
				stdio: 'inherit',
			});
			if (r.status !== 0) throw new Error('fixture generation failed');
		}
		dir = mkdtempSync(join(tmpdir(), 'jasper-smoothpath-'));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const run = async (name: string, step: ProcessStep, input = fixture('reframe.mp4')) => {
		const output = join(dir, `${name}.mov`);
		const scratch = join(dir, `scratch-${name}`);
		mkdirSync(scratch, { recursive: true });
		const events: ProcEvent[] = [];
		const res = await runProc(
			{
				input,
				output,
				steps: [step],
				ffmpeg: FFMPEG,
				ffprobe: FFPROBE,
				models: {},
				threads: 4,
				device: 'cpu',
				scratch,
			},
			{ emit: (e) => events.push(e), signal: new AbortController().signal, createStep: createStepImpl },
		);
		const notes = events.flatMap((e) => (e.event === 'note' ? [e.message] : []));
		return { output, res, info: res.sidecarData.steps[0].info as Record<string, any>, notes };
	};

	it('tracks the background (not the subject), evens out the reframe within the zoom cap', async () => {
		const t = await truth();
		const { output, res, info, notes } = await run('rf', {
			op: 'stabilize',
			method: 'smoothpath',
			smoothing: 12,
			borders: 'crop',
			lockVertical: true,
			lockRotation: true,
			maxZoom: 115,
		});
		expect(res.frames).toBe(90);
		console.log('[smoothpath] reframe.mp4', JSON.stringify(info), notes);
		// camera travel = the fixture's crop path (content moves the other way), the subject ignored
		const D = t.xs[89] - t.xs[0];
		expect(info.camera.travelPx[0]).toBeGreaterThan(-D - 1.5);
		expect(info.camera.travelPx[0]).toBeLessThan(-D + 1.5);
		expect(Math.abs(info.camera.travelPx[1])).toBeLessThan(1);
		expect(info.tracking.failedPairs).toBe(0);
		expect(info.fallback).toBeNull();
		expect(info.zoomPercent).toBeGreaterThan(100);
		expect(info.zoomPercent).toBeLessThanOrEqual(115);
		expect(info.speed.smoothedMaxPxPerFrame1080).toBeLessThan(info.speed.rawMaxPxPerFrame1080 / 2.5);
		expect(
			notes.some((n) => /smooth path\): zoom [\d.]+ %, camera speed max [\d.]+ → [\d.]+ px\/frame/.test(n)),
		).toBe(true);
		// independent measurement on the output: the peak frame-to-frame motion drops, no frame jerks back
		const before = columnShifts(fixture('reframe.mp4'));
		const after = columnShifts(output);
		const peak = (a: number[]) => Math.max(...a.map(Math.abs));
		const jerkiness = (a: number[]) => Math.max(...a.slice(1).map((v, i) => Math.abs(v - a[i])));
		console.log(
			`[smoothpath] peak ${peak(before)} → ${peak(after)} px/frame, jerk ${jerkiness(before)} → ${jerkiness(after)}`,
		);
		expect(peak(after)).toBeLessThanOrEqual(peak(before) / 2);
		expect(jerkiness(after)).toBeLessThanOrEqual(2);
	}, 600_000);

	it('explains and falls back when the cap is too small', async () => {
		const { info, notes } = await run('rf-cap', {
			op: 'stabilize',
			method: 'smoothpath',
			smoothing: 60,
			borders: 'crop',
			maxZoom: 104,
		});
		expect(info.fallback).not.toBeNull();
		expect(info.used.sigma).toBeLessThan(60);
		expect(info.zoomPercent).toBeLessThanOrEqual(104);
		expect(notes.some((n) => /above the 104\.0 % cap — used the largest smoothing that fits/.test(n))).toBe(
			true,
		);
	}, 600_000);

	it('warps the same with the vid.stab WASM kernel and the OpenCV.js fallback', async () => {
		const step: ProcessStep = {
			op: 'stabilize',
			method: 'smoothpath',
			smoothing: 12,
			borders: 'crop',
			maxZoom: 115,
		};
		const saved = process.env.JASPER_SMOOTHPATH_WARP;
		try {
			process.env.JASPER_SMOOTHPATH_WARP = 'wasm';
			const w = await run('rf-wasm', step);
			process.env.JASPER_SMOOTHPATH_WARP = 'opencv';
			const c = await run('rf-opencv', step);
			expect(w.info.warp.engine).toBe('wasm');
			expect(c.info.warp.engine).toBe('opencv');
			expect(c.res.frames).toBe(90);
			expect(c.info.zoomPercent).toBe(w.info.zoomPercent);
			// same geometry: the two bicubic kernels (Catmull-Rom vs OpenCV a = −0.75) differ only in fine detail
			const psnr = spawnSync(
				FFMPEG,
				['-v', 'info', '-i', w.output, '-i', c.output, '-lavfi', '[0:v][1:v]psnr', '-f', 'null', '-'],
				{ encoding: 'utf8' },
			);
			const avg = Number(/PSNR .*average:([\d.]+|inf)/.exec(psnr.stderr)?.[1]);
			console.log(`[smoothpath] wasm vs opencv warp PSNR ${avg} dB`);
			expect(avg).toBeGreaterThan(38);
			// and the stabilisation itself is as good with either
			const peak = (a: number[]) => Math.max(...a.map(Math.abs));
			expect(peak(columnShifts(c.output))).toBeLessThanOrEqual(peak(columnShifts(w.output)) + 1);
		} finally {
			if (saved === undefined) delete process.env.JASPER_SMOOTHPATH_WARP;
			else process.env.JASPER_SMOOTHPATH_WARP = saved;
		}
	}, 900_000);

	it('a shot with a cut is stabilised per segment (own path and zoom), the cut found by the de-judder guard', async () => {
		const t = await truth();
		// frames 0–44 of reframe.mp4, then a different shot: frames 45–89 mirrored and inverted
		const cutInput = join(dir, 'cut.mkv');
		const r = spawnSync(FFMPEG, [
			...['-v', 'error', '-y', '-i', fixture('reframe.mp4'), '-filter_complex'],
			'[0:v]split[a][b];[a]trim=end_frame=45,setpts=PTS-STARTPTS[a1];[b]trim=start_frame=45,setpts=PTS-STARTPTS,hflip,negate[b1];[a1][b1]concat=n=2:v=1[v]',
			...['-map', '[v]', '-c:v', 'ffv1', '-pix_fmt', 'yuv420p', cutInput],
		]);
		expect(r.status, r.stderr?.toString()).toBe(0);
		const { info, notes, res } = await run(
			'rf-cut',
			{
				op: 'stabilize',
				method: 'smoothpath',
				smoothing: 12,
				borders: 'crop',
				lockVertical: true,
				maxZoom: 120,
			},
			cutInput,
		);
		expect(res.frames).toBe(90);
		console.log('[smoothpath] cut', JSON.stringify(info.segments), notes);
		expect(info.cuts).toEqual([45]);
		expect(
			info.segments.map((s: { firstFrame: number; frames: number }) => [s.firstFrame, s.frames]),
		).toEqual([
			[0, 45],
			[45, 45],
		]);
		// each shot's own camera travel (the second one is mirrored: it moves the other way)
		const [s1, s2] = info.segments;
		expect(Math.abs(s1.travelPx[0] + (t.xs[44] - t.xs[0]))).toBeLessThan(1.5);
		expect(Math.abs(s2.travelPx[0] - (t.xs[89] - t.xs[45]))).toBeLessThan(1.5);
		expect(s1.zoomPercent).not.toBe(s2.zoomPercent);
		for (const s of info.segments) expect(s.zoomPercent).toBeLessThanOrEqual(120);
		expect(notes.some((n) => /2 shots \(cut at frame 45\) stabilised separately/.test(n))).toBe(true);
	}, 900_000);
});

// Real footage (read-only, outside the repo; skipped where it is not present): the cut decision on crudo.mp4.
const CRUDO = '/var/lib/orquester/workspaces/jaspersito/MatsSmileTrailer/raw/crudo.mp4';
describe.skipIf(!existsSync(CRUDO))('cut decision on real footage (crudo.mp4)', () => {
	it('the operator reframe (frames 30–50) is not a cut; the shot change at frame 404 is', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-smoothpath-crudo-'));
		try {
			for (const [start, end, cuts] of [
				[20, 60, []],
				[390, 420, [14]],
			] as const) {
				const output = join(dir, `c${start}.mov`);
				mkdirSync(join(dir, `s${start}`), { recursive: true });
				const res = await runProc(
					{
						input: CRUDO,
						output,
						steps: [{ op: 'stabilize', method: 'smoothpath', smoothing: 10, borders: 'crop', maxZoom: 120 }],
						range: { startFrame: start, endFrame: end },
						ffmpeg: FFMPEG,
						ffprobe: FFPROBE,
						models: {},
						threads: 4,
						device: 'cpu',
						scratch: join(dir, `s${start}`),
					},
					{ emit: () => {}, signal: new AbortController().signal, createStep: createStepImpl },
				);
				expect(res.sidecarData.steps[0]!.info.cuts).toEqual(cuts);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 900_000);
});
