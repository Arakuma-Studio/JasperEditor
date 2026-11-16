// Spec 16 SG-001…SG-003, SG-030/031 on the engine: the cached provider probe, per-job device plans from the
// Transcription preferences, a GPU worker that crashes mid-job → the job runs again on the CPU and its result says
// so, measured speed, the CUDA provider status — with a fake `jasper-speech` worker (JASPER_SPEECH), no GPU needed.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EngineJob, SpeechModel, SpeechProbe, TranscriptionResult } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	JSON_H,
	makeApp,
	ROOT,
	register,
	TEST_HOST,
	type TestApp,
} from './helpers.ts';
import { asset } from './sound-design-fixture.ts';

const H = { host: TEST_HOST };
const FIXTURE = join(ROOT, 'fixtures', 'speech', 'lj-composite.flac');
let app: TestApp;
let dir: string;
let specLog: string;

/** The fake worker: a probe that finds a WebGPU device, and jobs that crash whenever a GPU provider is planned. */
const FAKE_WORKER = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [cmd, a, b] = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (cmd === 'probe') {
	const req = JSON.parse(readFileSync(a, 'utf8'));
	writeFileSync(b, JSON.stringify({
		ortVersion: '1.30.0',
		providers: [
			...req.candidates.filter((c) => c !== 'webgpu').map((id) => ({ id, available: false, reason: (req.blocked && req.blocked[id]) || 'no device' })),
			{ id: 'webgpu', available: true },
			{ id: 'cpu', available: true },
		],
	}));
	emit({ type: 'done' });
	process.exit(0);
}
const spec = JSON.parse(readFileSync(cmd, 'utf8'));
appendFileSync(process.env.FAKE_SPEECH_LOG, JSON.stringify(spec) + '\\n');
const d = spec.device || { encoder: 'cpu', decoder: 'cpu' };
emit({ type: 'device', encoder: d.encoder, decoder: d.decoder, attempt: 1 });
emit({ type: 'progress', fraction: 0.5, stage: 'Transcribing 50%' });
if (d.encoder !== 'cpu' || d.decoder !== 'cpu') {
	process.stderr.write('GPU device lost\\n');
	process.kill(process.pid, 'SIGKILL');
}
writeFileSync(a, JSON.stringify({
	modelId: spec.modelId, language: 'en', languageProbability: null, task: 'transcribe', samples: 16000 * 20, speakers: 0,
	words: [{ text: 'hello', start: 16000, end: 24000, confidence: 0.9, speaker: null }],
	segments: [{ start: 1, end: 1.5, text: 'hello', avgLogprob: -0.2, noSpeechProb: 0.01, compressionRatio: 1.1, temperature: 0 }],
	timings: { decodeMs: 1, loadMs: 1, transcribeMs: 4000 },
	device: { encoder: 'cpu', decoder: 'cpu', threads: spec.threads, fallbacks: [] },
	calibration: null,
	guard: { skippedWindows: 1, droppedWords: 2, removed: [{ text: 'Thanks for watching!', start: 5, end: 6, reason: 'known-phrase' }], frames: 'energy' },
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

function waitJob(id: string): Promise<EngineJob> {
	return coreServices(app).queue.wait(id);
}

const specs = () =>
	readFileSync(specLog, 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map(
			(l) =>
				JSON.parse(l) as Record<string, unknown> & {
					device: { encoder: string; decoder: string; calibrate: string | null };
				},
		);

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'jasper-speech-svc-'));
	const worker = join(dir, 'fake-speech.mjs');
	writeFileSync(worker, FAKE_WORKER);
	specLog = join(dir, 'specs.jsonl');
	writeFileSync(specLog, '');
	const files = [
		file('config.json', '{"num_mel_bins":80}'),
		file('generation_config.json', '{}'),
		file('tokenizer.json', '{}'),
		file('encoder_model.onnx', 'enc'),
		file('decoder_model_merged.onnx', 'dec'),
	];
	const entry = {
		id: 'test-turbo',
		name: 'Test turbo',
		parameters: 809,
		multilingual: true,
		description: 'test',
		license: 'MIT',
		licenseUrl: 'https://example.invalid/LICENSE',
		attribution: 'Test',
		sourceUrl: 'https://example.invalid/model',
		upstreamUrl: 'https://example.invalid/upstream',
		revision: '0123456789abcdef0123456789abcdef01234567',
		recommend: 'turbo',
		files,
	};
	writeFileSync(
		join(dir, 'catalog.json'),
		JSON.stringify({
			models: [],
			speech: [entry, { ...entry, id: 'test-small', recommend: 'small', parameters: 244 }],
		}),
	);
	process.env.JASPER_MODEL_CATALOG = join(dir, 'catalog.json');
	process.env.JASPER_SPEECH = worker;
	process.env.FAKE_SPEECH_LOG = specLog;
	app = await makeApp({ totalSlots: 8 });
	const inst = await app.inject({ method: 'POST', url: '/api/speech/models/test-turbo/install', headers: H });
	expect((await waitJob((inst.json() as EngineJob).id)).state).toBe('succeeded');
}, 120_000);

afterAll(async () => {
	delete process.env.JASPER_MODEL_CATALOG;
	delete process.env.JASPER_SPEECH;
	delete process.env.FAKE_SPEECH_LOG;
	await closeApps();
	rmSync(dir, { recursive: true, force: true });
});

describe('speech on the GPU (spec 16) with a fake worker', () => {
	it('probes once (cached), reports providers in the probe, capabilities and the model list', async () => {
		const p = (
			await app.inject({ method: 'GET', url: '/api/speech/probe', headers: H })
		).json() as SpeechProbe;
		expect(p.providers.find((x) => x.id === 'webgpu')).toMatchObject({ available: true });
		expect(p.providers.find((x) => x.id === 'cpu')).toMatchObject({ available: true });
		expect(p.chosen).toEqual({ encoder: 'webgpu', decoder: 'cpu' });
		expect(p.threads).toBeGreaterThanOrEqual(1);
		expect(p.threads).toBeLessThanOrEqual(8);
		expect(p.gpu).toMatchObject({ provider: 'webgpu' });
		if (process.platform === 'linux' && process.arch === 'x64')
			expect(p.providers.find((x) => x.id === 'cuda')?.reason).toMatch(/NVIDIA GPU support is off/);
		const again = (
			await app.inject({ method: 'GET', url: '/api/speech/probe', headers: H })
		).json() as SpeechProbe;
		expect(again.probedAt).toBe(p.probedAt);
		const caps = (await app.inject({ method: 'GET', url: '/api/capabilities', headers: H })).json() as {
			features: {
				speech: { providers?: unknown[]; chosen?: unknown; recommendedModel?: string; cuda?: string };
			};
		};
		expect(caps.features.speech.chosen).toEqual({ encoder: 'webgpu', decoder: 'cpu' });
		expect(caps.features.speech.recommendedModel).toBe('test-turbo');
		const models = (
			(await app.inject({ method: 'GET', url: '/api/speech/models', headers: H })).json() as {
				models: SpeechModel[];
			}
		).models;
		const turbo = models.find((m) => m.id === 'test-turbo')!;
		expect(turbo).toMatchObject({ recommended: true, default: true, installed: true });
		expect(turbo.runsOn).toMatchObject({ encoder: 'webgpu', decoder: 'cpu' });
		expect(turbo.speed).toMatchObject({ basis: 'estimated', accuracy: 'standard' });
		const re = (
			await app.inject({ method: 'POST', url: '/api/speech/probe', headers: H })
		).json() as SpeechProbe;
		expect(re.probedAt >= p.probedAt).toBe(true);
	});

	it('settings: Processor and Accuracy are validated and change the plan', async () => {
		const bad = await app.inject({
			method: 'PUT',
			url: '/api/speech/settings',
			headers: JSON_H,
			payload: { processor: 'tpu' },
		});
		expect(bad.statusCode).toBe(400);
		const s = await app.inject({
			method: 'PUT',
			url: '/api/speech/settings',
			headers: JSON_H,
			payload: { processor: 'cpu', accuracy: 'best' },
		});
		expect(s.json()).toEqual({ processor: 'cpu', accuracy: 'best', nvidiaGpu: false });
		const models = (
			(await app.inject({ method: 'GET', url: '/api/speech/models', headers: H })).json() as {
				models: SpeechModel[];
			}
		).models;
		expect(models[0]!.runsOn).toMatchObject({ encoder: 'cpu', decoder: 'cpu', device: 'CPU' });
		expect(models[0]!.speed?.accuracy).toBe('best');
		await app.inject({
			method: 'PUT',
			url: '/api/speech/settings',
			headers: JSON_H,
			payload: { processor: 'auto', accuracy: 'standard' },
		});
		expect(
			(await app.inject({ method: 'GET', url: '/api/speech/settings', headers: H })).json(),
		).toMatchObject({
			processor: 'auto',
		});
	});

	it('a GPU worker that crashes mid-job → the job runs again on the CPU; the result notes the fallback', async () => {
		writeFileSync(specLog, '');
		const m = await register(app, FIXTURE);
		const r = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/transcribe`,
			headers: JSON_H,
			payload: { verbatim: true, initialPrompt: 'JasperEditor', language: 'en' },
		});
		expect(r.statusCode).toBe(202);
		const done = await waitJob((r.json() as EngineJob).id);
		expect(done.state).toBe('succeeded');
		const res = done.result as TranscriptionResult;
		expect(res.device).toMatchObject({ encoder: 'cpu', decoder: 'cpu', label: 'CPU' });
		expect(res.device?.fallbacks).toContainEqual(
			expect.objectContaining({ stage: 'job', from: 'webgpu', to: 'cpu' }),
		);
		expect(res.device?.fallbacks[0]?.reason).toMatch(/GPU device lost|killed/);
		expect(res.accuracy).toBe('standard');
		expect(res.beamSize).toBe(1);
		expect(res.segments[0]).toMatchObject({ avgLogprob: -0.2, noSpeechProb: 0.01, compressionRatio: 1.1 });
		expect(res.guard).toMatchObject({ skippedWindows: 1, droppedWords: 2, frames: 'energy' });
		expect(res.timings.rtf).toBeCloseTo(0.2, 3);
		const runs = specs();
		expect(runs).toHaveLength(2);
		// greedy on a WebGPU encoder: the first run calibrates the decoder; the retry is CPU only
		expect(runs[0]!.device).toEqual({ encoder: 'webgpu', decoder: 'cpu', calibrate: 'webgpu' });
		expect(runs[1]!.device).toEqual({ encoder: 'cpu', decoder: 'cpu', calibrate: null });
		expect(runs[0]).toMatchObject({ beamSize: 1, verbatim: true, initialPrompt: 'JasperEditor' });
		expect((runs[0] as { voiceAnalysis?: { path: string } }).voiceAnalysis?.path).toMatch(/voice-analysis-/);
		// the measured speed shows for the device that ran
		await app.inject({
			method: 'PUT',
			url: '/api/speech/settings',
			headers: JSON_H,
			payload: { processor: 'cpu' },
		});
		const models = (
			(await app.inject({ method: 'GET', url: '/api/speech/models', headers: H })).json() as {
				models: SpeechModel[];
			}
		).models;
		expect(models.find((x) => x.id === 'test-turbo')!.speed).toMatchObject({
			basis: 'measured',
			minutesPer10Min: 2,
		});
		await app.inject({
			method: 'PUT',
			url: '/api/speech/settings',
			headers: JSON_H,
			payload: { processor: 'auto' },
		});
	}, 120_000);

	it('job options: accuracy best = beam 5 without decoder calibration; device cpu; Processor GPU without one says why', async () => {
		const m = await register(app, FIXTURE);
		writeFileSync(specLog, '');
		const best = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/transcribe`,
			headers: JSON_H,
			payload: { accuracy: 'best', device: 'cpu', language: 'en' },
		});
		const done = await waitJob((best.json() as EngineJob).id);
		expect(done.state).toBe('succeeded');
		const runs = specs();
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			beamSize: 5,
			device: { encoder: 'cpu', decoder: 'cpu', calibrate: null },
		});
		expect((done.result as TranscriptionResult).device?.fallbacks).toEqual([]);
	}, 120_000);

	it('the NVIDIA CUDA provider reports its state; it is not bundled', async () => {
		const st = (await app.inject({ method: 'GET', url: '/api/speech/cuda', headers: H })).json() as {
			state: string;
			ortVersion: string;
			downloadBytes: number;
			license: string;
		};
		if (process.platform === 'linux' && process.arch === 'x64') expect(st.state).toBe('not-installed');
		else expect(st.state).toBe('unsupported');
		expect(st).toMatchObject({ ortVersion: '1.30.0', downloadBytes: 236_037_232 });
		expect(st.license).toMatch(/MIT/);
	});
});

describe('sequence transcription with offline media (AGENTS §0, §4)', () => {
	it('an offline picture does not refuse the sequence mix; offline sound does (MEDIA_OFFLINE)', async () => {
		// the transcription used to plan a video export: any offline picture refused it, though it reads only the sound
		const transcribe = (d: DocBuilder) =>
			app.inject({
				method: 'POST',
				url: '/api/speech/transcribe-sequence',
				headers: JSON_H,
				payload: { envelope: d.envelope(), sequenceId: d.seqId, model: 'test-turbo', device: 'cpu' },
			});
		const voice = await register(app, FIXTURE);
		const d = new DocBuilder();
		const m = d.addMedia(voice);
		d.tx([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				tracks: { audio: 'A1' },
				sourceRange: { in: { seconds: 0 }, out: { seconds: 4 } },
			},
			{ type: 'media.register', asset: asset('image'), ref: '$pic' },
			{
				type: 'clip.place',
				source: { mediaId: '$pic' },
				at: 0,
				tracks: { video: 'V1' },
				video: true,
				audio: false,
				sourceRange: { in: { flicks: 0 }, out: { seconds: 1 } },
			},
		]);
		const ok = await transcribe(d);
		expect(ok.statusCode, ok.body).toBe(202);
		const done = await waitJob((ok.json() as EngineJob).id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		const off = new DocBuilder();
		const o = off.addMedia({
			...voice,
			locators: [{ type: 'engine-store', engineId: 'x', key: 'mk_ffffffffffffffffffffffff' }],
		});
		off.tx([{ type: 'clip.place', source: { mediaId: o }, at: 0, tracks: { audio: 'A1' } }]);
		const refused = await transcribe(off);
		// (the speech routes answer a refused submission 422)
		expect(refused.statusCode, refused.body).toBe(422);
		expect(refused.json().code).toBe('MEDIA_OFFLINE');
	}, 120_000);
});
