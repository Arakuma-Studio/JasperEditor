// Public-domain LJ Speech fixture: twelve sentences with measured onsets/offsets, 71.6 s (three Whisper windows).
// Uses JASPER_SPEECH_MODELS_DIR or target/speech-models; SPEECH_E2E=1 downloads missing models via the verified installer.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob, TranscriptionResult } from '@jasper/api';
import { FLICKS_PER_SECOND } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/processing/models.ts';
import { WhisperTokenizer } from '../src/speech/core/tokenizer.ts';
import { SpeechModelStore } from '../src/speech/models.ts';
import { decodeAudio } from '../src/speech/worker/run.ts';
import { VERBATIM_PROMPTS } from '../src/speech/worker/whisper.ts';
import { resolveBinaries } from '../src/tools/ffmpeg.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, ROOT, register, type TestApp, until } from './helpers.ts';
import { wordErrorRate } from './speech-wer.ts';

const CACHE = process.env.JASPER_SPEECH_MODELS_DIR ?? join(ROOT, 'target', 'speech-models');
const MODELS = ['whisper-tiny.en', 'whisper-tiny'];
const store = new SpeechModelStore(CACHE, loadCatalog({}).speech);
const present = await Promise.all(MODELS.map(async (id) => store.installed(store.entry(id)!)));
const enabled = process.env.SPEECH_E2E === '1' || present.every(Boolean);
/** spec 16: large-v3-turbo from a local directory with the catalogue's files (e.g. the build VM's model cache). */
const TURBO_DIR = process.env.JASPER_SPEECH_TURBO_DIR ?? null;

/** 16-bit PCM mono 16 kHz WAV. */
function wav(samples: Float32Array): Buffer {
	const b = Buffer.alloc(44 + samples.length * 2);
	b.write('RIFF', 0);
	b.writeUInt32LE(36 + samples.length * 2, 4);
	b.write('WAVEfmt ', 8);
	b.writeUInt32LE(16, 16);
	b.writeUInt16LE(1, 20);
	b.writeUInt16LE(1, 22);
	b.writeUInt32LE(16_000, 24);
	b.writeUInt32LE(32_000, 28);
	b.writeUInt16LE(2, 32);
	b.writeUInt16LE(16, 34);
	b.write('data', 36);
	b.writeUInt32LE(samples.length * 2, 40);
	for (let i = 0; i < samples.length; i++)
		b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767))), 44 + i * 2);
	return b;
}

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
		const e1 = Math.abs(mine[0]!.start / FLICKS_PER_SECOND - offsetSec - u.start);
		const e2 = Math.abs(mine[mine.length - 1]!.end / FLICKS_PER_SECOND - offsetSec - u.end);
		if (Math.max(e1, e2) > 0.15)
			console.log(
				`boundary ${u.start}–${u.end}: first "${mine[0]!.text}" ${e1.toFixed(2)} s, last "${mine.at(-1)!.text}" ${e2.toFixed(2)} s off`,
			);
		errs.push(e1, e2);
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
		expect(wer).toBeLessThanOrEqual(0.04);
		expect(t.mean).toBeLessThanOrEqual(0.06);
		expect(t.max).toBeLessThanOrEqual(0.25);
		expect(t.outside).toBe(0);
		expect(res.language).toBe('en');
		expect(Math.abs(res.duration - truth.durationSeconds * FLICKS_PER_SECOND)).toBeLessThan(
			FLICKS_PER_SECOND / 1000,
		);
		for (let i = 1; i < res.words.length; i++)
			expect(res.words[i]!.start).toBeGreaterThanOrEqual(res.words[i - 1]!.end);
		expect(res.words.at(-1)!.end).toBeLessThanOrEqual(res.duration);
		expect(res.words.filter((w) => w.confidence > 0.5).length / res.words.length).toBeGreaterThan(0.9);
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
		expect(wer).toBeLessThanOrEqual(0.1);
		expect(t.mean).toBeLessThanOrEqual(0.06);
		expect(t.outside).toBe(0);
		expect(Object.keys(res.speakers)).toEqual(['S1']);
		expect(res.words.every((w) => w.speaker === 'S1')).toBe(true);
	}, 600_000);

	it('transcribes a trimmed and offset sequence mix in sequence time', async () => {
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
		const inRange = truth.utterances.filter((u) => u.start >= 14 && u.end <= 43);
		const ref = inRange.map((u) => u.text).join(' ');
		const hyp = res.words.map((w) => w.text).join(' ');
		const wer = wordErrorRate(ref, hyp);
		console.log(`sequence mix: WER ${(wer * 100).toFixed(2)} % over ${inRange.length} sentences`);
		expect(wer).toBeLessThanOrEqual(0.08);
		for (const u of inRange) {
			// Source 14s plays at sequence 2s: every measured onset shifts by -12s.
			const expected = u.start - 12;
			const first = res.words.find((w) => w.start / FLICKS_PER_SECOND >= expected - 0.3);
			expect(Math.abs(first!.start / FLICKS_PER_SECOND - expected)).toBeLessThan(0.15);
		}
	}, 600_000);

	it('a silence gap (spec 16 SG-011): no words in it, none lost after it', async () => {
		const ffmpeg = resolveBinaries({ env: process.env }).ffmpeg as string;
		const audio = await decodeAudio({ path: FIXTURE, ffmpeg });
		// the fixture up to the pause at 17.5 s, 30 s of digital silence, then the rest
		const cut = Math.round(17.5 * 16_000);
		const gap = 30 * 16_000;
		const out = new Float32Array(audio.length + gap);
		out.set(audio.subarray(0, cut));
		out.set(audio.subarray(cut), cut + gap);
		const dir = mkdtempSync(join(tmpdir(), 'jasper-gap-'));
		const file = join(dir, 'gap.wav');
		writeFileSync(file, wav(out));
		const m = await register(app, file);
		const r = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/transcribe?wait=1`,
			headers: JSON_H,
			payload: { model: 'whisper-tiny.en', language: 'en' },
		});
		expect(r.statusCode, r.body).toBe(200);
		const res = (r.json() as EngineJob).result as TranscriptionResult;
		const sec = (f: number) => f / FLICKS_PER_SECOND;
		const inGap = res.words.filter(
			(w) => (sec(w.start) + sec(w.end)) / 2 > 17.6 && (sec(w.start) + sec(w.end)) / 2 < 47.4,
		);
		const before = truth.utterances.filter((u) => u.end <= 17.5);
		const after = truth.utterances.filter((u) => u.start >= 17.5);
		const hypAfter = res.words
			.filter((w) => sec(w.start) >= 47.4)
			.map((w) => w.text)
			.join(' ');
		const werAfter = wordErrorRate(after.map((u) => u.text).join(' '), hypAfter);
		const hypBefore = res.words
			.filter((w) => sec(w.end) <= 17.6)
			.map((w) => w.text)
			.join(' ');
		const werBefore = wordErrorRate(before.map((u) => u.text).join(' '), hypBefore);
		console.log(
			`silence gap: ${inGap.length} words in the gap, WER before ${(werBefore * 100).toFixed(2)} %, after ${(werAfter * 100).toFixed(2)} %, guard ${JSON.stringify(res.guard)}`,
		);
		if (werAfter > 0.06)
			console.log(
				`after the gap: ${res.words.map((w) => `${w.text}@${sec(w.start).toFixed(2)}`).join(' ')}; segments ${JSON.stringify(res.segments.map((x) => [x.start, x.end]))}`,
			);
		expect(inGap).toEqual([]);
		expect(werAfter).toBeLessThanOrEqual(0.06);
		expect(werBefore).toBeLessThanOrEqual(0.06);
		expect(res.guard?.skippedWindows ?? 0).toBeGreaterThanOrEqual(0);
	}, 600_000);

	it('verbatim prompts: the real tokenizer encodes them losslessly; an unconditioned job keeps its accuracy', async () => {
		const tok = new WhisperTokenizer(
			JSON.parse(readFileSync(join(CACHE, 'whisper-tiny', 'tokenizer.json'), 'utf8')),
			true,
		);
		for (const p of Object.values(VERBATIM_PROMPTS)) {
			const ids = tok.encode(` ${p}`);
			expect(tok.decode(ids)).toBe(` ${p}`);
			expect(ids.length).toBeLessThan(Buffer.byteLength(p));
			expect(ids.every((t) => t < tok.eot)).toBe(true);
		}
		// an unconditioned job keeps its accuracy
		const m = await register(app, FIXTURE);
		const r = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/transcribe?wait=1`,
			headers: JSON_H,
			payload: { model: 'whisper-tiny.en', language: 'en', conditionOnPreviousText: false },
		});
		expect(r.statusCode, r.body).toBe(200);
		const res = (r.json() as EngineJob).result as TranscriptionResult;
		const wer = wordErrorRate(reference, res.words.map((w) => w.text).join(' '));
		console.log(`tiny.en without previous text: WER ${(wer * 100).toFixed(2)} %`);
		expect(wer).toBeLessThanOrEqual(0.06);
		expect(
			res.segments.every((sg) => typeof sg.avgLogprob === 'number' && typeof sg.noSpeechProb === 'number'),
		).toBe(true);
		expect(res.device).toMatchObject({ encoder: 'cpu', decoder: 'cpu' });
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

describe.skipIf(!enabled || !TURBO_DIR)(
	'large-v3-turbo from a local model directory (spec 16 SG-020)',
	() => {
		beforeAll(async () => {
			app = await makeApp({ totalSlots: 8 });
			const dir = join(app.appdir, 'models', 'speech');
			mkdirSync(dir, { recursive: true });
			symlinkSync(TURBO_DIR as string, join(dir, 'whisper-large-v3-turbo'), 'dir');
		}, 120_000);
		afterAll(async () => {
			await closeApps();
		});

		it('the pinned files verify and transcribe the fixture (greedy, beam 5, verbatim): WER ≤ 4 %', async () => {
			const m = await register(app, FIXTURE);
			for (const accuracy of ['standard', 'best', 'verbatim'] as const) {
				const r = await app.inject({
					method: 'POST',
					url: `/api/media/${m.mediaKey}/transcribe?wait=1`,
					headers: JSON_H,
					payload: {
						model: 'whisper-large-v3-turbo',
						language: 'en',
						...(accuracy === 'verbatim' ? { verbatim: true } : { accuracy }),
					},
				});
				expect(r.statusCode, r.body).toBe(200);
				const res = (r.json() as EngineJob).result as TranscriptionResult;
				const wer = wordErrorRate(reference, res.words.map((w) => w.text).join(' '));
				const t = timing(res.words);
				console.log(
					`turbo ${accuracy}: WER ${(wer * 100).toFixed(2)} %, boundary mean ${(t.mean * 1000).toFixed(0)} ms, rtf ${res.timings.rtf}, device ${res.device?.label}`,
				);
				expect(wer).toBeLessThanOrEqual(0.04);
				expect(t.outside).toBe(0);
				expect(res.beamSize).toBe(accuracy === 'best' ? 5 : 1);
			}
		}, 1_800_000);
	},
);
