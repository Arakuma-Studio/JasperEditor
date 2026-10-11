// Deterministic tests of the transcript → sequence mapping and the text-based edit ranges, on the hand-made
// interview transcript (10 s, two speakers, a 2 s pause after "show.", fillers "Um," and "uh", phrase
// "you know."). Ported from FilmCraft `crates/edit/src/transcript/tests.rs`.
import { describe, expect, it } from 'vitest';
import { snapDown } from '../src/captions/formats/rate.ts';
import {
	type CaptionBlock,
	type CaptionRules,
	captionBlocks,
	DEFAULT_CAPTION_RULES,
	DEFAULT_FILLERS,
	fillerRanges,
	findFillers,
	findPauses,
	mediaWordRange,
	mergeRanges,
	paragraphs,
	type SeqWord,
	searchWords,
	sequenceWords,
	wordAt,
	wordRangeFrames,
} from '../src/captions/index.ts';
import type { Clip, Sequence, Transcript } from '../src/index.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';
import fixture from './fixtures/interview.transcript.json' with { type: 'json' };

const R = { num: 25, den: 1 };
const F = FLICKS_PER_SECOND / 25;
const s = (x: number) => Math.round(x * FLICKS_PER_SECOND);
const fr = (x: number) => Math.round(x * 25);

function interviewTranscript(id = 'trs_interview', mediaId = 'med_interview'): Transcript {
	return {
		id,
		mediaId,
		language: fixture.language,
		origin: 'manual',
		speakers: fixture.speakers,
		words: fixture.words.map((w) => ({
			text: w.text,
			start: s(w.seconds[0]!),
			end: s(w.seconds[1]!),
			confidence: null,
			speaker: w.speaker,
			breakBefore: 'none' as const,
		})),
	};
}

const docT = { transcripts: { trs_interview: interviewTranscript() } };

function audioClip(
	id: string,
	start: number,
	dur: number,
	srcIn: number,
	opts: Partial<{ track: string; rate: number; reverse: boolean; enabled: boolean }> = {},
): Clip {
	return {
		id,
		kind: 'audio',
		trackId: opts.track ?? 'A1',
		start: fr(start),
		duration: fr(dur),
		sourceIn: s(srcIn),
		speed: { rate: opts.rate ?? 1, reverse: opts.reverse ?? false, maintainPitch: true },
		name: 'interview',
		label: 'caribbean',
		enabled: opts.enabled ?? true,
		linkId: null,
		groupId: null,
		markers: [],
		mediaId: 'med_interview',
		channels: { streamIndex: 0, map: [0, 1] },
		gainDb: 0,
		volumeDb: { value: 0, keyframes: [] },
		pan: { value: 0, keyframes: [] },
		effects: [],
	} as Clip;
}

function seqWith(...clips: Clip[]): Sequence {
	return {
		settings: { frameRate: R },
		audioTracks: [
			{ id: 'A1', kind: 'audio', name: null, locked: false, syncLock: true },
			{ id: 'A2', kind: 'audio', name: null, locked: false, syncLock: true },
		],
		videoTracks: [],
		captionTracks: [],
		clips: Object.fromEntries(clips.map((c) => [c.id, c])),
	} as unknown as Sequence;
}

const texts = (w: SeqWord[]) => w.map((x) => x.text);
const whole = () => seqWith(audioClip('c100', 0, 10, 0));

describe('sequence transcript', () => {
	it('maps words through the clip', () => {
		// media 3.5 s – 6.5 s at timeline 2 s
		const w = sequenceWords(docT, seqWith(audioClip('c100', 2, 3, 3.5)));
		expect(texts(w)).toEqual(['Um,', 'today', 'we', 'talk', 'about', 'rivers.']);
		expect(w[0]!.start).toBe(s(2.2));
		expect(w[0]!.end).toBe(s(2.5));
		expect(w[5]!.end).toBe(s(4.4));
		expect(w.every((x) => x.clipId === 'c100' && x.mediaId === 'med_interview' && x.track === 0)).toBe(true);
		expect(w[0]!.index).toBe(4);
		expect(w[0]!.speaker).toBe('Speaker 1');
	});
	it('keeps a cut word by its midpoint and clamps it', () => {
		// cut inside "show." (1.20–1.70, midpoint 1.45): the clip starts at media 1.4
		const w = sequenceWords(docT, seqWith(audioClip('c100', 0, 1, 1.4)));
		expect(texts(w)).toEqual(['show.']);
		expect(w[0]!.start).toBe(0);
		expect(w[0]!.end).toBe(s(0.3));
	});
	it('scales word times by speed', () => {
		const w = sequenceWords(docT, seqWith(audioClip('c100', 0, 5, 0, { rate: 2 })));
		expect(w).toHaveLength(20);
		expect([w[3]!.start, w[3]!.end]).toEqual([s(0.6), s(0.85)]);
	});
	it('reads duplicated tracks once; disabled or reversed clips are silent', () => {
		const q = seqWith(audioClip('c100', 0, 10, 0), audioClip('c101', 0, 10, 0, { track: 'A2' }));
		let w = sequenceWords(docT, q);
		expect(w).toHaveLength(20);
		expect(w.every((x) => x.track === 0)).toBe(true);
		(q.clips.c100 as { enabled: boolean }).enabled = false;
		w = sequenceWords(docT, q);
		expect(w).toHaveLength(20);
		expect(w.every((x) => x.track === 1)).toBe(true);
		(q.clips.c101 as { speed: { reverse: boolean } }).speed.reverse = true;
		expect(sequenceWords(docT, q)).toEqual([]);
	});
	it('repeats words of two clips of the same media in edit order', () => {
		// "rivers." twice: media 5.3–5.9 at 0 s and again at 1 s
		const w = sequenceWords(docT, seqWith(audioClip('c100', 0, 1, 5.2), audioClip('c101', 1, 1, 5.2)));
		expect(texts(w)).toEqual(['rivers.', 'rivers.']);
		expect(w[1]!.start).toBe(s(1.1));
		expect(w[1]!.clipId).toBe('c101');
	});
	it('search, word at and paragraphs', () => {
		const w = sequenceWords(docT, whole());
		expect(searchWords(w, 'rivers')).toEqual([
			[9, 10],
			[17, 18],
		]);
		expect(searchWords(w, 'YOU kn')).toEqual([[18, 20]]);
		expect(searchWords(w, 'talk about')).toEqual([[7, 9]]);
		expect(searchWords(w, '  ')).toEqual([]);
		expect(wordAt(w, s(4.2))).toBe(5);
		expect(wordAt(w, s(2.5))).toBeNull(); // in the pause
		expect(wordAt(w, s(0.1))).toBeNull();
		// pause ≥ 1.5 s after "show.", speaker change before "Thanks"
		expect(paragraphs(w, s(1.5))).toEqual([
			[0, 4],
			[4, 10],
			[10, 20],
		]);
	});
	it('word ranges snap outward', () => {
		const w = sequenceWords(docT, whole());
		// "Welcome to the show." 0.50–1.70 → frames 12..43 (0.48–1.72)
		expect(wordRangeFrames(w, 3, 0, R)).toEqual([12, 43]);
		const m = mediaWordRange(interviewTranscript(), 4, 9, R)!;
		expect(m).toEqual([s(3.68), s(5.92)]);
		expect(wordRangeFrames(w, 0, 99, R)).toBeNull();
	});
	it('finds pauses with kept air, snapped inward', () => {
		const w = sequenceWords(docT, whole());
		// only the 2 s pause after "show." is ≥ 1 s; 0.1 s is kept on each side
		const p = findPauses(w, s(1), s(0.1), R);
		expect(p).toEqual([[fr(1.8), fr(3.6)]]);
		// 0.4 s threshold also finds 5.90→6.40 and 7.60→8.00
		expect(findPauses(w, s(0.4), s(0.1), R)).toHaveLength(3);
	});
	it('finds fillers, longest phrase first, without cutting into neighbours', () => {
		const w = sequenceWords(docT, whole());
		const hits = findFillers(w, DEFAULT_FILLERS);
		expect(hits).toEqual([
			[4, 5],
			[15, 16],
		]);
		expect(findFillers(w, [...DEFAULT_FILLERS, 'You know', 'you'])).toEqual([
			[4, 5],
			[15, 16],
			[18, 20],
		]);
		// "Um," 3.70–4.00 → nearest frames 3.68–4.00; "uh" 8.20–8.50 → 8.20–8.48
		expect(fillerRanges(w, hits, R)).toEqual([
			[fr(3.68), fr(4.0)],
			[fr(8.2), fr(8.48)],
		]);
	});
	it('filler ranges never reach into the neighbouring words', () => {
		// words packed tightly: the filler's nearest-frame snap would overlap both neighbours
		const words = [
			{ text: 'so', start: 0, end: s(0.5) + F / 3 },
			{ text: 'um', start: s(0.5) + F / 3, end: s(0.9) - F / 3 },
			{ text: 'yes', start: s(0.9) - F / 3, end: s(1.4) },
		];
		const [[a, b]] = fillerRanges(words, [[1, 2]], R) as [[number, number]];
		expect(a * F).toBeGreaterThanOrEqual(words[0]!.end);
		expect(b * F).toBeLessThanOrEqual(words[2]!.start);
	});
	it('merges ranges', () => {
		expect(
			mergeRanges([
				[5, 6],
				[1, 2],
				[1.5, 3],
				[3, 4],
			]),
		).toEqual([
			[1, 4],
			[5, 6],
		]);
	});
});

function checkBlocks(b: CaptionBlock[], rules: CaptionRules): void {
	b.forEach((x, i) => {
		expect(x.end).toBeGreaterThan(x.start);
		expect(snapDown(x.start, R)).toBe(x.start);
		expect(snapDown(x.end, R)).toBe(x.end);
		const lines = x.text.split('\n');
		expect(lines.length).toBeLessThanOrEqual(rules.lines);
		expect(lines.every((l) => [...l].length <= rules.maxChars)).toBe(true);
		if (i > 0) expect(x.start).toBeGreaterThanOrEqual(b[i - 1]!.end + F * rules.gapFrames);
	});
}

describe('caption blocks', () => {
	it('follow line length, speaker and pause rules', () => {
		const w = sequenceWords(docT, whole());
		const rules = DEFAULT_CAPTION_RULES;
		const b = captionBlocks(w, rules, R);
		checkBlocks(b, rules);
		expect(b.map((x) => x.text)).toEqual([
			'Welcome to the show.',
			'Um, today we talk about rivers.',
			'Thanks for having me. I uh love rivers,\nyou know.',
		]);
		expect([b[0]!.start, b[0]!.end]).toEqual([s(0.48), s(1.72)]);
		expect(b[2]!.speaker).toBe('Speaker 2');
		expect(b[2]!.words).toEqual([10, 20]);
		// single 20-character lines, two-frame gaps, 3 s minimum
		const tight = { ...rules, maxChars: 20, lines: 1, gapFrames: 2, minDuration: s(3) };
		const t = captionBlocks(w, tight, R);
		checkBlocks(t, tight);
		expect(t.length).toBeGreaterThanOrEqual(5);
		// the first block is extended to 3 s (room before "Um,")
		expect(t[0]!.end - t[0]!.start).toBe(s(3));
		expect(
			t.flatMap((x) => Array.from({ length: x.words[1] - x.words[0] }, (_, k) => x.words[0] + k)),
		).toEqual(Array.from({ length: 20 }, (_, k) => k));
	});
	it('never overlap with dense words', () => {
		const words = Array.from({ length: 30 }, (_, i) => ({
			text: `w${i}.`,
			start: i * F,
			end: (i + 1) * F,
			speaker: i % 3 === 0 ? 'A' : 'B',
		}));
		const rules = { ...DEFAULT_CAPTION_RULES, gapFrames: 1 };
		checkBlocks(captionBlocks(words, rules, R), rules);
	});
	it('a short caption extends into the silence but never over the next caption', () => {
		const words = [
			{ text: 'Hi.', start: 0, end: s(0.2) },
			{ text: 'There', start: s(0.5), end: s(0.9), breakBefore: 'segment' },
		];
		const b = captionBlocks(words, DEFAULT_CAPTION_RULES, R);
		expect(b).toHaveLength(2);
		expect(b[0]!.end).toBe(b[1]!.start);
		expect(b[1]!.end - b[1]!.start).toBe(s(1));
	});
	it('breaks at maximum duration', () => {
		const words = Array.from({ length: 20 }, (_, i) => ({
			text: 'a',
			start: s(i * 0.5),
			end: s(i * 0.5 + 0.4),
		}));
		const b = captionBlocks(words, { ...DEFAULT_CAPTION_RULES, maxChars: 200 }, R);
		expect(b.length).toBeGreaterThan(1);
		for (const x of b)
			expect(words[x.words[1] - 1]!.end - words[x.words[0]]!.start).toBeLessThanOrEqual(s(7));
	});
});
