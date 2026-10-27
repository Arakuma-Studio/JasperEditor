// Spec 17 SC-103 with REAL Whisper models (gated like speech-model.e2e: the models in JASPER_SPEECH_MODELS_DIR or
// target/speech-models, or SPEECH_E2E=1, which downloads them through the engine's pinned, verified catalogue).
//
// On the public-domain LJ fixture (fixtures/speech/lj-composite.flac): the engine transcribes it, the transcript is
// split into scoring windows (SC-030), and through `SpeechService.score`
//  - transcript words corrupted with typical confusions ("block" → "black") lose to the script reading by more
//    than the Standard margin (Δ_tok ≥ −1.5: the fix is made), and the script word's forced times lie within 100 ms
//    of the truth (the uncorrupted transcript's word bounds, which speech-model.e2e checks against the fixture's
//    measured sentence bounds; utterance-initial/final words also against those bounds);
//  - a corrupted script loses (Δ_tok < −1.5: nothing applied).
// Every Δ_tok is printed (`SCORE_MARGIN` lines) for the wp-note's margin re-check (ONNX fp32 vs the research's mlx
// fp16). `SPEECH_SCORE_BENCH=1` also measures the scoring cost per speech minute (SC-037; run under the bench lock).
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineJob, SpeechScoreRequest, SpeechScoreResult, TranscriptionResult } from '@jasper/api';
import { cleanupNorm, FLICKS_PER_SECOND } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/processing/models.ts';
import type { SpeechService } from '../src/speech/service.ts';
import { SpeechModelStore } from '../src/speech/models.ts';
import { closeApps, JSON_H, makeApp, ROOT, register, type TestApp, until } from './helpers.ts';

const CACHE = process.env.JASPER_SPEECH_MODELS_DIR ?? join(ROOT, 'target', 'speech-models');
const store = new SpeechModelStore(CACHE, loadCatalog({}).speech);
const REQUIRED = ['whisper-tiny.en'];
const present = await Promise.all(REQUIRED.map(async (id) => store.installed(store.entry(id)!)));
const enabled = process.env.SPEECH_E2E === '1' || present.every(Boolean);
const TURBO = 'whisper-large-v3-turbo';
const turboPresent = await store.installed(store.entry(TURBO)!);
const MODELS = [...REQUIRED, ...(turboPresent ? [TURBO] : [])];
const BENCH = process.env.SPEECH_SCORE_BENCH === '1';

const FIXTURE = join(ROOT, 'fixtures', 'speech', 'lj-composite.flac');
type Truth = { utterances: Array<{ text: string; start: number; end: number }>; durationSeconds: number };
const truth = JSON.parse(readFileSync(FIXTURE.replace(/\.flac$/, '.json'), 'utf8')) as Truth;
const H = { host: '127.0.0.1:47900' };
const F = FLICKS_PER_SECOND;
/** SC-034 Standard margin for `sub`. */
const MARGIN = -1.5;

/** Typical recognition confusions of words of the fixture (phonetic neighbours, no homophones). */
const CONFUSIONS: Array<[string, string]> = [
	['block', 'black'],
	['prisoners', 'prisons'],
	['slept', 'slapped'],
	['wall', 'war'],
	['egg', 'leg'],
	['carton', 'cartoon'],
	['topic', 'tropic'],
	['yeast', 'east'],
	['stock', 'stack'],
	['forged', 'forget'],
];

type Word = { text: string; start: number; end: number };
let app: TestApp;
let speech: SpeechService;
let mediaKey: string;
const transcripts = new Map<string, Word[]>();

async function waitJob(id: string, timeoutMs = 900_000): Promise<EngineJob> {
	return until(
		async () => {
			const j = (await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: H })).json() as EngineJob;
			return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state) ? j : null;
		},
		timeoutMs,
		200,
	);
}

async function transcribe(model: string, extra: Record<string, unknown> = {}): Promise<TranscriptionResult> {
	const r = await app.inject({
		method: 'POST',
		url: `/api/media/${mediaKey}/transcribe`,
		headers: JSON_H,
		payload: { model, language: 'en', device: 'cpu', ...extra },
	});
	expect(r.statusCode, r.body).toBe(202);
	const done = await waitJob((r.json() as EngineJob).id);
	expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
	return done.result as TranscriptionResult;
}

/**
 * SC-030 windows (test copy of the rule; the editor's pure version belongs to script-fix): split at gaps ≥ 1 s,
 * split windows over 28 s at their largest gap, pad 0.25 s before / 0.35 s after (≤ half the gap to the
 * neighbours). Returns word index ranges with flick bounds.
 */
function windows(words: Word[]): Array<{ from: number; to: number; start: number; end: number }> {
	const groups: Array<[number, number]> = [];
	let a = 0;
	for (let i = 1; i <= words.length; i++)
		if (i === words.length || words[i]!.start - words[i - 1]!.end >= F) {
			groups.push([a, i]);
			a = i;
		}
	const split = (g: [number, number]): Array<[number, number]> => {
		const [s, e] = g;
		if (words[e - 1]!.end - words[s]!.start <= 28 * F || e - s < 2) return [g];
		let best = s + 1;
		for (let i = s + 1; i < e; i++)
			if (words[i]!.start - words[i - 1]!.end > words[best]!.start - words[best - 1]!.end) best = i;
		return [...split([s, best]), ...split([best, e])];
	};
	return groups.flatMap(split).map(([from, to]) => {
		const before = from > 0 ? (words[from]!.start - words[from - 1]!.end) / 2 : 0.25 * F;
		const after = to < words.length ? (words[to]!.start - words[to - 1]!.end) / 2 : 0.35 * F;
		return {
			from,
			to,
			start: Math.max(0, Math.round(words[from]!.start - Math.min(0.25 * F, before))),
			end: Math.round(words[to - 1]!.end + Math.min(0.35 * F, after)),
		};
	});
}

/** The word with its letters replaced (punctuation and an initial capital kept). */
function swapWord(text: string, to: string): string {
	return text.replace(/[A-Za-z']+/, (m) => (m[0] === m[0]!.toUpperCase() ? to[0]!.toUpperCase() + to.slice(1) : to));
}

type Case = { pair: [string, string]; index: number; window: ReturnType<typeof windows>[number] };

function cases(words: Word[]): Case[] {
	const ws = windows(words);
	const out: Case[] = [];
	for (const pair of CONFUSIONS) {
		const index = words.findIndex((w) => cleanupNorm(w.text) === pair[0]);
		if (index < 0) continue; // the model misrecognised the word itself: not a usable case
		const window = ws.find((w) => index >= w.from && index < w.to)!;
		out.push({ pair, index, window });
	}
	return out;
}

/** Δ_tok = (LL_script − LL_asr) / max(region tokens) (SC-033). */
function deltaTok(res: SpeechScoreResult, id: string, index: number, from: number): number {
	const w = res.windows.find((x) => x.id === id)!;
	const asr = w.readings.find((r) => r.id === 'asr')!;
	const script = w.readings.find((r) => r.id === 'script')!;
	const k = index - from;
	return (script.logprob - asr.logprob) / Math.max(script.words[k]!.tokens, asr.words[k]!.tokens, 1);
}

function request(model: string, words: Word[], list: Case[], corrupt: 'transcript' | 'script'): SpeechScoreRequest {
	return {
		mediaId: mediaKey,
		language: 'en',
		model,
		device: 'cpu',
		windows: list.map((c) => {
			const original = words.slice(c.window.from, c.window.to).map((w) => w.text);
			const corrupted = original.map((t, k) => (k === c.index - c.window.from ? swapWord(t, c.pair[1]) : t));
			return {
				id: c.pair[0],
				start: c.window.start,
				end: c.window.end,
				readings: [
					{ id: 'asr', words: corrupt === 'transcript' ? corrupted : original },
					{ id: 'script', words: corrupt === 'transcript' ? original : corrupted },
				],
			};
		}),
	};
}

describe.skipIf(!enabled)('speech scoring with real Whisper models (spec 17 SC-103)', () => {
	beforeAll(async () => {
		for (const id of REQUIRED) if (!(await store.installed(store.entry(id)!))) await store.install(id);
		app = await makeApp({ totalSlots: 8 });
		const dir = join(app.appdir, 'models', 'speech');
		mkdirSync(dir, { recursive: true });
		for (const id of MODELS)
			if (!existsSync(join(dir, id))) symlinkSync(join(CACHE, id), join(dir, id), 'dir');
		speech = app.jasper.services.speech as SpeechService;
		mediaKey = (await register(app, FIXTURE)).mediaKey;
		for (const m of MODELS) transcripts.set(m, (await transcribe(m)).words);
	}, 1_800_000);

	afterAll(async () => {
		await closeApps();
	});

	for (const model of MODELS)
		it(`${model}: corrupted transcript words lose to the script (times within 100 ms); a corrupted script loses`, async () => {
			const words = transcripts.get(model)!;
			const list = cases(words);
			expect(list.length).toBeGreaterThanOrEqual(8);
			const fix = await speech.score(request(model, words, list, 'transcript'), new AbortController().signal);
			const keep = await speech.score(request(model, words, list, 'script'), new AbortController().signal);
			expect(fix.device).toMatchObject({ encoder: 'cpu', decoder: 'cpu' });
			// windows shared by several cases are encoded once
			expect(fix.timings!.encoderPasses).toBe(new Set(list.map((c) => c.window.start)).size);
			const report: Array<Record<string, unknown>> = [];
			for (const c of list) {
				const dFix = deltaTok(fix, c.pair[0], c.index, c.window.from);
				const dKeep = deltaTok(keep, c.pair[0], c.index, c.window.from);
				const script = fix.windows.find((w) => w.id === c.pair[0])!.readings.find((r) => r.id === 'script')!;
				const sw = script.words[c.index - c.window.from]!;
				const tw = words[c.index]!;
				const errStart = Math.abs(sw.start - tw.start) / F;
				const errEnd = Math.abs(sw.end - tw.end) / F;
				report.push({
					model,
					pair: c.pair.join('→'),
					deltaTokFix: Math.round(dFix * 1000) / 1000,
					deltaTokKeep: Math.round(dKeep * 1000) / 1000,
					errStartMs: Math.round(errStart * 1000),
					errEndMs: Math.round(errEnd * 1000),
					probability: Math.round(sw.probability * 1000) / 1000,
				});
				expect(dFix, `${c.pair.join('→')} fix`).toBeGreaterThanOrEqual(MARGIN);
				expect(dKeep, `${c.pair.join('→')} keep`).toBeLessThan(MARGIN);
				expect(errStart, `${c.pair[0]} start`).toBeLessThanOrEqual(0.1);
				expect(errEnd, `${c.pair[0]} end`).toBeLessThanOrEqual(0.1);
				// a word that starts or ends an utterance: against the fixture's measured bounds as well
				for (const u of truth.utterances) {
					const first = cleanupNorm(u.text.split(/\s+/)[0]!);
					const last = cleanupNorm(u.text.split(/\s+/).at(-1)!);
					const mid = (tw.start + tw.end) / 2 / F;
					if (mid < u.start - 0.5 || mid > u.end + 0.5) continue;
					if (first === c.pair[0]) expect(Math.abs(sw.start / F - u.start)).toBeLessThanOrEqual(0.1);
					if (last === c.pair[0]) expect(Math.abs(sw.end / F - u.end)).toBeLessThanOrEqual(0.1);
				}
			}
			for (const r of report) console.log(`SCORE_MARGIN ${JSON.stringify(r)}`);
		}, 1_800_000);

	it.skipIf(!BENCH)('SC-037: scoring cost per speech minute (and transcription for comparison)', async () => {
		const model = turboPresent ? TURBO : REQUIRED[0]!;
		const speechMin = truth.utterances.reduce((s, u) => s + u.end - u.start, 0) / 60;
		const audioMin = truth.durationSeconds / 60;
		const t0 = Date.now();
		const plain = await transcribe(model, { conditionOnPreviousText: false });
		const plainMs = Date.now() - t0;
		const t1 = Date.now();
		await transcribe(model, {});
		const condMs = Date.now() - t1;
		const words = plain.words;
		const ws = windows(words);
		// the research's rate: 6.3 candidate readings per speech minute + the ASR reading of each window
		const candidates = Math.max(ws.length, Math.round(6.3 * speechMin));
		const req: SpeechScoreRequest = {
			mediaId: mediaKey,
			language: 'en',
			model,
			device: 'cpu',
			windows: ws.map((w, i) => {
				const base = words.slice(w.from, w.to).map((x) => x.text);
				const n = Math.floor(candidates / ws.length) + (i < candidates % ws.length ? 1 : 0);
				const readings = [{ id: 'asr', words: base }];
				for (let k = 0; k < n; k++) {
					const at = Math.floor(((k + 0.5) * base.length) / n);
					readings.push({ id: `c${k}`, words: base.map((t, j) => (j === at ? swapWord(t, 'novaplay') : t)) });
				}
				return { id: `w${i}`, start: w.start, end: w.end, readings };
			}),
		};
		const runs: Array<{ wallMs: number; timings: SpeechScoreResult['timings'] }> = [];
		for (let r = 0; r < 3; r++) {
			const t = Date.now();
			const res = await speech.score(req, new AbortController().signal, { threads: 8 });
			runs.push({ wallMs: Date.now() - t, timings: res.timings });
		}
		const med = [...runs].sort((a, b) => a.wallMs - b.wallMs)[1]!;
		console.log(
			`SCORE_BENCH ${JSON.stringify({
				model,
				speechMin: Math.round(speechMin * 1000) / 1000,
				audioMin: Math.round(audioMin * 1000) / 1000,
				windows: ws.length,
				readings: req.windows.reduce((s, w) => s + w.readings.length, 0),
				scoreWallMs: runs.map((r) => r.wallMs),
				median: med,
				scoreSecPerSpeechMin: Math.round((med.wallMs / 1000 / speechMin) * 100) / 100,
				transcribeNoPrevMs: plainMs,
				transcribeNoPrevSecPerSpeechMin: Math.round((plainMs / 1000 / speechMin) * 100) / 100,
				transcribeNoPrevRtf: plain.timings.rtf,
				transcribeConditionedMs: condMs,
			})}`,
		);
		// SC-037 target: ≤ 20 s per speech minute on the build VM CPU
		expect(med.wallMs / 1000 / speechMin).toBeLessThanOrEqual(20);
	}, 1_800_000);
});
