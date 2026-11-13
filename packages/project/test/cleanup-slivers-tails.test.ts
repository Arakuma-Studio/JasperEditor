// Round 12 (docs/wp-notes/transcript-cleanup.md "Round 12"), from a user's real cut of a 57-minute Spanish talking
// head: kept slivers of 1–7 frames flashing another take's pose, sentence-final words whose soft fading tail a join cut,
// a quiet phrase without words cut as a pause, and a restart inside a word under 1 s that the fixed 1 s stretched-word
// rule missed. Synthetic words over hand-made voice analyses, planned through `analyzeSequenceCleanup` at 30 fps.
import { describe, expect, it } from 'vitest';
import { type CleanupVoice, type CleanupWordIn, detectCleanup } from '../src/cleanup/detector.ts';
import { FAST_SETTINGS } from '../src/cleanup/schema.ts';
import { analyzeSequenceCleanup, type CleanupDecisions } from '../src/cleanup/sequence.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';
import { Harness, videoAsset } from './helpers.ts';

const S = (x: number) => Math.round(x * FLICKS_PER_SECOND);
const sec = (f: number) => f / FLICKS_PER_SECOND;
const FPS = 30;
const q = (db: number) => Math.round((db + 120) * 2);

/** Words written "text[start-end]" (seconds). */
const real = (s: string): CleanupWordIn[] =>
	s
		.trim()
		.split(/\s+/)
		.map((x) => {
			const m = /^(.*)\[([\d.]+)-([\d.]+)\]$/.exec(x)!;
			return { text: m[1]!, start: S(Number(m[2])), end: S(Number(m[3])), confidence: 0.9 };
		});

/** Words of `dur` seconds `gap` apart from `t0`; `|` is a pause of `pause` seconds. */
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

/**
 * A voice analysis: floor −60 dBFS, speech level −10 dBFS; every word speech at −16 dBFS and voiced, the rest
 * measured silence (unvoiced); `put` overwrites frames [a, b) seconds.
 */
function voiceOf(words: readonly CleanupWordIn[], seconds?: number) {
	const n = Math.ceil((seconds ?? sec(Math.max(...words.map((w) => w.end))) + 2) * 100);
	const v = {
		classes: new Uint8Array(n),
		level: new Uint8Array(n).fill(q(-60)),
		voicing: new Uint8Array(n).fill(20),
		flatness: new Uint8Array(n).fill(100),
		frameCount: n,
		levels: { floorDb: -60, speechDb: -10, speechThresholdDb: -45, breathFloorDb: -55 },
	};
	const put = (
		a: number,
		b: number,
		o: { db?: (f: number) => number; cls?: number; voicing?: (f: number) => number },
	) => {
		for (let f = Math.round(a * 100); f < Math.min(n, Math.round(b * 100)); f++) {
			if (o.db) v.level[f] = q(o.db(f));
			if (o.cls !== undefined) v.classes[f] = o.cls;
			if (o.voicing) v.voicing[f] = Math.round(o.voicing(f) * 255);
		}
	};
	for (const w of words) put(sec(w.start), sec(w.end), { db: () => -16, cls: 2, voicing: () => 0.8 });
	return { v: v as CleanupVoice, put };
}

/** The plan of one 30 fps clip holding the media: kept pieces (seconds), removed ranges (seconds), the analysis. */
function plan(words: CleanupWordIn[], voice: CleanupVoice, decisions?: CleanupDecisions) {
	const H = new Harness({ preset: 'hd-1080p-30' });
	const r0 = H.ok([
		{ type: 'media.register', asset: videoAsset({ seconds: voice.frameCount / 100, kind: 'audio' }) },
	]);
	const mediaId = (r0.results[0] as { mediaId: string }).mediaId;
	H.ok([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { audio: ['A1'] }, mode: 'overwrite' }]);
	H.ok([{ type: 'transcript.create', mediaId, language: 'es', origin: 'manual', words }]);
	const a = analyzeSequenceCleanup({
		doc: H.doc,
		seq: H.seq,
		voice: () => voice,
		settings: FAST_SETTINGS,
		...(decisions ? { decisions } : {}),
	});
	if (!a.ok) throw new Error(a.message);
	return {
		a,
		kept: a.plan.kept.map((k) => [k.start / FPS, k.end / FPS] as const),
		removed: a.plan.ranges.map((r) => [r.start / FPS, r.end / FPS] as const),
	};
}

const keptOf = (kept: ReadonlyArray<readonly [number, number]>, s: number, e: number) =>
	kept.reduce((t, [x, y]) => t + Math.max(0, Math.min(e, y) - Math.max(s, x)), 0);

/** Thirty two-syllable words of 0.25 s (the speaker's pace: 0.125 s per syllable), 0.05 s apart, from `t0`. */
const pace = (t0: number) =>
	say(Array.from({ length: 30 }, (_, i) => ['cosa', 'mesa', 'lado', 'vino', 'tema'][i % 5]).join(' '), {
		t0,
		dur: 0.25,
		gap: 0.05,
		pause: 0,
	});

describe('round 12: stretched words against the speaker’s pace', () => {
	it('a 0.95 s word whose syllables take 0.125 s is stretched; a long word said at its normal length is not', () => {
		// "y es extra… ¡extremadamente!" written as one word under 1 s: the 1 s rule never flagged it
		const words = [
			...pace(1),
			...real('y[10.3-10.4] es[10.4-11.35] rápido.[11.35-11.8] es[12.6-12.8] extremadamente[12.8-13.68]'),
		];
		const { v } = voiceOf(words);
		const d = detectCleanup({ mediaId: 'med_s', words, voice: v, language: 'es', settings: FAST_SETTINGS });
		const flagged = d.findings.filter((f) => f.kind === 'untranscribed').map((f) => f.reason.params.text);
		// the speaker's own "extremadamente" lasts 0.88 s (run 9, AG): six syllables at their pace, no restart in it
		expect(flagged).toEqual(['es']);
		expect(d.findings.find((f) => f.reason.params.text === 'es')!.suggested).toBe('review');
	});
});

describe('round 12: sentence ends and quiet speech', () => {
	it('a sentence-final word keeps its fading tail to measured silence, then 80 ms of air', () => {
		const words = say('Vamos a ver si lo arreglen. | Sigue el video. | Luego seguimos con esto ahora', {
			t0: 1,
			dur: 0.25,
			gap: 0.05,
			pause: 1,
		});
		const { v, put } = voiceOf(words);
		const at = (t: string) => words.find((w) => w.text === t)!;
		// "arreglen." fades after its time: unvoiced frames from −30 to −58 dBFS (floor −60: silence under −54)
		const e1 = sec(at('arreglen.').end);
		put(e1, e1 + 0.06, { db: (f) => -30 - (f - Math.round(e1 * 100)) * 6, cls: 0 });
		// the soft "video." (−28 dBFS) ends inside its time at −50…−57 dBFS: measured silence, but within 30 dB of the word
		const w2 = at('video.');
		put(sec(w2.start), sec(w2.end), { db: () => -28 });
		put(sec(w2.end) - 0.12, sec(w2.end), { db: (f) => -50 - ((f * 7) % 8), cls: 0, voicing: () => 0.2 });
		const { kept } = plan(words, v);
		const pieceEnd = (t: number) => kept.find(([x, y]) => x <= t && y > t)?.[1] ?? Number.NaN;
		// the decay reaches measured silence 50 ms after the word (−54 is not under −54): kept, then 80 ms of air, on the grid
		expect(pieceEnd(e1 - 0.01)).toBeGreaterThanOrEqual(e1 + 0.05 + 0.06);
		expect(pieceEnd(e1 - 0.01)).toBeLessThanOrEqual(e1 + 0.05 + 0.08 + 1 / FPS + 1e-9);
		// all of "video." plays, its quiet end too
		expect(keptOf(kept, sec(w2.start), sec(w2.end))).toBeGreaterThan(sec(w2.end - w2.start) - 1e-6);
		expect(pieceEnd(sec(w2.end) - 0.01)).toBeGreaterThanOrEqual(sec(w2.end) + 0.06);
	});

	it('a quiet phrase without words, voiced and rising and falling like syllables, is voice for review, not a pause', () => {
		// "…lo arreglen. | es un keke. | Sigue…": the phrase ≈ 20 dB under the speech level, under the speech threshold
		const words = say('Vamos a ver si lo arreglen. | Sigue el video ahora', {
			t0: 1,
			dur: 0.25,
			gap: 0.05,
			pause: 2,
		});
		const { v, put } = voiceOf(words);
		const end = sec(words.find((w) => w.text === 'arreglen.')!.end);
		const [pa, pb] = [end + 0.6, end + 1.25];
		// four syllables of 160 ms: a voiced vowel at −30 dBFS, then an unvoiced consonant at −42 dBFS
		put(pa, pb, {
			db: (f) => ((f - Math.round(pa * 100)) % 16 < 8 ? -30 : -42),
			voicing: (f) => ((f - Math.round(pa * 100)) % 16 < 8 ? 0.7 : 0.2),
			cls: 0,
		});
		const { a, kept } = plan(words, v);
		const overlaps = (f: { range: { start: number; end: number } }) =>
			sec(f.range.start) < pb && sec(f.range.end) > pa;
		expect(a.findings.filter((f) => f.kind === 'pause' && overlaps(f))).toEqual([]);
		const voice = a.findings.find((f) => f.kind === 'untranscribed' && overlaps(f));
		expect(voice?.suggested).toBe('review');
		expect(keptOf(kept, pa, pb)).toBeGreaterThan(pb - pa - 1 / FPS);
		// a steady hum at the same level is no speech: the pause takes it
		const hum = voiceOf(words);
		hum.put(pa, pb, { db: () => -30, voicing: () => 0.7, cls: 0 });
		expect(plan(words, hum.v).a.findings.some((f) => f.kind === 'pause' && overlaps(f))).toBe(true);
	});
});
