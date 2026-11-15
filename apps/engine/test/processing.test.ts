import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob, ProcessResult } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	register,
	TEST_HOST,
	type TestApp,
} from './helpers.ts';
import { writeTinySrModel } from './tiny-model.ts';

const H = { host: TEST_HOST };
let app: TestApp;
let catalogDir: string;

function ffprobeJson(file: string): { streams: Array<Record<string, string | number>> } {
	const r = spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-show_streams', '-of', 'json', file], {
		encoding: 'utf8',
	});
	return JSON.parse(r.stdout);
}

async function waitJob(id: string): Promise<EngineJob> {
	return coreServices(app).queue.wait(id);
}

beforeAll(async () => {
	ensureFixtures();
	catalogDir = mkdtempSync(join(tmpdir(), 'jasper-models-'));
	const sha = writeTinySrModel(join(catalogDir, 'tiny.onnx'));
	const size = readFileSync(join(catalogDir, 'tiny.onnx')).length;
	writeFileSync(
		join(catalogDir, 'catalog.json'),
		JSON.stringify({
			models: [
				{
					id: 'tiny-2x',
					name: 'Tiny 2× (test)',
					architecture: 'conv1x1+pixelshuffle',
					scale: 2,
					file: 'tiny.onnx',
					bundled: true,
					license: 'CC0-1.0',
					attribution: null,
					sourceUrl: 'https://example.invalid/tiny',
					downloadUrl: null,
					sha256: sha,
					sizeBytes: size,
				},
				{
					id: 'remote-only',
					name: 'Not installed',
					architecture: 'SPAN',
					scale: 2,
					file: 'missing.onnx',
					license: 'CC-BY-4.0',
					attribution: 'someone',
					sourceUrl: 'https://example.invalid/x',
					downloadUrl: 'https://example.invalid/x.onnx',
					sha256: '0'.repeat(64),
					sizeBytes: 10,
				},
			],
		}),
	);
	process.env.JASPER_MODEL_CATALOG = join(catalogDir, 'catalog.json');
	app = await makeApp({ totalSlots: 8 });
}, 60_000);

afterAll(async () => {
	delete process.env.JASPER_MODEL_CATALOG;
	await closeApps();
	if (catalogDir) rmSync(catalogDir, { recursive: true, force: true });
});

describe('processing routes', () => {
	it('lists the model catalogue with install state', async () => {
		const r = await app.inject({ method: 'GET', url: '/api/processing/models', headers: H });
		expect(r.statusCode).toBe(200);
		const models = (r.json() as { models: Array<{ id: string; installed: boolean }> }).models;
		expect(models.find((m) => m.id === 'tiny-2x')?.installed).toBe(true);
		expect(models.find((m) => m.id === 'remote-only')?.installed).toBe(false);
	});

	it('stores settings in engine.json and validates them', async () => {
		const get0 = await app.inject({ method: 'GET', url: '/api/settings/processing', headers: H });
		expect(get0.json()).toEqual({ remote: null });
		const bad = await app.inject({
			method: 'PUT',
			url: '/api/settings/processing',
			headers: JSON_H,
			payload: {
				remote: {
					enabled: true,
					host: 'gpu.example',
					user: 'me',
					port: 22,
					identityFile: null,
					remoteDir: '/srv/jasper; rm -rf /',
					useFor: ['upscale'],
					strictHostKeyChecking: 'accept-new',
				},
			},
		});
		expect(bad.statusCode).toBe(400);
		const ok = await app.inject({
			method: 'PUT',
			url: '/api/settings/processing',
			headers: JSON_H,
			payload: { remote: null, localSlots: 3 },
		});
		expect(ok.statusCode).toBe(200);
		const file = JSON.parse(readFileSync(join(app.appdir, 'engine', 'engine.json'), 'utf8'));
		expect(file.processing).toEqual({ remote: null, localSlots: 3 });
	});

	it('probe/setup without settings answer a clear "not configured" error', async () => {
		const p = await app.inject({ method: 'POST', url: '/api/processing/remote/probe', headers: H });
		expect(p.statusCode).toBe(409);
		expect(p.json().code).toBe('REMOTE_NOT_CONFIGURED');
		const s = await app.inject({ method: 'POST', url: '/api/processing/remote/setup', headers: H });
		expect(s.statusCode).toBe(409);
	});

	it('reports features.processing and licences (vid.stab, ONNX Runtime, OpenCV.js, weights)', async () => {
		const caps = (await app.inject({ method: 'GET', url: '/api/capabilities', headers: H })).json();
		const p = caps.features.processing;
		expect(p.denoise).toEqual(expect.arrayContaining(['atadenoise', 'fftdnoiz', 'nlmeans']));
		expect(p.deblock).toBe(true);
		expect(p.upscale.runtime).toBe('onnxruntime');
		expect(p.upscale.providers).toContain('cpu');
		expect(p.upscale.modelsInstalled).toBe(1);
		expect(p.remote).toEqual({ configured: false, lastProbe: null });
		const lic = (await app.inject({ method: 'GET', url: '/api/licenses', headers: H })).json() as {
			components: Array<{
				id: string;
				license: string;
				texts: unknown[];
				notice?: string;
				version: string | null;
			}>;
		};
		const ids = lic.components.map((c) => c.id);
		expect(ids).toEqual(
			expect.arrayContaining(['libvidstab', 'onnxruntime-node', 'opencv-js', 'model:tiny-2x']),
		);
		const vs = lic.components.find((c) => c.id === 'libvidstab')!;
		expect(vs.license).toBe('LGPL-2.1-or-later');
		expect(vs.version).toContain('e2445c408165');
		expect(lic.components.find((c) => c.id === 'onnxruntime-node')!.texts.length).toBeGreaterThan(0);
		expect(lic.components.find((c) => c.id === 'opencv-js')!.license).toBe('Apache-2.0');
	});

	it('rejects unknown media and uninstalled models', async () => {
		const r = await app.inject({
			method: 'POST',
			url: '/api/media/mk_000000000000000000000000/process',
			headers: JSON_H,
			payload: { steps: [{ op: 'deblock', filter: 'weak' }] },
		});
		expect(r.statusCode).toBe(404);
		const m = await register(app, fixture('clip-b.mp4'));
		const r2 = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/process`,
			headers: JSON_H,
			payload: { steps: [{ op: 'upscale', model: 'remote-only', scale: 2 }] },
		});
		expect(r2.json().code).toBe('MODEL_NOT_INSTALLED');
	});
});

describe('process jobs (local)', () => {
	it('registers and reuses a processed version, then starts its browser proxy', async () => {
		const m = await register(app, fixture('clip-b.mp4'));
		const steps = [
			{ op: 'deblock', filter: 'weak' },
			{ op: 'denoise', method: 'atadenoise', strength: 0.5 },
		];
		const r = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/process`,
			headers: JSON_H,
			payload: { steps, executor: 'local', projectId: 'prj_0000000000000001' },
		});
		expect(r.statusCode).toBe(200);
		const job = await waitJob((r.json() as EngineJob).id);
		expect(job.error).toBeUndefined();
		expect(job.state).toBe('succeeded');
		const res = job.result as ProcessResult;
		expect(res.fromMediaKey).toBe(m.mediaKey);
		expect(res.executor).toBe('local');
		const path = res.registered.locators.find((l) => l.type === 'path');
		// Managed files expose no path locator; resolve through the registry file instead.
		const index = JSON.parse(readFileSync(join(app.appdir, 'engine', 'media-index.json'), 'utf8'));
		const rec = index.items[res.registered.mediaKey];
		expect(rec.derivedFrom).toEqual({ mediaKey: m.mediaKey, recipeHash: res.recipeHash });
		expect(path).toBeUndefined();
		const out = rec.storage.path as string;
		expect(ffprobeJson(out).streams.some((s) => s.codec_type === 'video')).toBe(true);
		// proxy-720 follows (browsers cannot decode ProRes).
		const jobs = (await app.inject({ method: 'GET', url: '/api/jobs', headers: H })).json()
			.jobs as EngineJob[];
		expect(jobs.some((j) => j.kind === 'proxy' && j.assetId === res.registered.mediaKey)).toBe(true);
		const again = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/process`,
			headers: JSON_H,
			payload: { steps, executor: 'local' },
		});
		const job2 = await waitJob((again.json() as EngineJob).id);
		expect((job2.result as ProcessResult).registered.mediaKey).toBe(res.registered.mediaKey);
	}, 300_000);

	it('a sequence using a processed version plans native and exports reading the ProRes file (S07 §8 test 8)', async () => {
		// A private copy of the source: it is deleted before the export, so the export can only read the
		// processed file.
		const copy = join(catalogDir, 'clip-b-copy.mp4');
		copyFileSync(fixture('clip-b.mp4'), copy);
		writeFileSync(copy, readFileSync(copy));
		const m = await register(app, copy);
		const steps = [{ op: 'denoise', method: 'atadenoise', strength: 0.2 }];
		const r = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/process`,
			headers: JSON_H,
			payload: { steps, executor: 'local' },
		});
		const job = await waitJob((r.json() as EngineJob).id);
		const res = job.result as ProcessResult;
		const d = new DocBuilder('hd-720p-30');
		const original = d.addMedia(m);
		const placed = d.tx([{ type: 'clip.place', source: { mediaId: original }, at: 0, ref: '$c' }]);
		const clipId = placed.refs.$c!;
		const reg = res.registered;
		const derived = d.tx([
			{
				type: 'media.derive',
				fromMediaId: original,
				recipe: { op: 'process', steps },
				asset: {
					fingerprint: reg.fingerprint,
					originalName: reg.originalName,
					sizeBytes: reg.sizeBytes,
					container: reg.container,
					probe: reg.probe,
					locators: [{ type: 'engine-store', engineId: 'local', key: reg.mediaKey }],
					recipeVersion: res.recipeVersion,
					recipeHash: res.recipeHash,
				},
				replaceInClips: [clipId],
				ref: '$p',
			},
		]);
		const processedId = derived.refs.$p!;
		const clip = d.doc.sequences[d.seqId]!.clips[clipId] as unknown as { mediaId: string };
		expect(clip.mediaId).toBe(processedId);
		const settings = {
			sequenceId: d.seqId,
			range: { type: 'entire' },
			container: 'mp4',
			video: {
				codec: 'h264',
				width: 1280,
				height: 720,
				frameRate: { num: 30, den: 1 },
				scaling: 'fit',
				quality: { mode: 'crf', value: 23 },
				encoderSpeed: 'fast',
			},
			audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
			engine: 'auto',
		};
		rmSync(copy);
		const plan = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
		});
		expect(plan.statusCode).toBe(200);
		expect(plan.json()).toMatchObject({ path: 'native', blockers: [] });
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
		});
		expect(start.statusCode).toBe(202);
		const done = await waitJob(start.json().id);
		expect(done.error).toBeUndefined();
		const result = done.result as { renderPath: string; frames: number; downloadUrl: string };
		expect(result.renderPath).toBe('native');
		expect(result.frames).toBe(180);
		const artifact = await app.inject({
			method: 'GET',
			url: result.downloadUrl,
			headers: { ...H, range: 'bytes=0-31' },
		});
		expect(artifact.statusCode).toBe(206);
		expect(artifact.rawPayload.length).toBeGreaterThan(0);
	}, 300_000);
});
