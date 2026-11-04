// Run: JASPER_SPEECH_MODELS_DIR=<dir> pnpm exec tsx apps/engine/bench/transcript-fix.ts
// SC-037: the original short-LJ whole-job measurement (request to stored proposal), median of three trials.
// Uses the installed whisper-large-v3-turbo when available, otherwise whisper-tiny.en; pinned model setup is
// unchanged from the real-model fixture. Hold the benchmark lock when comparing measurements.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { cpus, loadavg, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	type EngineJob,
	MediaRegisterResponseSchema,
	TranscriptFixResultSchema,
	TranscriptionResultSchema,
} from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import { makeEnvelope } from '@jasper/project';
import type { LightMyRequestResponse } from 'fastify';
import { createServer, engineConfig, prepareAppdir } from '../src/index.ts';
import { loadCatalog } from '../src/processing/models.ts';
import { SpeechModelStore } from '../src/speech/models.ts';
import { coreServices } from '../src/tools/services.ts';
import { corrupt, scriptOf, transcriptFixDocument, type Word } from '../test/transcript-fix-fixture.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CACHE = process.env.JASPER_SPEECH_MODELS_DIR ?? join(ROOT, 'target', 'speech-models');
const FIXTURE = join(ROOT, 'fixtures', 'speech', 'lj-composite.flac');
const MODEL = 'whisper-tiny.en';
const TURBO = 'whisper-large-v3-turbo';
const TRIALS = 3;
const truth = JSON.parse(readFileSync(FIXTURE.replace(/\.flac$/, '.json'), 'utf8')) as {
	utterances: { text: string; start: number; end: number }[];
};
const speechMinutes = truth.utterances.reduce((n, u) => n + (u.end - u.start), 0) / 60;
assert.ok(Number.isFinite(speechMinutes) && speechMinutes > 0, 'Fixture must contain speech');
const store = new SpeechModelStore(CACHE, loadCatalog({}).speech);
const model = (await store.installed(store.entry(TURBO)!)) ? TURBO : MODEL;
const appdir = mkdtempSync(join(tmpdir(), 'jasper-transcript-fix-bench-'));
let app: Awaited<ReturnType<typeof createServer>> | undefined;
try {
	if (!(await store.installed(store.entry(MODEL)!))) await store.install(MODEL);
	prepareAppdir(appdir);
	const token = randomBytes(32).toString('base64url');
	const config = engineConfig({ appdir, port: 0, dev: true, token, webDir: null, env: {} });
	app = await createServer(config, { env: { PATH: process.env.PATH }, totalSlots: 8 });
	await app.ready();
	const headers = {
		host: '127.0.0.1:0',
		authorization: `Bearer ${token}`,
		'content-type': 'application/json',
	};
	const modelsDir = join(appdir, 'models', 'speech');
	mkdirSync(modelsDir, { recursive: true });
	for (const id of new Set([MODEL, model]))
		if (!existsSync(join(modelsDir, id))) symlinkSync(join(CACHE, id), join(modelsDir, id), 'dir');
	const register = await app.inject({
		method: 'POST',
		url: '/api/media/register',
		headers,
		payload: { projectId: 'prj_0000000000000001', paths: [FIXTURE] },
	});
	assert.equal(register.statusCode, 200, register.body);
	const registered = MediaRegisterResponseSchema.parse(register.json());
	assert.equal(registered.items.length, 1, register.body);
	const reg = registered.items[0]!;
	const queue = coreServices(app).queue;
	let truthWords: Word[] = [];
	for (const id of new Set([MODEL, model])) {
		const transcription: LightMyRequestResponse = await app.inject({
			method: 'POST',
			url: `/api/media/${reg.mediaKey}/transcribe`,
			headers,
			payload: { model: id, language: 'en', device: 'cpu' },
		});
		assert.equal(transcription.statusCode, 202, transcription.body);
		const transcribed = await queue.wait((transcription.json() as EngineJob).id);
		assert.equal(transcribed.state, 'succeeded', JSON.stringify(transcribed.error));
		const transcript = TranscriptionResultSchema.parse(transcribed.result);
		if (id === model)
			truthWords = transcript.words.map((w) => ({
				text: w.text,
				start: w.start,
				end: w.end,
				confidence: w.confidence ?? null,
			}));
	}
	const { words, at } = corrupt(truthWords);
	console.log(
		`FIX_BENCH_MACHINE ${JSON.stringify({
			node: process.version,
			cpu: cpus()[0]?.model,
			cores: cpus().length,
			memoryBytes: totalmem(),
			load: loadavg(),
			fixture: 'fixtures/speech/lj-composite.flac',
			corruptions: at.size,
			trials: TRIALS,
		})}`,
	);
	const runs: number[] = [];
	let last: ReturnType<typeof TranscriptFixResultSchema.parse> | null = null;
	for (let k = 0; k < TRIALS; k++) {
		const { doc, seqId } = transcriptFixDocument(
			reg,
			words,
			scriptOf(truthWords),
			model,
			`prj_E${(k + 1).toString().padStart(15, '0')}`,
		);
		const file = appdirPaths(appdir).projectFile(doc.projectId);
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify(
				makeEnvelope(doc, {
					revision: 3,
					savedAt: '2026-10-27T00:00:00.000Z',
					platform: 'test',
				}),
			),
		);
		const t0 = performance.now();
		const response: LightMyRequestResponse = await app.inject({
			method: 'POST',
			url: `/api/projects/${doc.projectId}/sequences/${seqId}/transcript-fix`,
			headers,
			payload: { mode: 'propose', device: 'cpu', sources: ['script'] },
		});
		assert.equal(response.statusCode, 202, response.body);
		const done = await queue.wait((response.json() as EngineJob).id);
		assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
		last = TranscriptFixResultSchema.parse(done.result);
		runs.push((performance.now() - t0) / 1000);
	}
	runs.sort((a, b) => a - b);
	const median = runs[1]!;
	console.log(
		`FIX_BENCH ${JSON.stringify({
			model,
			runsSec: runs,
			medianSec: median,
			speechMinutes: Math.round(speechMinutes * 1000) / 1000,
			perSpeechMinuteSec: Math.round((median / speechMinutes) * 10) / 10,
			windows: last!.report.perMedia[0]!.windows,
			readings: last!.report.perMedia[0]!.readings,
			timings: last!.report.timings,
			device: last!.report.device,
			slots: queue.totalSlots,
			load: loadavg(),
		})}`,
	);
} finally {
	try {
		await app?.close();
	} finally {
		rmSync(appdir, { recursive: true, force: true });
	}
}
