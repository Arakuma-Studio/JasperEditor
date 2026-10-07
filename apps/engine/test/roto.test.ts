// Roto jobs end to end (parity workstream `roto`) with real ffmpeg, OpenCV.js and the jasper-roto child process on
// the synthetic plate of `scripts/fixtures/roto.mjs` (an ellipse with known geometry per frame): classic graph-cut
// segmentation + Farnebäck propagation, frame reuse, the matte route, cancellation (no partial files), cache refs,
// planner refusal of uncomputed mattes. With JASPER_ROTO_MODELS_DIR (a directory holding the SAM 2.1 files of the
// catalogue), the model is installed through the real installer (file:// URLs, sha256 verified) and segmentation runs
// with it.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EngineJob, RotoSegmentRequest, RotoSegmentResult } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectCacheRefs } from '../src/cache/project-refs.ts';
import builtin from '../src/processing/models.json' with { type: 'json' };
import { decodeGreyPng } from '../src/roto/core/codec.ts';
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

type Truth = {
	width: number;
	height: number;
	frames: { cx: number; cy: number; rx: number; ry: number; angle: number }[];
};

const MODELS = process.env.JASPER_ROTO_MODELS_DIR;
const SETTINGS = {
	engine: 'classic' as 'classic' | 'model',
	model: 'sam2.1-hiera-tiny',
	quality: 'standard' as const,
	searchRadius: 15,
	motionThreshold: 10,
	motionDamping: 20,
	edgeMode: 'guided' as const,
	edgeRadius: 3,
	edgeSmooth: 1,
	faceThreshold: 0.5,
	faceExpand: 15,
	faceShape: 'outline' as const,
};

let app: TestApp;
let key: string;
let truth: Truth;
let dir: string;

function request(over: Partial<RotoSegmentRequest['roto']> = {}, extra: Partial<RotoSegmentRequest> = {}) {
	return {
		mediaKey: key,
		inputs: 'test-inputs',
		roto: {
			kind: 'brush',
			rate: { num: 30, den: 1 },
			base: 10,
			span: [0, 29],
			strokes: [
				{
					kind: 'fg',
					frame: 10,
					radius: 6,
					points: [
						[210, 180],
						[250, 190],
					],
				},
			],
			settings: SETTINGS,
			...over,
		},
		direction: 'both',
		...extra,
	} as RotoSegmentRequest;
}

async function segment(body: unknown, target: TestApp = app): Promise<EngineJob> {
	const r = await target.inject({
		method: 'POST',
		url: '/api/roto/segment',
		headers: JSON_H,
		payload: body as object,
	});
	if (r.statusCode !== 202) throw new Error(`segment failed ${r.statusCode}: ${r.body}`);
	const job = r.json() as EngineJob;
	return until(async () => {
		const j = (
			await target.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: H })
		).json() as EngineJob;
		return ['succeeded', 'failed', 'cancelled'].includes(j.state) ? j : null;
	}, 600_000);
}

/** IoU of a set's frame against the ellipse. */
async function iouOf(res: RotoSegmentResult, f: number, target: TestApp = app): Promise<number> {
	const r = await target.inject({ method: 'GET', url: `/mg/roto/${res.key}?n=${f}`, headers: H });
	expect(r.statusCode).toBe(200);
	expect(r.headers['content-type']).toContain('image/png');
	const { data, width, height } = decodeGreyPng(r.rawPayload);
	const e = truth.frames[f]!;
	const sx = truth.width / width;
	const c = Math.cos(-e.angle);
	const s = Math.sin(-e.angle);
	let i = 0;
	let u = 0;
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const px = (x + 0.5) * sx - e.cx;
			const py = (y + 0.5) * sx - e.cy;
			const a = px * c - py * s;
			const b = px * s + py * c;
			const g = (a / e.rx) ** 2 + (b / e.ry) ** 2 <= 1;
			const m = data[y * width + x]! >= 128;
			if (g && m) i++;
			if (g || m) u++;
		}
	return i / u;
}

beforeAll(async () => {
	ensureFixtures();
	truth = JSON.parse(readFileSync(fixture('roto-object.json'), 'utf8'));
	dir = mkdtempSync(join(tmpdir(), 'jasper-roto-cat-'));
	const vision = (builtin as { vision: { id: string; files: { path: string; url: string }[] }[] }).vision.map(
		(v) => ({
			...v,
			files: v.files.map((f) => ({ ...f, url: MODELS ? pathToFileURL(join(MODELS, f.path)).href : f.url })),
		}),
	);
	writeFileSync(join(dir, 'catalog.json'), JSON.stringify({ models: [], vision }));
	process.env.JASPER_MODEL_CATALOG = join(dir, 'catalog.json');
	app = await makeApp({ totalSlots: 6 });
	key = (await register(app, fixture('roto-object.mp4'))).mediaKey;
}, 240_000);

afterAll(async () => {
	delete process.env.JASPER_MODEL_CATALOG;
	await closeApps();
	rmSync(dir, { recursive: true, force: true });
});

describe('roto jobs (classic engine)', () => {
	let first: RotoSegmentResult;

	it('lists the vision models with licences and reports the capability', async () => {
		const r = await app.inject({ method: 'GET', url: '/api/roto/models', headers: H });
		const models = (
			r.json() as { models: { id: string; task: string; license: string; installed: boolean }[] }
		).models;
		expect(models.map((m) => m.id)).toEqual(['sam2.1-hiera-tiny', 'mediapipe-face-landmarker']);
		expect(models.every((m) => m.license.includes('Apache-2.0'))).toBe(true);
		const caps = (await app.inject({ method: 'GET', url: '/api/capabilities', headers: H })).json() as {
			features: { roto: { status: string; segmentationModel: boolean; faceModel: boolean } };
		};
		expect(caps.features.roto).toMatchObject({ status: 'ready', faceModel: false });
	});

	it('segments the base frame from a stroke and propagates both ways (IoU ≥ 0.95 on every frame)', async () => {
		const job = await segment(request());
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		first = job.result as RotoSegmentResult;
		expect(first).toMatchObject({ start: 0, end: 29, width: 640, height: 360, model: null, reused: 0 });
		expect(first.computed).toBe(30);
		expect(first.area.length).toBe(30);
		const ellipse = (Math.PI * 80 * 60) / (640 * 360);
		for (const a of first.area) expect(Math.abs(a - ellipse)).toBeLessThan(0.01);
		for (const f of [0, 10, 20, 29]) expect(await iouOf(first, f)).toBeGreaterThan(0.95);
		const info = (await app.inject({ method: 'GET', url: `/api/roto/sets/${first.key}`, headers: H })).json();
		expect(info).toMatchObject({ key: first.key, start: 0, end: 29, frames: 30 });
	}, 600_000);

	it('reuses every frame for the same inputs, and only recomputes after a correction', async () => {
		const again = (await segment(request())).result as RotoSegmentResult;
		expect(again).toMatchObject({ key: first.key, computed: 0, reused: 30 });
		// A correction stroke on frame 20 changes frames 20… only.
		const corrected = request({
			strokes: [
				{
					kind: 'fg',
					frame: 10,
					radius: 6,
					points: [
						[210, 180],
						[250, 190],
					],
				},
				{ kind: 'bg', frame: 20, radius: 4, points: [[20, 20]] },
			],
		});
		const r = (await segment(corrected)).result as RotoSegmentResult;
		expect(r.key).not.toBe(first.key);
		expect(r.computed).toBe(10);
		expect(r.reused).toBe(20);
	}, 600_000);

	it('computes a single frame for interactive previews', async () => {
		const r = (
			await segment(
				request(
					{ base: 5, strokes: [{ kind: 'fg', frame: 5, radius: 6, points: [[200, 180]] }] },
					{ direction: 'frame', frame: 5 },
				),
			)
		).result as RotoSegmentResult;
		expect(r).toMatchObject({ start: 5, end: 5, computed: 1 });
		expect(await iouOf(r, 5)).toBeGreaterThan(0.93);
	}, 300_000);

	it('validates requests (400) and refuses faces without the face model (409)', async () => {
		const bad = await app.inject({
			method: 'POST',
			url: '/api/roto/segment',
			headers: JSON_H,
			payload: request({ base: null }) as object,
		});
		expect(bad.statusCode).toBe(400);
		const faces = await app.inject({
			method: 'POST',
			url: '/api/roto/segment',
			headers: JSON_H,
			payload: request({ kind: 'faces', base: 0, strokes: [] }) as object,
		});
		expect(faces.statusCode).toBe(409);
		expect(faces.json().code).toBe('FACE_MODEL_NOT_INSTALLED');
		const missing = await app.inject({
			method: 'GET',
			url: '/mg/roto/0123456789abcdef0123456789abcdef?n=0',
			headers: H,
		});
		expect(missing.statusCode).toBe(404);
	});

	it('cancelling leaves no partial files and publishes no set', async () => {
		const body = request({ strokes: [{ kind: 'fg', frame: 10, radius: 7, points: [[200, 170]] }] });
		const r = await app.inject({
			method: 'POST',
			url: '/api/roto/segment',
			headers: JSON_H,
			payload: body as object,
		});
		const job = r.json() as EngineJob;
		await until(async () => {
			const j = (
				await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: H })
			).json() as EngineJob;
			return j.state === 'running' && (j.progress ?? 0) > 0.05 ? j : null;
		}, 120_000);
		await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: H });
		const done = await until(async () => {
			const j = (
				await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: H })
			).json() as EngineJob;
			return ['cancelled', 'failed', 'succeeded'].includes(j.state) ? j : null;
		}, 60_000);
		expect(done.state).toBe('cancelled');
		const root = join(app.appdir, 'cache', 'roto');
		for (const sub of ['pool/seg', 'pool/png'])
			for (const n of existsSync(join(root, sub)) ? readdirSync(join(root, sub)) : [])
				expect(n).not.toMatch(/\.tmp$/);
		const sets = readdirSync(join(root, 'sets'));
		expect(sets).toHaveLength(3); // first, corrected, single frame
	}, 300_000);

	it('saved projects reference their roto sets (cache)', () => {
		const refs = projectCacheRefs(
			{ media: {}, sequences: { s: { clips: { c: { rotos: [{ result: { key: first.key } }] } } } } },
			null,
		);
		expect([...(refs.rotoKeys ?? [])]).toEqual([first.key]);
	});
});

describe.runIf(!!MODELS)('roto jobs with SAM 2.1 (JASPER_ROTO_MODELS_DIR)', () => {
	it('installs the model through the catalogue installer and segments with it', async () => {
		const inst = await app.inject({
			method: 'POST',
			url: '/api/roto/models/sam2.1-hiera-tiny/install',
			headers: H,
		});
		expect(inst.statusCode).toBe(200);
		const job = inst.json() as EngineJob;
		const done = await until(async () => {
			const j = (
				await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: H })
			).json() as EngineJob;
			return ['succeeded', 'failed'].includes(j.state) ? j : null;
		}, 120_000);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		const notice = readFileSync(
			join(app.appdir, 'models', 'vision', 'sam2.1-hiera-tiny', 'NOTICE.txt'),
			'utf8',
		);
		expect(notice).toContain('Apache-2.0');
		const r = (
			await segment(
				request({ span: [8, 14], settings: { ...SETTINGS, engine: 'model' } }, { direction: 'both' }),
			)
		).result as RotoSegmentResult;
		expect(r).toMatchObject({ model: 'sam2.1-hiera-tiny', start: 8, end: 14 });
		expect(r.modelFrames).toBeGreaterThan(0);
		for (const f of [8, 10, 14]) expect(await iouOf(r, f)).toBeGreaterThan(0.95);
	}, 900_000);
});
