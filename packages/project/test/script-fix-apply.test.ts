// Spec 17 SC-050…SC-054: `transcript.replaceWords` on documents built through the real commands — index-free edits
// composing in one transaction, refusals (E_NOT_FOUND / E_STALE / E_INVALID_PARAM), undo (the previous document is
// untouched) and redo (deterministic), invariants, and the in-place patch of subtitle text clips (styled runs, line
// breaks, re-break, highlight, hand edits, Source Text keys) and caption-track clips; `planReplaceWords` reports
// exactly what the command does. Invented neutral words only.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type CaptionsClip,
	type Clip,
	captionOf,
	checkInvariants,
	FLICKS_PER_SECOND,
	type ProjectDocument,
	planReplaceWords,
	type ReplaceWordsEdit,
	type TranscriptWord,
	wordsInSequence,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

type TextClip = Extract<Clip, { kind: 'text' }>;
const sec = (x: number) => Math.round(x * FLICKS_PER_SECOND);
const valid = (doc: ProjectDocument) => expect(checkInvariants(doc)).toEqual([]);

/** 30 fps: media A transcribed, on V1/A1 from frame 0 (sequence time = media time). */
function talk(words: Array<[string, number, number, Partial<TranscriptWord>?]>) {
	const H = new Harness({ preset: 'hd-1080p-30' });
	const a = H.registerVideo({ seconds: 20 });
	H.ok([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 0,
			tracks: { video: 'V1', audio: ['A1'] },
			mode: 'overwrite',
		},
	]);
	const r = H.ok([
		{
			type: 'transcript.create',
			mediaId: a,
			language: 'es',
			origin: 'whisper-local',
			words: words.map(([text, s, e, extra]) => ({
				text,
				start: sec(s),
				end: sec(e),
				confidence: 0.4,
				...(extra ?? {}),
			})),
			speakers: { s1: { name: 'Ana' } },
		},
	]);
	const transcriptId = (r.results[0] as { transcriptId: string }).transcriptId;
	return { H, a, transcriptId };
}

const WORDS: Array<[string, number, number, Partial<TranscriptWord>?]> = [
	['Hoy', 0.2, 0.5, { speaker: 's1', breakBefore: 'segment' }],
	['probamos', 0.5, 1.0, { speaker: 's1' }],
	['Glimer', 1.0, 1.4, { speaker: 's1' }],
	['box', 1.4, 1.7, { speaker: 's1' }],
	['en', 1.7, 1.8, { speaker: 's1' }],
	['la', 1.8, 1.9, { speaker: 's1' }],
	['Play', 2.0, 2.3, { speaker: 's1' }],
	['Store.', 2.3, 2.8, { speaker: 's1' }],
	['Luego', 4.0, 4.4, { speaker: 's1', breakBefore: 'segment' }],
	['abrimos', 4.4, 4.9, { speaker: 's1' }],
	['Nova', 4.9, 5.2, { speaker: 's1' }],
	['play', 5.2, 5.5, { speaker: 's1' }],
	['estudio.', 5.5, 6.1, { speaker: 's1' }],
];

const words = (H: Harness, id: string) => H.doc.transcripts[id]!.words;
const texts = (H: Harness, id: string) => words(H, id).map((w) => w.text);
const w = (text: string, s: number, e: number, confidence: number | null = 0.9) => ({
	text,
	start: sec(s),
	end: sec(e),
	confidence,
});
const merge: ReplaceWordsEdit = {
	start: sec(1.0),
	end: sec(1.7),
	expect: ['Glimer', 'box'],
	words: [w('Glimmerbox', 1.0, 1.68)],
};
const split: ReplaceWordsEdit = {
	start: sec(4.9),
	end: sec(5.5),
	expect: ['Nova', 'play'],
	words: [w('NovaPlay', 4.9, 5.5)],
};

describe('transcript.replaceWords (SC-050)', () => {
	it('replaces words by time and expected text, keeps break / speaker / untouched words, sets confidence', () => {
		const { H, transcriptId } = talk(WORDS);
		const segBefore = (H.doc.transcripts[transcriptId] as { segments?: unknown }).segments;
		const before = words(H, transcriptId);
		const r = H.ok([{ type: 'transcript.replaceWords', transcriptId, edits: [merge] }]);
		expect(r.results[0]).toMatchObject({ transcriptId, edits: 1, words: WORDS.length - 1 });
		const now = words(H, transcriptId);
		expect(texts(H, transcriptId).slice(0, 4)).toEqual(['Hoy', 'probamos', 'Glimmerbox', 'en']);
		expect(now[2]).toEqual({
			text: 'Glimmerbox',
			start: sec(1.0),
			end: sec(1.68),
			confidence: 0.9,
			speaker: 's1',
			breakBefore: 'none',
		});
		// untouched words are the same objects (structural sharing) with the same times
		expect(now[0]).toBe(before[0]);
		expect(now.slice(3)).toEqual(before.slice(4));
		expect((H.doc.transcripts[transcriptId] as { segments?: unknown }).segments).toEqual(segBefore);
		valid(H.doc);
	});

	it('keeps the first replaced word’s segment break and composes many edits in one command', () => {
		const { H, transcriptId } = talk(WORDS);
		const luego: ReplaceWordsEdit = {
			start: sec(4.0),
			end: sec(4.4),
			expect: ['Luego'],
			words: [w('Después', 4.0, 4.4)],
		};
		H.ok([{ type: 'transcript.replaceWords', transcriptId, edits: [merge, luego, split] }]);
		const now = words(H, transcriptId);
		expect(texts(H, transcriptId)).toEqual([
			'Hoy',
			'probamos',
			'Glimmerbox',
			'en',
			'la',
			'Play',
			'Store.',
			'Después',
			'abrimos',
			'NovaPlay',
			'estudio.',
		]);
		expect(now[7]!.breakBefore).toBe('segment');
		valid(H.doc);
	});

	it('is index-free: separate commands in one transaction give the same document as one command', () => {
		const a = talk(WORDS);
		a.H.ok([{ type: 'transcript.replaceWords', transcriptId: a.transcriptId, edits: [merge, split] }]);
		const b = talk(WORDS);
		b.H.ok([
			{ type: 'transcript.replaceWords', transcriptId: b.transcriptId, edits: [split] },
			{ type: 'transcript.replaceWords', transcriptId: b.transcriptId, edits: [merge] },
		]);
		expect(b.H.doc.transcripts[b.transcriptId]).toEqual(a.H.doc.transcripts[a.transcriptId]);
	});

	it('inserts script words into a gap (expect []) and deletes words, carrying a segment break', () => {
		const { H, transcriptId } = talk(WORDS);
		H.ok([
			{
				type: 'transcript.replaceWords',
				transcriptId,
				edits: [
					{ start: sec(1.9), end: sec(2.0), expect: [], words: [w('de', 1.91, 1.99)] },
					{ start: sec(4.0), end: sec(4.4), expect: ['Luego'], words: [] },
				],
			},
		]);
		const now = words(H, transcriptId);
		expect(texts(H, transcriptId).slice(5, 9)).toEqual(['la', 'de', 'Play', 'Store.']);
		expect(now[6]!.speaker).toBe('s1');
		// "Luego" (a segment start) deleted: "abrimos" starts the segment now
		const abrimos = now.find((x) => x.text === 'abrimos')!;
		expect(abrimos.breakBefore).toBe('segment');
		valid(H.doc);
	});

	it('undo leaves the previous document untouched; redo is deterministic', () => {
		const run = () => {
			const { H, transcriptId } = talk(WORDS);
			const before = H.doc;
			const snap = structuredClone(H.doc);
			H.ok([{ type: 'transcript.replaceWords', transcriptId, edits: [merge, split] }]);
			expect(before).toEqual(snap);
			return H.doc.transcripts[transcriptId];
		};
		expect(run()).toEqual(run());
	});

	it('refuses: E_NOT_FOUND, E_STALE (also after an earlier edit of the same transaction), E_INVALID_PARAM', () => {
		const { H, transcriptId } = talk(WORDS);
		const code = (r: ReturnType<Harness['tx']>) => (r.ok ? 'ok' : r.errors[0]!.code);
		expect(code(H.tx([{ type: 'transcript.replaceWords', transcriptId: 'trs_nope', edits: [merge] }]))).toBe(
			'E_NOT_FOUND',
		);
		const stale = H.tx([
			{ type: 'transcript.replaceWords', transcriptId, edits: [{ ...merge, expect: ['Glimmer', 'box'] }] },
		]);
		expect(code(stale)).toBe('E_STALE');
		expect(!stale.ok && stale.errors[0]!.message).toContain('"Glimer box"');
		// the second command sees the first one's result: its words are stale now
		expect(
			code(
				H.tx([
					{ type: 'transcript.replaceWords', transcriptId, edits: [merge] },
					{ type: 'transcript.replaceWords', transcriptId, edits: [merge] },
				]),
			),
		).toBe('E_STALE');
		const bad = (edits: unknown[]) => code(H.tx([{ type: 'transcript.replaceWords', transcriptId, edits }]));
		expect(bad([split, merge])).toBe('E_INVALID_PARAM'); // unsorted
		expect(bad([merge, { ...merge, start: sec(1.5), end: sec(1.9), expect: ['box', 'en', 'la'] }])).toBe(
			'E_INVALID_PARAM',
		); // overlapping spans
		expect(bad([{ ...merge, words: [w('Glimmerbox', 0.9, 1.6)] }])).toBe('E_INVALID_PARAM'); // outside the span
		expect(
			bad([{ ...merge, words: [w('Glimmer', 1.0, 1.5), w('box', 1.4, 1.7)] }]), // overlapping new words
		).toBe('E_INVALID_PARAM');
		expect(bad([{ start: sec(1.9), end: sec(2.0), expect: [], words: [] }])).toBe('E_INVALID_PARAM');
		expect(bad([{ ...merge, start: sec(1.2) }])).toBe('E_INVALID_PARAM'); // a new word outside the span
		expect(bad([{ ...merge, words: [w('Glimmer box', 1.0, 1.6)] }])).toBe('E_SCHEMA');
		expect(code(H.tx([{ type: 'transcript.replaceWords', transcriptId, edits: [] }]))).toBe('E_SCHEMA');
		// nothing changed
		expect(texts(H, transcriptId)).toEqual(WORDS.map((x) => x[0]));
	});

	it('planReplaceWords reports what the command does, and the stale edits without throwing', () => {
		const { H, transcriptId } = talk(WORDS);
		const plan = planReplaceWords(H.doc, { transcriptId, edits: [merge, split] });
		expect(plan.ok).toBe(true);
		expect(plan.edits.map((e) => [e.from, e.to, e.before, e.after])).toEqual([
			[2, 4, ['Glimer', 'box'], ['Glimmerbox']],
			[10, 12, ['Nova', 'play'], ['NovaPlay']],
		]);
		const stale = planReplaceWords(H.doc, {
			transcriptId,
			edits: [merge, { ...split, expect: ['Nova', 'Play'] }],
		});
		expect(stale).toMatchObject({ ok: false, problem: { code: 'E_STALE' } });
		expect(stale.stale).toEqual([
			{ index: 1, start: split.start, end: split.end, expect: ['Nova', 'Play'], actual: ['Nova', 'play'] },
		]);
		expect(planReplaceWords(H.doc, { transcriptId: 'x', edits: [merge] }).problem?.code).toBe('E_NOT_FOUND');
		expect(planReplaceWords(H.doc, null as never).problem?.code).toBe('E_NOT_FOUND');
		expect(planReplaceWords(H.doc, { transcriptId, edits: 'x' as never }).problem?.code).toBe(
			'E_INVALID_PARAM',
		);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Subtitle text clips (SC-051)

const subs = (H: Harness) =>
	Object.values(H.seq.clips)
		.filter((c): c is TextClip => c.kind === 'text' && !!captionOf(c))
		.sort((x, y) => x.start - y.start);
const gen = (H: Harness, extra: Record<string, unknown> = {}) =>
	H.ok([{ type: 'captions.generate', cutAware: false, ...extra }]).results[0] as {
		groupId: string;
		clipIds: string[];
	};
const containing = (H: Harness, word: string) => subs(H).find((c) => c.content.text.includes(word))!;
/** Replace a subtitle clip in place (a hand edit straight into the document, then re-checked). */
function edit(H: Harness, id: string, fn: (c: TextClip) => void) {
	const doc = structuredClone(H.doc);
	fn(doc.sequences[H.seqId]!.clips[id] as TextClip);
	H.doc = doc;
}

describe('subtitle patch (SC-051)', () => {
	it('patches the text and words of the subtitle in place (same clip, effects, style link), invariants hold', () => {
		const { H, transcriptId } = talk(WORDS);
		gen(H, { template: 'builtin:pixel-pop', rules: { maxWords: 4 } });
		const c0 = containing(H, 'Glimer');
		const r = H.ok([{ type: 'transcript.replaceWords', transcriptId, edits: [merge] }]);
		const c1 = H.seq.clips[c0.id] as TextClip;
		expect(c1.content.text).toBe(c0.content.text.replace('Glimer box', 'Glimmerbox'));
		const cap = captionOf(c1)!;
		expect(cap.words.map((x) => x.text)).toEqual(
			captionOf(c0)!
				.words.map((x) => x.text)
				.join(' ')
				.replace('Glimer box', 'Glimmerbox')
				.split(' '),
		);
		const glim = wordsInSequence(c1, H.seq.settings.frameRate).find((x) => x.text === 'Glimmerbox')!;
		expect([glim.start, glim.end]).toEqual([sec(1.0), sec(1.68)]);
		expect(c1.effects).toEqual(c0.effects);
		expect((c1 as { styleId?: string }).styleId).toBe((c0 as { styleId?: string }).styleId);
		expect(c1.content.style).toEqual(c0.content.style);
		expect((r.results[0] as { patched: { clipId: string; kind: string }[] }).patched).toEqual([
			expect.objectContaining({
				clipId: c0.id,
				kind: 'subtitle',
				before: c0.content.text,
				after: c1.content.text,
			}),
		]);
		valid(H.doc);
	});

	it('applies the group’s text transforms (upper case) and rebuilds the word highlight', () => {
		const { H, transcriptId } = talk(WORDS);
		gen(H, { template: 'builtin:word-highlight', text: { case: 'upper' }, rules: { maxWords: 4 } });
		const c0 = containing(H, 'NOVA');
		H.ok([{ type: 'transcript.replaceWords', transcriptId, edits: [split] }]);
		const c1 = H.seq.clips[c0.id] as TextClip;
		expect(c1.content.text).toContain('NOVAPLAY');
		expect(c1.content.text).not.toContain('NOVA PLAY');
		const cap = captionOf(c1)!;
		const keys = (
			c1 as { sourceTextKeyframes?: { time: number; value: { text: string; runs?: unknown[] } }[] }
		).sourceTextKeyframes!;
		// a key per word (and one before the first word unless it starts at the In), each holding the new text
		expect(keys.length).toBeGreaterThanOrEqual(cap.words.length);
		expect(keys.length).toBeLessThanOrEqual(cap.words.length + 1);
		for (const k of keys) expect(k.value.text).toBe(c1.content.text);
		const at = keys.find((k) => k.time === cap.words.find((x) => x.text === 'NOVAPLAY')!.start)!;
		const run = (at.value.runs as { from: number; to: number }[]).at(-1)!;
		expect(c1.content.text.slice(run.from, run.to)).toBe('NOVAPLAY');
		valid(H.doc);
	});

	it('keeps styled runs on the replacing words and manual line breaks; re-breaks only an offending line', () => {
		const { H, transcriptId } = talk(WORDS);
		gen(H, { rules: { maxWords: 8, maxChars: 30, lines: 3 } });
		const c0 = containing(H, 'Glimer');
		const text0 = c0.content.text.replace(/\s+/g, ' ');
		// the user styled "Glimer box" and put a manual break before "en"
		const at = text0.indexOf('Glimer box');
		const manual = text0.replace(' en ', '\nen ');
		edit(H, c0.id, (c) => {
			c.content.text = manual;
			c.content.runs = [{ from: at, to: at + 'Glimer box'.length, style: { fill: [1, 0, 0, 1] } }];
		});
		valid(H.doc);
		H.ok([{ type: 'transcript.replaceWords', transcriptId, edits: [merge] }]);
		const c1 = H.seq.clips[c0.id] as TextClip;
		expect(c1.content.text).toBe(manual.replace('Glimer box', 'Glimmerbox'));
		const run = c1.content.runs![0]!;
		expect(c1.content.text.slice(run.from, run.to)).toBe('Glimmerbox');
		valid(H.doc);
		// a long replacement breaks only the line that is now too long; the manual break stays
		const long: ReplaceWordsEdit = {
			start: sec(0.5),
			end: sec(1.0),
			expect: ['probamos'],
			words: [w('probamos-mucho-hoy', 0.5, 1.0)],
		};
		H.ok([{ type: 'transcript.replaceWords', transcriptId, edits: [long] }]);
		const c2 = H.seq.clips[c0.id] as TextClip;
		expect(c2.content.text.split('\n')).toEqual([
			'Hoy probamos-mucho-hoy',
			'Glimmerbox',
			'en la Play Store.',
		]);
		const r2 = c2.content.runs![0]!;
		expect(c2.content.text.slice(r2.from, r2.to)).toBe('Glimmerbox');
		valid(H.doc);
	});

	it('a merge across a manual break keeps paragraph settings of the other lines', () => {
		const { H, transcriptId } = talk(WORDS);
		gen(H, { rules: { maxWords: 8, maxChars: 40, lines: 3 } });
		const c0 = containing(H, 'Glimer');
		const t = c0.content.text
			.replace(/\s+/g, ' ')
			.replace('Glimer box', 'Glimer\nbox')
			.replace(' la ', '\nla ');
		edit(H, c0.id, (c) => {
			c.content.text = t;
			c.content.paragraphs = [{ index: 2, style: { align: 'left' } }];
		});
		valid(H.doc);
		H.ok([{ type: 'transcript.replaceWords', transcriptId, edits: [merge] }]);
		const c1 = H.seq.clips[c0.id] as TextClip;
		expect(c1.content.text.split('\n')).toHaveLength(2);
		expect(c1.content.paragraphs).toEqual([{ index: 1, style: { align: 'left' } }]);
		valid(H.doc);
	});

	it('skips and reports a hand-edited subtitle and one whose Source Text keys hold its old text', () => {
		const { H, transcriptId } = talk(WORDS);
		gen(H, { rules: { maxWords: 4 } });
		const g = containing(H, 'Glimer');
		const n = containing(H, 'Nova');
		// the user already fixed "Glimer box" by hand (the text and its words)
		edit(H, g.id, (c) => {
			c.content.text = c.content.text.replace('Glimer box', 'Glimmer-box');
			const cap = (c as { caption: { words: { text: string }[] } }).caption;
			cap.words = cap.words.filter((x) => x.text !== 'box');
			cap.words.find((x) => x.text === 'Glimer')!.text = 'Glimmer-box';
		});
		// hand-made Source Text keys holding a copy of the text
		edit(H, n.id, (c) => {
			(c as { sourceTextKeyframes?: unknown[] }).sourceTextKeyframes = [
				{
					id: H.ids.next('kf'),
					time: c.sourceIn,
					value: structuredClone(c.content),
					interpolation: 'hold',
					easeIn: { influence: 1 / 3, slope: 0 },
					easeOut: { influence: 1 / 3, slope: 0 },
				},
			];
		});
		valid(H.doc);
		const plan = planReplaceWords(H.doc, { transcriptId, edits: [merge, split] });
		const r = H.ok([{ type: 'transcript.replaceWords', transcriptId, edits: [merge, split] }]);
		const res = r.results[0] as { skipped: unknown[]; patched: unknown[] };
		expect(res.skipped).toHaveLength(2);
		expect(res.skipped).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ clipId: g.id, reason: 'edited', edits: [0] }),
				expect.objectContaining({ clipId: n.id, reason: 'source-text-keyframes', edits: [1] }),
			]),
		);
		expect(res.skipped).toEqual(plan.skipped);
		expect(res.patched).toEqual(plan.patched);
		expect(r.warnings.filter((x) => x.code === 'W_TRANSCRIPT_PATCH_SKIPPED')).toHaveLength(2);
		// the transcript changed; the skipped clips did not
		expect(texts(H, transcriptId)).toContain('Glimmerbox');
		expect((H.seq.clips[g.id] as TextClip).content.text).toContain('Glimmer-box');
		expect((H.seq.clips[n.id] as TextClip).content.text).toContain('Nova play');
		valid(H.doc);
	});

	it('a subtitle holding a word the sequence no longer hears is skipped, never written with overlapping words', () => {
		// the reporter's rev 144: a subtitle "y su propio" made when the zero-length "propio" (a leftover of an edit)
		// still reached the captions; Rebuild from script writes "su propio" heard later — the whole accept was refused
		// (INV-SUBTITLE: overlapping words)
		const { H, transcriptId } = talk([
			['y', 0.2, 0.3],
			['su', 0.3, 0.45],
			['propio', 0.6, 0.6],
			['ritmo,', 1.0, 1.4],
			['y', 1.4, 1.5],
			['luego', 1.5, 1.9],
		]);
		gen(H, { rules: { maxWords: 3 } });
		const c0 = containing(H, 'su');
		edit(H, c0.id, (c) => {
			c.content.text = c.content.text.replace('su', 'su propio');
			const cap = (c as { caption: { words: { text: string; start: number; end: number }[] } }).caption;
			const k = cap.words.findIndex((x) => x.text === 'su');
			const at = cap.words[k]!.end + Math.round(0.15 * FLICKS_PER_SECOND);
			cap.words.splice(k + 1, 0, { text: 'propio', start: at, end: at });
		});
		valid(H.doc);
		const r = H.tx([
			{
				type: 'transcript.replaceWords',
				transcriptId,
				edits: [
					{
						start: sec(0.3),
						end: sec(1.0),
						expect: ['su', 'propio'],
						words: [w('su', 0.3, 0.48), w('propio', 0.65, 0.95)],
					},
				],
			},
		]);
		expect(r.ok, JSON.stringify((r as { errors?: unknown }).errors)).toBe(true);
		expect(texts(H, transcriptId)).toEqual(['y', 'su', 'propio', 'ritmo,', 'y', 'luego']);
		const res = (r as { results: Array<{ skipped: Array<{ clipId: string; reason: string }> }> }).results[0]!;
		expect(res.skipped).toEqual([expect.objectContaining({ clipId: c0.id, reason: 'edited' })]);
		valid(H.doc);
	});

	it('patches nothing with subtitles: "none"; a locked subtitle track is skipped', () => {
		const { H, transcriptId } = talk(WORDS);
		const r0 = gen(H, { rules: { maxWords: 4 } });
		const c0 = containing(H, 'Glimer');
		const none = H.ok([{ type: 'transcript.replaceWords', transcriptId, edits: [merge], subtitles: 'none' }]);
		expect((none.results[0] as { patched: unknown[] }).patched).toEqual([]);
		expect((H.seq.clips[c0.id] as TextClip).content.text).toContain('Glimer box');
		H.ok([{ type: 'track.update', trackId: c0.trackId, patch: { locked: true } }]);
		const r = H.ok([{ type: 'transcript.replaceWords', transcriptId, edits: [split] }]);
		expect((r.results[0] as { skipped: { reason: string }[] }).skipped).toEqual([
			expect.objectContaining({ reason: 'locked', groupId: r0.groupId }),
		]);
		valid(H.doc);
	});

	it('a merge across two subtitles goes to the one holding the new word; the other loses the old word', () => {
		const { H, transcriptId } = talk(WORDS);
		gen(H, { rules: { maxWords: 3 } });
		const a = containing(H, 'Glimer');
		expect(a.content.text).not.toContain('box');
		const b = containing(H, 'box');
		H.ok([{ type: 'transcript.replaceWords', transcriptId, edits: [merge] }]);
		const all = subs(H).map((c) => c.content.text);
		expect(
			all
				.join(' ')
				.split(/\s+/)
				.filter((x) => x === 'Glimmerbox'),
		).toHaveLength(1);
		expect(all.join(' ')).not.toMatch(/Glimer|\bbox\b/);
		expect(H.seq.clips[a.id]).toBeTruthy();
		expect(H.seq.clips[b.id]).toBeTruthy();
		valid(H.doc);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Caption-track clips (SC-052)

describe('caption-track patch (SC-052)', () => {
	it('patches the private words of caption clips made from the transcript (breaks kept), one command', () => {
		const { H, transcriptId } = talk(WORDS);
		H.ok([{ type: 'transcript.createCaptions', sequenceId: H.seqId }]);
		const caps = Object.values(H.seq.clips).filter((c): c is CaptionsClip => c.kind === 'captions');
		const target = caps.find((c) =>
			H.doc.transcripts[c.transcriptId]!.words.some((x) => x.text === 'Glimer'),
		)!;
		const before = H.doc.transcripts[target.transcriptId]!.words;
		const r = H.ok([{ type: 'transcript.replaceWords', transcriptId, edits: [merge, split] }]);
		const after = H.doc.transcripts[target.transcriptId]!.words;
		expect(after.map((x) => x.text)).toEqual(
			before
				.map((x) => x.text)
				.join(' ')
				.replace('Glimer box', 'Glimmerbox')
				.replace('Nova play', 'NovaPlay')
				.split(' '),
		);
		expect(after[0]!.breakBefore).toBe(before[0]!.breakBefore);
		const patched = (r.results[0] as { patched: { kind: string }[] }).patched;
		expect(patched.every((p) => p.kind === 'caption')).toBe(true);
		expect(patched.length).toBeGreaterThanOrEqual(1);
		valid(H.doc);
	});

	it('leaves caption clips imported from a file alone', () => {
		const { H, transcriptId } = talk(WORDS);
		H.ok([
			{
				type: 'caption.import',
				sequenceId: H.seqId,
				cues: [{ start: 30, end: 60, text: 'Glimer box en la' }],
			},
		]);
		const r = H.ok([{ type: 'transcript.replaceWords', transcriptId, edits: [merge] }]);
		expect(r.results[0]).toMatchObject({ patched: [], skipped: [] });
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Property (SC-100 style): random transcripts and random edit sets

describe('replaceWords property', () => {
	it('invariants hold, the words are exactly the spliced ones, undo restores, plan = command', () => {
		const word = fc.stringMatching(/^[a-zñé]{1,8}[.,]?$/);
		fc.assert(
			fc.property(
				fc.array(fc.tuple(word, fc.integer({ min: 0, max: 8 }), fc.integer({ min: 0, max: 8 })), {
					minLength: 2,
					maxLength: 30,
				}),
				fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 3 }), fc.array(word, { maxLength: 3 })), {
					minLength: 1,
					maxLength: 6,
				}),
				(spec, picks) => {
					// words on a 0.1 s grid with gaps (so insertions have room)
					let t = 0;
					const list: Array<[string, number, number]> = spec.map(([text, gap, len]) => {
						const s = t + gap * 0.05;
						const e = s + (len + 1) * 0.05;
						t = e;
						return [text, s, e];
					});
					const { H, transcriptId } = talk(list);
					const src = words(H, transcriptId);
					// non-overlapping regions [i, i+n) in order
					const edits: ReplaceWordsEdit[] = [];
					let next = 0;
					for (const [skip, n0, repl] of picks) {
						const i = next + (skip % 4);
						if (i > src.length) break;
						const n = Math.min(n0, src.length - i);
						if (!n && !repl.length) continue;
						const start = n ? src[i]!.start : i > 0 ? src[i - 1]!.end : 0;
						const end = n ? src[i + n - 1]!.end : i < src.length ? src[i]!.start : start;
						const step = repl.length ? Math.floor((end - start) / repl.length) : 0;
						if (repl.length && step < 1 && end > start) continue;
						edits.push({
							start,
							end,
							expect: src.slice(i, i + n).map((x) => x.text),
							words: repl.map((x, k) => ({
								text: x,
								start: start + k * step,
								end: k === repl.length - 1 ? end : start + (k + 1) * step,
								confidence: null,
							})),
						});
						next = i + n + 1;
					}
					if (!edits.length) return;
					const before = H.doc;
					const snap = structuredClone(H.doc);
					const plan = planReplaceWords(H.doc, { transcriptId, edits });
					const r = H.tx([{ type: 'transcript.replaceWords', transcriptId, edits }]);
					expect(r.ok).toBe(plan.ok);
					expect(before).toEqual(snap);
					if (!r.ok) return;
					valid(H.doc);
					// expected words: the naive splice by the plan's ranges
					const expectTexts: string[] = [];
					let cur = 0;
					plan.edits.forEach((e, k) => {
						expectTexts.push(
							...src.slice(cur, e.from).map((x) => x.text),
							...edits[k]!.words.map((x) => x.text),
						);
						cur = e.to;
					});
					expectTexts.push(...src.slice(cur).map((x) => x.text));
					expect(texts(H, transcriptId)).toEqual(expectTexts);
				},
			),
			{ numRuns: 120, seed: 1717 },
		);
	});
});
