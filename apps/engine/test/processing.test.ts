// Clip processing on the engine (S07 §3, §8 tests 2, 6, 8): routes, process jobs through jasper-proc,
// content-addressed outputs, registerDerived, models, settings, licences, and a native export that reads the
// processed ProRes file.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob, ProcessResult } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recipeHash } from '../src/processing/proc/recipe.ts';
import { writeTinySrModel } from '../src/processing/proc/tiny-onnx.ts';
import { VIDSTAB_PIN } from '../src/processing/vidstab-pin.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	ROOT,
	register,
	type TestApp,
	until,
} from './helpers.ts';

const H = { host: '127.0.0.1:47900' };
let app: TestApp;
let catalogDir: string;

function ffprobeJson(file: string): { streams: Array<Record<string, string | number>> } {
	const r = spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-show_streams', '-of', 'json', file], {
		encoding: 'utf8',
	});
	return JSON.parse(r.stdout);
}

function audioHash(file: string): string {
	const r = spawnSync(
		'ffmpeg',
		['-v', 'error', '-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'data', '-'],
		{
			maxBuffer: 256 * 1024 * 1024,
		},
	);
	return createHash('sha256').update(r.stdout).digest('hex');
}

async function waitJob(id: string, timeoutMs = 240_000): Promise<EngineJob> {
	return until(
		async () => {
			const r = await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: H });
			const j = r.json() as EngineJob;
			return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state) ? j : null;
		},
		timeoutMs,
		200,
	);
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
		expect(vs.version).toContain(VIDSTAB_PIN.commit.slice(0, 12));
		expect(lic.components.find((c) => c.id === 'onnxruntime-node')!.texts.length).toBe(1);
		expect(lic.components.find((c) => c.id === 'opencv-js')!.license).toBe('Apache-2.0');
	});

	it('the vid.stab pin mirrors scripts/ffmpeg/manifest.json', () => {
		const m = JSON.parse(readFileSync(join(ROOT, 'scripts', 'ffmpeg', 'manifest.json'), 'utf8'));
		expect(m.vidstab.commit).toBe(VIDSTAB_PIN.commit);
		expect(m.vidstab.license).toBe(VIDSTAB_PIN.license);
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
	it('denoise + deblock: same frame count and rate, ProRes BT.709, audio copied bit-exact, registered, reused', async () => {
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
		expect(res.recipeHash).toBe(recipeHash(steps as never));
		expect(res.registered.originalName).toBe('clip-b [Deblocked · Denoised].mov');
		const path = res.registered.locators.find((l) => l.type === 'path');
		// Managed files expose no path locator; resolve through the registry file instead.
		const index = JSON.parse(readFileSync(join(app.appdir, 'engine', 'media-index.json'), 'utf8'));
		const rec = index.items[res.registered.mediaKey];
		expect(rec.derivedFrom).toEqual({ mediaKey: m.mediaKey, recipeHash: res.recipeHash });
		expect(path).toBeUndefined();
		const out = rec.storage.path as string;
		const src = ffprobeJson(fixture('clip-b.mp4')).streams.find((s) => s.codec_type === 'video')!;
		const probe = ffprobeJson(out);
		const v = probe.streams.find((s) => s.codec_type === 'video')!;
		expect(v.codec_name).toBe('prores');
		expect(v.pix_fmt).toBe('yuv422p10le');
		expect(v.color_primaries).toBe('bt709');
		expect(v.color_transfer).toBe('bt709');
		expect(v.color_space).toBe('bt709');
		expect(v.nb_read_packets).toBe(src.nb_read_packets);
		expect(v.r_frame_rate).toBe(src.r_frame_rate);
		expect(audioHash(out)).toBe(audioHash(fixture('clip-b.mp4')));
		const side = JSON.parse(readFileSync(`${out}.json`, 'utf8'));
		expect(side.recipeHash).toBe(res.recipeHash);
		expect(side.output.frames).toBe(Number(src.nb_read_packets));
		// proxy-720 follows (browsers cannot decode ProRes).
		const jobs = (await app.inject({ method: 'GET', url: '/api/jobs', headers: H })).json()
			.jobs as EngineJob[];
		expect(jobs.some((j) => j.kind === 'proxy' && j.assetId === res.registered.mediaKey)).toBe(true);
		// Same recipe again: content-addressed reuse.
		const again = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/process`,
			headers: JSON_H,
			payload: { steps, executor: 'local' },
		});
		const job2 = await waitJob((again.json() as EngineJob).id);
		expect((job2.result as ProcessResult).registered.mediaKey).toBe(res.registered.mediaKey);
		expect((job2.result as ProcessResult).notes.join()).toMatch(/reused/);
	}, 300_000);

	it('upscale with the generated test model: exactly 2× (range processing)', async () => {
		const m = await register(app, fixture('clip-b.mp4'));
		const r = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/process`,
			headers: JSON_H,
			payload: {
				steps: [{ op: 'upscale', model: 'tiny-2x', scale: 2 }],
				executor: 'local',
				range: { startFrame: 25, endFrame: 37 },
			},
		});
		const job = await waitJob((r.json() as EngineJob).id);
		expect(job.error).toBeUndefined();
		const res = job.result as ProcessResult;
		const index = JSON.parse(readFileSync(join(app.appdir, 'engine', 'media-index.json'), 'utf8'));
		const out = index.items[res.registered.mediaKey].storage.path as string;
		const src = ffprobeJson(fixture('clip-b.mp4')).streams.find((s) => s.codec_type === 'video')!;
		const v = ffprobeJson(out).streams.find((s) => s.codec_type === 'video')!;
		expect(Number(v.width)).toBe(2 * Number(src.width));
		expect(Number(v.height)).toBe(2 * Number(src.height));
		expect(Number(v.nb_read_packets)).toBe(12);
	}, 300_000);

	it('cancel kills jasper-proc and leaves no partial output', async () => {
		const m = await register(app, fixture('clip-a.mp4'));
		const r = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/process`,
			headers: JSON_H,
			payload: { steps: [{ op: 'denoise', method: 'nlmeans', strength: 1 }], executor: 'local' },
		});
		const id = (r.json() as EngineJob).id;
		await until(
			async () => {
				const j = (
					await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: H })
				).json() as EngineJob;
				return j.state === 'running' && (j.progress ?? 0) > 0 ? j : null;
			},
			60_000,
			100,
		);
		await app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: H });
		const done = await waitJob(id, 30_000);
		expect(done.state).toBe('cancelled');
		const ls = spawnSync('find', [join(app.appdir, 'media', 'processed'), '-name', '.partial-*'], {
			encoding: 'utf8',
		});
		expect(ls.stdout.trim()).toBe('');
	}, 120_000);

	it('a sequence using a processed version plans native and exports reading the ProRes file (S07 §8 test 8)', async () => {
		// A private copy of the source: it is deleted before the export, so the export can only read the
		// processed file.
		const copy = join(catalogDir, 'clip-b-copy.mp4');
		copyFileSync(fixture('clip-b.mp4'), copy);
		writeFileSync(copy, readFileSync(copy)); // fresh mtime
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
				colorTags: 'rec709',
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
		expect((done.result as { renderPath: string; frames: number }).renderPath).toBe('native');
		expect((done.result as { frames: number }).frames).toBe(180);
	}, 300_000);
});
