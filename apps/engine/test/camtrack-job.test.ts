// scripts/fixtures/camtrack.mjs ray-casts a dolly with an exactly known camera for comparison.
import { readFileSync } from 'node:fs';
import type { CamTrackResult, EngineJob } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { M3, V3 } from '../src/camtrack/core/linalg.ts';
import { collinearPathError } from './camera-path-oracle.ts';
import {
	closeApps,
	ensureFixtures,
	fixture,
	H,
	JSON_H,
	makeApp,
	register,
	type TestApp,
	until,
} from './helpers.ts';

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
		const j = (
			await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: H })
		).json() as EngineJob;
		return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state) ? j : null;
	}, 600_000);
}

const frameOf = (r: CamTrackResult, k: number) => r.frames.slice(k * 8, k * 8 + 8);

// q v q⁻¹, with q = [cos(angle/2), axis * sin(angle/2)].
function rotateVector(v: V3, rotation: V3): V3 {
	const half = Math.hypot(...rotation) / 2;
	const scale = half === 0 ? 0.5 : Math.sin(half) / (2 * half);
	const [x, y, z] = rotation.map((r) => r * scale);
	const w = Math.cos(half);
	const tx = 2 * (y! * v[2] - z! * v[1]);
	const ty = 2 * (z! * v[0] - x! * v[2]);
	const tz = 2 * (x! * v[1] - y! * v[0]);
	return [
		v[0] + w * tx + y! * tz - z! * ty,
		v[1] + w * ty + z! * tx - x! * tz,
		v[2] + w * tz + x! * ty - y! * tx,
	];
}

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
		// Fit every returned frame, normalized by the full authored dolly path.
		expect(
			collinearPathError(
				solved.map((f) => f.slice(3, 6)),
				truth.frames.length,
			),
		).toBeLessThan(0.05);
		// Decode the public axis-angle with a quaternion sandwich, independently
		// of the solver's Rodrigues/log-matrix conversion. For rotations A/B,
		// ||A-B||_F = sqrt(8) sin(angle/2).
		const r0 = solved[0]!.slice(0, 3).map((v) => -v) as V3;
		let rot = 0;
		for (let k = 1; k < 60; k++) {
			let squared = 0;
			for (let j = 0; j < 3; j++) {
				const basis = [0, 0, 0] as V3;
				basis[j] = 1;
				const actual = rotateVector(rotateVector(basis, r0), solved[k]!.slice(0, 3) as V3);
				for (let i = 0; i < 3; i++) {
					const expected = truth.frames[k]!.r[i]!.reduce(
						(sum, v, a) => sum + v * truth.frames[0]!.r[j]![a]!,
						0,
					);
					squared += (actual[i]! - expected) ** 2;
				}
			}
			rot = Math.max(rot, (2 * Math.asin(Math.min(1, Math.sqrt(squared / 8))) * 180) / Math.PI);
		}
		expect(rot).toBeLessThan(0.5);
	}, 600_000);

	it('re-solves from the cached tracks without the deleted points', async () => {
		const gone = first.points.slice(0, 10).map((p) => p.id);
		const t0 = Date.now();
		const job = await finished(
			await post({
				mediaKey: key,
				span: [0, 59],
				settings: { ...SETTINGS, shot: 'specify', hfov: 59.5 },
				deleted: gone,
			}),
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
			const j = (
				await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: H })
			).json() as EngineJob;
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
