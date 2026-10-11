import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessStep } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProc } from '../src/processing/proc/runner.ts';
import type { SegmentPlan } from '../src/processing/proc/smoothpath/math.ts';
import { createStepImpl } from '../src/processing/proc/steps.ts';
import { fixture, ROOT } from './helpers.ts';

type SmoothPathStep = Extract<ProcessStep, { op: 'stabilize' }> & { method: 'smoothpath' };
type SmoothPathInfo = {
	camera: Pick<SegmentPlan['stats'], 'travelPx'>;
	fallback: SegmentPlan['fallback'];
	zoomPercent: number;
	speed: { rawMaxPxPerFrame1080: number; smoothedMaxPxPerFrame1080: number };
	used: Pick<SegmentPlan, 'sigma' | 'lockVertical'>;
	warp: { engine: 'wasm' | 'opencv' | null };
	cuts: number[];
	segments: (Pick<SegmentPlan, 'firstFrame'> &
		Pick<SegmentPlan['stats'], 'frames' | 'travelPx'> & { zoomPercent: number })[];
};

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
	if (r.status !== 0) throw new Error(r.stderr.toString());
	if (r.stdout.length !== 90 * w * h) throw new Error(`Expected 90 decoded frames from ${file}`);
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
	}, 600_000);
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const run = async (name: string, step: SmoothPathStep, input = fixture('reframe.mp4')) => {
		const output = join(dir, `${name}.mov`);
		const scratch = join(dir, `scratch-${name}`);
		mkdirSync(scratch, { recursive: true });
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
			{ emit: () => {}, signal: new AbortController().signal, createStep: createStepImpl },
		);
		return { output, res, info: res.sidecarData.steps[0].info as SmoothPathInfo };
	};

	it('tracks the background (not the subject), evens out the reframe within the zoom cap', async () => {
		const t = await truth();
		const { output, res, info } = await run('rf', {
			op: 'stabilize',
			method: 'smoothpath',
			smoothing: 12,
			borders: 'crop',
			lockVertical: true,
			lockRotation: true,
			maxZoom: 115,
		});
		expect(res.frames).toBe(90);
		// camera travel = the fixture's crop path (content moves the other way), the subject ignored
		const D = t.xs[89] - t.xs[0];
		expect(info.camera.travelPx[0]).toBeGreaterThan(-D - 1.5);
		expect(info.camera.travelPx[0]).toBeLessThan(-D + 1.5);
		expect(Math.abs(info.camera.travelPx[1])).toBeLessThan(1);
		expect(info.fallback).toBeNull();
		expect(info.zoomPercent).toBeGreaterThan(100);
		expect(info.zoomPercent).toBeLessThanOrEqual(115);
		expect(info.speed.smoothedMaxPxPerFrame1080).toBeLessThan(info.speed.rawMaxPxPerFrame1080 / 2.5);
		const before = columnShifts(fixture('reframe.mp4'));
		const after = columnShifts(output);
		const peak = (a: number[]) => Math.max(...a.map(Math.abs));
		const jerkiness = (a: number[]) => Math.max(...a.slice(1).map((v, i) => Math.abs(v - a[i])));
		expect(peak(after)).toBeLessThanOrEqual(peak(before) / 2);
		expect(jerkiness(after)).toBeLessThanOrEqual(2);
	}, 600_000);

	it('reports fallback and releases locks when the cap is too small', async () => {
		const { info } = await run('rf-cap', {
			op: 'stabilize',
			method: 'smoothpath',
			smoothing: 60,
			borders: 'crop',
			maxZoom: 101,
			lockVertical: true,
		});
		expect(info.fallback).not.toBeNull();
		expect(info.used.sigma).toBeLessThan(60);
		expect(info.zoomPercent).toBeLessThanOrEqual(101);
		expect(info.fallback!.requestedSigma).toBe(60);
		expect(info.fallback!.neededZoom).toBeGreaterThan(1.01);
		expect(info.fallback!.locksReleased).toBe(true);
		expect(info.used.lockVertical).toBe(false);
	}, 600_000);

	it('warps the same with the vid.stab WASM kernel and the OpenCV.js fallback', async () => {
		const step: SmoothPathStep = {
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
			// same geometry: the two bicubic kernels (Catmull-Rom vs OpenCV a = −0.75) differ only in fine detail
			const psnr = spawnSync(
				FFMPEG,
				['-v', 'info', '-i', w.output, '-i', c.output, '-lavfi', '[0:v][1:v]psnr', '-f', 'null', '-'],
				{ encoding: 'utf8' },
			);
			const avg = Number(/PSNR .*average:([\d.]+|inf)/.exec(psnr.stderr)?.[1]);
			expect(avg).toBeGreaterThan(38);
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
		const { info, res } = await run(
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
	}, 900_000);
});
