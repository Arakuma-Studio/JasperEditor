// scripts/fixtures/camtrack.mjs ray-casts a dolly with an exactly known camera for comparison.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CamTrackResult, EngineJob } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { M3, V3 } from '../src/camtrack/core/linalg.ts';
import { coreServices } from '../src/tools/services.ts';
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
	tempAppdir,
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
	return coreServices(app).queue.wait(job.id);
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
	it('solves the camera against the truth, then reuses tracks without deleted points', async () => {
		const job = await finished(
			await post({ mediaKey: key, span: [0, 59], settings: SETTINGS, clipId: 'c1', trackerId: 'ct1' }),
		);
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		const first = job.result as CamTrackResult;
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

		// Continue the same solve workflow: a re-solve reuses tracks and excludes deleted points.
		const gone = first.points.slice(0, 10).map((p) => p.id);
		const reSolved = await finished(
			await post({
				mediaKey: key,
				span: [0, 59],
				settings: { ...SETTINGS, shot: 'specify', hfov: 59.5 },
				deleted: gone,
			}),
		);
		expect(reSolved.state, JSON.stringify(reSolved.error)).toBe('succeeded');
		const r = reSolved.result as CamTrackResult;
		expect(r.points.some((p) => gone.includes(p.id))).toBe(false);
		expect(r.shot).toBe('specify');
		expect(r.tracks).toBe(first.tracks);
	}, 600_000);

	it('cancelling a camera job terminates its worker process', async () => {
		const dir = tempAppdir('jasper-camtrack-cancel-');
		const pidFile = join(dir, 'worker.pid');
		const worker = join(dir, 'camera-worker.mjs');
		// A real worker protocol peer that stays busy until killed. Camera accuracy is owned by the solve above.
		writeFileSync(
			worker,
			`import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdout.write(JSON.stringify({ type: 'progress', fraction: 0.25, stage: 'Peer ready' }) + '\\n');
setInterval(() => {}, 1000);
`,
		);
		const previousWorker = process.env.JASPER_CAMTRACK;
		process.env.JASPER_CAMTRACK = worker;
		const queue = coreServices(app).queue;
		let job: EngineJob | undefined;
		let pid: number | undefined;
		let unsubscribe = () => {};
		const ready = new Promise<void>((resolve) => {
			unsubscribe = coreServices(app).broadcaster.subscribe((event) => {
				const updated = event.payload as EngineJob;
				if (event.type === 'job.updated' && updated.kind === 'camtrack' && updated.stage === 'Peer ready')
					resolve();
			});
		});
		try {
			job = await post({ mediaKey: key, span: [0, 59], settings: SETTINGS });
			const jobId = job.id;
			expect(await Promise.race([ready.then(() => true), queue.wait(jobId).then(() => false)])).toBe(true);
			pid = Number(readFileSync(pidFile, 'utf8'));
			expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
			const cancel = await app.inject({
				method: 'POST',
				url: `/api/jobs/${jobId}/cancel`,
				headers: H,
			});
			expect(cancel.statusCode).toBe(200);
			expect((await queue.wait(jobId)).state).toBe('cancelled');
			expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
		} finally {
			unsubscribe();
			if (previousWorker === undefined) delete process.env.JASPER_CAMTRACK;
			else process.env.JASPER_CAMTRACK = previousWorker;
			if (job) {
				queue.cancel(job.id);
				pid ??= existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined;
				if (pid && Number.isSafeInteger(pid) && pid > 0) {
					try {
						process.kill(pid, 'SIGKILL');
					} catch {
						/* worker already exited */
					}
				}
				await queue.wait(job.id);
			}
		}
	}, 30_000);

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
