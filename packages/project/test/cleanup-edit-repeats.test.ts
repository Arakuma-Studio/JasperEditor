// Repeats in the edit (docs/wp-notes/transcript-cleanup.md "Repeats at cuts"): a cut that joins an abandoned start of a
// phrase to the take that says it again, and stutters left inside a kept span, found in chunked words of the kept spans
// (or of the mixdown) that the stored transcript merged.
import { describe, expect, it } from 'vitest';
import type { CleanupVoice } from '../src/cleanup/detector.ts';
import {
	type EditRepeat,
	type EditSpan,
	type EditWord,
	editSpanRequest,
	findEditRepeats,
} from '../src/cleanup/edit-repeats.ts';
import { editSpans } from '../src/cleanup/edit-spans.ts';
import { FAST_SETTINGS } from '../src/cleanup/schema.ts';
import { analyzeSequenceCleanup } from '../src/cleanup/sequence.ts';
import { FLICKS_PER_SECOND, flicksPerFrame } from '../src/time.ts';
import corpus from './fixtures/cleanup-real-takes.json' with { type: 'json' };
import fixture from './fixtures/edit-repeats-rev144.json' with { type: 'json' };
import { Harness, videoAsset } from './helpers.ts';

const S = (x: number) => Math.round(x * FLICKS_PER_SECOND);
const sec = (f: number) => f / FLICKS_PER_SECOND;
const RATE60 = { num: 60, den: 1 };
const F60 = flicksPerFrame(RATE60);

type Fx = (typeof fixture.cases)[number];

const spansOf = (c: Fx): EditSpan[] =>
	c.spans.map((s) => ({
		clipId: s.clipId,
		mediaId: fixture.mediaId,
		stream: 1,
		seqStart: s.seqStart,
		seqEnd: s.seqEnd,
		mediaStart: S(s.mediaStart),
		mediaEnd: S(s.mediaEnd),
	}));

/** A fake chunked transcription: the given words that lie in the padded span (media flicks). */
const lookup =
	(words: ReadonlyArray<readonly [string, number, number]>) =>
	(span: EditSpan): EditWord[] => {
		const r = editSpanRequest(span);
		return words
			.filter(([, s, e]) => S(e) > r.start && S(s) < r.end)
			.map(([text, s, e]) => ({ text, start: S(s), end: S(e), confidence: 0.95 }));
	};

type W = Array<[string, number, number]>;

/** The voice analysis of the case's region: speech everywhere but the measured non-speech runs. */
function voiceOf(c: Fx): CleanupVoice {
	const n = Math.ceil((Math.max(...c.spans.map((x) => x.mediaEnd)) + 2) * 100);
	const classes = new Uint8Array(n).fill(2);
	for (const [a, b] of c.nonSpeech)
		for (let k = Math.round(a * 100); k < Math.round(b * 100); k++) classes[k] = 0;
	return {
		classes,
		level: new Uint8Array(n),
		frameCount: n,
		levels: { floorDb: -50, speechDb: -9, speechThresholdDb: -37.7, breathFloorDb: -45 },
	};
}

const run = (
	c: Fx,
	words = c.words as W,
	confirm: W | null = c.confirm === 'stored' ? (c.stored as W) : words,
) =>
	findEditRepeats({
		spans: spansOf(c),
		rate: RATE60,
		words: lookup(words),
		confirm: confirm ? [lookup(confirm)] : [],
		voice: () => voiceOf(c),
		settings: FAST_SETTINGS,
		language: 'es',
	});

const inside = (t: number, xs: ReadonlyArray<readonly [number, number]>) =>
	xs.some(([a, b]) => t >= a && t < b);
const mid = (w: readonly [string, number, number]) => (w[1] + w[2]) / 2;

/**
 * What the cases must give: the words that go (the earlier copy) and where the copies lie; `review` — a doubled phrase
 * one decode wrote (the second says it once) is never removed by default; null — nothing proposed.
 */
const EXPECT: Record<string, { text: string; where: 'cut' | 'span' } | 'review' | null> = {
	'y si | y si buscas': { text: 'y', where: 'cut' },
	'aunque el | aunque el Jaspersito': { text: 'Aunque el', where: 'cut' },
	'No | no había': { text: 'No', where: 'cut' },
	'así que el… | así que el botón': { text: 'que el...', where: 'cut' },
	'y que | y que mi': { text: 'y que', where: 'span' },
	'y los… | y después los puse': { text: 'Y los...', where: 'span' },
	'como | como un': { text: 'como', where: 'cut' },
	'Hubo | Hubo otro': { text: 'Hubo', where: 'cut' },
	'Pero | Pero de qué': { text: 'Pero', where: 'cut' },
	// one decode wrote them twice, the stored transcript and the cut's per-span decode once: review at most
	'tiene que… tiene que': 'review',
	'un montón de… un montón de': 'review',
	// the user's v7 review: said once (an ASR doubling, a closure inside "mostrar", the stressed "-xel")
	'most… mostrar': 'review',
	'en una… en una': 'review',
	'tienes que (said once)': 'review',
	'pixel (one word)': 'review',
	'boing boing boing (deliberate)': null,
};

describe('repeats in the edit of a real cut (rev 144)', () => {
	for (const c of fixture.cases) {
		const want = EXPECT[c.name]!;
		const title =
			want === 'review'
				? `${c.name}: one decode only, never removed by default`
				: want
					? `${c.name}: the earlier copy goes, as the hand fix of rev 267 removed`
					: `${c.name}: nothing goes`;
		it(title, () => {
			const reps = run(c);
			const rm = reps.filter((r) => r.suggested === 'remove');
			if (want === null) {
				expect(rm).toEqual([]);
				return;
			}
			if (want === 'review') {
				expect(rm).toEqual([]);
				return;
			}
			expect(rm.map((r) => [r.text, r.where])).toEqual([[want.text, want.where]]);
			// the words it removes against the words the hand fix removed (both within the spans rev 144 kept)
			const kept144 = c.spans.map((s) => [s.mediaStart, s.mediaEnd] as [number, number]);
			const cuts = rm[0]!.cuts.map((x) => [sec(x.start), sec(x.end)] as [number, number]);
			const kept267 = c.kept267 as Array<[number, number]>;
			const words = (c.words as W).filter((w) => inside(mid(w), kept144));
			const byRule = words.filter((w) => inside(mid(w), cuts)).map((w) => `${w[0]}@${w[1]}`);
			const byHand = words.filter((w) => !inside(mid(w), kept267)).map((w) => `${w[0]}@${w[1]}`);
			if (c.name === 'y si | y si buscas') {
				// the hand fix kept the clip's trailing "y" and removed the retry's: either way "y si buscas" plays once
				expect(byRule).toEqual(['y@396.6435']);
				expect(byHand).toEqual(['y@408.096']);
			} else expect(byRule).toEqual(byHand);
			// the take after a cut stays whole
			if (want.where === 'cut') {
				const last = c.spans.findIndex((s) => s.clipId === rm[0]!.cuts[rm[0]!.cuts.length - 1]!.clipId);
				const next = spansOf(c)[last + 1]!;
				expect(rm[0]!.cuts.some((x) => x.clipId === next.clipId)).toBe(false);
			}
		});
	}

	it('a repeat one decode alone finds is only reviewed', () => {
		const c = fixture.cases.find((x) => x.name === 'No | no había')!;
		const reps = run(c, c.words as W, null);
		expect(reps.map((r) => [r.text, r.suggested, r.held])).toEqual([['No', 'review', 'decode']]);
	});

	it('no edge goes through a closure, even when two decodes write the restart', () => {
		// "most… mostrar" written twice by both decodes: the only dip between the copies is 60 ms (1646.31–1646.37)
		const c = fixture.cases.find((x) => x.name === 'most… mostrar')!;
		const reps = run(c, c.words as W, c.words as W);
		expect(reps.map((r) => [r.text, r.suggested, r.held])).toEqual([['most...', 'review', 'closure']]);
	});

	it('the stored transcript alone finds none of the cut repeats', () => {
		// the reason for chunked words: the merged words hold one copy, or put the retry's first word before the clip
		const found = fixture.cases
			.filter((c) => typeof EXPECT[c.name] === 'object' && EXPECT[c.name] !== null)
			.filter((c) => (EXPECT[c.name] as { where: string }).where === 'cut')
			.filter((c) => run(c, c.stored as W, c.stored as W).length > 0)
			.map((c) => c.name);
		expect(found).toEqual([]);
	});
});

/** A span list and words from compact strings: spans "clip:seqFrom-seqTo@mediaFrom" (frames at 60 fps, seconds). */
function edit(spans: string[], words: string): { spans: EditSpan[]; words: Array<[string, number, number]> } {
	const sp = spans.map((s): EditSpan => {
		const m = /^(\w+):(\d+)-(\d+)@([\d.]+)$/.exec(s)!;
		const [a, b, ms] = [Number(m[2]), Number(m[3]), Number(m[4])];
		return {
			clipId: m[1]!,
			mediaId: 'm',
			stream: 1,
			seqStart: a,
			seqEnd: b,
			mediaStart: S(ms),
			mediaEnd: S(ms) + (b - a) * F60,
		};
	});
	const ws = words
		.trim()
		.split(/\s+/)
		.map((x) => {
			const m = /^(.*)\[([\d.]+)-([\d.]+)\]$/.exec(x)!;
			return [m[1]!.replace(/_/g, ' '), Number(m[2]), Number(m[3])] as [string, number, number];
		});
	return { spans: sp, words: ws };
}

/** Speech under every word, silence elsewhere. */
function wordVoice(words: W): CleanupVoice {
	const n = Math.ceil((Math.max(...words.map((w) => w[2])) + 2) * 100);
	const classes = new Uint8Array(n);
	for (const [, a, b] of words)
		for (let k = Math.round(a * 100); k < Math.round(b * 100); k++) classes[k] = 2;
	return {
		classes,
		level: new Uint8Array(n),
		frameCount: n,
		levels: { floorDb: -60, speechDb: -14, speechThresholdDb: -46, breathFloorDb: -55 },
	};
}

/** Two agreeing decodes of the given words, with their voice. */
const check = (e: ReturnType<typeof edit>, script: string | null = null): EditRepeat[] =>
	findEditRepeats({
		spans: e.spans,
		rate: RATE60,
		words: lookup(e.words),
		confirm: [lookup(e.words)],
		voice: () => wordVoice(e.words),
		settings: FAST_SETTINGS,
		language: 'es',
		script,
	});

describe('deliberate repetition is never removed', () => {
	it('a reduplication said together in the recording, with only its pause cut, gives nothing', () => {
		// "y hace boing, | boing, boing." — the copies 0.3 s apart in the source
		const e = edit(
			['A:0-120@10', 'B:120-240@12.3'],
			'y[10.2-10.4] hace[10.4-10.8] boing,[11.5-11.95] boing,[12.35-12.8] boing.[12.9-13.4] Luego[13.6-13.9]',
		);
		expect(check(e)).toEqual([]);
	});

	it('allowed emphasis said together gives nothing; the same word joined from another moment goes', () => {
		const together = edit(
			['A:0-90@20', 'B:90-240@21.6'],
			'Pues[20.1-20.5] no,[20.9-21.4] no[21.65-21.9] había[21.9-22.3] botones[22.3-22.9]',
		);
		expect(check(together)).toEqual([]);
		const apart = edit(
			['A:0-90@20', 'B:90-240@60'],
			'Pues[20.1-20.5] no[20.9-21.45] No[60.05-60.3] había[60.3-60.7] botones[60.7-61.3]',
		);
		expect(check(apart).map((r) => [r.text, r.suggested])).toEqual([['no', 'remove']]);
	});

	it('a reduplication joined from two moments is only reviewed', () => {
		const e = edit(
			['A:0-60@5', 'B:60-180@40'],
			'Dijo,[5.0-5.3] guiño.[5.4-5.9] Guiño.[40.1-40.6] Y[41.2-41.3] se[41.3-41.5] fue.[41.5-41.9]',
		);
		expect(check(e).map((r) => [r.text, r.suggested])).toEqual([['guiño.', 'review']]);
	});

	it('a repetition the script says is no attempt', () => {
		const e = edit(
			['A:0-60@5', 'B:60-180@40'],
			'Y[5.0-5.2] dijo:[5.2-5.6] hola[5.6-5.95] hola[40.05-40.4] a[40.4-40.5] todos.[40.5-41.0]',
		);
		expect(check(e).filter((r) => r.suggested === 'remove')).toHaveLength(1);
		expect(check(e, 'Y dijo: hola hola a todos.')).toEqual([]);
	});

	it('a clip that ends a sentence before one that starts with its words is only reviewed', () => {
		const e = edit(
			['A:0-120@5', 'B:120-240@40'],
			'Todo[5.0-5.3] corre[5.3-5.7] en[5.7-5.8] mi[5.8-5.95] motor.[5.95-6.6] Mi[40.05-40.2] motor[40.2-40.6] tiene[40.6-40.9] físicas[40.9-41.5]',
		);
		expect(check(e).map((r) => [r.text, r.suggested])).toEqual([['mi motor.', 'review']]);
	});

	it('one word across a cut restarts nothing when it does not start a clause', () => {
		// "Bueno, no lo | Lo reescribieron mis agentes" (rev 144, 3159 s): the cut shortened "no lo reescribí yo."
		const e = edit(
			['A:0-120@5', 'B:120-300@40'],
			'Bueno,[5.0-5.4] no[5.5-5.7] lo[5.7-5.9] Lo[40.05-40.2] reescribieron[40.2-40.9] mis[40.9-41.1] agentes[41.1-41.6]',
		);
		expect(check(e)).toEqual([]);
	});

	it('a hesitation on a stop word inside a span is no restart', () => {
		const e = edit(
			['A:0-300@5'],
			'Y[5.0-5.2] lo[5.2-5.4] que…[5.4-5.8] quedó[6.2-6.6] fue[6.6-6.8] esto.[6.8-7.2]',
		);
		expect(check(e)).toEqual([]);
	});
});

describe('Clean Up plans the repeats in the edit', () => {
	/** "es muy complejo de hacer, y | y si buscas en internet": the stored transcript wrote one "y". */
	function setup() {
		const H = new Harness({ preset: 'hd-1080p-30' });
		const r0 = H.ok([{ type: 'media.register', asset: videoAsset({ seconds: 30, kind: 'audio' }) }]);
		const mediaId = (r0.results[0] as { mediaId: string }).mediaId;
		H.ok([
			{
				type: 'clip.place',
				source: { mediaId },
				sourceRange: { in: { seconds: 1 }, out: { seconds: 2.8 } },
				at: 0,
				tracks: { audio: ['A1'] },
				mode: 'overwrite',
			},
		]);
		H.ok([
			{
				type: 'clip.place',
				source: { mediaId },
				sourceRange: { in: { seconds: 10 }, out: { seconds: 12.6 } },
				at: 54,
				tracks: { audio: ['A1'] },
				mode: 'overwrite',
			},
		]);
		const stored = [
			['es', 1.1, 1.3],
			['muy', 1.3, 1.6],
			['complejo', 1.6, 2.1],
			['de', 2.1, 2.25],
			['hacer,', 2.25, 2.5],
			['y', 10.05, 10.2],
			['si', 10.2, 10.4],
			['buscas', 10.4, 10.8],
			['en', 10.8, 10.95],
			['internet', 10.95, 11.5],
			['debería', 11.6, 12.0],
			['ser', 12.0, 12.3],
		] as Array<[string, number, number]>;
		const words = stored.map(([text, s, e]) => ({ text, start: S(s), end: S(e), confidence: 0.95 }));
		H.ok([{ type: 'transcript.create', mediaId, language: 'es', origin: 'manual', words }]);
		const chunked = [...stored.slice(0, 5), ['y', 2.6, 2.75] as [string, number, number], ...stored.slice(5)];
		// the voice analysis: speech under every word said (the stored transcript's missing "y" too), the floor elsewhere
		const n = 3000;
		const classes = new Uint8Array(n);
		const level = new Uint8Array(n).fill((-60 + 120) * 2);
		for (const [, a, b] of chunked)
			for (let k = Math.round(a * 100); k < Math.round(b * 100); k++) {
				classes[k] = 2;
				level[k] = (-14 + 120) * 2;
			}
		const voice: CleanupVoice = {
			classes,
			level,
			frameCount: n,
			levels: { floorDb: -60, speechDb: -14, speechThresholdDb: -46, breathFloorDb: -55 },
		};
		return { H, mediaId, chunked, voice };
	}

	it('an accepted repeat across a cut removes the earlier copy and keeps the retry whole', () => {
		const { H, chunked, voice } = setup();
		const sp = editSpans(H.doc, H.seq);
		if (!sp.ok) throw new Error(sp.message);
		const editRepeats = findEditRepeats({
			spans: sp.spans,
			rate: H.seq.settings.frameRate,
			words: lookup(chunked),
			confirm: [lookup(chunked)],
			voice: () => voice,
			settings: FAST_SETTINGS,
			language: 'es',
		});
		const a = analyzeSequenceCleanup({
			doc: H.doc,
			seq: H.seq,
			voice: () => voice,
			settings: FAST_SETTINGS,
			editRepeats,
		});
		if (!a.ok) throw new Error(a.message);
		const f = a.findings.find((x) => x.reason.params.cut === 1);
		expect(f && [f.kind, f.suggested, f.reason.params.text, f.reason.params.kept]).toEqual([
			'restart',
			'remove',
			'y',
			'y si buscas',
		]);
		const [clipA, clipB] = sp.spans;
		const keptA = a.plan.kept.filter((k) => k.clipId === clipA!.clipId);
		const keptB = a.plan.kept.filter((k) => k.clipId === clipB!.clipId);
		// clip A plays at 30 fps from 1 s of media: the cut starts at or before the attempt (2.6 s → frame 48)
		expect(Math.max(...keptA.map((k) => k.end))).toBeLessThanOrEqual(48);
		expect(Math.max(...keptA.map((k) => k.end))).toBeGreaterThanOrEqual(45); // "hacer," (ends 2.5 s) plays
		expect(a.editRepeats).toEqual(editRepeats);

		// rejected, nothing goes: the plan of the stored transcript alone, which finds no repeat and keeps the voice
		// of the "y" it has no word for
		const r = analyzeSequenceCleanup({
			doc: H.doc,
			seq: H.seq,
			voice: () => voice,
			settings: FAST_SETTINGS,
			editRepeats,
			decisions: { reject: [f!.fingerprint] },
		});
		if (!r.ok) throw new Error(r.message);
		const plain = analyzeSequenceCleanup({
			doc: H.doc,
			seq: H.seq,
			voice: () => voice,
			settings: FAST_SETTINGS,
		});
		if (!plain.ok) throw new Error(plain.message);
		expect(plain.findings.filter((x) => x.kind === 'restart' || x.kind === 'stutter')).toEqual([]);
		expect(r.plan.kept).toEqual(plain.plan.kept);
		expect(
			Math.max(...plain.plan.kept.filter((k) => k.clipId === clipA!.clipId).map((k) => k.end)),
		).toBeGreaterThan(52);
		// the retry's clip plays as it does without the finding, from its first frame
		expect(keptB).toEqual(plain.plan.kept.filter((k) => k.clipId === clipB!.clipId));
		expect(keptB[0]!.start).toBe(54);
	});

	it('the cut of an accepted repeat keeps the fading decay of the word before it (edge-snap.ts)', () => {
		const { H, chunked, voice } = setup();
		// "hacer," fades out over 0.16 s (−14 → −46 dBFS) into the attempt's timestamp; the attempt "y" sounds from 2.68 s
		for (let k = 250; k < 268; k++) {
			voice.classes[k] = k < 256 ? 2 : 0;
			voice.level[k] = (k < 266 ? -14 - (k - 250) * 2 + 120 : -60 + 120) * 2;
		}
		const sp = editSpans(H.doc, H.seq);
		if (!sp.ok) throw new Error(sp.message);
		const editRepeats = findEditRepeats({
			spans: sp.spans,
			rate: H.seq.settings.frameRate,
			words: lookup(chunked),
			confirm: [lookup(chunked)],
			voice: () => voice,
			settings: FAST_SETTINGS,
			language: 'es',
		});
		const a = analyzeSequenceCleanup({
			doc: H.doc,
			seq: H.seq,
			voice: () => voice,
			settings: FAST_SETTINGS,
			editRepeats,
		});
		if (!a.ok) throw new Error(a.message);
		expect(a.findings.find((x) => x.reason.params.cut === 1)?.suggested).toBe('remove');
		const clipA = sp.spans[0]!.clipId;
		const end = Math.max(...a.plan.kept.filter((k) => k.clipId === clipA).map((k) => k.end));
		// the cut's frame grid put the edge at 2.6 s (frame 48), 22 dB into the decay; it now waits for the quiet at 2.633 s
		expect(end).toBe(49);
	});

	it('the closed loop maps the mixdown words back to clips, for review', () => {
		const { H } = setup();
		const sp = editSpans(H.doc, H.seq);
		if (!sp.ok) throw new Error(sp.message);
		// the mixdown of the cut (sequence time): "… de hacer, y y si buscas …"
		const mix = [
			['de', 1.1, 1.25],
			['hacer,', 1.25, 1.55],
			['y', 1.6, 1.75],
			['y', 1.85, 2.0],
			['si', 2.0, 2.2],
			['buscas', 2.2, 2.6],
			['en', 2.6, 2.75],
			['internet', 2.75, 3.3],
		].map(([text, s, e]) => ({
			text: text as string,
			start: S(s as number),
			end: S(e as number),
			confidence: 0.9,
		}));
		const reps = findEditRepeats({
			spans: sp.spans,
			rate: H.seq.settings.frameRate,
			mix,
			settings: FAST_SETTINGS,
			language: 'es',
		});
		expect(reps.map((r) => [r.source, r.where, r.text, r.suggested])).toEqual([
			['mix', 'cut', 'y', 'review'],
		]);
		const cut = reps[0]!.cuts[0]!;
		expect([cut.clipId, sec(cut.start), sec(cut.end)]).toEqual([sp.spans[0]!.clipId, 2.6, 2.8]);
	});
});

describe('precision on the real-take corpus', () => {
	it('the edit check over each fragment as one kept span removes ≥ 99 % words its reference removes', () => {
		// two agreeing decodes (the corpus words twice) and speech under every word (the corpus voice): what the matcher
		// and the detector's rules remove from takes said in one go, against each case's `dup` reference
		let right = 0;
		let wrong = 0;
		for (const c of corpus.cases as unknown as Array<{
			words: W;
			dup?: Array<[number, number]>;
			debatable?: Array<[number, number]>;
		}>) {
			const end = Math.max(...c.words.map((w) => w[2])) + 1;
			const span: EditSpan = {
				clipId: 'c',
				mediaId: 'm',
				stream: 0,
				seqStart: 0,
				seqEnd: Math.ceil(end * 60),
				mediaStart: 0,
				mediaEnd: Math.ceil(end * 60) * F60,
			};
			const words = lookup(c.words);
			const reps = findEditRepeats({
				spans: [span],
				rate: RATE60,
				words,
				confirm: [words],
				voice: () => wordVoice(c.words),
				settings: FAST_SETTINGS,
				language: 'es',
			});
			const cuts = reps
				.filter((r) => r.suggested === 'remove')
				.flatMap((r) => r.cuts.map((x) => [sec(x.start), sec(x.end)] as [number, number]));
			for (const w of c.words) {
				if (!inside(mid(w), cuts)) continue;
				const near = (xs: Array<[number, number]> | undefined) =>
					(xs ?? []).some(([a, b]) => mid(w) >= a - 1e-6 && mid(w) <= b + 1e-6);
				if (near(c.dup) && !near(c.debatable)) right++;
				else wrong++;
			}
		}
		expect(right + wrong).toBeGreaterThan(1000);
		expect(right / (right + wrong)).toBeGreaterThanOrEqual(0.99);
	});
});
