// 3D Camera Tracker jobs end to end (three-d) with real ffmpeg, OpenCV.js and the jasper-camtrack child process on the
// ray-cast plate of `scripts/fixtures/camtrack.mjs` (a dolly with an exactly known camera): the solved focal length and
// path against the truth, the tracks cache (re-solve with deleted points), cancellation and refusals.
import { readFileSync } from 'node:fs';
import type { CamTrackResult, EngineJob } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { logRot, type M3, mm, mt, norm, rodrigues, sub, umeyama, type V3 } from '../src/camtrack/core/linalg.ts';
import { closeApps, ensureFixtures, fixture, H, JSON_H, makeApp, register, type TestApp, until } from './helpers.ts';

type Truth = { width: number; height: number; frames: { r: M3; c: V3; f: number }[] };

let app: TestApp;
let key: string;
let truth: Truth;

const SETTINGS = { shot: 'fixed', hfov: 40, method: 'auto', detailed: false, lensDistortion: false } as const;

async function post(body: object): Promise<EngineJob> {
	const r = await app.inject({ method: 'POST', url: '/api/camtrack/solve', headers: JSON_H, payload: body });
	if (r.statusCode !== 202) throw new Error(`solve failed ${r.statusCode}: ${r.body}`);
	return r.json() as EngineJob;
}

async function finished(job: EngineJob): Promise<EngineJob> {
	return until(async () => {
		const j = (await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: H })).json() as EngineJob;
		return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state) ? j : null;
	}, 600_000);
}

const frameOf = (r: CamTrackResult, k: number) => r.frames.slice(k * 8, k * 8 + 8);

beforeAll(async () => {
	ensureFixtures();
	truth = JSON.parse(readFileSync(fixture('camtrack-dolly.json'), 'utf8'));
	app = await makeApp({ totalSlots: 4 });
	key = (await register(app, fixture('camtrack-dolly.mp4'))).mediaKey;
}, 240_000);

afterAll(async () => {
	await closeApps();
});

describe('camtrack jobs', () => {
	let first: CamTrackResult;

	it('solves the camera of the plate: focal length, path and rotation against the truth', async () => {
		const job = await finished(
			await post({ mediaKey: key, span: [0, 59], settings: SETTINGS, clipId: 'c1', trackerId: 'ct1' }),
		);
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		first = job.result as CamTrackResult;
		expect(first).toMatchObject({ clipId: 'c1', trackerId: 'ct1', span: [0, 59], size: [640, 360] });
		expect(first.frames.length).toBe(60 * 8);
		expect(first.methodUsed).toBe('typical');
		expect(first.averageError).toBeLessThan(0.6);
		expect(first.points.length).toBeGreaterThan(100);
		const solved = Array.from({ length: 60 }, (_, k) => frameOf(first, k));
		expect(solved.filter((f) => f[7] === 1).length).toBeGreaterThan(55);
		const focal = [...solved.map((f) => f[6]!)].sort((a, b) => a - b)[30]!;
		expect(Math.abs(focal / 560 - 1)).toBeLessThan(0.04);
		// Path after the best similarity, relative to the path length.
		const src = solved.map((f) => [f[3]!, f[4]!, f[5]!] as V3);
		const dst = truth.frames.map((f) => f.c);
		const sim = umeyama(src, dst)!;
		const len = norm(sub(dst[59]!, dst[0]!));
		let worst = 0;
		src.forEach((s, i) => {
			const p = [0, 1, 2].map(
				(j) => sim.s * (sim.r[j]![0] * s[0] + sim.r[j]![1] * s[1] + sim.r[j]![2] * s[2]) + sim.t[j]!,
			) as V3;
			worst = Math.max(worst, norm(sub(p, dst[i]!)));
		});
		expect(worst / len).toBeLessThan(0.05);
		// Relative rotations against the first frame (degrees).
		const r0 = rodrigues([solved[0]![0]!, solved[0]![1]!, solved[0]![2]!]);
		let rot = 0;
		for (let k = 1; k < 60; k++) {
			const rs = mm(rodrigues([solved[k]![0]!, solved[k]![1]!, solved[k]![2]!]), mt(r0));
			const rt = mm(truth.frames[k]!.r, mt(truth.frames[0]!.r));
			rot = Math.max(rot, (norm(logRot(mm(rs, mt(rt)))) * 180) / Math.PI);
		}
		expect(rot).toBeLessThan(0.5);
	}, 600_000);

	it('re-solves from the cached tracks without the deleted points', async () => {
		const gone = first.points.slice(0, 10).map((p) => p.id);
		const t0 = Date.now();
		const job = await finished(
			await post({ mediaKey: key, span: [0, 59], settings: { ...SETTINGS, shot: 'specify', hfov: 59.5 }, deleted: gone }),
		);
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		const r = job.result as CamTrackResult;
		expect(r.points.some((p) => gone.includes(p.id))).toBe(false);
		expect(r.shot).toBe('specify');
		expect(r.tracks).toBe(first.tracks);
		expect(Date.now() - t0).toBeLessThan(600_000);
	}, 600_000);

	it('cancels a running job (the child process is killed)', async () => {
		const job = await post({ mediaKey: key, span: [0, 59], settings: { ...SETTINGS, detailed: true } });
		await until(async () => {
			const j = (await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: H })).json() as EngineJob;
			return j.state === 'running' ? j : null;
		}, 60_000);
		const c = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: H });
		expect(c.statusCode).toBeLessThan(300);
		const done = await finished(job);
		expect(done.state).toBe('cancelled');
	}, 120_000);

	it('refuses spans shorter than two frames and unknown media', async () => {
		const short = await app.inject({
			method: 'POST',
			url: '/api/camtrack/solve',
			headers: JSON_H,
			payload: { mediaKey: key, span: [3, 3], settings: SETTINGS },
		});
		expect(short.statusCode).toBe(400);
		const unknown = await app.inject({
			method: 'POST',
			url: '/api/camtrack/solve',
			headers: JSON_H,
			payload: { mediaKey: 'nope', span: [0, 10], settings: SETTINGS },
		});
		expect(unknown.statusCode).toBe(404);
	});
});
