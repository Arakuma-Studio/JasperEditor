// Fix Transcript cost on a representative input (spec 17 SC-037: ≤ 20 s per speech minute for the whole job on the
// build VM CPU). Opt-in: TRANSCRIPT_FIX_BENCH=1, a real model (JASPER_SPEECH_MODELS_DIR, whisper-large-v3-turbo
// preferred, else whisper-tiny.en) and `pnpm fixtures` (fixtures/media/lj-long.flac, scripts/fixtures/speech-long.mjs).
// Run it under the bench lock.
//
// Input: the LJ composite played 11 times (10.6 min of speech) read from ONE script (11 takes: retakes, as the user
// records), transcribed by the model (the composite's transcript shifted per take: the audio repeats sample-exactly).
// Candidates at the research density (≈ 6.3 per speech minute, ≈ 1.9 of them real recognition errors; spec 17 §0):
// per take, 2 transcript words corrupted with typical confusions (real fixes, a different pair each take) and 4
// script words corrupted (deviations the audio must keep). Three full `transcript-fix` jobs (propose, CPU), median;
// `FIX_LONG_BENCH` prints the split (model load, decode, encoder, decoder, alignment) per speech minute, the load
// average and the decisions. TRANSCRIPT_FIX_BENCH_OUT=<file> writes the decisions (ids, groups, Δ_tok) for
// before/after equivalence checks of optimisations.
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import {
	type EngineJob,
	mediaRegisterCommand,
	type RegisteredMedia,
	type TranscriptFixResult,
	TranscriptFixResultSchema,
	type TranscriptionResult,
} from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import {
	applyTransaction,
	cleanupNorm,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	makeEnvelope,
	type ProjectDocument,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/processing/models.ts';
import { SpeechModelStore } from '../src/speech/models.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, JSON_H, makeApp, ROOT, register, type TestApp, until } from './helpers.ts';

const CACHE = process.env.JASPER_SPEECH_MODELS_DIR ?? join(ROOT, 'target', 'speech-models');
const store = new SpeechModelStore(CACHE, loadCatalog({}).speech);
const TURBO = 'whisper-large-v3-turbo';
const MODEL = (await store.installed(store.entry(TURBO)!)) ? TURBO : 'whisper-tiny.en';
const SHORT = join(ROOT, 'fixtures', 'speech', 'lj-composite.flac');
const LONG = join(ROOT, 'fixtures', 'media', 'lj-long.flac');
const REPEATS = 11;
const enabled =
	process.env.TRANSCRIPT_FIX_BENCH === '1' &&
	existsSync(LONG) &&
	(await store.installed(store.entry(MODEL)!));

type Truth = { utterances: Array<{ text: string; start: number; end: number }>; durationSeconds: number };
const truth = JSON.parse(readFileSync(SHORT.replace(/\.flac$/, '.json'), 'utf8')) as Truth;
const F = FLICKS_PER_SECOND;
const TAKE_FLICKS = Math.round(truth.durationSeconds * F);
const SPEECH_MINUTES = (REPEATS * truth.utterances.reduce((n, u) => n + (u.end - u.start), 0)) / 60;
const H = { host: '127.0.0.1:47900' };

/** Recognition errors put into the transcript (two per take, rotating) … */
const TRANSCRIPT_PAIRS: Array<[string, string]> = [
	['block', 'black'],
	['prisoners', 'prisons'],
	['slept', 'slapped'],
	['wall', 'war'],
	['egg', 'leg'],
	['forged', 'forget'],
];
/** … and deviations put into the script (what the speaker did not read; the audio must keep the transcript). */
const SCRIPT_PAIRS: Array<[string, string]> = [
	['carton', 'cartoon'],
	['topic', 'tropic'],
	['yeast', 'east'],
	['stock', 'stack'],
];

type Word = { text: string; start: number; end: number; confidence: number | null };
let app: TestApp;
let reg: RegisteredMedia;
let take: Word[] = [];

async function waitJob(id: string, timeoutMs = 1_800_000): Promise<EngineJob> {
	return until(
		async () => {
			const j = (await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: H })).json() as EngineJob;
			return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state) ? j : null;
		},
		timeoutMs,
		500,
	);
}

const swapWord = (text: string, to: string) =>
	text.replace(/[A-Za-z']+/, (m) => (m[0] === m[0]!.toUpperCase() ? to[0]!.toUpperCase() + to.slice(1) : to));
const swapIn = (words: Word[], pair: [string, string]) => {
	const i = words.findIndex((w) => cleanupNorm(w.text) === pair[0]);
	if (i >= 0) words[i] = { ...words[i]!, text: swapWord(words[i]!.text, pair[1]) };
	return i >= 0;
};

/** The long transcript (11 takes, two recognition errors each) and how many errors went in. */
function longTranscript(): { words: Word[]; errors: number } {
	const out: Word[] = [];
	let errors = 0;
	for (let k = 0; k < REPEATS; k++) {
		const words = take.map((w) => ({ ...w, start: w.start + k * TAKE_FLICKS, end: w.end + k * TAKE_FLICKS }));
		for (const j of [(2 * k) % TRANSCRIPT_PAIRS.length, (2 * k + 1) % TRANSCRIPT_PAIRS.length])
			if (swapIn(words, TRANSCRIPT_PAIRS[j]!)) errors++;
		out.push(...words);
	}
	return { words: out, errors };
}

/** One read of the text (a line per sentence) with the script deviations. */
function script(): string {
	const words = take.map((w) => ({ ...w }));
	for (const p of SCRIPT_PAIRS) swapIn(words, p);
	return words
		.map((w) => w.text)
		.join(' ')
		.replace(/([.!?]) /g, '$1\n');
}

let projects = 0;
function seed(words: Word[], text: string) {
	const ids = createCounterIdSource(11);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Fix bench', preset: 'hd-1080p-30' });
	doc = { ...doc, projectId: `prj_B${(++projects).toString().padStart(15, '0')}` };
	const seqId = Object.keys(doc.sequences)[0]!;
	const r = applyTransaction(
		doc,
		{
			label: 'seed',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				mediaRegisterCommand(reg, '$a', '$ai', 'lj-long'),
				{ type: 'transcript.create', mediaId: '$a', language: 'en', origin: 'whisper-local', words },
				{
					type: 'clip.place',
					source: { mediaId: '$a' },
					at: 0,
					tracks: { audio: 'A1' },
					video: false,
					audio: true,
				},
				{ type: 'cleanup.configure', sequenceId: seqId, script: { name: 'Script', text } },
			] as never[],
		},
		{ ids, now: () => '2026-10-27T00:00:00.000Z', revision: 0, registries: defaultRegistries() },
	);
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	doc = {
		...r.document,
		transcripts: Object.fromEntries(
			Object.entries(r.document.transcripts).map(([k, t]) => [k, { ...t, model: MODEL }]),
		),
	};
	const file = appdirPaths(app.appdir).projectFile(doc.projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(makeEnvelope(doc, { revision: 3, savedAt: '2026-10-27T00:00:00.000Z', platform: 'test' })),
	);
	return { projectId: doc.projectId, seqId };
}

const perMin = (ms: number) => Math.round((ms / 1000 / SPEECH_MINUTES) * 100) / 100;

describe.skipIf(!enabled)('Fix Transcript cost on 10.6 min of speech (SC-037)', () => {
	beforeAll(async () => {
		app = await makeApp();
		const dir = join(app.appdir, 'models', 'speech');
		mkdirSync(dir, { recursive: true });
		if (!existsSync(join(dir, MODEL))) symlinkSync(join(CACHE, MODEL), join(dir, MODEL), 'dir');
		const short = await register(app, SHORT);
		const r = await app.inject({
			method: 'POST',
			url: `/api/media/${short.mediaKey}/transcribe`,
			headers: JSON_H,
			payload: { model: MODEL, language: 'en', device: 'cpu' },
		});
		expect(r.statusCode, r.body).toBe(202);
		const done = await waitJob((r.json() as EngineJob).id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		take = (done.result as TranscriptionResult).words.map((w) => ({
			text: w.text,
			start: w.start,
			end: w.end,
			confidence: w.confidence ?? null,
		}));
		reg = await register(app, LONG);
	}, 1_800_000);

	afterAll(async () => {
		await closeApps();
	});

	it('the whole job per speech minute, with its split', async () => {
		const { words, errors } = longTranscript();
		const text = script();
		const runs: Array<{ wallMs: number; result: TranscriptFixResult; load: number[] }> = [];
		for (let k = 0; k < 3; k++) {
			const s = seed(words, text);
			const load = loadavg().map((x) => Math.round(x * 100) / 100);
			const t0 = Date.now();
			const r = await app.inject({
				method: 'POST',
				url: `/api/projects/${s.projectId}/sequences/${s.seqId}/transcript-fix`,
				headers: JSON_H,
				payload: { mode: 'propose', device: 'cpu', sources: ['script'] },
			});
			expect(r.statusCode, r.body).toBe(202);
			const done = await waitJob((r.json() as EngineJob).id);
			expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
			runs.push({
				wallMs: Date.now() - t0,
				result: TranscriptFixResultSchema.parse(done.result),
				load: [...load, ...loadavg().map((x) => Math.round(x * 100) / 100)],
			});
		}
		const order = [...runs].sort((a, b) => a.wallMs - b.wallMs);
		const med = order[1]!;
		const rep = med.result.report;
		const sp = rep.timings.speech!;
		const decisions = rep.decisions.map((d) => ({
			id: d.candidateId,
			group: d.group,
			rule: d.rule,
			deltaTok: d.deltaTok === null ? null : Math.round(d.deltaTok * 1e6) / 1e6,
		}));
		if (process.env.TRANSCRIPT_FIX_BENCH_OUT)
			writeFileSync(
				process.env.TRANSCRIPT_FIX_BENCH_OUT,
				JSON.stringify({ model: MODEL, decisions }, null, 1),
			);
		console.log(
			`FIX_LONG_BENCH ${JSON.stringify({
				model: MODEL,
				machine: {
					cpus: availableParallelism(),
					cpu: cpus()[0]?.model,
					slots: coreServices(app).queue.totalSlots,
				},
				speechMinutes: Math.round(SPEECH_MINUTES * 1000) / 1000,
				injectedErrors: errors,
				candidates: rep.candidates,
				candidatesPerSpeechMinute: Math.round((rep.candidates.total / SPEECH_MINUTES) * 100) / 100,
				runsSec: runs.map((x) => Math.round(x.wallMs) / 1000),
				loadAvgBeforeAfter: runs.map((x) => x.load),
				medianSec: med.wallMs / 1000,
				perSpeechMinuteSec: perMin(med.wallMs),
				split: {
					loadPerMin: perMin(sp.loadMs),
					decodePerMin: perMin(sp.decodeMs),
					encoderPerMin: perMin(sp.encoderMs),
					decoderPerMin: perMin(sp.decoderMs),
					workerScorePerMin: perMin(sp.workerScoreMs),
					alignPerMin: perMin(rep.timings.alignMs),
					decidePerMin: perMin(rep.timings.decideMs),
					rest: perMin(med.wallMs - rep.timings.scoreMs - rep.timings.alignMs - rep.timings.decideMs),
				},
				work: {
					encoderPasses: sp.encoderPasses,
					decoderRuns: sp.decoderRuns,
					readings: sp.readings,
					windowSec: sp.windowSec,
					windows: rep.perMedia[0]!.windows,
				},
				device: rep.device,
				timings: rep.timings,
			})}`,
		);
		// the injected errors are fixed and the script's deviations kept
		expect(rep.candidates.byGroup.fix ?? 0).toBe(errors);
		expect(rep.candidates.byGroup.spelling ?? 0).toBe(0);
	}, 3_600_000);
});
