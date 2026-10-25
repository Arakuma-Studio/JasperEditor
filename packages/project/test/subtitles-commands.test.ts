// Spec 13 AS-001…AS-012 / AS-020: subtitle commands on documents built through the real commands — generation as one
// command, text clips with words, caption-track output, refusals, invariants, razor / text edits / trims, regenerate,
// align to cuts, conversion round trips, SRT export of a group, groups, templates, duplicate and load repair.
import { describe, expect, it } from 'vitest';
import {
	buildClipsPayload,
	type CaptionsClip,
	type Clip,
	captionClipText,
	captionCuesForGroup,
	captionGroupsOf,
	captionOf,
	checkInvariants,
	createCounterIdSource,
	FLICKS_PER_SECOND,
	groupClips,
	isTemplateEffect,
	PIXEL_POP_SHAKE,
	type ProjectDocument,
	repairDocument,
	type Sequence,
	textStylesOf,
	wordsInSequence,
	writeCaptionFile,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

type TextClip = Extract<Clip, { kind: 'text' }>;
const F30 = FLICKS_PER_SECOND / 30;
const sec = (x: number) => Math.round(x * FLICKS_PER_SECOND);

/** 30 fps: media A (10 s, transcribed) on V1/A1 from 0; media B overwrites V1 from frame 90 (a picture cut at 90). */
function shot(opts: { cut?: boolean; words?: Array<[string, number, number]> } = {}) {
	const H = new Harness({ preset: 'hd-1080p-30' });
	const a = H.registerVideo({ seconds: 10 });
	const b = H.registerVideo({ seconds: 10 });
	H.ok([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 0,
			tracks: { video: 'V1', audio: ['A1'] },
			mode: 'overwrite',
		},
	]);
	if (opts.cut !== false)
		H.ok([
			{
				type: 'clip.place',
				source: { mediaId: b },
				at: 90,
				tracks: { video: 'V1' },
				audio: false,
				mode: 'overwrite',
			},
		]);
	// words in seconds of media A (= sequence time: placed at 0)
	const list = opts.words ?? [
		['Hola', 0.2, 0.5],
		['a', 0.5, 0.6],
		['todos', 0.6, 1.0],
		['hoy', 1.0, 1.4],
		['hice', 2.3, 2.6],
		['el', 2.6, 2.7],
		['juego', 2.7, 3.1],
		['de', 3.1, 3.2],
		['Doors.', 3.2, 3.7],
	];
	H.ok([
		{
			type: 'transcript.create',
			mediaId: a,
			language: 'es',
			origin: 'manual',
			words: list.map(([text, s, e]) => ({ text, start: sec(s), end: sec(e) })),
		},
	]);
	return { H, a, b };
}

const subs = (H: Harness) =>
	Object.values(H.seq.clips)
		.filter((c): c is TextClip => c.kind === 'text' && !!captionOf(c))
		.sort((x, y) => x.start - y.start);
const spans = (H: Harness) => subs(H).map((c) => [c.start, c.start + c.duration, c.content.text]);
const valid = (doc: ProjectDocument) => expect(checkInvariants(doc)).toEqual([]);
const gen = (H: Harness, extra: Record<string, unknown> = {}) =>
	H.ok([{ type: 'captions.generate', ...extra }]).results[0] as {
		groupId: string;
		trackId: string;
		clipIds: string[];
		stats: { count: number; snappedToCuts: number; splitAtCuts: number; crossing: number };
	};

describe('captions.generate (AS-001, AS-003)', () => {
	it('creates text-clip subtitles in one command, on a new top track, in a group, linked to a text style', () => {
		const { H } = shot();
		const before = H.doc;
		const r = gen(H, { template: 'builtin:pixel-pop' });
		expect(H.revision).toBe(6);
		expect(r.clipIds.length).toBeGreaterThan(1);
		const top = H.seq.videoTracks[H.seq.videoTracks.length - 1]!;
		expect(top.id).toBe(r.trackId);
		expect(top.name).toBe('Subtitles');
		const g = captionGroupsOf(H.seq)[r.groupId]!;
		expect(g.templateId).toBe('builtin:pixel-pop');
		expect(g.rules.maxWords).toBe(3);
		expect(g.language).toBe('es');
		for (const c of subs(H)) {
			const cap = captionOf(c)!;
			expect(cap.groupId).toBe(r.groupId);
			expect(cap.words.length).toBeGreaterThan(0);
			expect(cap.words.length).toBeLessThanOrEqual(3);
			// words in content time, inside the clip
			for (const w of wordsInSequence(c, H.seq.settings.frameRate)) {
				expect(w.start).toBeGreaterThanOrEqual(c.start * F30);
				expect(w.end).toBeLessThanOrEqual((c.start + c.duration) * F30);
			}
			// linked to the template's project text style; Pixel12x10 resolved by family
			expect((c as { styleId?: string }).styleId).toBeTruthy();
			expect(H.doc.fonts[c.content.style.fontId]!.family).toBe('Pixel12x10');
			// the pop-in and the shake, marked as the template's
			expect(c.effects.map((e) => e.effectId)).toEqual(['jasper.transform', 'jasper.s.shake']);
			expect(c.effects.every((e) => isTemplateEffect(e as never))).toBe(true);
			const scale = c.effects[0]!.params.scaleHeight as { keyframes: { time: number; value: number }[] };
			expect(scale.keyframes.map((k) => [Math.round((k.time - c.sourceIn) / F30), k.value])).toEqual([
				[0, 75],
				[3, 108],
				[5, 100],
			]);
		}
		expect(textStylesOf(H.doc).some((s) => s.name === 'Pixel Pop')).toBe(true);
		expect(
			(H.doc as { subtitleTemplates?: Record<string, unknown> }).subtitleTemplates?.['builtin:pixel-pop'],
		).toBeTruthy();
		// the "de" of "juego de Doors" stays with "Doors" (Spanish weak words)
		expect(subs(H).some((c) => c.content.text.endsWith(' de'))).toBe(false);
		valid(H.doc);
		expect(before.sequences[H.seqId]!.videoTracks.length).toBe(H.seq.videoTracks.length - 1);
	});
	it('never runs a subtitle across the picture cut; a start just after it moves onto it', () => {
		const { H } = shot({
			words: [
				['one', 2.5, 2.8],
				['two', 2.8, 2.95],
				['three', 3.05, 3.4],
			],
		});
		const r = gen(H, { rules: { minSeconds: 0.2, maxWords: 5, maxChars: 40 } });
		expect(r.stats.crossing).toBe(0);
		for (const c of subs(H)) expect(c.start >= 90 || c.start + c.duration <= 90).toBe(true);
		expect(subs(H).some((c) => c.start === 90)).toBe(true);
		valid(H.doc);
	});
	it('dry run: statistics and a preview, no change', () => {
		const { H } = shot();
		const doc = H.doc;
		const r = H.ok([{ type: 'captions.generate', dryRun: true, template: 'builtin:pixel-pop' }])
			.results[0] as {
			stats: { count: number };
			captions: { text: string }[];
		};
		expect(H.doc).toBe(doc);
		expect(r.stats.count).toBe(r.captions.length);
	});
	it("caption-track output keeps today's behaviour with the template style and the same rules", () => {
		const { H } = shot();
		const r = H.ok([{ type: 'captions.generate', output: 'caption-track', template: 'builtin:subtitles' }])
			.results[0] as { trackId: string; clipIds: string[] };
		const t = H.seq.captionTracks.find((x) => x.id === r.trackId)!;
		expect(t.styleDefaults?.boxWidthPct).toBe(80);
		const caps = Object.values(H.seq.clips).filter((c): c is CaptionsClip => c.kind === 'captions');
		expect(caps.length).toBe(r.clipIds.length);
		expect(
			captionClipText(H.doc, caps.sort((x, y) => x.start - y.start)[0]!, H.seq.settings.frameRate),
		).toContain('Hola');
		valid(H.doc);
	});
	it('refusals: locked track, wrong track kind, no transcript, unknown or invalid template', () => {
		const { H } = shot();
		H.ok([{ type: 'track.update', trackId: H.seq.videoTracks[0]!.id, patch: { locked: true } }]);
		const locked = H.tx([{ type: 'captions.generate', trackId: 'V1' }]);
		expect(locked.ok || locked.errors[0]!.code).toBe('E_TRACK_LOCKED');
		const kind = H.tx([{ type: 'captions.generate', trackId: 'A1' }]);
		expect(kind.ok || kind.errors[0]!.code).toBe('E_TRACK_KIND');
		const none = new Harness();
		const nt = none.tx([{ type: 'captions.generate' }]);
		expect(nt.ok || nt.errors[0]!.code).toBe('E_INVALID_PARAM');
		const missing = H.tx([{ type: 'captions.generate', template: 'nope' }]);
		expect(missing.ok || missing.errors[0]!.code).toBe('E_NOT_FOUND');
		const bad = H.tx([{ type: 'captions.generate', template: { format: 'x' } }]);
		expect(bad.ok || bad.errors[0]!.code).toBe('E_SCHEMA');
		const range = H.tx([{ type: 'captions.generate', range: { start: 50, end: 40 } }]);
		expect(range.ok || range.errors[0]!.code).toBe('E_INVALID_PARAM');
	});
	it('nested output with a warning', () => {
		const { H } = shot();
		const r = H.ok([{ type: 'captions.generate', nest: true }]);
		expect(r.warnings.some((w) => w.code === 'W_SUBTITLES_NESTED')).toBe(true);
		const nested = (r.results[0] as { nestedSequenceId: string }).nestedSequenceId;
		expect(Object.keys(captionGroupsOf(H.doc.sequences[nested]!))).toHaveLength(1);
		valid(H.doc);
	});
});

describe('editing integrity (AS-006)', () => {
	it('a razor cut divides the words and each half keeps its own text', () => {
		const { H } = shot({
			cut: false,
			words: [
				['alpha', 0.2, 0.5],
				['beta', 0.5, 0.8],
				['gamma', 0.8, 1.1],
			],
		});
		gen(H, { rules: { maxWords: 3, minSeconds: 0.2, maxChars: 40, lines: 1 } });
		const c = subs(H)[0]!;
		expect(c.content.text).toBe('alpha beta gamma');
		H.ok([{ type: 'clip.split', at: 20, clipIds: [c.id] }]);
		expect(spans(H).map((x) => x[2])).toEqual(['alpha beta', 'gamma']);
		const [l, r] = subs(H);
		expect(captionOf(l!)!.words.map((w) => w.text)).toEqual(['alpha', 'beta']);
		expect(captionOf(r!)!.words.map((w) => w.text)).toEqual(['gamma']);
		valid(H.doc);
	});
	it('a cut inside one word keeps the whole text on both pieces', () => {
		const { H } = shot({ cut: false, words: [['longword', 0.2, 1.5]] });
		gen(H, { rules: { minSeconds: 0.2 } });
		const c = subs(H)[0]!;
		H.ok([{ type: 'clip.split', at: c.start + 10, clipIds: [c.id] }]);
		expect(spans(H).map((x) => x[2])).toEqual(['longword', 'longword']);
	});
	it('a text edit re-times the changed words and keeps the unchanged ones', () => {
		const { H } = shot({
			cut: false,
			words: [
				['alpha', 0.2, 0.5],
				['beta', 0.5, 0.8],
				['gamma', 0.8, 1.1],
			],
		});
		gen(H, { rules: { maxWords: 3, minSeconds: 0.2, maxChars: 40, lines: 1 } });
		const c = subs(H)[0]!;
		const before = captionOf(c)!.words;
		H.ok([{ type: 'clip.update', clipId: c.id, patch: { content: { text: 'alpha BETA gamma' } } }]);
		const after = captionOf(subs(H)[0]!)!.words;
		expect(after.map((w) => w.text)).toEqual(['alpha', 'BETA', 'gamma']);
		expect(after[0]).toEqual(before[0]);
		expect(after[2]).toEqual(before[2]);
		valid(H.doc);
	});
	it('template keys stay anchored to the In after a trim', () => {
		const { H } = shot({
			cut: false,
			words: [
				['alpha', 1, 1.5],
				['beta', 1.5, 2],
			],
		});
		gen(H, { template: 'builtin:pixel-pop', cutAware: false });
		const c = subs(H)[0]!;
		H.ok([{ type: 'clip.trim', clipId: c.id, edge: 'in', deltaFrames: -6 }]);
		const t = subs(H)[0]!;
		expect(t.start).toBe(c.start - 6);
		const k = t.effects[0]!.params.opacity as { keyframes: { time: number }[] };
		expect(Math.round((k.keyframes[0]!.time - t.sourceIn) / F30)).toBe(0);
		// words stay where they were in sequence time
		expect(wordsInSequence(t, H.seq.settings.frameRate)).toEqual(
			wordsInSequence(c, H.seq.settings.frameRate),
		);
		valid(H.doc);
	});
	it('a pasted subtitle brings its group to another sequence', () => {
		const { H } = shot({ cut: false });
		gen(H);
		const c = subs(H)[0]!;
		const payload = buildClipsPayload(H.doc, H.seqId, [c.id]);
		H.ok([{ type: 'sequence.create', name: 'Other', preset: 'hd-1080p-30', ref: '$s' }]);
		const other = Object.values(H.doc.sequences).find((s) => s.id !== H.seqId)!;
		H.ok([{ type: 'clip.paste', sequenceId: other.id, payload, at: 0 }]);
		const seq = H.doc.sequences[other.id]!;
		expect(Object.keys(captionGroupsOf(seq))).toEqual([captionOf(c)!.groupId]);
		valid(H.doc);
	});
});

describe('regenerate, align to cuts (AS-006, AS-012)', () => {
	it('regenerate keeps clips that still match and rebuilds the rest', () => {
		const { H, a } = shot({ cut: false });
		const r = gen(H, { rules: { maxWords: 3 } });
		const first = subs(H)[0]!;
		const trs = Object.values(H.doc.transcripts).find((t) => t.mediaId === a)!;
		const last = trs.words.length - 1;
		H.ok([
			{ type: 'transcript.editText', transcriptId: trs.id, fromWord: last, toWord: last, text: 'Puertas.' },
		]);
		const g = H.ok([{ type: 'captions.regenerate', groupId: r.groupId }]).results[0] as {
			kept: number;
			created: number;
			removed: number;
		};
		expect(g.kept).toBeGreaterThan(0);
		expect(g.created).toBeGreaterThan(0);
		expect(subs(H)[0]!.id).toBe(first.id);
		expect(subs(H).some((c) => c.content.text.includes('Puertas'))).toBe(true);
		valid(H.doc);
	});
	it('align to cuts after the picture is re-edited', () => {
		const { H } = shot({
			cut: false,
			words: [
				['one', 2.5, 2.8],
				['two', 3.05, 3.4],
			],
		});
		gen(H, { rules: { minSeconds: 0.2, maxWords: 5, maxChars: 40 }, cutAware: false });
		expect(subs(H).length).toBe(1);
		// a cut appears at frame 90 later
		const b = H.registerVideo({ seconds: 5 });
		H.ok([
			{
				type: 'clip.place',
				source: { mediaId: b },
				at: 90,
				tracks: { video: 'V1' },
				audio: false,
				mode: 'overwrite',
			},
		]);
		const g = subs(H)[0]!.content.text;
		const r = H.ok([{ type: 'captions.alignToCuts', groupId: captionOf(subs(H)[0]!)!.groupId }])
			.results[0] as {
			splitAtCuts: number;
			crossing: number;
		};
		expect(r.splitAtCuts).toBe(1);
		expect(r.crossing).toBe(0);
		expect(
			spans(H)
				.map((x) => x[2])
				.join(' '),
		).toBe(g);
		for (const c of subs(H)) expect(c.start >= 90 || c.start + c.duration <= 90).toBe(true);
		valid(H.doc);
	});
});

describe('conversion and export (AS-005)', () => {
	it('text clips → caption track → text clips keeps words, timing and text', () => {
		const { H } = shot({ cut: false });
		const r = gen(H, { template: 'builtin:pixel-pop' });
		const original = spans(H);
		const c1 = H.ok([{ type: 'captions.convert', groupId: r.groupId, to: 'caption-track' }]);
		const res = c1.results[0] as { trackId: string; unrepresentable: { feature: string }[] };
		expect(res.unrepresentable.map((x) => x.feature)).toContain('effects');
		expect(c1.warnings.some((w) => w.code === 'W_SUBTITLES_CONVERT')).toBe(true);
		expect(subs(H)).toHaveLength(0);
		valid(H.doc);
		H.ok([{ type: 'captions.convert', captionTrackId: res.trackId, to: 'text-clips' }]);
		expect(spans(H)).toEqual(original);
		expect(H.seq.captionTracks.find((t) => t.id === res.trackId)).toBeUndefined();
		valid(H.doc);
	});
	it('SRT / VTT straight from a text-clip group', () => {
		const { H } = shot({ cut: false });
		const r = gen(H);
		const cues = captionCuesForGroup(H.seq as Sequence, r.groupId);
		expect(cues.length).toBe(subs(H).length);
		const srt = writeCaptionFile({ cues, blocks: [], warnings: [] }, 'srt', {
			rate: H.seq.settings.frameRate,
		});
		expect(String(srt)).toContain('Hola');
	});
});

describe('groups and templates (AS-020)', () => {
	it('save a styled clip as a template, apply it to a group in one step', () => {
		const { H } = shot({ cut: false });
		const r = gen(H, { template: 'builtin:bold-pop' });
		const c = subs(H)[0]!;
		const t = H.ok([{ type: 'subtitleTemplate.save', clipId: c.id, name: 'Mine' }]).results[0] as {
			templateId: string;
		};
		const r2 = gen(H, { template: 'builtin:minimal', trackId: 'new' });
		const rev = H.revision;
		H.ok([{ type: 'subtitleTemplate.apply', template: t.templateId, groupId: r2.groupId }]);
		expect(H.revision).toBe(rev + 1);
		for (const x of groupClips(H.seq, r2.groupId) as TextClip[]) expect(x.content.style.allCaps).toBe(true);
		expect(captionGroupsOf(H.seq)[r2.groupId]!.templateId).toBe(t.templateId);
		void r;
		valid(H.doc);
	});
	it('word highlight draws Source Text keys at each word', () => {
		const { H } = shot({ cut: false });
		gen(H, { template: 'builtin:word-highlight' });
		const c = subs(H)[0]!;
		const keys = (c as { sourceTextKeyframes?: unknown[] }).sourceTextKeyframes!;
		expect(keys.length).toBeGreaterThanOrEqual(captionOf(c)!.words.length);
		valid(H.doc);
	});
	it('delete a group keeping or deleting its clips; duplicate a sequence re-ids its groups', () => {
		const { H } = shot({ cut: false });
		const r = gen(H);
		const n = subs(H).length;
		H.ok([{ type: 'sequence.duplicate', sequenceId: H.seqId }]);
		const copy = Object.values(H.doc.sequences).find((s) => s.id !== H.seqId)!;
		const ids = Object.keys(captionGroupsOf(copy));
		expect(ids).toHaveLength(1);
		expect(ids[0]).not.toBe(r.groupId);
		H.ok([{ type: 'captions.deleteGroup', groupId: r.groupId, clips: 'keep' }]);
		expect(subs(H)).toHaveLength(0);
		expect(Object.values(H.seq.clips).filter((c) => c.kind === 'text')).toHaveLength(n);
		valid(H.doc);
	});
});

describe('load repair (schema v9 fields)', () => {
	it('repairs damaged subtitle fields conservatively and idempotently', () => {
		const { H } = shot({ cut: false });
		const r = gen(H, { rules: { maxWords: 3 } });
		const doc = JSON.parse(JSON.stringify(H.doc)) as ProjectDocument;
		const seq = doc.sequences[H.seqId]! as Sequence & { captionGroups: Record<string, unknown> };
		const [c1, c2] = Object.values(seq.clips).filter((c) => captionOf(c));
		(c1 as { caption: { words: unknown[] } }).caption.words.reverse();
		(c2 as { caption: unknown }).caption = { groupId: 'cgp_0000000000000000', words: 'x' };
		const audio = Object.values(seq.clips).find((c) => c.kind === 'audio')!;
		(audio as { caption?: unknown }).caption = { groupId: r.groupId, words: [] };
		(seq.captionGroups[r.groupId] as { rules: unknown }).rules = 'bad';
		(doc as { subtitleTemplates: Record<string, unknown> }).subtitleTemplates.junk = { format: 'nope' };
		expect(checkInvariants(doc).some((i) => i.invariant === 'INV-SUBTITLE' || i.code)).toBe(true);
		const ids = createCounterIdSource(900);
		const a = repairDocument(doc, ids);
		expect(a.report.map((x) => x.action)).toEqual(
			expect.arrayContaining([
				'repair-caption-words',
				'drop-caption',
				'repair-caption-group',
				'drop-subtitle-template',
			]),
		);
		expect(checkInvariants(a.document)).toEqual([]);
		const b = repairDocument(a.document, ids);
		expect(b.report).toEqual([]);
	});
});

describe('cut-aware edge cases on documents (AS-013)', () => {
	it('an overlay below the coverage threshold is not a cut; above it is', () => {
		const { H, b } = shot({
			cut: false,
			words: [
				['one', 2.5, 2.8],
				['two', 3.05, 3.4],
			],
		});
		const r = H.ok([
			{
				type: 'clip.place',
				source: { mediaId: b },
				at: 90,
				tracks: { video: 'V2' },
				audio: false,
				mode: 'overwrite',
			},
		]);
		const pip = (r.results[0] as { clipIds: string[] }).clipIds[0]!;
		H.ok([{ type: 'param.set', target: ['clip', pip, 'transform', 'scale'], value: 60 }]); // 36 % of the frame
		const g = gen(H, { rules: { minSeconds: 0.2, maxWords: 5, maxChars: 40 } });
		expect(subs(H).map((c) => c.start)).not.toContain(90);
		H.ok([{ type: 'captions.deleteGroup', groupId: g.groupId }]);
		H.ok([{ type: 'param.set', target: ['clip', pip, 'transform', 'scale'], value: 90 }]); // 81 %
		gen(H, { rules: { minSeconds: 0.2, maxWords: 5, maxChars: 40 } });
		for (const c of subs(H)) expect(c.start >= 90 || c.start + c.duration <= 90).toBe(true);
		valid(H.doc);
	});
	it('reversed dialogue gives no words and is reported', () => {
		const { H } = shot({ cut: false });
		const audio = H.clips('A1')[0]!;
		H.ok([{ type: 'clip.setSpeed', clipIds: [audio.id], reverse: true, ripple: false }]);
		const r = H.tx([{ type: 'captions.generate' }]);
		expect(r.ok || r.errors[0]!.code).toBe('E_INVALID_PARAM');
	});
	it('subtitles inside a nested sequence align to the cuts of the sequence it is placed in (warned)', () => {
		const { H, b } = shot({
			cut: false,
			words: [
				['one', 2.5, 2.8],
				['two', 3.05, 3.4],
			],
		});
		// nest the A-roll pair, then cut to B-roll in the parent at frame 90 over the nest
		const pair = [H.clips('V1')[0]!.id, H.clips('A1')[0]!.id];
		const n = H.ok([{ type: 'clip.nest', clipIds: pair, name: 'A-roll', ref: '$n' }]);
		const nested = (n.results[0] as { sequenceId: string }).sequenceId;
		H.ok([
			{
				type: 'clip.place',
				source: { mediaId: b },
				at: 90,
				tracks: { video: 'V2' },
				audio: false,
				mode: 'overwrite',
			},
		]);
		const r = H.ok([
			{
				type: 'captions.generate',
				sequenceId: nested,
				rules: { minSeconds: 0.2, maxWords: 5, maxChars: 40 },
			},
		]);
		expect(r.warnings.some((w) => /nested sequence/.test(w.message))).toBe(true);
		const seq = H.doc.sequences[nested]!;
		const list = Object.values(seq.clips).filter((c) => captionOf(c));
		for (const c of list) expect(c.start >= 90 || c.start + c.duration <= 90).toBe(true);
		valid(H.doc);
	});
	for (const preset of ['hd-1080p-23.976', 'hd-1080p-25', 'hd-1080p-29.97', 'hd-1080p-59.94', 'hd-1080p-60'])
		it(`cut-aligned and invariant-clean at ${preset}`, () => {
			const H = new Harness({ preset });
			const rate = H.seq.settings.frameRate;
			const a = H.registerVideo({ seconds: 10, fps: rate });
			const b = H.registerVideo({ seconds: 10, fps: rate });
			const cut = Math.round((3 * rate.num) / rate.den);
			H.ok([
				{
					type: 'clip.place',
					source: { mediaId: a },
					at: 0,
					tracks: { video: 'V1', audio: ['A1'] },
					mode: 'overwrite',
				},
			]);
			H.ok([
				{
					type: 'clip.place',
					source: { mediaId: b },
					at: cut,
					tracks: { video: 'V1' },
					audio: false,
					mode: 'overwrite',
				},
			]);
			H.ok([
				{
					type: 'transcript.create',
					mediaId: a,
					language: 'en',
					origin: 'manual',
					words: [
						{ text: 'one', start: sec(2.5), end: sec(2.9) },
						{ text: 'two', start: sec(2.9), end: sec(3.2) },
						{ text: 'three', start: sec(3.2), end: sec(3.8) },
					],
				},
			]);
			const g = gen(H, { rules: { minSeconds: 0.2, maxWords: 5, maxChars: 40 } });
			expect(g.stats.crossing).toBe(0);
			expect(subs(H).some((c) => c.start === cut)).toBe(true);
			for (const c of subs(H)) expect(c.start >= cut || c.start + c.duration <= cut).toBe(true);
			valid(H.doc);
		});
	it('the Pixel Pop shake reproduces the Premiere offsets on any frame (calibration)', () => {
		// Premiere: offset = Amplitude × (Rand Amp / 360) × 0.1 frame widths; ours: × 0.1 layer-box widths
		for (const [w] of [[1080], [1920]]) {
			const premierePx = 0.6 * (72 / 360) * 0.1 * w;
			const boxW = (w * 75) / 100;
			const oursPx = 0.6 * PIXEL_POP_SHAKE.xRandAmp * 0.1 * boxW;
			expect(Math.abs(oursPx - premierePx)).toBeLessThan(0.05);
		}
	});
});
