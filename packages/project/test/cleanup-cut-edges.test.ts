// Where Clean Up's cuts land on the sequence's frame grid (docs/wp-notes/transcript-cleanup.md "Cut edges in
// continuous voice"): the round-7 listening of large-v3-turbo runs heard cuts that kept 20–30 ms of a removed word
// ("WTF, | no puede ser", "mucho o | que aparece") and a removed retake that left the 0.19 s tail of its last word.
// Synthetic words over a hand-made voice analysis, planned through `analyzeSequenceCleanup` at 30 fps.
import { describe, expect, it } from 'vitest';
import type { CleanupVoice, CleanupWordIn } from '../src/cleanup/detector.ts';
import { FAST_SETTINGS } from '../src/cleanup/schema.ts';
import { analyzeSequenceCleanup } from '../src/cleanup/sequence.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';
import { Harness, videoAsset } from './helpers.ts';

const S = (x: number) => Math.round(x * FLICKS_PER_SECOND);
const sec = (f: number) => f / FLICKS_PER_SECOND;
const FPS = 30;

/** Words "a b c | d e": `dur` long, `gap` apart, `|` a pause. */
function say(text: string, o: { t0: number; dur: number; gap: number; pause: number }): CleanupWordIn[] {
	let t = o.t0;
	const out: CleanupWordIn[] = [];
	for (const tok of text.split(/\s+/)) {
		if (tok === '|') {
			t += o.pause;
			continue;
		}
		out.push({ text: tok, start: S(t), end: S(t + o.dur), confidence: 0.9 });
		t += o.dur + o.gap;
	}
	return out;
}

/** Speech at −25 dBFS under every word and in `extra` (seconds), silence at −65 dBFS elsewhere. */
function voiceOf(words: readonly CleanupWordIn[], extra: Array<[number, number]> = []): CleanupVoice {
	const n = Math.ceil((sec(Math.max(...words.map((w) => w.end))) + 2) * 100);
	const classes = new Uint8Array(n);
	const level = new Uint8Array(n).fill((120 - 65) * 2);
	const mark = (a: number, b: number) => {
		for (let f = Math.floor(a * 100); f < Math.min(n, Math.ceil(b * 100)); f++) {
			classes[f] = 2;
			level[f] = (120 - 25) * 2;
		}
	};
	for (const w of words) mark(sec(w.start), sec(w.end));
	for (const [a, b] of extra) mark(a, b);
	return {
		classes,
		level,
		frameCount: n,
		levels: { floorDb: -65, speechDb: -25, speechThresholdDb: -53, breathFloorDb: -60 },
	};
}

/** The plan of one clip holding the media: kept pieces (seconds) and the findings. */
function plan(words: CleanupWordIn[], voice: CleanupVoice) {
	const seconds = voice.frameCount / 100;
	const H = new Harness({ preset: 'hd-1080p-30' });
	const r0 = H.ok([{ type: 'media.register', asset: videoAsset({ seconds, kind: 'audio' }) }]);
	const mediaId = (r0.results[0] as { mediaId: string }).mediaId;
	H.ok([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { audio: ['A1'] }, mode: 'overwrite' }]);
	H.ok([{ type: 'transcript.create', mediaId, language: 'es', origin: 'manual', words }]);
	const a = analyzeSequenceCleanup({ doc: H.doc, seq: H.seq, voice: () => voice, settings: FAST_SETTINGS });
	if (!a.ok) throw new Error(a.message);
	return { a, kept: a.plan.kept.map((k) => [k.start / FPS, k.end / FPS] as const) };
}

const keptOf = (kept: ReadonlyArray<readonly [number, number]>, s: number, e: number) =>
	kept.reduce((t, [x, y]) => t + Math.max(0, Math.min(e, y) - Math.max(s, x)), 0);

describe('cut edges in continuous voice', () => {
	it('a removal right after a kept word starts at the quietest point before it and takes the removed word whole', () => {
		// "WTF, no puede ser…" said without a break (Z b: the cut kept 30 ms of the removed "no")
		const words = say(
			'¡Me falta el logo! WTF, no puede ser que justo haciendo este video. | No puede ser que justo haciendo este video me pasa.',
			{ t0: 1, dur: 0.25, gap: 0, pause: 0.8 },
		);
		const v = voiceOf(words);
		const no = words.findIndex((w) => w.text === 'no');
		// the quietest 10 ms between "WTF," and "no": 30 ms before its timestamp
		const valley = Math.round(sec(words[no]!.start) * 100) - 3;
		v.level[valley] = (120 - 40) * 2;
		const { a, kept } = plan(words, v);
		// nothing of the removed "no" plays; "WTF," stays but for less than a frame before the cut
		expect(keptOf(kept, sec(words[no]!.start), sec(words[no]!.end))).toBeLessThan(1e-6);
		const wtf = words[no - 1]!;
		expect(keptOf(kept, sec(wtf.start), sec(wtf.end))).toBeGreaterThan(sec(wtf.end - wtf.start) - 1 / FPS);
		const f = a.findings.find((x) => x.words?.[0] === no)!;
		expect(f.suggested).toBe('remove');
		expect(sec(f.range.start)).toBeCloseTo(valley / 100, 6);
	});

	it("a removed retake takes its last word's voice that runs on after its time (W a: a 0.19 s tail stayed)", () => {
		const words = say(
			'vamos a ver que aparece un bug rarísimo. | que aparece un bug rarísimo y después de horas.',
			{ t0: 1, dur: 0.25, gap: 0.05, pause: 1 },
		);
		const last = words.findIndex((w) => w.text === 'rarísimo.');
		const tail: [number, number] = [sec(words[last]!.end), sec(words[last]!.end) + 0.34];
		const { a, kept } = plan(words, voiceOf(words, [tail]));
		expect(a.findings.filter((x) => x.kind === 'untranscribed')).toEqual([]);
		expect(keptOf(kept, sec(words[3]!.start), tail[1])).toBeLessThan(1e-6);
	});
});
