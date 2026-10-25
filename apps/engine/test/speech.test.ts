import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EngineJob } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApps, JSON_H, makeApp, ROOT, register, type TestApp, until } from './helpers.ts';

const H = { host: '127.0.0.1:47900' };
const FIXTURE = join(ROOT, 'fixtures', 'speech', 'lj-composite.flac');
let app: TestApp;
let dir: string;

function file(name: string, content: string) {
	const p = join(dir, name);
	writeFileSync(p, content);
	return {
		path: name,
		url: pathToFileURL(p).href,
		sha256: createHash('sha256').update(content).digest('hex'),
		sizeBytes: Buffer.byteLength(content),
	};
}

function model(id: string, files: ReturnType<typeof file>[], extra: Record<string, unknown> = {}) {
	return {
		id,
		name: `Test ${id}`,
		parameters: 1,
		multilingual: !id.endsWith('.en'),
		description: 'test model',
		license: 'MIT',
		licenseUrl: 'https://example.invalid/LICENSE',
		attribution: 'Test authors',
		sourceUrl: 'https://example.invalid/model',
		upstreamUrl: 'https://example.invalid/upstream',
		revision: '0123456789abcdef0123456789abcdef01234567',
		files,
		...extra,
	};
}

async function waitJob(id: string): Promise<EngineJob> {
	return until(
		async () => {
			const j = (await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: H })).json() as EngineJob;
			return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state) ? j : null;
		},
		120_000,
		100,
	);
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'jasper-speech-cat-'));
	const good = [
		file('config.json', '{"num_mel_bins":80}'),
		file('generation_config.json', '{}'),
		file('tokenizer.json', '{}'),
		file('encoder_model.onnx', 'not an onnx model'),
		file('decoder_model_merged.onnx', 'not an onnx model either'),
	];
	// spec 16 SG-023: a speech entry needs its config, encoder and decoder; one of them is corrupt here
	const bad = [
		...good.slice(0, 4),
		{ ...file('decoder-bad.onnx', 'payload'), path: 'decoder_model_merged.onnx', sha256: '0'.repeat(64) },
	];
	writeFileSync(
		join(dir, 'catalog.json'),
		JSON.stringify({
			models: [],
			speech: [
				model('test-multi', good, { default: true }),
				model('test-small.en', good),
				model('test-corrupt', bad),
			],
		}),
	);
	process.env.JASPER_MODEL_CATALOG = join(dir, 'catalog.json');
	app = await makeApp({ totalSlots: 4 });
}, 60_000);

afterAll(async () => {
	delete process.env.JASPER_MODEL_CATALOG;
	await closeApps();
	rmSync(dir, { recursive: true, force: true });
});

describe('speech models (processing catalogue `speech`)', () => {
	it('lists the models with licence, size and install state', async () => {
		const r = await app.inject({ method: 'GET', url: '/api/speech/models', headers: H });
		expect(r.statusCode).toBe(200);
		const models = (r.json() as { models: Array<Record<string, unknown>> }).models;
		expect(models.map((m) => m.id)).toEqual(['test-multi', 'test-small.en', 'test-corrupt']);
		expect(models[0]).toMatchObject({ installed: false, default: true, license: 'MIT', multilingual: true });
		expect(models[1]).toMatchObject({ multilingual: false, default: false });
		expect(models[0]!.sizeBytes).toBe(models[0]!.missingBytes);
		const caps = (await app.inject({ method: 'GET', url: '/api/capabilities', headers: H })).json() as {
			features: { speech: { status: string; modelsInstalled: number; defaultModel: string } };
		};
		expect(caps.features.speech).toMatchObject({
			modelsInstalled: 0,
			defaultModel: 'test-multi',
			status: 'ready',
		});
	});

	it('refuses to transcribe with a model that is not downloaded (409), an unknown model (404) or media (404)', async () => {
		const m = await register(app, FIXTURE);
		const notInstalled = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/transcribe`,
			headers: JSON_H,
			payload: {},
		});
		expect(notInstalled.statusCode).toBe(409);
		expect(notInstalled.json()).toMatchObject({ code: 'SPEECH_MODEL_NOT_INSTALLED' });
		const unknown = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/transcribe`,
			headers: JSON_H,
			payload: { model: 'nope' },
		});
		expect(unknown.statusCode).toBe(404);
		const media = await app.inject({
			method: 'POST',
			url: '/api/media/mk_0000000000000000/transcribe',
			headers: JSON_H,
			payload: {},
		});
		expect(media.statusCode).toBe(404);
	});

	it('installs a multi-file model through the model-download job, verified file by file', async () => {
		const r = await app.inject({ method: 'POST', url: '/api/speech/models/test-multi/install', headers: H });
		expect(r.statusCode).toBe(200);
		const job = r.json() as EngineJob;
		expect(job.kind).toBe('model-download');
		const done = await waitJob(job.id);
		expect(done.state).toBe('succeeded');
		expect(existsSync(join(app.appdir, 'models', 'speech', 'test-multi', 'install.json'))).toBe(true);
		const models = (
			(await app.inject({ method: 'GET', url: '/api/speech/models', headers: H })).json() as {
				models: Array<{ id: string; installed: boolean; missingBytes: number }>;
			}
		).models;
		expect(models.find((m) => m.id === 'test-multi')).toMatchObject({ installed: true, missingBytes: 0 });
		const again = await app.inject({
			method: 'POST',
			url: '/api/processing/models/test-small.en/install',
			headers: H,
		});
		expect(again.statusCode, again.body).toBe(200);
		expect((await waitJob((again.json() as EngineJob).id)).state).toBe('succeeded');
	}, 60_000);

	it('a file whose sha256 does not match fails the install and leaves no partial file', async () => {
		const r = await app.inject({
			method: 'POST',
			url: '/api/speech/models/test-corrupt/install',
			headers: H,
		});
		const done = await waitJob((r.json() as EngineJob).id);
		expect(done.state).toBe('failed');
		expect(done.error?.code).toBe('SPEECH_MODEL_CHECKSUM');
		const d = join(app.appdir, 'models', 'speech', 'test-corrupt');
		expect(existsSync(join(d, 'decoder_model_merged.onnx.partial'))).toBe(false);
		expect(existsSync(join(d, 'decoder_model_merged.onnx'))).toBe(false);
	}, 60_000);

	it('English-only models refuse translation and other languages', async () => {
		const m = await register(app, FIXTURE);
		for (const payload of [
			{ model: 'test-small.en', task: 'translate' },
			{ model: 'test-small.en', language: 'de' },
		]) {
			const r = await app.inject({
				method: 'POST',
				url: `/api/media/${m.mediaKey}/transcribe`,
				headers: JSON_H,
				payload,
			});
			expect(r.statusCode).toBe(422);
			expect(r.json()).toMatchObject({ code: 'INVALID_SPEC' });
		}
	});

	it('a model that cannot be loaded fails the transcription job with the worker message', async () => {
		const m = await register(app, FIXTURE);
		const r = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/transcribe`,
			headers: JSON_H,
			payload: { model: 'test-multi', language: 'en', speakerLabels: true },
		});
		expect(r.statusCode).toBe(202);
		const job = r.json() as EngineJob;
		expect(job.kind).toBe('transcription');
		const done = await waitJob(job.id);
		expect(done.state).toBe('failed');
		expect(done.error?.code).toBe('TRANSCRIPTION_FAILED');
		expect(done.error?.message).toBeTruthy();
	}, 120_000);

	it('lists the speech weights in the licences and deletes a model', async () => {
		const lic = (await app.inject({ method: 'GET', url: '/api/licenses', headers: H })).json() as {
			components: Array<{ id: string; license: string; notice?: string }>;
		};
		const c = lic.components.find((x) => x.id === 'model:test-multi');
		expect(c).toMatchObject({ license: 'MIT' });
		expect(c?.notice).toContain('Test authors');
		const del = await app.inject({ method: 'DELETE', url: '/api/speech/models/test-multi', headers: H });
		expect(del.statusCode).toBe(200);
		expect((del.json() as { freedBytes: number }).freedBytes).toBeGreaterThan(0);
		expect(existsSync(join(app.appdir, 'models', 'speech', 'test-multi'))).toBe(false);
		const missing = await app.inject({ method: 'DELETE', url: '/api/speech/models/nope', headers: H });
		expect(missing.statusCode).toBe(404);
	});
});
