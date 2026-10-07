// wp speech end to end with REAL Whisper models on a public-domain speech fixture (fixtures/speech/lj-composite.flac:
// twelve LJ Speech sentences with measured onsets/offsets, 71.6 s = three Whisper windows).
//
// Runs when the models are in the speech model cache — `$JASPER_SPEECH_MODELS_DIR`, else `<repo>/target/speech-models`
// (`<id>/` holding the catalogue files) — or with SPEECH_E2E=1, which downloads them there first through the
// catalogue's verified installer (whisper-tiny.en 154 MB, whisper-tiny 154 MB). Otherwise it reports itself skipped.
//
// Through the engine's HTTP API: POST /api/media/:key/transcribe (`transcription` job → jasper-speech child process),
// the sequence-mix job, cancellation; asserts the word error rate and word-timestamp accuracy against the ground truth
// and that the transcript commits with `transcript.attach`.
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineJob, TranscriptionResult } from '@jasper/api';
import { distributeSequenceWords, FLICKS_PER_SECOND, sequenceWords } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/processing/models.ts';
import { wordErrorRate } from '../src/speech/core/wer.ts';
import { SpeechModelStore } from '../src/speech/models.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, ROOT, register, type TestApp, until } from './helpers.ts';

const CACHE = process.env.JASPER_SPEECH_MODELS_DIR ?? join(ROOT, 'target', 'speech-models');
const MODELS = ['whisper-tiny.en', 'whisper-tiny'];
const store = new SpeechModelStore(CACHE, loadCatalog({}).speech);
const present = await Promise.all(MODELS.map(async (id) => store.installed(store.entry(id)!)));
const enabled = process.env.SPEECH_E2E === '1' || present.every(Boolean);

const FIXTURE = join(ROOT, 'fixtures', 'speech', 'lj-composite.flac');
type Truth = {
	utterances: Array<{ file: string; text: string; start: number; end: number }>;
	durationSeconds: number;
};
const truth = JSON.parse(readFileSync(FIXTURE.replace(/\.flac$/, '.json'), 'utf8')) as Truth;
const reference = truth.utterances.map((u) => u.text).join(' ');
const H = { host: '127.0.0.1:47900' };

let app: TestApp;

async function waitJob(id: string, timeoutMs = 300_000): Promise<EngineJob> {
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

/** Boundary error of every utterance's first word start / last word end, and words outside the speech. */
function timing(words: Array<{ start: number; end: number }>, offsetSec = 0) {
	const errs: number[] = [];
	for (const u of truth.utterances) {
		const mine = words.filter((w) => {
			const mid = (w.start + w.end) / 2 / FLICKS_PER_SECOND - offsetSec;
			return mid >= u.start - 0.5 && mid <= u.end + 0.5;
		});
		if (!mine.length) {
			errs.push(99);
			continue;
		}
		errs.push(Math.abs(mine[0]!.start / FLICKS_PER_SECOND - offsetSec - u.start));
		errs.push(Math.abs(mine[mine.length - 1]!.end / FLICKS_PER_SECOND - offsetSec - u.end));
	}
	const outside = words.filter(
		(w) =>
			!truth.utterances.some(
				(u) =>
					w.start / FLICKS_PER_SECOND - offsetSec >= u.start - 0.15 &&
					w.end / FLICKS_PER_SECOND - offsetSec <= u.end + 0.15,
			),
	).length;
	errs.sort((a, b) => a - b);
	return { mean: errs.reduce((a, b) => a + b, 0) / errs.length, max: errs[errs.length - 1]!, outside };
}

describe.skipIf(!enabled)('speech-to-text with real Whisper models (wp speech)', () => {
	beforeAll(async () => {
		for (const id of MODELS) {
			const e = store.entry(id)!;
			if (!(await store.installed(e))) await store.install(id);
		}
		app = await makeApp({ totalSlots: 4 });
		const dir = join(app.appdir, 'models', 'speech');
		mkdirSync(dir, { recursive: true });
		for (const id of MODELS)
			if (!existsSync(join(dir, id))) symlinkSync(join(CACHE, id), join(dir, id), 'dir');
	}, 1_800_000);

	afterAll(async () => {
		await closeApps();
	});

	it('lists the installed models and reports the capability', async () => {
		const r = await app.inject({ method: 'GET', url: '/api/speech/models', headers: H });
		const models = (r.json() as { models: Array<{ id: string; installed: boolean; license: string }> })
			.models;
		for (const id of MODELS) expect(models.find((m) => m.id === id)?.installed).toBe(true);
		expect(models.every((m) => /MIT/.test(m.license))).toBe(true);
		const caps = (await app.inject({ method: 'GET', url: '/api/capabilities', headers: H })).json() as {
			features?: { speech?: { status: string; modelsInstalled: number } };
		};
		expect(caps.features?.speech?.status).toBe('ready');
		expect(caps.features?.speech?.modelsInstalled).toBeGreaterThanOrEqual(2);
	});

	it('transcribes the media (English model): WER ≤ 4 %, word bounds within 60 ms on average', async () => {
		const m = await register(app, FIXTURE);
		const r = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/transcribe?wait=1`,
			headers: JSON_H,
			payload: { model: 'whisper-tiny.en', language: 'en' },
		});
		expect(r.statusCode, r.body).toBe(200);
		const res = (r.json() as EngineJob).result as TranscriptionResult;
		const hyp = res.words.map((w) => w.text).join(' ');
		const wer = wordErrorRate(reference, hyp);
		const t = timing(res.words);
		console.log(
			`whisper-tiny.en: WER ${(wer * 100).toFixed(2)} %, boundary error mean ${(t.mean * 1000).toFixed(0)} ms max ${(t.max * 1000).toFixed(0)} ms, outside ${t.outside}; ${res.timings.transcribeMs} ms`,
		);
		// measured 2026-10-07: 1.9 % WER, 18 ms mean / 40 ms max (FilmCraft has no English-only model)
		expect(wer).toBeLessThanOrEqual(0.04);
		expect(t.mean).toBeLessThanOrEqual(0.06);
		expect(t.max).toBeLessThanOrEqual(0.25);
		expect(t.outside).toBe(0);
		expect(res.language).toBe('en');
		expect(Math.abs(res.duration - truth.durationSeconds * FLICKS_PER_SECOND)).toBeLessThan(
			FLICKS_PER_SECOND / 1000,
		);
		// words sorted, non-overlapping, confident, inside the audio
		for (let i = 1; i < res.words.length; i++)
			expect(res.words[i]!.start).toBeGreaterThanOrEqual(res.words[i - 1]!.end);
		expect(res.words.at(-1)!.end).toBeLessThanOrEqual(res.duration);
		expect(res.words.filter((w) => w.confidence > 0.5).length / res.words.length).toBeGreaterThan(0.9);

		// the client commits it: one media transcript, read back through a clip of the media
		const d = new DocBuilder();
		const mediaId = d.addMedia(m);
		d.tx([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { audio: 'A1' } }]);
		d.tx([
			{
				type: 'transcript.attach',
				mediaId,
				language: res.language,
				words: res.words,
				speakers: res.speakers,
				model: res.model,
			},
		]);
		const words = sequenceWords(d.doc, d.doc.sequences[d.seqId]!);
		expect(words.length).toBe(res.words.length);
	}, 600_000);

	it('detects the language with the multilingual model and labels a single reader as one speaker', async () => {
		const m = await register(app, FIXTURE);
		const r = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/transcribe?wait=1`,
			headers: JSON_H,
			payload: { model: 'whisper-tiny', speakerLabels: true },
		});
		expect(r.statusCode, r.body).toBe(200);
		const res = (r.json() as EngineJob).result as TranscriptionResult;
		const wer = wordErrorRate(reference, res.words.map((w) => w.text).join(' '));
		const t = timing(res.words);
		console.log(
			`whisper-tiny (auto): ${res.language} p=${res.languageProbability?.toFixed(3)}, WER ${(wer * 100).toFixed(2)} %, boundary mean ${(t.mean * 1000).toFixed(0)} ms max ${(t.max * 1000).toFixed(0)} ms, speakers ${Object.keys(res.speakers).length}`,
		);
		expect(res.language).toBe('en');
		expect(res.languageProbability).toBeGreaterThan(0.8);
		// measured: 5.8 % (FilmCraft whisper-tiny on the same file: 6.4 %); 18 ms mean (FilmCraft: 438 ms)
		expect(wer).toBeLessThanOrEqual(0.1);
		expect(t.mean).toBeLessThanOrEqual(0.06);
		expect(t.outside).toBe(0);
		expect(Object.keys(res.speakers)).toEqual(['S1']);
		expect(res.words.every((w) => w.speaker === 'S1')).toBe(true);
	}, 600_000);

	it('transcribes a sequence mix and gives the words back to the clip media in media time', async () => {
		const m = await register(app, FIXTURE);
		const d = new DocBuilder();
		const mediaId = d.addMedia(m);
		// the media from 14 s on, placed at 2 s of the sequence (frame 60 at 30 fps)
		d.tx([
			{
				type: 'clip.place',
				source: { mediaId },
				sourceRange: { in: { seconds: 14 }, out: { seconds: 43 } },
				at: 60,
				tracks: { audio: 'A1' },
			},
		]);
		const r = await app.inject({
			method: 'POST',
			url: '/api/speech/transcribe-sequence?wait=1',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, model: 'whisper-tiny.en' },
		});
		expect(r.statusCode, r.body).toBe(200);
		const res = (r.json() as EngineJob).result as TranscriptionResult;
		expect(res.target.type).toBe('sequence');
		// sequence time: the media's 14 s sits at 2 s
		const media = distributeSequenceWords(d.doc, d.seqId, res.words);
		expect(media.unassigned).toBe(0);
		expect(media.media).toHaveLength(1);
		const mw = media.media[0]!;
		expect(mw.coverage).toEqual([[14 * FLICKS_PER_SECOND, 43 * FLICKS_PER_SECOND]]);
		const inRange = truth.utterances.filter((u) => u.start >= 14 && u.end <= 43);
		const ref = inRange.map((u) => u.text).join(' ');
		const hyp = mw.words.map((w) => w.text).join(' ');
		const wer = wordErrorRate(ref, hyp);
		console.log(`sequence mix: WER ${(wer * 100).toFixed(2)} % over ${inRange.length} sentences`);
		expect(wer).toBeLessThanOrEqual(0.08);
		for (const u of inRange) {
			const first = mw.words.find((w) => w.start / FLICKS_PER_SECOND >= u.start - 0.3);
			expect(Math.abs(first!.start / FLICKS_PER_SECOND - u.start)).toBeLessThan(0.15);
		}
		d.tx([
			{
				type: 'transcript.attach',
				mediaId,
				language: res.language,
				words: mw.words,
				coverage: mw.coverage,
				model: res.model,
			},
		]);
		const t = Object.values(d.doc.transcripts)[0]!;
		expect(t.coverage).toEqual(mw.coverage);
	}, 600_000);

	it('cancels a running transcription (the child process is killed)', async () => {
		const m = await register(app, FIXTURE);
		const r = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/transcribe`,
			headers: JSON_H,
			payload: { model: 'whisper-tiny', language: 'de' },
		});
		const job = r.json() as EngineJob;
		await until(async () => {
			const j = (
				await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: H })
			).json() as EngineJob;
			return j.state === 'running' && (j.progress ?? 0) > 0.03 ? j : null;
		}, 120_000);
		await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: H });
		const done = await waitJob(job.id, 60_000);
		expect(done.state).toBe('cancelled');
	}, 300_000);
});
