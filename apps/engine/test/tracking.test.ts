// Tracking jobs end to end (S09:TRK-010…014, §8.2–8.3) with real ffmpeg and OpenCV.js workers on the synthetic
// plates of `scripts/fixtures/track.mjs` (known per-frame homography / point path).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { join } from 'node:path';
import {
	type EngineJob,
	type EventEnvelope,
	TRACKING_PROGRESS_EVENT,
	type TrackProgress,
	type TrackResult,
	TrackResultSchema,
} from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ffmpeg, resolveBinaries } from '../src/tools/ffmpeg.ts';
import { coreServices } from '../src/tools/services.ts';
import { decodeSpan } from '../src/tracking/decode.ts';
import {
	closeApps,
	ensureFixtures,
	FIXTURES,
	fixture,
	H,
	JSON_H,
	makeApp,
	ROOT,
	register,
	type TestApp,
	until,
} from './helpers.ts';

type PlanarTruth = {
	width: number;
	height: number;
	frames: number;
	reference: { frame: number; corners: [number, number][] };
	occluded: number[];
	corners: [number, number][][];
};
type PointTruth = {
	frames: number;
	reference: { frame: number; point: [number, number]; patch: number; search: number };
	points: [number, number][];
};

const TRACK_FIXTURES = ['plate-planar.mp4', 'plate-planar.json', 'plate-point.mp4', 'plate-point.json'];
const LGPL_DIR = join(ROOT, 'vendor', 'ffmpeg-lgpl', `${process.platform}-${process.arch}`);
const LGPL_FFMPEG = join(LGPL_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

function ensureTrackFixtures(): void {
	ensureFixtures();
	if (TRACK_FIXTURES.every((n) => existsSync(join(FIXTURES, n)))) return;
	const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-fixtures.mjs')], { stdio: 'inherit' });
	if (r.status !== 0) throw new Error('fixture generation failed');
}

let app: TestApp;
let planarKey: string;
let pointKey: string;
let planar: PlanarTruth;
let point: PointTruth;

beforeAll(async () => {
	ensureTrackFixtures();
	planar = JSON.parse(readFileSync(fixture('plate-planar.json'), 'utf8'));
	point = JSON.parse(readFileSync(fixture('plate-point.json'), 'utf8'));
	app = await makeApp({ totalSlots: 8 });
	planarKey = (await register(app, fixture('plate-planar.mp4'))).mediaKey;
	pointKey = (await register(app, fixture('plate-point.mp4'))).mediaKey;
}, 240_000);
afterAll(closeApps);

async function post(body: unknown, target: TestApp = app) {
	return target.inject({
		method: 'POST',
		url: '/api/tracking/track',
		headers: JSON_H,
		payload: body as object,
	});
}

async function runTrack(
	body: unknown,
	target: TestApp = app,
): Promise<{ job: EngineJob; result: TrackResult }> {
	const r = await post(body, target);
	expect(r.statusCode, r.body).toBe(202);
	const queued = r.json() as EngineJob;
	expect(queued.kind).toBe('track');
	const job = await coreServices(target).queue.wait(queued.id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return { job, result: TrackResultSchema.parse(job.result) };
}

/** Per-frame largest corner error (media px) against the planar ground truth. */
function planarErrors(result: TrackResult, truth: PlanarTruth): Map<number, number> {
	const out = new Map<number, number>();
	const n = result.data.length / 8;
	for (let i = 0; i < n; i++) {
		const f = result.startFrame + i;
		const gt = truth.corners[f]!;
		let m = 0;
		for (let k = 0; k < 4; k++)
			m = Math.max(
				m,
				Math.hypot(result.data[i * 8 + 2 * k]! - gt[k]![0], result.data[i * 8 + 2 * k + 1]! - gt[k]![1]),
			);
		out.set(f, m);
	}
	return out;
}

/** RMS over every corner of the non-occluded frames. */
function planarRms(result: TrackResult, truth: PlanarTruth): number {
	let sum = 0;
	let count = 0;
	const occluded = new Set(truth.occluded);
	for (let i = 0; i < result.data.length / 8; i++) {
		const f = result.startFrame + i;
		if (occluded.has(f)) continue;
		for (let k = 0; k < 4; k++) {
			const dx = result.data[i * 8 + 2 * k]! - truth.corners[f]![k]![0];
			const dy = result.data[i * 8 + 2 * k + 1]! - truth.corners[f]![k]![1];
			sum += dx * dx + dy * dy;
			count++;
		}
	}
	return Math.sqrt(sum / count);
}

const planarBody = (extra: Record<string, unknown> = {}) => ({
	projectId: 'prj_0000000000000001',
	mediaKey: planarKey,
	kind: 'planar',
	reference: { frame: planar.reference.frame, corners: planar.reference.corners },
	range: { startFrame: 0, endFrame: planar.frames },
	direction: 'both',
	quality: 'balanced',
	...extra,
});

describe('POST /api/tracking/track: validation (S09:TRK-010)', () => {
	it('answers 404 ASSET_NOT_FOUND for an unknown media key', async () => {
		const r = await post(planarBody({ mediaKey: 'mk_000000000000000000000000' }));
		expect(r.statusCode).toBe(404);
		expect(r.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
	});

	it('answers 400 VALIDATION_FAILED for bad bodies and geometry', async () => {
		const cases: [unknown, RegExp][] = [
			[{ ...planarBody(), kind: 'mesh' }, /kind/],
			[planarBody({ range: { startFrame: 0, endFrame: 50 } }), /contain the reference frame/],
			[planarBody({ range: { startFrame: 80, endFrame: 150 } }), /contain the reference frame/],
			[planarBody({ reference: { frame: 75 } }), /corners/],
			[{ ...planarBody(), kind: 'point', reference: { frame: 75 } }, /point/],
			[
				planarBody({
					reference: {
						frame: 75,
						corners: [
							[100, 100],
							[900, 900],
							[900, 100],
							[100, 900],
						],
					},
				}),
				/convex/,
			],
			[
				planarBody({
					reference: { frame: 400, corners: planar.reference.corners },
					range: { startFrame: 0, endFrame: 500 },
				}),
				/beyond the end/,
			],
		];
		for (const [body, message] of cases) {
			const r = await post(body);
			expect(r.statusCode, JSON.stringify(body)).toBe(400);
			const err = r.json() as { code: string; message: string };
			expect(err.code).toBe('VALIDATION_FAILED');
			expect(err.message).toMatch(message);
		}
	});

	it('reports features.tracking in the capabilities', async () => {
		const caps = (await app.inject({ method: 'GET', url: '/api/capabilities', headers: H })).json() as {
			features?: { tracking?: { status: string; engine: string; warpStage: boolean } };
		};
		expect(caps.features?.tracking).toMatchObject({ status: 'ready', engine: 'opencv.js 4.12' });
		expect(typeof caps.features?.tracking?.warpStage).toBe('boolean');
	});
});

describe('decoding (S09:TRK-011)', () => {
	const frameCodes = async (ffmpegPath: string | null) => {
		const bins = ffmpegPath ? { ffmpeg: ffmpegPath, ffprobe: null } : resolveBinaries();
		const ff = new Ffmpeg(bins);
		const read = async (start: number, count: number) => {
			// frame-code.mp4 burns the frame number as 6 white/black 60x60 blocks at x = 40 + 70·bit, y = 40.
			const frames = await decodeSpan(ff, {
				file: fixture('frame-code.mp4'),
				start,
				count,
				fps: { num: 30, den: 1 },
				width: 1280,
				height: 720,
				scale: true,
			});
			return frames.map((f) => {
				let n = 0;
				for (let b = 0; b < 6; b++) {
					const x = Math.round((70 + 70 * b + 0.5) / 1.5 - 0.5);
					const y = Math.round(70.5 / 1.5 - 0.5);
					if (f[y * 1280 + x]! > 128) n |= 1 << b;
				}
				return n;
			});
		};
		expect(await read(0, 3)).toEqual([0, 1, 2]);
		expect(await read(37, 4)).toEqual([37, 38, 39, 40]);
		expect(await read(62, 5)).toEqual([62, 63]);
	};

	it('lands on the exact frames after an input seek (system ffmpeg)', async () => {
		await frameCodes(null);
	});

	it.skipIf(!existsSync(LGPL_FFMPEG))('lands on the exact frames with the LGPL ffmpeg build', async () => {
		await frameCodes(LGPL_FFMPEG);
	});
});

describe('planar tracker klt-homography@1 (S09:TRK-012, §8.2)', () => {
	it('tracks the plate both ways from a mid reference within 1.5 px RMS, 4 px max, with live progress', async () => {
		const events: TrackProgress[] = [];
		const off = coreServices(app).broadcaster.subscribe((e: EventEnvelope) => {
			if (e.type === TRACKING_PROGRESS_EVENT) events.push(e.payload as TrackProgress);
		});
		const t0 = performance.now();
		const { job, result } = await runTrack(
			planarBody({ trackerId: 'tkr_test0001', options: { features: 'inside', refineEdges: true } }),
		);
		const wall = (performance.now() - t0) / 1000;
		off();
		expect(job.priority).toBe('interactive');
		expect(result).toMatchObject({
			startFrame: 0,
			fps: { num: 30, den: 1 },
			stride: 8,
			method: 'klt-homography@1',
			trackerId: 'tkr_test0001',
		});
		expect(result.data).toHaveLength(planar.frames * 8);
		expect(result.confidence).toHaveLength(planar.frames);
		// Every frame is different (the plane moves up to ~300 px from the reference).
		expect(Math.abs(result.data[0]! - result.data[75 * 8]!)).toBeGreaterThan(50);
		const errors = planarErrors(result, planar);
		const occluded = new Set(planar.occluded);
		const rms = planarRms(result, planar);
		const max = Math.max(...[...errors].filter(([f]) => !occluded.has(f)).map(([, e]) => e));
		console.log(
			`[tracking] planar balanced 1080p both+refineEdges: RMS ${rms.toFixed(3)} px, max ${max.toFixed(3)} px, ` +
				`${result.framesPerSec} frames/s (tracking), ${(planar.frames / wall).toFixed(1)} frames/s wall; lost ${result.lost.length}`,
		);
		expect(rms).toBeLessThanOrEqual(1.5);
		expect(max).toBeLessThanOrEqual(4);
		// Occlusion: lost (confidence 0) or within 4 px, and recovered within 5 frames after.
		for (const f of planar.occluded) {
			if (result.lost.includes(f)) expect(result.confidence[f]).toBe(0);
			else expect(errors.get(f)!).toBeLessThanOrEqual(4);
		}
		const lastOccluded = Math.max(...planar.occluded);
		for (let f = lastOccluded + 5; f < lastOccluded + 15; f++) {
			expect(result.lost).not.toContain(f);
			expect(errors.get(f)!).toBeLessThanOrEqual(4);
		}
		for (let f = 0; f < planar.frames; f++)
			if (!result.lost.includes(f)) expect(result.confidence[f]!).toBeGreaterThan(0.3);
		// Live progress: throttled events carrying the current frame's corners (media px).
		const mine = events.filter((e) => e.jobId === job.id);
		expect(mine.length).toBeGreaterThanOrEqual(2);
		expect(mine.length).toBeLessThanOrEqual(planar.frames);
		for (const e of mine) {
			expect(e).toMatchObject({ trackerId: 'tkr_test0001', mediaKey: planarKey, total: planar.frames });
			expect(e.data).toHaveLength(8);
			expect(e.done).toBeLessThanOrEqual(e.total);
			expect(e.data).toEqual(result.data.slice(e.frame * 8, e.frame * 8 + 8));
		}
		expect(mine.at(-1)!.done).toBe(planar.frames);
		expect(new Set(mine.map((e) => e.frame)).size).toBeGreaterThan(1);
	}, 180_000);

	it('tracks forward only (span = reference … end) and pads frames past the end of the media as lost', async () => {
		const { result } = await runTrack(
			planarBody({
				reference: { frame: 140, corners: planar.corners[140] },
				range: { startFrame: 140, endFrame: 155 },
				direction: 'forward',
				quality: 'fast',
			}),
		);
		expect(result.startFrame).toBe(140);
		expect(result.data).toHaveLength(15 * 8);
		expect(result.lost).toEqual([150, 151, 152, 153, 154]);
		expect(result.confidence.slice(10)).toEqual([0, 0, 0, 0, 0]);
		expect(result.data.slice(14 * 8)).toEqual(result.data.slice(9 * 8, 10 * 8));
		const errors = planarErrors({ ...result, data: result.data.slice(0, 80) }, planar);
		for (const e of errors.values()) expect(e).toBeLessThanOrEqual(1.5);
	}, 120_000);

	it('tracks backward with the surroundings ring (span = start … reference)', async () => {
		const { result } = await runTrack(
			planarBody({
				reference: { frame: 20, corners: planar.corners[20] },
				range: { startFrame: 5, endFrame: 150 },
				direction: 'backward',
				options: { features: 'both' },
			}),
		);
		expect(result.startFrame).toBe(5);
		expect(result.data).toHaveLength(16 * 8);
		for (const e of planarErrors(result, planar).values()) expect(e).toBeLessThanOrEqual(4);
	}, 120_000);

	it('TRK-014: balanced 1080p planar speed (reported; fails below 12.5 frames/s on an idle host)', async () => {
		const load = loadavg()[0]!;
		const t0 = performance.now();
		const { result } = await runTrack(planarBody({ direction: 'forward', trackerId: 'tkr_speed' }));
		const wall = (performance.now() - t0) / 1000;
		const frames = result.data.length / 8;
		console.log(
			`[tracking] TRK-014 balanced 1080p planar forward: ${result.framesPerSec} frames/s tracking, ` +
				`${(frames / wall).toFixed(1)} frames/s incl. start-up; load ${load.toFixed(1)} on ${availableParallelism()} cores`,
		);
		if (load < availableParallelism() * 0.75) expect(result.framesPerSec!).toBeGreaterThanOrEqual(12.5);
		else console.warn('[tracking] host is loaded: speed budget reported, not asserted');
	}, 180_000);
});

describe('point tracker template@1 (S09:TRK-013, §8.2)', () => {
	it('tracks the blob both ways within 1 px RMS', async () => {
		const { result } = await runTrack({
			mediaKey: pointKey,
			kind: 'point',
			reference: point.reference,
			range: { startFrame: 0, endFrame: point.frames },
			direction: 'both',
			quality: 'balanced',
		});
		expect(result).toMatchObject({ startFrame: 0, stride: 2, method: 'template@1', lost: [] });
		let sum = 0;
		let max = 0;
		for (let f = 0; f < point.frames; f++) {
			const e = Math.hypot(
				result.data[2 * f]! - point.points[f]![0],
				result.data[2 * f + 1]! - point.points[f]![1],
			);
			sum += e * e;
			max = Math.max(max, e);
			expect(result.confidence[f]!).toBeGreaterThan(0.5);
		}
		const rms = Math.sqrt(sum / point.frames);
		console.log(
			`[tracking] point: RMS ${rms.toFixed(3)} px, max ${max.toFixed(3)} px, ${result.framesPerSec} frames/s`,
		);
		expect(rms).toBeLessThanOrEqual(1);
	}, 120_000);
});

describe('cancellation (S09:TRK-014)', () => {
	it('stops a running track job within 500 ms', async () => {
		const r = await post(planarBody({ quality: 'best', trackerId: 'tkr_cancel' }));
		expect(r.statusCode).toBe(202);
		const id = (r.json() as EngineJob).id;
		const queue = coreServices(app).queue;
		await until(() => (queue.get(id)?.progress ?? 0) > 0.02, 60_000, 20);
		const t0 = performance.now();
		const c = await app.inject({
			method: 'POST',
			url: `/api/jobs/${id}/cancel`,
			headers: JSON_H,
			payload: '{}',
		});
		expect(c.statusCode).toBe(200);
		const job = await queue.wait(id);
		const ms = performance.now() - t0;
		console.log(`[tracking] cancel latency ${ms.toFixed(0)} ms`);
		expect(job.state).toBe('cancelled');
		expect(ms).toBeLessThan(500);
	}, 120_000);
});

describe('LGPL ffmpeg (D-13)', () => {
	it.skipIf(!existsSync(LGPL_FFMPEG))(
		'tracks with the vendor FFmpeg 7.1 LGPL build',
		async () => {
			const lgpl = await makeApp({
				env: { JASPER_FFMPEG: LGPL_FFMPEG, JASPER_FFPROBE: join(LGPL_DIR, 'ffprobe') },
			});
			expect(coreServices(lgpl).ffmpeg.bins.ffmpeg).toBe(LGPL_FFMPEG);
			const key = (await register(lgpl, fixture('plate-planar.mp4'))).mediaKey;
			const { result } = await runTrack(
				{ ...planarBody(), mediaKey: key, range: { startFrame: 60, endFrame: 95 } },
				lgpl,
			);
			expect(result.startFrame).toBe(60);
			expect(planarRms(result, planar)).toBeLessThanOrEqual(1.5);
		},
		120_000,
	);
});
