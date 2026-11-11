// Hidden takes (docs/wp-notes/speech.md §11.3 "Hidden takes"; reported on a 57-minute Spanish file with large-v3-turbo): a phrase the
// speaker says twice back to back is written once over a long window, its last word stretched over both takes, but
// decoding a few seconds around it alone writes both takes with correct times. The scripted decoder here behaves like
// that: it finds where its window lies in the audio and, for a window holding more than 10 s of audio, writes the
// "long" reading (one take, stretched), else the true words.
import { wordsWellFormed } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { redecodeAccepted, replaceWindowWords } from '../src/speech/core/gaps.ts';
import { inputFromSamples } from '../src/speech/worker/audio.ts';
import { runSpeechJob, type SpeechJobSpec } from '../src/speech/worker/run.ts';
import { EOT, fakeModelDir, fakeOrt, noiseAudio, SPACE, TS_BEGIN } from './speech-fake-ort.ts';

const SOT = 27;
const NO_TS = 31;
const SR = 16_000;
const SECONDS = 17;
/** Token id of "..." in a `dot` fake model (replaces 'y'). */
const DOT = 24;
type W = { text: string; start: number; end: number };

const at = (text: string, start: number, len = 0.3): W => ({ text, start, end: start + len });
const LEAD = [at('ab', 0.5), at('cd', 0.9), at('ef', 1.3), at('gh', 1.7)];
// the first take breaks off ("ij kl mn—"), the second says the whole phrase
const TAKE1 = [at('ij', 2.2), at('kl', 2.6), at('mn', 3.0, 0.2)];
const TAKE2 = [at('ij', 3.32), at('kl', 3.72), at('mn', 4.12), at('op', 4.52), at('qr', 4.92)];
const TAIL = 'st uv wx ya bd ce df eg fh gi hj ik jl km ln mo np oq pr qs rt su tv uw'
	.split(' ')
	.map((t, k) => at(t, 5.5 + 0.4 * k));
const TRUTH = [...LEAD, ...TAKE1, ...TAKE2, ...TAIL];
// what a long window gets: the phrase once, "mn" stretched from the first take to the second take's "op"
const LONG = [...LEAD, ...TAKE1, ...TAKE2.slice(3), ...TAIL];

const ids = (w: string) => [
	SPACE,
	...w.split(/(\.\.\.)/).flatMap((p) => (p === '...' ? [DOT] : [...p].map((c) => c.charCodeAt(0) - 97))),
];

/** `long`: what a window holding more than 10 s of audio gets; `truth`: what a shorter one gets. */
/** `window`: what a window of 5–10 s gets instead of `truth` (when given). */
function hiddenTakeDecoder(
	audio: Float32Array,
	truth: readonly W[] = TRUTH,
	long: readonly W[] = LONG,
	window?: readonly W[],
) {
	const input = inputFromSamples(audio, 80);
	const F = Math.round((audio.length / SR) * 100);
	const full = new Float32Array(80 * F);
	input.mel.window(0, F, full, F);
	input.dispose();
	let words: W[] = [];
	let offset = 0;
	const onEncoderInput = (x: Float32Array) => {
		// where the window starts in the audio (the same normalised mel values) and how many frames it holds
		let o = 0;
		for (; o < F; o++) {
			let same = true;
			for (let j = 0; j < 3 && same; j++)
				for (let m = 0; m < 80 && same; m++) same = x[m * 3000 + j] === full[m * F + o + j];
			if (same) break;
		}
		let n = 0;
		while (n < 3000 && [0, 40, 79].some((m) => x[m * 3000 + n] !== 0)) n++;
		offset = o / 100;
		// a short window loses the words within 80 ms of its edges (a chunk edge cuts them)
		const edge = n > 1000 ? 0 : 0.08;
		words = (n > 1000 ? long : window && n > 500 ? window : truth)
			.filter((w) => w.start >= offset + edge - 1e-6 && w.end <= offset + n / 100 - edge + 1e-6)
			.map((w) => ({ ...w, start: w.start - offset, end: w.end - offset }));
	};
	const ts = (sec: number) => TS_BEGIN + Math.round(sec * 50);
	const logits = (h: readonly number[], row: Float32Array) => {
		const sot = h.lastIndexOf(SOT);
		if (sot < 0) return;
		const aligning = h[sot + 1] === NO_TS;
		const text = words.flatMap((w) => ids(w.text));
		const gen = h.slice(sot + (aligning ? 2 : 1));
		const target = aligning
			? text
			: words.length
				? [ts(words[0]!.start), ...text, ts(words[words.length - 1]!.end)]
				: [TS_BEGIN];
		row.fill(-20);
		row[gen.length < target.length ? target[gen.length]! : EOT] = 20;
	};
	// word alignment: each token attends to its share of its word (20 ms encoder frames), the end token to the end
	const cross = (h: readonly number[], row: Float32Array) => {
		const sot = h.lastIndexOf(SOT);
		// the row at a token attends for the token after it (OpenAI reads rows from `<|notimestamps|>` on)
		const k = h.length - 1 - (sot + 1);
		const frames: number[] = [];
		for (const w of words) {
			const n = ids(w.text).length;
			for (let q = 0; q < n; q++) frames.push((w.start + ((w.end - w.start) * q) / n) * 50);
		}
		const last = words.length ? words[words.length - 1]!.end * 50 : 0;
		frames.push(last);
		const i = Math.min(frames.length - 1, Math.max(0, k));
		const a = Math.round(frames[i]!);
		const b = Math.max(a + 4, Math.round(frames[i + 1] ?? last + 4));
		row.fill(1e-6);
		for (let j = a; j < Math.min(1500, b); j++) row[j] = 1;
	};
	return { onEncoderInput, logits, cross };
}

const audio = noiseAudio(SECONDS, (t) => TRUTH.some((w) => t >= w.start && t < w.end));
const transcribe = (spec: Partial<SpeechJobSpec> = {}) =>
	runSpeechJob(
		{
			modelDir: fakeModelDir({ encodable: true }),
			modelId: 'fake',
			input: { f32: '' },
			language: 'en',
			...spec,
		},
		{ ort: fakeOrt(hiddenTakeDecoder(audio)).ort, audio },
	);

describe('hidden takes', () => {
	it('a stretched word is decoded again alone and both takes are written with their times', async () => {
		const out = await transcribe();
		expect(
			wordsWellFormed(out.words.map((w) => ({ ...w, speaker: null, breakBefore: 'none' as const }))),
		).toBeNull();
		const texts = out.words.map((w) => w.text);
		expect(texts.slice(4, 12)).toEqual(['ij', 'kl', 'mn', 'ij', 'kl', 'mn', 'op', 'qr']);
		// each take where it was said (±60 ms)
		for (const [k, w] of [...TAKE1, ...TAKE2].entries()) {
			expect(Math.abs(out.words[4 + k]!.start / SR - w.start)).toBeLessThan(0.06);
			expect(Math.abs(out.words[4 + k]!.end / SR - w.end)).toBeLessThan(0.06);
		}
		expect(out.guard.redecoded).toEqual({
			windows: 1,
			replaced: 1,
			wordsAdded: 3,
			skipped: 0,
			// 3 s before "mn" (from 0) to 1.5 s after it, widened to the end of the word there
			ranges: [{ start: 0, end: 6.3, before: 11, after: 14, replaced: true }],
		});
	});

	it('VAD chunks decode every take, and the shifted pass restores the words a chunk edge cut', async () => {
		const out = await transcribe({ chunking: 'vad', redecode: false });
		expect(out.words.map((w) => w.text)).toEqual(TRUTH.map((w) => w.text));
		for (const [k, w] of TRUTH.entries())
			expect(Math.abs(out.words[k]!.start / SR - w.start)).toBeLessThan(0.06);
		expect(out.guard.chunked).toMatchObject({ chunks: 2, shiftedChunks: 3 });
		expect(out.guard.chunked!.replaced).toBeGreaterThan(0);
	});

	it('a window whose re-decode is rejected is decoded again in VAD chunks (fragment E: 17 s, 26 → 33 words)', async () => {
		// three restarts in a row, each written once by a long window: their windows merge into one of more than 10 s,
		// whose re-decode is the long reading again (no more words: rejected); VAD chunks within it write every take
		const take = (t: string, at0: number) =>
			t.split(' ').map((x, k) => at(x, at0 + 0.4 * k, k === 2 ? 0.2 : 0.3));
		const pairs = [
			[take('ij kl mn', 2.2), take('ij kl mn op qr', 3.32)],
			[take('st uv wx', 5.5), take('st uv wx ab cd', 6.62)],
			[take('ef gh ik', 8.8), take('ef gh ik jl km', 9.92)],
		];
		const tail = 'ln mo np oq pr qs rt su tv uw ab cd'.split(' ').map((t, k) => at(t, 12.1 + 0.4 * k));
		const truth = [...LEAD, ...pairs.flatMap(([a, b]) => [...a!, ...b!]), ...tail];
		const long = [...LEAD, ...pairs.flatMap(([a, b]) => [...a!, ...b!.slice(3)]), ...tail];
		const audio = noiseAudio(SECONDS, (t) => truth.some((w) => t >= w.start && t < w.end));
		const out = await runSpeechJob(
			{ modelDir: fakeModelDir({ encodable: true }), modelId: 'fake', input: { f32: '' }, language: 'en' },
			{ ort: fakeOrt(hiddenTakeDecoder(audio, truth, long)).ort, audio },
		);
		// every take, in order (the window ends in the tail)
		expect(out.words.map((w) => w.text).slice(0, 28)).toEqual(truth.slice(0, 28).map((w) => w.text));
		expect(out.guard.redecoded!.ranges).toMatchObject([{ replaced: true, chunked: true }]);
	});

	it('a re-decode writes no word of punctuation only: an ellipsis joins the word before ("..." and "...y")', async () => {
		// the re-decode (verbatim) writes "mn ..." at the end of the first take and "...ij" for the second
		const dotted = [...LEAD, ...TAKE1, at('...', 3.2, 0.1), at('...ij', 3.32), ...TAKE2.slice(1), ...TAIL];
		const out = await runSpeechJob(
			{
				modelDir: fakeModelDir({ encodable: true, dot: true }),
				modelId: 'fake',
				input: { f32: '' },
				language: 'en',
			},
			{ ort: fakeOrt(hiddenTakeDecoder(audio, dotted)).ort, audio },
		);
		expect(out.words.map((w) => w.text).slice(4, 12)).toEqual([
			'ij',
			'kl',
			'mn...',
			'ij',
			'kl',
			'mn',
			'op',
			'qr',
		]);
	});

	it('a re-decode never drops words the original had over voice (second run, fragment E 29.79–47.03)', () => {
		// "text[start-end]" in seconds; the original (plain pass) and what the chunked re-decode wrote there
		const words = (x: string) =>
			x
				.trim()
				.split(/\s+/)
				.map((t) => {
					const m = /^(.*)\[([\d.]+)-([\d.]+)\]$/.exec(t)!;
					return { text: m[1]!, start: Math.round(Number(m[2]) * SR), end: Math.round(Number(m[3]) * SR) };
				});
		const original = words(`decenas[29.79-30.07] de[30.07-30.17] miles[30.17-30.37] de[30.37-30.47]
			millones[30.47-30.65] de[30.65-30.81] dólares.[30.81-31.15] ¿Que[31.87-31.93] puedo[31.93-32.09]
			hacer[32.09-32.23] en[32.23-32.39] un[32.39-32.47] mes[32.47-33.50] lo[33.72-34.95] mismo[35.18-36.27]
			que[36.27-36.39] una[36.39-36.49] empresa[36.49-36.77] de[36.77-36.97] decenas[36.97-37.21] de[37.21-37.55]
			miles[38.14-42.03] de[42.03-42.48] millones[42.91-45.49] de[45.49-45.65] dólares?[45.65-46.08]`);
		const redecoded = words(`de[29.55-30.04] ¿Qué[33.00-33.50] puedo[33.72-33.97] hacer[33.97-34.15]
			en[34.15-34.27] un[34.27-34.95] mes[35.18-35.95] lo[35.95-36.07] mismo[36.07-36.39] una[36.39-36.49]
			empresa[36.49-36.79] de[36.79-36.97] decenas[36.97-37.23] de...?[37.23-37.55] puedo[38.19-38.35]
			hacer[38.35-38.51] en[38.51-38.63] un[38.63-38.75] mes[38.75-38.91] lo[38.91-39.01] mismo[39.01-39.34]
			que[39.79-40.93] una[40.93-41.03] empresa[41.03-41.31] de[41.31-41.51] decenas[41.51-41.79] de[41.79-41.87]
			miles[41.87-42.48] de[42.91-45.29] millones[45.29-45.45] de[45.45-45.65] dólares?[45.65-46.08]`);
		// continuous speech (−12 to −25 dBFS) under all of it
		const mask = new Uint8Array(4800).fill(1);
		const placed = redecodeAccepted(original, redecoded, mask, 0.2);
		const kept = (w: { text: string; start: number }) =>
			placed?.some((p) => p.text === w.text && p.start === w.start) ?? true;
		// either nothing is replaced, or every original word under 31.15 s is still there
		expect(original.filter((w) => w.end <= 31.15 * SR).every(kept)).toBe(true);
	});

	it('a re-decoded word timed inside the word before it gets time of its own (third run, fragment E: "hacer…")', () => {
		const at2 = (text: string, a: number, b: number) => ({
			text,
			start: Math.round(a * SR),
			end: Math.round(b * SR),
		});
		const words = [at2('empresa', 36.49, 36.77), at2('de', 36.77, 36.97), at2('Que', 38.14, 38.2)];
		// the re-decode wrote "decenas hacer... de miles?" with "hacer..." inside "decenas"
		const placed = replaceWindowWords(words, 36.7 * SR, 37.6 * SR, [
			at2('de', 36.77, 37.01),
			at2('decenas', 37.01, 37.23),
			at2('hacer...', 37.1, 37.2),
			at2('de', 37.23, 37.39),
			at2('miles?', 37.39, 37.55),
		]);
		expect(placed.map((w) => w.text)).toEqual([
			'empresa',
			'de',
			'decenas',
			'hacer...',
			'de',
			'miles?',
			'Que',
		]);
		for (const [k, w] of placed.entries()) {
			expect(w.end, w.text).toBeGreaterThan(w.start);
			if (k) expect(w.start, w.text).toBeGreaterThanOrEqual(placed[k - 1]!.end);
		}
	});

	it('voice a replaced window leaves without words is decoded alone (run 4, fragment E: the take at 38.14–42.15)', async () => {
		const seq = (t: string, at0: number) => t.split(' ').map((x, k) => at(x, at0 + 0.4 * k));
		const lead = [at('ab', 0.5), at('cd', 0.9, 0.4)];
		const take1 = [at('ij', 1.4), at('kl', 1.8), at('mn', 2.2, 0.2)];
		// an attempt of 2.4 s of voice that the window's re-decode does not write
		const missed = seq('op qr st uv wx bd ce df', 2.42);
		const final = seq('ij kl mn op qr', 6.0);
		const tail = seq('eg fh gi hj ik jl km ln mo np oq pr qs rt su tv uw', 8.5);
		const truth = [...lead, ...take1, ...missed, ...final, ...tail];
		// the long reading skips "cd" and stretches "mn" over the attempt
		const long = [lead[0]!, at('ij', 1.4), at('kl', 1.8), at('mn', 2.2, 3.4), ...final, ...tail];
		const window = [...lead, ...take1, ...final, ...tail];
		const audio = noiseAudio(SECONDS, (t) => truth.some((w) => t >= w.start && t < w.end));
		const out = await runSpeechJob(
			{ modelDir: fakeModelDir({ encodable: true }), modelId: 'fake', input: { f32: '' }, language: 'en' },
			{ ort: fakeOrt(hiddenTakeDecoder(audio, truth, long, window)).ort, audio },
		);
		expect(out.guard.redecoded!.ranges.some((r) => r.replaced)).toBe(true);
		expect(out.words.map((w) => w.text)).toEqual(truth.map((w) => w.text));
	});

	it('a stretched word a rejected one-chunk window leaves is decoded alone (run 5, fragment H: "rápida" over 2.2 s of speech)', async () => {
		// continuous speech (no pause of 100 ms): the window is one VAD chunk, so there is no chunked fallback
		const seq = (t: string, at0: number) => t.split(' ').map((x, k) => at(x, at0 + 0.4 * k, 0.36));
		const head = seq('ab cd ij kl mn', 0.5);
		const rest = seq('ij kl mn op qr st uv wx ya bd ce', 2.5);
		const tail = seq('df eg fh gi hj ik jl km ln mo np oq', 9);
		const truth = [...head, ...rest, ...tail];
		// longer windows write the phrase once, "mn" stretched from the attempt over the second take's "mn"
		const long = [...head.slice(0, 4), { ...head[4]!, end: rest[2]!.end }, ...rest.slice(3), ...tail];
		const audio = noiseAudio(SECONDS, (t) => truth.some((w) => t >= w.start && t < w.end));
		const out = await runSpeechJob(
			{ modelDir: fakeModelDir({ encodable: true }), modelId: 'fake', input: { f32: '' }, language: 'en' },
			{ ort: fakeOrt(hiddenTakeDecoder(audio, truth, long, long)).ort, audio },
		);
		expect(out.guard.redecoded!.ranges).toMatchObject([{ replaced: false }]);
		// both takes, each where it was said
		expect(out.words.map((w) => w.text).slice(0, 12)).toEqual(truth.slice(0, 12).map((w) => w.text));
		expect(out.guard.recovered).toMatchObject({ spans: 1, words: 3 });
	});
});
