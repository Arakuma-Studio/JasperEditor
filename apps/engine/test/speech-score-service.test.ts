// Spec 17 SC-092 / SC-035 / SC-036 / SC-074 on the engine with a fake `jasper-speech` worker (JASPER_SPEECH): the
// `SpeechService.score` request/result shape with flicks ↔ samples, validation, the device plan, a GPU worker that
// crashes → one CPU retry with the reason, refusals and failures as JobErrors, cancellation within ≈ 1 s, and the
// transcription glossary (spec, dedupe key, guard report).
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EngineJob, SpeechScoreRequest, TranscriptionResult } from '@jasper/api';
import { FLICKS_PER_SECOND } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobError } from '../src/jobs/types.ts';
import type { SpeechService } from '../src/speech/service.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, JSON_H, makeApp, ROOT, register, TEST_HOST, type TestApp } from './helpers.ts';

const H = { host: TEST_HOST };
const FIXTURE = join(ROOT, 'fixtures', 'speech', 'lj-composite.flac');
const FPS = FLICKS_PER_SECOND / 16_000;
let app: TestApp;
let dir: string;
let specLog: string;
let transcriptionGate: string;
let speech: SpeechService;
let mediaKey: string;
let stopCancellationFixture = async () => {};

/**
 * The fake worker. probe: WebGPU available. score: the first window id picks a behaviour — `crash-gpu` (killed
 * when a GPU is planned), `refuse` (exit 4 with a code), `fail` (exit 3), `hang` (ignores SIGTERM, never ends);
 * otherwise each word is timed to its window and scored −1 per word. Transcription waits for its release receipt.
 */
const FAKE_WORKER = `
import { appendFileSync, existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const argv = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (argv[0] === 'probe') {
	writeFileSync(argv[2], JSON.stringify({ ortVersion: '1.30.0', providers: [
		{ id: 'cuda', available: false, reason: 'no device' }, { id: 'webgpu', available: true }, { id: 'cpu', available: true },
	] }));
	process.exit(0);
}
const scoring = argv[0] === 'score';
const [specPath, outPath] = scoring ? argv.slice(1) : argv;
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
appendFileSync(process.env.FAKE_SPEECH_LOG, JSON.stringify({ mode: scoring ? 'score' : 'transcribe', spec }) + '\\n');
const d = spec.device || { encoder: 'cpu', decoder: 'cpu' };
emit({ type: 'device', encoder: d.encoder, decoder: d.decoder, attempt: 1 });
if (scoring) {
	const mode = spec.windows[0].id;
	emit({ type: 'progress', fraction: 0.5, stage: 'Scoring 1/2' });
	if (mode === 'crash-gpu' && (d.encoder !== 'cpu' || d.decoder !== 'cpu')) {
		process.stderr.write('GPU device lost\\n');
		process.kill(process.pid, 'SIGKILL');
	}
	if (mode === 'refuse') {
		emit({ type: 'error', code: 'SPEECH_READING_TOO_LONG', message: 'A reading has 500 tokens' });
		process.exit(4);
	}
	if (mode === 'fail') {
		emit({ type: 'error', message: 'broken decoder' });
		process.exit(3);
	}
	if (mode === 'hang') {
		process.on('SIGTERM', () => {});
		setInterval(() => {}, 1000);
		writeFileSync(process.env.FAKE_SPEECH_READY, 'ready');
	} else {
		writeFileSync(outPath, JSON.stringify({
			modelId: spec.modelId, language: spec.language, samples: 16000 * 71,
			windows: spec.windows.map((w) => ({ id: w.id, readings: w.readings.map((r) => ({
				id: r.id, logprob: -r.words.length - 0.5, tokens: r.words.length + 1,
				words: r.words.map((t, i) => ({ text: t, tokens: 1, logprob: -1, probability: Math.exp(-1),
					start: w.start + i * 160, end: w.start + (i + 1) * 160 })),
			})) })),
			timings: { decodeMs: 5, loadMs: 6, scoreMs: 7 },
			device: { encoder: d.encoder, decoder: d.decoder, threads: spec.threads, fallbacks: [] },
			profile: { encoderPasses: spec.windows.length, readings: 1, decoderRuns: 1, encoderMs: 1, decoderMs: 2, windowSec: 3 },
			guard: { frames: 'energy' },
		}));
		process.exit(0);
}
} else {
	const gate = process.env.FAKE_SPEECH_GATE;
	if (!existsSync(gate)) await new Promise((resolve) => {
		const ready = () => { if (existsSync(gate)) { watcher.close(); resolve(); } };
		const watcher = watch(dirname(gate), ready);
		ready();
	});
	writeFileSync(outPath, JSON.stringify({
		modelId: spec.modelId, language: 'en', languageProbability: null, task: 'transcribe', samples: 16000 * 20, speakers: 0,
		words: [{ text: 'hello', start: 16000, end: 24000, confidence: 0.9, speaker: null }],
		segments: [], timings: { decodeMs: 1, loadMs: 1, transcribeMs: 4000 },
		device: { encoder: 'cpu', decoder: 'cpu', threads: spec.threads, fallbacks: [] }, calibration: null,
		guard: { skippedWindows: 0, droppedWords: 0, removed: [], frames: 'energy',
			...(spec.glossary ? { glossary: { terms: spec.glossary.length, tokens: 9, events: 1, replaced: 1 } } : {}) },
		profile: { encoderMs: 1, decoderMs: 1, jsMs: 1, decoderRuns: 1, windows: 1 },
	}));
	process.exit(0);
}
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

const logged = () =>
	readFileSync(specLog, 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { mode: string; spec: Record<string, unknown> & { device: unknown } });

const sec = (s: number) => Math.round(s * FLICKS_PER_SECOND);
const req = (id: string, extra: Partial<SpeechScoreRequest> = {}): SpeechScoreRequest => ({
	mediaId: mediaKey,
	language: 'en',
	windows: [
		{
			id,
			start: sec(1.25),
			end: sec(6.5) + 1,
			readings: [
				{ id: 'asr', words: ['the', 'block', 'books,'] },
				{ id: 'script', words: ['the', 'black', 'books,'] },
			],
		},
		{ id: 'w2', start: sec(20), end: sec(28), readings: [{ id: 'asr', words: ['printing'] }] },
	],
	...extra,
});

async function failure(p: Promise<unknown>): Promise<JobError> {
	const e = await p.then(
		() => null,
		(x: unknown) => x,
	);
	expect(e).toBeTruthy();
	return e as JobError;
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'jasper-speech-score-'));
	const worker = join(dir, 'fake-speech.mjs');
	writeFileSync(worker, FAKE_WORKER);
	specLog = join(dir, 'specs.jsonl');
	transcriptionGate = join(dir, 'transcribe.release');
	writeFileSync(specLog, '');
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
		files: [
			file('config.json', '{"num_mel_bins":80}'),
			file('generation_config.json', '{}'),
			file('tokenizer.json', '{}'),
			file('encoder_model.onnx', 'enc'),
			file('decoder_model_merged.onnx', 'dec'),
		],
	};
	writeFileSync(join(dir, 'catalog.json'), JSON.stringify({ models: [], speech: [entry] }));
	process.env.JASPER_MODEL_CATALOG = join(dir, 'catalog.json');
	process.env.JASPER_SPEECH = worker;
	process.env.FAKE_SPEECH_LOG = specLog;
	process.env.FAKE_SPEECH_GATE = transcriptionGate;
	app = await makeApp({ totalSlots: 8 });
	const inst = await app.inject({ method: 'POST', url: '/api/speech/models/test-turbo/install', headers: H });
	expect((await waitJob((inst.json() as EngineJob).id)).state).toBe('succeeded');
	speech = app.jasper.services.speech as SpeechService;
	mediaKey = (await register(app, FIXTURE)).mediaKey;
}, 120_000);

afterAll(async () => {
	await stopCancellationFixture();
	delete process.env.JASPER_MODEL_CATALOG;
	delete process.env.JASPER_SPEECH;
	delete process.env.FAKE_SPEECH_LOG;
	delete process.env.FAKE_SPEECH_GATE;
	await closeApps();
	rmSync(dir, { recursive: true, force: true });
});

describe('SpeechService.score (spec 17 SC-092)', () => {
	it('converts flicks ↔ samples, plans the devices without calibration and returns the spec shape', async () => {
		writeFileSync(specLog, '');
		const stages: string[] = [];
		const res = await speech.score(req('w1'), new AbortController().signal, {
			onProgress: (_, s) => stages.push(s),
		});
		const run = logged();
		expect(run).toHaveLength(1);
		const spec = run[0]!.spec as {
			language: string;
			device: unknown;
			input: { stream?: number };
			windows: Array<{ id: string; start: number; end: number; readings: unknown[] }>;
		};
		expect(run[0]!.mode).toBe('score');
		expect(spec.language).toBe('en');
		// 1.25 s = 20,000 samples; the end rounds up to the next sample
		expect(spec.windows[0]).toMatchObject({ id: 'w1', start: 20_000, end: 104_001 });
		expect(spec.windows[1]).toMatchObject({ start: 320_000, end: 448_000 });
		expect(spec.device).toEqual({ encoder: 'webgpu', decoder: 'cpu', calibrate: null });
		expect(typeof spec.input.stream).toBe('number');
		expect(res.model).toBe('test-turbo');
		expect(res.device).toMatchObject({ encoder: 'webgpu', decoder: 'cpu', fallbacks: [] });
		expect(res.fallback).toBeUndefined();
		const r = res.windows[0]!.readings[1]!;
		expect(res.windows.map((w) => w.id)).toEqual(['w1', 'w2']);
		expect(r).toMatchObject({ id: 'script', logprob: -3.5, tokens: 4 });
		expect(r.words[1]).toEqual({
			text: 'black',
			tokens: 1,
			logprob: -1,
			probability: Math.exp(-1),
			start: Math.round((20_000 + 160) * FPS),
			end: Math.round((20_000 + 320) * FPS),
		});
		expect(res.timings).toMatchObject({ decodeMs: 5, loadMs: 6, scoreMs: 7, encoderPasses: 2 });
		expect(stages.some((s) => s.startsWith('Scoring 1/2'))).toBe(true);
		// processor CPU: no GPU in the plan
		writeFileSync(specLog, '');
		await speech.score(req('w1', { device: 'cpu' }), new AbortController().signal);
		expect(logged()[0]!.spec.device).toEqual({ encoder: 'cpu', decoder: 'cpu', calibrate: null });
	});

	it('passes muted gaps to the worker in samples, rounded inwards; windows without them carry none (SC-030)', async () => {
		writeFileSync(specLog, '');
		const r = req('w1');
		// 2.0 s + 1 flick … 4.5 s − 1 flick: the first whole sample after the start, the last whole one before the end
		r.windows[0]!.mute = [
			{ start: sec(2) + 1, end: sec(4.5) - 1 },
			{ start: sec(5), end: sec(5) + 10 },
		];
		await speech.score(r, new AbortController().signal);
		const spec = logged()[0]!.spec as unknown as { windows: Array<{ id: string; mute?: unknown }> };
		// the second range is shorter than a sample: dropped
		expect(spec.windows[0]!.mute).toEqual([{ start: 32_001, end: 71_999 }]);
		expect('mute' in spec.windows[1]!).toBe(false);
		const outside = req('w1');
		outside.windows[0]!.mute = [{ start: sec(1), end: sec(2) }];
		expect((await failure(speech.score(outside, new AbortController().signal))).code).toBe('INVALID_SPEC');
	});

	it('validates the request and the media: INVALID_SPEC, ASSET_NOT_FOUND, NO_AUDIO, SPEECH_MODEL_UNKNOWN', async () => {
		const signal = new AbortController().signal;
		const bad = await failure(speech.score({ ...req('w1'), windows: [] }, signal));
		expect(bad.code).toBe('INVALID_SPEC');
		const long = req('w1');
		long.windows[0]!.end = long.windows[0]!.start + sec(31);
		expect((await failure(speech.score(long, signal))).code).toBe('INVALID_SPEC');
		expect(
			(await failure(speech.score({ ...req('w1'), extra: 1 } as unknown as SpeechScoreRequest, signal))).code,
		).toBe('INVALID_SPEC');
		expect((await failure(speech.score(req('w1', { language: 'auto' }), signal))).code).toBe('INVALID_SPEC');
		expect((await failure(speech.score(req('w1', { mediaId: 'nope' }), signal))).code).toBe(
			'ASSET_NOT_FOUND',
		);
		expect((await failure(speech.score(req('w1', { streamIndex: 9 }), signal))).code).toBe('NO_AUDIO');
		expect((await failure(speech.score(req('w1', { model: 'whisper-huge' }), signal))).code).toBe(
			'SPEECH_MODEL_UNKNOWN',
		);
	});

	it('a GPU worker that crashes → scored once more on the CPU; the result names the fallback (SC-035)', async () => {
		writeFileSync(specLog, '');
		const res = await speech.score(req('crash-gpu'), new AbortController().signal);
		const runs = logged();
		expect(runs.map((r) => r.spec.device)).toEqual([
			{ encoder: 'webgpu', decoder: 'cpu', calibrate: null },
			{ encoder: 'cpu', decoder: 'cpu', calibrate: null },
		]);
		expect(res.device).toMatchObject({ encoder: 'cpu', decoder: 'cpu', label: 'CPU' });
		expect(res.fallback).toMatchObject({ stage: 'job', from: 'webgpu', to: 'cpu' });
		expect(res.fallback?.reason).toMatch(/GPU device lost|killed/);
		expect(res.device.fallbacks).toEqual([res.fallback]);
	});

	it('worker refusals and failures become JobErrors {code, message, retryable}; refusals are not retried', async () => {
		writeFileSync(specLog, '');
		const refused = await failure(speech.score(req('refuse'), new AbortController().signal));
		expect(refused).toMatchObject({ code: 'SPEECH_READING_TOO_LONG', retryable: false });
		expect(refused.message).toMatch(/500 tokens/);
		expect(logged()).toHaveLength(1);
		writeFileSync(specLog, '');
		const failed = await failure(speech.score(req('fail', { device: 'cpu' }), new AbortController().signal));
		expect(failed).toMatchObject({
			code: 'SPEECH_SCORE_FAILED',
			retryable: false,
			message: 'broken decoder',
		});
		expect(logged()).toHaveLength(1);
	});

	it('cancellation kills a worker that ignores SIGTERM after its grace period (SC-036)', async () => {
		const ac = new AbortController();
		const readyFile = join(dir, 'hang.ready');
		process.env.FAKE_SPEECH_READY = readyFile;
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const watcher = watch(dir, () => {
			if (existsSync(readyFile)) ready();
		});
		let worker: ChildProcess | undefined;
		let exited = Promise.resolve<NodeJS.Signals | null>(null);
		const result = failure(
			speech.score(req('hang', { device: 'cpu' }), ac.signal, {
				trackChild: (child) => {
					worker = child;
					exited = new Promise((resolve) => child.once('exit', (_, signal) => resolve(signal)));
				},
			}),
		);
		void result.catch(() => {});
		stopCancellationFixture = async () => {
			watcher.close();
			delete process.env.FAKE_SPEECH_READY;
			vi.useRealTimers();
			if (worker?.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
			await exited;
		};
		try {
			await started;
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			ac.abort();
			await vi.advanceTimersByTimeAsync(1000);
			expect((await result).code).toBe('JOB_CANCELLED');
			expect(await exited).toBe('SIGKILL');
		} finally {
			await stopCancellationFixture();
			await result.catch(() => {});
		}
	}, 30_000);
});

describe('transcription glossary (SC-074)', () => {
	it('is validated, normalised into the worker spec, part of the dedupe key, and its guard is reported', async () => {
		const bad = await app.inject({
			method: 'POST',
			url: `/api/media/${mediaKey}/transcribe`,
			headers: JSON_H,
			payload: { glossary: Array.from({ length: 41 }, (_, i) => `T${i}`) },
		});
		expect(bad.statusCode).toBe(400);
		writeFileSync(specLog, '');
		const submit = async (glossary?: string[]) =>
			(
				await app.inject({
					method: 'POST',
					url: `/api/media/${mediaKey}/transcribe`,
					headers: JSON_H,
					payload: { language: 'en', device: 'cpu', ...(glossary ? { glossary } : {}) },
				})
			).json() as EngineJob;
		const a = await submit([' NovaPlay ', 'Glimmerbox', 'novaplay']);
		const a2 = await submit(['NovaPlay', 'Glimmerbox']);
		const b = await submit(['Pixelforge']);
		const c = await submit();
		writeFileSync(transcriptionGate, 'release');
		expect(a2.id).toBe(a.id);
		expect(new Set([a.id, b.id, c.id]).size).toBe(3);
		const done = await waitJob(a.id);
		expect(done.state).toBe('succeeded');
		await Promise.all([waitJob(b.id), waitJob(c.id)]);
		const specs = logged().filter((r) => r.mode === 'transcribe');
		expect(specs.map((s) => s.spec.glossary ?? null)).toEqual(
			expect.arrayContaining([['NovaPlay', 'Glimmerbox'], ['Pixelforge'], null]),
		);
		expect((done.result as TranscriptionResult).guard?.glossary).toEqual({
			terms: 2,
			tokens: 9,
			events: 1,
			replaced: 1,
		});
	}, 60_000);
});
