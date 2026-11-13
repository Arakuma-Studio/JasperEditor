// Dense speech (reported on a 57-minute Spanish talking head with large-v3-turbo, and on `cut_v5.wav`, a
// loudness-normalised mixdown of its cut): the silence guards removed words spoken over voiced audio — whole
// sentences through OpenAI's `hallucination_silence_threshold` rule (166 words, reason "silence-threshold"), and short
// words ("y", "a", "que") the alignment timed onto a dip between two words. The scripted decoder here writes the
// given words with the given times for any window it is shown (no hallucination at all), so every word missing from
// the result was removed by a guard.
import { wordsWellFormed } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { inputFromSamples } from '../src/speech/worker/audio.ts';
import { runSpeechJob } from '../src/speech/worker/run.ts';
import { EOT, fakeModelDir, fakeOrt, SPACE, TS_BEGIN } from './speech-fake-ort.ts';

const SOT = 27;
const NO_TS = 31;
const SR = 16_000;
type W = { text: string; start: number; end: number };

const ids = (w: string) => [SPACE, ...[...w].map((c) => c.charCodeAt(0) - 97)];

/** A decoder that writes the words of `truth` lying in its window, timed as given (one segment per window). */
function scriptedDecoder(audio: Float32Array, truth: readonly W[]) {
	const input = inputFromSamples(audio, 80);
	const F = Math.round((audio.length / SR) * 100);
	const full = new Float32Array(80 * F);
	input.mel.window(0, F, full, F);
	input.dispose();
	let words: W[] = [];
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
		const offset = o / 100;
		words = truth
			.filter((w) => w.start >= offset - 1e-6 && w.end <= offset + n / 100 + 1e-6)
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
		const b = Math.max(a + 1, Math.round(frames[i + 1] ?? last + 1));
		row.fill(1e-6);
		for (let j = a; j < Math.min(1500, b); j++) row[j] = 1;
	};
	return { onEncoderInput, logits, cross };
}

/**
 * A loudness-normalised mixdown: speech at ≈ −17 dBFS wherever `speech(t)`, room tone at ≈ −50 dBFS elsewhere (raised
 * by the compression, never digital silence).
 */
function mixdown(seconds: number, speech: (t: number) => boolean): Float32Array {
	const out = new Float32Array(Math.round(seconds * SR));
	let s = 7;
	for (let i = 0; i < out.length; i++) {
		s = (s * 1664525 + 1013904223) >>> 0;
		const r = s / 4294967296 - 0.5;
		out[i] = r * (speech(i / SR) ? 0.5 : 0.01);
	}
	return out;
}

async function transcribe(audio: Float32Array, truth: readonly W[]) {
	const out = await runSpeechJob(
		{ modelDir: fakeModelDir({ encodable: true }), modelId: 'fake', input: { f32: '' }, language: 'en' },
		{ ort: fakeOrt(scriptedDecoder(audio, truth)).ort, audio },
	);
	expect(
		wordsWellFormed(out.words.map((w) => ({ ...w, speaker: null, breakBefore: 'none' as const }))),
	).toBeNull();
	return out;
}

const LETTERS = 'abcdefghijklmnopqrstuvwx';
const word = (k: number) => LETTERS[k % 24]! + LETTERS[(k * 7 + 3) % 24]!;

describe('dense speech keeps every spoken word (silence guards)', () => {
	it('a sentence of short words over voiced audio is never cut by the hallucination silence threshold', async () => {
		// fast speech: content words (0.3 s) and short function words (0.06 s, under OpenAI's 0.133 s "too short")
		// alternate, so every segment scores as an anomaly; the audio is voiced throughout
		const truth: W[] = [];
		for (let t = 1, k = 0; t + 0.36 <= 9; t += 0.36, k++) {
			truth.push({ text: word(2 * k), start: t, end: t + 0.3 });
			truth.push({ text: LETTERS[k % 24]!, start: t + 0.3, end: t + 0.36 });
		}
		const end = truth[truth.length - 1]!.end;
		const out = await transcribe(
			mixdown(10, (t) => t >= 1 && t < end),
			truth,
		);
		expect(out.words.map((w) => w.text)).toEqual(truth.map((w) => w.text));
		expect(out.guard.removed.filter((r) => r.reason === 'silence-threshold')).toEqual([]);
	});

	it('a short word timed onto a dip between two words stays, and words in silence are listed as removed', async () => {
		// "cosas y objetos": the alignment gives "y" 80 ms on the dip between its neighbours (no voiced frame), and
		// "a" 100 ms of which one 10 ms frame is voiced; a word written over the long room tone is a hallucination
		const truth: W[] = [];
		let t = 1;
		for (let k = 0; k < 8; k++, t += 0.3) truth.push({ text: word(k), start: t, end: t + 0.3 });
		const y = { text: 'y', start: t, end: t + 0.08 };
		truth.push(y, { text: 'ob', start: t + 0.08, end: t + 0.4 });
		t += 0.4;
		const a = { text: 'a', start: t, end: t + 0.1 };
		truth.push(a, { text: 'ce', start: t + 0.1, end: t + 0.4 });
		t += 0.4;
		for (let k = 0; k < 6; k++, t += 0.3) truth.push({ text: word(k + 9), start: t, end: t + 0.3 });
		const speechEnd = t;
		truth.push({ text: 'gr', start: speechEnd + 3, end: speechEnd + 3.4 });
		const dips: Array<[number, number]> = [
			[y.start, y.end],
			[a.start + 0.01, a.end],
		];
		const out = await transcribe(
			mixdown(speechEnd + 5, (s) => s >= 1 && s < speechEnd && !dips.some(([p, q]) => s >= p && s < q)),
			truth,
		);
		expect(out.words.map((w) => w.text)).toEqual(truth.slice(0, -1).map((w) => w.text));
		expect(out.guard.removed).toContainEqual(expect.objectContaining({ text: 'gr', reason: 'silence' }));
	});
});
