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
	restartWindows,
} from '../src/cleanup/edit-repeats.ts';
import { editSpans } from '../src/cleanup/edit-spans.ts';
import { FAST_SETTINGS } from '../src/cleanup/schema.ts';
import { analyzeSequenceCleanup } from '../src/cleanup/sequence.ts';
import { FLICKS_PER_SECOND, flicksPerFrame } from '../src/time.ts';
import corpus from './fixtures/cleanup-real-takes.json' with { type: 'json' };
import fixture from './fixtures/edit-repeats-rev144.json' with { type: 'json' };
import spanStart from './fixtures/edit-repeats-span-start.json' with { type: 'json' };
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
	// the clip's In cuts into "Así" and plays the rest of it (`heardFromCutStart`): the attempt starts with it
	'así que el… | así que el botón': { text: 'Así que el...', where: 'cut' },
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

	it('the stored transcript alone finds one of the cut repeats', () => {
		// the reason for chunked words: the merged words hold one copy, or put the retry's first word before the clip;
		// only "No" is found: the stored retry "No" (1155.40–1155.79) starts before the clip's In (1155.683), which plays
		// 27 % of it, so it is heard through the clip (`heardFromCutStart`)
		const found = fixture.cases
			.filter((c) => typeof EXPECT[c.name] === 'object' && EXPECT[c.name] !== null)
			.filter((c) => (EXPECT[c.name] as { where: string }).where === 'cut')
			.filter((c) => run(c, c.stored as W, c.stored as W).length > 0)
			.map((c) => c.name);
		expect(found).toEqual(['No | no había']);
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

describe('a restart at the start of a phrase that the span decodes merge (v8 review)', () => {
	// "Lo… | Lo reescribieron mis agentes": a decode from before the fragment writes "Lo reescribí a mis agentes", one
	// from inside the dip "Lo reescribieron mis agentes"; the user cut at 3172.167
	type Region = { from: number; level: number[]; speech: string };
	const voiceAt = (r: Region, pauseAt?: [number, number]): CleanupVoice => {
		const n = Math.round((r.from + r.level.length / 100 + 1) * 100);
		const classes = new Uint8Array(n);
		const level = new Uint8Array(n);
		const k0 = Math.round(r.from * 100);
		r.level.forEach((db, i) => {
			level[k0 + i] = Math.round((db + 120) * 2);
			classes[k0 + i] = r.speech[i] === 'S' ? 2 : 0;
		});
		if (pauseAt)
			for (let k = Math.round(pauseAt[0] * 100); k < Math.round(pauseAt[1] * 100); k++) classes[k] = 0;
		return {
			classes,
			level,
			frameCount: n,
			levels: { floorDb: -50, speechDb: -9, speechThresholdDb: -37.7, breathFloorDb: -45 },
		};
	};
	const span = (id: string, seqStart: number, from: number, to: number): EditSpan => ({
		clipId: id,
		mediaId: 'm',
		stream: 1,
		seqStart,
		seqEnd: seqStart + Math.round((to - from) * 60),
		mediaStart: S(from),
		mediaEnd: S(from) + Math.round((to - from) * 60) * F60,
	});
	const analyse = (spans: EditSpan[], voice: CleanupVoice, decodes: { merged: W; window: W; stored: W }) => {
		const windows = restartWindows(spans, () => voice);
		return {
			windows,
			reps: findEditRepeats({
				spans,
				rate: RATE60,
				words: lookup(decodes.merged),
				confirm: [lookup(decodes.merged), lookup(decodes.stored)],
				windows: windows.map((w) => ({
					...w,
					words: decodes.window
						.filter(([, s]) => S(s) >= w.start - S(0.03) && S(s) < w.end)
						.map(([text, s, e]) => ({ text, start: S(s), end: S(e), confidence: 0.9 })),
				})),
				voice: () => voice,
				settings: FAST_SETTINGS,
				language: 'es',
			}),
		};
	};
	const ss = spanStart as unknown as {
		merged: W;
		window: W;
		stored: W;
		voice: Region;
		mostrarStored: W;
		mostrarWindow: W;
		mostrarVoice: Region;
	};
	const decodes = { merged: ss.merged, window: ss.window, stored: ss.stored };

	for (const [variant, spans] of [
		['at the start of a kept span', [span('A', 0, 3159.0, 3160.08), span('B', 65, 3171.95, 3179.2)]],
		['inside a kept span, after a pause', [span('B', 0, 3170.5, 3179.2)]],
	] as const) {
		it(`${variant}: a review finding cutting the fragment up to the dip`, () => {
			const voice = voiceAt(ss.voice);
			const { windows, reps } = analyse([...spans], voice, decodes);
			// one window, from inside the dip (3172.12–3172.19)
			expect(windows.map((w) => [sec(w.dip[0]), sec(w.dip[1])])).toEqual([[3172.12, 3172.19]]);
			expect(reps.map((r) => [r.where, r.text, r.kept, r.suggested, r.held])).toEqual([
				['span', 'Lo', 'Lo reescribieron mis', 'review', 'decode'],
			]);
			// accepted, it cuts from the fragment's onset (the span's start, or the start of its voice) to the dip's quietest
			// frame (3172.15; the user cut at 3172.167)
			const c = reps[0]!.cuts[0]!;
			expect([c.clipId, sec(c.start), sec(c.end)]).toEqual([
				'B',
				variant.startsWith('at') ? 3171.95 : 3171.84,
				3172.15,
			]);
		});
	}

	it('with a measured pause at the dip the fragment goes by default', () => {
		const voice = voiceAt(ss.voice, [3172.11, 3172.2]);
		const { reps } = analyse([span('B', 0, 3171.95, 3179.2)], voice, decodes);
		expect(reps.map((r) => [r.text, r.suggested, sec(r.cuts[0]!.end)])).toEqual([['Lo', 'remove', 3172.2]]);
	});

	it('a closure inside a word gives nothing even when the window decode says the word again', () => {
		// "mostrar": the stored word lies over the 50 ms closure at 1646.31; a decode from the closure writes "mostrar"
		const voice = voiceAt(ss.mostrarVoice);
		const spans = [span('C', 0, 1645.45, 1648.117)];
		const { windows, reps } = analyse(spans, voice, {
			merged: ss.mostrarStored,
			window: ss.mostrarWindow,
			stored: ss.mostrarStored,
		});
		expect(windows.length).toBeGreaterThan(0);
		expect(reps).toEqual([]);
	});

	it('without the window decode the merged decodes miss it', () => {
		const voice = voiceAt(ss.voice);
		const reps = findEditRepeats({
			spans: [span('B', 0, 3171.95, 3179.2)],
			rate: RATE60,
			words: lookup(ss.merged),
			confirm: [lookup(ss.stored)],
			voice: () => voice,
			settings: FAST_SETTINGS,
			language: 'es',
		});
		expect(reps).toEqual([]);
	});
});

describe('repeats the decodes of the real cut wrote differently (rev 144, rev 549 the reference)', () => {
	// The decodes of the user's recording as the engine wrote them (span decodes padded 0.2 s and 0.6 s, the stored
	// transcript, window decodes), one list per clip: docs/wp-notes/transcript-cleanup.md "Repeats at cuts", diagnosis.
	const span = (id: string, seqStart: number, from: number, to: number): EditSpan => ({
		clipId: id,
		mediaId: 'm',
		stream: 1,
		seqStart,
		seqEnd: seqStart + Math.round((to - from) * 60),
		mediaStart: S(from),
		mediaEnd: S(from) + Math.round((to - from) * 60) * F60,
	});
	/** Words from "text@start-end" lists. */
	const ws = (s: string): EditWord[] =>
		s
			.trim()
			.split(/\s+/)
			.map((x) => {
				const m = /^(.*)@([\d.]+)-([\d.]+)$/.exec(x)!;
				return {
					text: m[1]!.replace(/_/g, ' '),
					start: S(Number(m[2])),
					end: S(Number(m[3])),
					confidence: 0.9,
				};
			});
	const byClip =
		(m: Record<string, string>) =>
		(sp: EditSpan): EditWord[] | null =>
			m[sp.clipId] !== undefined ? ws(m[sp.clipId]!) : null;
	/** Connected speech over every span (no pause the voice analysis would measure). */
	const speechOver = (spans: EditSpan[]): CleanupVoice => {
		const n = Math.ceil(sec(Math.max(...spans.map((s) => s.mediaEnd))) * 100) + 200;
		const classes = new Uint8Array(n);
		for (const s of spans)
			for (let k = Math.floor(sec(s.mediaStart) * 100) - 30; k < Math.ceil(sec(s.mediaEnd) * 100) + 30; k++)
				classes[Math.max(0, k)] = 2;
		return {
			classes,
			level: new Uint8Array(n),
			frameCount: n,
			levels: { floorDb: -50, speechDb: -9, speechThresholdDb: -37.7, breathFloorDb: -45 },
		};
	};
	const find = (
		spans: EditSpan[],
		d: {
			words: Record<string, string>;
			alt?: Record<string, string>;
			stored?: string;
			windows?: Array<{ clip: string; dip: [number, number]; words: string }>;
		},
	) =>
		findEditRepeats({
			spans,
			rate: RATE60,
			words: byClip(d.words),
			...(d.alt ? { alt: [byClip(d.alt)] } : {}),
			...(d.stored ? { stored: () => ws(d.stored!) } : {}),
			...(d.windows
				? {
						windows: d.windows.map((w) => {
							const sp = spans.find((s) => s.clipId === w.clip)!;
							const start = S((w.dip[0] + w.dip[1]) / 2);
							return {
								clipId: w.clip,
								mediaId: sp.mediaId,
								stream: sp.stream,
								dip: [S(w.dip[0]), S(w.dip[1])] as [number, number],
								start,
								end: Math.min(sp.mediaEnd, start + S(3)),
								words: ws(w.words),
							};
						}),
					}
				: {}),
			voice: () => speechOver(spans),
			settings: FAST_SETTINGS,
			language: 'es',
		});
	const cutsOf = (r: EditRepeat) => r.cuts.map((c) => [c.clipId, sec(c.start), sec(c.end)]);

	it('an abandoned word the decodes write cut off still makes the attempt ("Aunque el jero… | Aunque el jaspercito")', () => {
		const spans = [span('A', 0, 827.45, 827.967), span('B', 31, 828.15, 833.133)];
		const reps = find(spans, {
			words: {
				A: 'Aunque@827.467-827.687 el@827.687-827.787 jero...@827.787-827.957',
				B: 'Aunque@828.153-828.333 el@828.333-828.473 jaspercito@828.473-828.943 todo@828.953-829.173 bonito@829.173-829.403 estaba@829.453-829.713',
			},
			alt: {
				A: 'Aunque@827.47-827.69 el...@827.69-827.96 Aunque@828.16-828.35 el@828.35-828.45 has...@828.45-828.57',
				B: 'Aunque@827.55-827.96 el@828.16-828.45 jaspercito@828.45-828.94 todo@828.95-829.17 bonito@829.17-829.4',
			},
			stored: 'el@827.667-827.967 Jaspersito@828.43-828.94 todo@828.96-829.17 bonito@829.17-829.4',
		});
		expect(reps.map((r) => [r.where, r.text, r.suggested, cutsOf(r)])).toEqual([
			['cut', 'Aunque el jero...', 'remove', [['A', 827.45, sec(spans[0]!.mediaEnd)]]],
		]);
	});

	it('a restart one span decode merges goes when the other decode and the window decode say it twice ("Y si… y si buscas")', () => {
		const spans = [span('B', 0, 408.083, 411.083)];
		const reps = find(spans, {
			// the 0.2 s decode stretches "buscas" over the 50 ms dip; the 0.6 s decode writes both copies
			words: {
				B: 'Y@408.09-408.19 si@408.19-408.35 buscas@408.35-408.89 en@408.89-409.03 internet,@409.03-409.57 debería@409.57-409.97 ser@409.97-410.17',
			},
			alt: {
				B: 'Y@408.09-408.17 si...@408.17-408.36 y@408.41-408.53 si@408.53-408.61 buscas@408.61-408.89 en@408.89-409.03 internet,@409.03-409.57 debería@409.57-409.95',
			},
			stored:
				'y@408.096-408.166 si@408.176-408.576 buscas@408.576-408.876 en@408.876-409.036 internet@409.036-409.476',
			windows: [
				{
					clip: 'B',
					dip: [408.36, 408.41],
					words:
						'Y@408.403-408.483 si@408.483-408.643 buscas@408.643-408.903 en@408.903-409.023 internet,@409.023-409.563',
				},
			],
		});
		const rm = reps.filter((r) => r.suggested === 'remove');
		expect(rm.map((r) => [r.where, r.text])).toEqual([['span', 'Y si...']]);
		// from the clip's start to the dip, before the retry's onset (the user cut at 408.367)
		const [, a, b] = cutsOf(rm[0]!)[0]! as [string, number, number];
		expect(a).toBe(sec(spans[0]!.mediaStart));
		expect(b).toBeGreaterThanOrEqual(408.36);
		expect(b).toBeLessThanOrEqual(408.41);
	});

	it('a stutter one decode writes over a word the other decode hears through the gap is only reviewed ("tiene que", said once)', () => {
		const spans = [span('S', 0, 70.133, 73.167)];
		const reps = find(spans, {
			words: {
				S: 'Y@70.14-70.2 mi@70.2-70.34 motor@70.34-70.64 tiene@70.64-70.9 que@70.9-71.12 verse@71.12-71.46 y@71.46-71.62 funcionar@71.62-72.08',
			},
			// a decode that doubles it, both copies around the 50 ms dip, and the window decode from the dip agreeing
			alt: {
				S: 'Y@70.137-70.197 mi@70.197-70.337 motor@70.337-70.637 tiene@70.637-70.7 que@70.7-70.74 tiene@70.79-70.92 que@70.92-71.117 verse@71.117-71.457 y@71.457-71.637 funcionar@71.637-72.097',
			},
			windows: [
				{
					clip: 'S',
					dip: [70.74, 70.79],
					words: 'Tiene@70.76-70.94 que@70.94-71.12 verse@71.12-71.46 y@71.46-71.62',
				},
			],
		});
		expect(reps.filter((r) => r.suggested === 'remove')).toEqual([]);
	});

	it('a word the clip’s in point cuts into belongs to the clip ("…sí que… | Así que el botón")', () => {
		const spans = [span('A', 0, 2296.533, 2296.817), span('B', 17, 2301.433, 2306.7)];
		const reps = find(spans, {
			words: {
				A: 'Así@2296.42-2296.61 que...@2296.66-2296.81',
				B: 'Así@2301.433-2301.573 que@2301.573-2301.693 el@2301.693-2301.833 botón@2301.833-2302.233 con@2302.233-2302.513 bordes@2302.513-2302.743',
			},
			alt: {
				A: 'así@2296.427-2296.607 que@2296.657-2296.807 así@2297.197-2297.327 que@2297.327-2297.417',
				B: 'Así@2301.437-2301.577 que@2301.577-2301.697 el@2301.697-2301.837 botón@2301.837-2302.237 con@2302.237-2302.497',
			},
			stored:
				'Así@2296.41-2296.58 que@2296.686-2296.746 el@2296.746-2296.78 ...@2296.78-2296.87 Así@2297.19-2297.36 que@2297.36-2297.48 el@2297.48-2297.58 botón@2301.823-2302.223 con@2302.223-2302.523',
		});
		expect(reps.map((r) => [r.where, cutsOf(r)])).toEqual([
			['cut', [['A', sec(spans[0]!.mediaStart), sec(spans[0]!.mediaEnd)]]],
		]);
	});

	it('a restart at a phrase’s start shows in the window decode when the span decodes stretch a later word over the dip ("Y que mi | y que mi ejército")', () => {
		const spans = [span('S', 0, 2734.35, 2737.167)];
		const reps = find(spans, {
			words: {
				S: 'Y@2734.347-2734.407 que@2734.437-2734.507 mi@2734.507-2734.627 ejército@2734.627-2735.507 de@2735.507-2735.647 cláudas@2735.647-2735.967 nunca@2735.967-2736.227',
			},
			windows: [
				{
					clip: 'S',
					dip: [2734.94, 2734.98],
					words:
						'y@2734.97-2735.03 que@2735.07-2735.13 mi@2735.13-2735.27 ejército@2735.27-2735.51 de@2735.51-2735.66',
				},
			],
		});
		expect(reps.map((r) => [r.where, r.text, r.suggested])).toEqual([['span', 'Y que mi', 'review']]);
	});

	it('a fragment the span decodes cannot read is read from the stored transcript, for review ("Hubo | Hubo otro")', () => {
		const spans = [span('A', 0, 2936.033, 2936.333), span('B', 18, 2937.0, 2942.2)];
		const B =
			'Hubo@2937.003-2937.243 otro@2937.243-2937.423 en@2937.423-2937.563 el@2937.563-2937.643 que@2937.643-2937.783 en@2937.783-2937.883';
		const reps = find(spans, {
			words: { A: 'Me@2935.827-2935.927 decía...@2935.927-2936.247', B },
			alt: { A: 'animación@2935.437-2935.817 es@2935.817-2936.037 siempre@2936.037-2936.247', B },
			stored:
				'animaciones@2935.34-2935.88 ...@2935.88-2936.093 Hubo@2936.093-2936.333 otro@2937.2-2937.42 en@2937.42-2937.56 el@2937.56-2937.62 que,@2937.63-2937.74',
		});
		expect(reps.map((r) => [r.where, r.text, r.suggested, cutsOf(r)])).toEqual([
			['cut', 'Hubo', 'review', [['A', sec(spans[0]!.mediaStart), sec(spans[0]!.mediaEnd)]]],
		]);
	});
});
