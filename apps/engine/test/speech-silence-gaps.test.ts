// Spec 16 SG-011 regression (reported on a 57-minute Spanish file, large-v3-turbo): speech right after stretches of
// digital silence came back without words, and decoding those ranges alone recovered them. Digital silence has the
// mel values of Whisper's zero padding, so the scripted decoder here behaves like Whisper on it: a window that starts
// with ≥ 0.75 s of it returns nothing, and a decode ends at the first second of it (single timestamp ending).
import { wordsWellFormed } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { runSpeechJob } from '../src/speech/worker/run.ts';
import { EOT, fakeModelDir, fakeOrt, noiseAudio, SPACE, TS_BEGIN } from './speech-fake-ort.ts';

const SOT = 27;
const NO_TS = 31;
const SR = 16_000;
const WORDS = ['ab', 'cd', 'ef', 'gh', 'ij', 'kl', 'mn', 'op'];
const ids = (w: string) => [SPACE, ...[...w].map((c) => c.charCodeAt(0) - 97)];

/** Voice bursts where `voiced`, faint noise elsewhere, digital silence (zeros) in `digital` (seconds). */
function audio(seconds: number, voiced: Array<[number, number]>, digital: Array<[number, number]>) {
	const a = noiseAudio(seconds, (t) => voiced.some(([s, e]) => t >= s && t < e) && t % 1 < 0.7);
	for (const [s, e] of digital) a.fill(0, Math.round(s * SR), Math.round(e * SR));
	return a;
}

/** A decoder that reads digital silence as the end of the audio, as Whisper does (see the module docs). */
function silenceShy() {
	let lead = 0;
	let end = 0;
	const onEncoderInput = (x: Float32Array) => {
		const n = x.length / 3000;
		let floor = Number.POSITIVE_INFINITY;
		for (const v of x) floor = Math.min(floor, v);
		// digital silence (the log-mel floor) or the window's padding past the content (zeros)
		const isFloor = (j: number) => {
			const v = x[j]!;
			if (v !== 0 && v > floor + 1e-6) return false;
			for (let m = 1; m < n; m++) if (x[m * 3000 + j] !== v) return false;
			return true;
		};
		lead = 0;
		while (lead < 3000 && isFloor(lead)) lead++;
		end = lead;
		for (let j = lead, run = 0; j < 3000 && run < 100; j++) {
			if (isFloor(j)) run++;
			else {
				run = 0;
				end = j + 1;
			}
		}
	};
	const words = () => Math.max(1, Math.floor((end - lead) / 150));
	const logits = (h: readonly number[], row: Float32Array) => {
		const sot = h.lastIndexOf(SOT);
		if (sot < 0) return;
		const text = WORDS.slice(0, words()).flatMap(ids);
		// the alignment pass (`<|notimestamps|>`) reads the same text, confidently
		const aligning = h[sot + 1] === NO_TS;
		const gen = h.slice(sot + (aligning ? 2 : 1));
		const target = aligning
			? text
			: lead >= 75
				? [TS_BEGIN]
				: [TS_BEGIN + Math.round(lead / 2), ...text, TS_BEGIN + Math.round(end / 2)];
		row.fill(-20);
		row[gen.length < target.length ? target[gen.length]! : EOT] = 20;
	};
	// word alignment: the text tokens attend to the voice in order (20 ms encoder frames)
	const cross = (h: readonly number[], row: Float32Array) => {
		const k = h.length - 1 - (h.indexOf(NO_TS) + 1);
		const tokens = 3 * words();
		const step = (end - lead) / 2 / tokens;
		const a = Math.round(lead / 2 + Math.min(tokens, Math.max(0, k)) * step);
		row.fill(1e-6);
		for (let j = a; j < Math.min(1500, a + Math.max(1, Math.round(step))); j++) row[j] = 1;
	};
	return { onEncoderInput, logits, cross };
}

async function transcribe(samples: Float32Array) {
	const out = await runSpeechJob(
		{ modelDir: fakeModelDir({ encodable: true }), modelId: 'fake', input: { f32: '' }, language: 'en' },
		{ ort: fakeOrt(silenceShy()).ort, audio: samples },
	);
	// sorted, non-overlapping integer times (the transcript invariant)
	expect(
		wordsWellFormed(out.words.map((w) => ({ ...w, speaker: null, breakBefore: 'none' as const }))),
	).toBeNull();
	return out;
}

const within = (w: { start: number; end: number }, s: number, e: number) =>
	w.start >= s * SR && w.end <= e * SR;

describe('speech after digital silence (SG-011)', () => {
	it('a decode that ends at digital silence resumes at the voice after it, in the main pass', async () => {
		const out = await transcribe(
			audio(
				25,
				[
					[0, 5],
					[15, 25],
				],
				[[5, 15]],
			),
		);
		expect(out.words.some((w) => within(w, 0, 5))).toBe(true);
		expect(out.words.some((w) => within(w, 15, 25))).toBe(true);
		expect(out.words.every((w) => within(w, 0, 5) || within(w, 15, 25))).toBe(true);
		// nothing was left for the wordless-span pass
		expect(out.guard.recovered).toBeUndefined();
	});

	it('voice left without words is decoded again alone and its words are merged and reported', async () => {
		const out = await transcribe(
			audio(
				12,
				[[1.5, 9]],
				[
					[0, 1.5],
					[9, 12],
				],
			),
		);
		expect(out.words.length).toBeGreaterThan(0);
		expect(out.words.every((w) => within(w, 1.5, 9))).toBe(true);
		expect(out.guard.recovered).toEqual({
			spans: 1,
			words: out.words.length,
			skipped: 0,
			// 0.5 s of context around the voice (the last burst ends at 8.71 s)
			ranges: [{ start: 1, end: 9.21, words: out.words.length }],
		});
	});
});
