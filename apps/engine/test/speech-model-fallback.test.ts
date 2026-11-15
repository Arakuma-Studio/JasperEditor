// The default speech model is not installed (reported: the default became `whisper-large-v3-turbo-fp16` while only
// the fp32 turbo was downloaded, and every `transcribe` without a model failed with SPEECH_MODEL_NOT_INSTALLED): a
// request that names no model runs on the best installed model — the same model in fp32 first — and the result says
// so; a request that names the missing model is still refused. Fake `jasper-speech` worker (JASPER_SPEECH).
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EngineJob, TranscriptionResult } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, JSON_H, makeApp, ROOT, register, TEST_HOST, type TestApp } from './helpers.ts';

const H = { host: TEST_HOST };
const FIXTURE = join(ROOT, 'fixtures', 'speech', 'lj-composite.flac');
let app: TestApp;
let dir: string;

const FAKE_WORKER = `
import { readFileSync, writeFileSync } from 'node:fs';
const [cmd, a, b] = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (cmd === 'probe') {
	writeFileSync(b, JSON.stringify({ ortVersion: '1.30.0', providers: [{ id: 'cpu', available: true }] }));
	emit({ type: 'done' });
	process.exit(0);
}
const spec = JSON.parse(readFileSync(cmd, 'utf8'));
emit({ type: 'device', encoder: 'cpu', decoder: 'cpu', attempt: 1 });
writeFileSync(a, JSON.stringify({
	modelId: spec.modelId, language: 'es', languageProbability: 0.9, task: 'transcribe', samples: 16000 * 2, speakers: 0,
	words: [{ text: 'hola', start: 16000, end: 24000, confidence: 0.9, speaker: null }],
	segments: [],
	timings: { decodeMs: 1, loadMs: 1, transcribeMs: 10 },
	device: { encoder: 'cpu', decoder: 'cpu', threads: spec.threads, fallbacks: [] },
	calibration: null,
	guard: { skippedWindows: 0, droppedWords: 0, removed: [], frames: 'energy' },
	profile: { encoderMs: 1, decoderMs: 1, jsMs: 1, decoderRuns: 1, windows: 1 },
}));
emit({ type: 'done' });
process.exit(0);
`;

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

const waitJob = (id: string) => coreServices(app).queue.wait(id);

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'jasper-speech-fallback-'));
	const worker = join(dir, 'fake-speech.mjs');
	writeFileSync(worker, FAKE_WORKER);
	const files = [
		file('config.json', '{"num_mel_bins":80}'),
		file('generation_config.json', '{}'),
		file('tokenizer.json', '{}'),
		file('encoder_model.onnx', 'enc'),
		file('decoder_model_merged.onnx', 'dec'),
	];
	const entry = (id: string, extra: Record<string, unknown>) => ({
		id,
		name: `Test ${id}`,
		parameters: 809,
		multilingual: true,
		description: 'test',
		license: 'MIT',
		licenseUrl: 'https://example.invalid/LICENSE',
		attribution: 'Test',
		sourceUrl: 'https://example.invalid/model',
		upstreamUrl: 'https://example.invalid/upstream',
		revision: '0123456789abcdef0123456789abcdef01234567',
		files,
		...extra,
	});
	writeFileSync(
		join(dir, 'catalog.json'),
		JSON.stringify({
			models: [],
			speech: [
				entry('t-big', { parameters: 1550, revision: 'fedcba9876543210fedcba9876543210fedcba98' }),
				entry('t-turbo', {}),
				entry('t-turbo-fp16', { default: true, precision: 'fp16', gpuOnly: true }),
			],
		}),
	);
	process.env.JASPER_MODEL_CATALOG = join(dir, 'catalog.json');
	process.env.JASPER_SPEECH = worker;
	app = await makeApp({ totalSlots: 4 });
	for (const id of ['t-big', 't-turbo']) {
		const inst = await app.inject({ method: 'POST', url: `/api/speech/models/${id}/install`, headers: H });
		expect((await waitJob((inst.json() as EngineJob).id)).state).toBe('succeeded');
	}
}, 120_000);

afterAll(async () => {
	delete process.env.JASPER_MODEL_CATALOG;
	delete process.env.JASPER_SPEECH;
	await closeApps();
	rmSync(dir, { recursive: true, force: true });
});

describe('the default speech model is not installed', () => {
	it('without a model the fp32 of the same model runs and the result names the fallback; naming it is refused', async () => {
		const m = await register(app, FIXTURE);
		const url = `/api/media/${m.mediaKey}/transcribe`;
		const r = await app.inject({ method: 'POST', url, headers: JSON_H, payload: { language: 'es' } });
		expect(r.statusCode).toBeLessThan(300);
		const done = await waitJob((r.json() as EngineJob).id);
		expect(done.state).toBe('succeeded');
		const res = done.result as TranscriptionResult;
		expect(res.model).toBe('t-turbo');
		expect(res.modelFallback).toMatchObject({ requested: 't-turbo-fp16' });
		const named = await app.inject({
			method: 'POST',
			url,
			headers: JSON_H,
			payload: { model: 't-turbo-fp16', language: 'es' },
		});
		expect(named.statusCode).toBe(409);
		expect(named.json()).toMatchObject({ code: 'SPEECH_MODEL_NOT_INSTALLED' });
	});
});
