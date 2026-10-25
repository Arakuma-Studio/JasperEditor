import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	coverageProblem,
	distributeSequenceWords,
	mergeTranscriptWords,
	normalizeTranscriptSegments,
	repairDocument,
	sequenceWords,
	type Transcript,
	transcriptAttachPlan,
	transcriptSegments,
	transcriptSegmentsProblem,
} from '../src/index.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';
import { Harness } from './helpers.ts';

const s = (x: number) => Math.round(x * FLICKS_PER_SECOND);
const w = (text: string, a: number, b: number, extra: Record<string, unknown> = {}) => ({
	text,
	start: s(a),
	end: s(b),
	...extra,
});

function setup() {
	const H = new Harness({ preset: 'hd-1080p-25' });
	const mediaId = H.registerVideo({ seconds: 20, fps: { num: 25, den: 1 } });
	H.ok([
		{
			type: 'clip.place',
			source: { mediaId },
			at: 0,
			tracks: { video: 'V1', audio: ['A1'] },
			mode: 'overwrite',
		},
	]);
	return { H, mediaId };
}

const transcriptsOf = (H: Harness, mediaId: string) =>
	(Object.values(H.doc.transcripts) as Transcript[]).filter((t) => t.mediaId === mediaId);

describe('transcript.attach', () => {
	it('creates the media transcript (words normalised, speakers named) and its clips read it back; undo removes it', () => {
		const { H, mediaId } = setup();
		const before = H.doc;
		const r = H.ok([
			{
				type: 'transcript.attach',
				mediaId,
				language: 'en',
				words: [
					w('world.', 1, 1.5, { speaker: 'S2', confidence: 0.4 }),
					w('Hello', 0.2, 0.8, { speaker: 'S1', confidence: 0.9 }),
				],
				model: 'whisper-base',
			},
		]);
		const res = r.results[0] as { transcriptId: string; replaced: boolean };
		expect(res.replaced).toBe(false);
		const t = H.doc.transcripts[res.transcriptId] as Transcript;
		expect(t.words.map((x) => x.text)).toEqual(['Hello', 'world.']);
		expect(t.origin).toBe('whisper-local');
		expect(t.model).toBe('whisper-base');
		expect(t.createdAt).toBeTruthy();
		expect(Object.keys(t.speakers).sort()).toEqual(['S1', 'S2']);
		expect(Object.values(t.speakers).every((s) => s.name.trim().length > 0)).toBe(true);
		expect(t.speakers.S1!.name).not.toBe(t.speakers.S2!.name);
		expect(sequenceWords(H.doc, H.seq).map((x) => [x.text, x.confidence])).toEqual([
			['Hello', 0.9],
			['world.', 0.4],
		]);
		expect(checkInvariants(H.doc)).toEqual([]);
		expect(r.created).toContain(res.transcriptId);
		expect(before.transcripts).toEqual({});
	});

	it('replace keeps the transcript id (references stay valid); keep leaves it; merge replaces only the coverage', () => {
		const { H, mediaId } = setup();
		const id = (
			H.ok([
				{
					type: 'transcript.attach',
					mediaId,
					language: 'en',
					words: [w('a', 1, 2), w('b', 5, 6), w('c', 9, 10)],
				},
			]).results[0] as { transcriptId: string }
		).transcriptId;
		const kept = H.ok([
			{ type: 'transcript.attach', mediaId, language: 'fr', words: [w('x', 0, 1)], mode: 'keep' },
		]).results[0] as { skipped?: boolean; transcriptId: string };
		expect(kept).toMatchObject({ skipped: true, transcriptId: id });
		expect(H.doc.transcripts[id]!.language).toBe('en');
		H.ok([
			{
				type: 'transcript.attach',
				mediaId,
				language: 'en',
				words: [w('B', 4.5, 5.5), w('B2', 6, 6.5)],
				coverage: [[s(4), s(7)]],
				mode: 'merge',
			},
		]);
		expect(H.doc.transcripts[id]!.words.map((x) => x.text)).toEqual(['a', 'B', 'B2', 'c']);
		expect(H.doc.transcripts[id]!.coverage).toBeUndefined();
		H.ok([
			{
				type: 'transcript.attach',
				mediaId,
				language: 'de',
				task: 'translate',
				sourceLanguage: 'de',
				words: [w('z', 0, 1)],
				coverage: [[0, s(3)]],
			},
		]);
		expect(transcriptsOf(H, mediaId)).toHaveLength(1);
		const t = H.doc.transcripts[id]!;
		expect(t.words.map((x) => x.text)).toEqual(['z']);
		expect(t.coverage).toEqual([[0, s(3)]]);
		expect(t.task).toBe('translate');
		expect(checkInvariants(H.doc)).toEqual([]);
	});

	it('refuses unknown media and words that end before they start', () => {
		const { H, mediaId } = setup();
		const r1 = H.tx([{ type: 'transcript.attach', mediaId: 'med_nope', language: 'en', words: [] }]);
		expect(r1.ok).toBe(false);
		const r2 = H.tx([{ type: 'transcript.attach', mediaId, language: 'en', words: [w('x', 2, 1)] }]);
		expect(r2.ok).toBe(false);
		if (!r2.ok) expect(r2.errors[0]!.code).toBe('E_INVALID_PARAM');
	});
});

describe('words of a sequence mix → media transcripts', () => {
	it('maps words through clip offset and speed, top track first, and records the media ranges played', () => {
		const H = new Harness({ preset: 'hd-1080p-25' });
		const a = H.registerVideo({ seconds: 30, fps: { num: 25, den: 1 } });
		const b = H.registerVideo({ seconds: 30, fps: { num: 25, den: 1 } });
		// A1: media a from 10 s, at 0 s, 5 s long; then media b from 0 s, at 5 s, 5 s long at 2× speed
		H.ok([
			{
				type: 'clip.place',
				source: { mediaId: a },
				sourceRange: { in: { seconds: 10 }, out: { seconds: 15 } },
				at: 0,
				tracks: { audio: ['A1'] },
				video: false,
			},
			{
				type: 'clip.place',
				source: { mediaId: b },
				sourceRange: { in: { seconds: 0 }, out: { seconds: 10 } },
				at: 125,
				tracks: { audio: ['A1'] },
				video: false,
			},
		]);
		const bClip = H.clips('A1').find((c) => (c as { mediaId?: string }).mediaId === b)!;
		H.ok([{ type: 'clip.setSpeed', clipIds: [bClip.id], rate: 2, ripple: false }]);
		const words = [w('one', 1, 1.5), w('two', 6, 6.5), w('lost', 20, 20.5)];
		const r = distributeSequenceWords(H.doc, H.seqId, words);
		expect(r.unassigned).toBe(1);
		const ma = r.media.find((m) => m.mediaId === a)!;
		const mb = r.media.find((m) => m.mediaId === b)!;
		expect(ma.words.map((x) => [x.text, x.start, x.end])).toEqual([['one', s(11), s(11.5)]]);
		expect(mb.words.map((x) => [x.text, x.start, x.end])).toEqual([['two', s(2), s(3)]]);
		expect(ma.coverage).toEqual([[s(10), s(15)]]);
		expect(mb.coverage).toEqual([[0, s(10)]]);
		H.ok(
			r.media.map((m) => ({
				type: 'transcript.attach',
				mediaId: m.mediaId,
				language: 'en',
				words: m.words,
				coverage: m.coverage,
			})),
		);
		const back = sequenceWords(H.doc, H.seq).map((x) => [x.text, x.start / FLICKS_PER_SECOND]);
		expect(back).toEqual([
			['one', 1],
			['two', 6],
		]);
		expect(checkInvariants(H.doc)).toEqual([]);
	});

	it('merge keeps words outside the new coverage (property)', () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 30 }),
				fc.integer({ min: 0, max: 900 }),
				fc.integer({ min: 1, max: 300 }),
				(starts, c0, len) => {
					const old = [...new Set(starts)]
						.sort((x, y) => x - y)
						.map((t) => ({
							text: `w${t}`,
							start: t * 10,
							end: t * 10 + 5,
							confidence: null,
							speaker: null,
							breakBefore: 'none' as const,
						}));
					const cov: [number, number][] = [[c0 * 10, (c0 + len) * 10]];
					const inside = (t: number) => t >= cov[0]![0] && t < cov[0]![1];
					const incoming = [
						{
							text: 'new',
							start: cov[0]![0],
							end: cov[0]![0] + 1,
							confidence: 1,
							speaker: null,
							breakBefore: 'none' as const,
						},
					];
					const m = mergeTranscriptWords({ words: old }, incoming, cov);
					for (const o of old) {
						const mid = o.start + 2;
						expect(m.words.some((x) => x.text === o.text)).toBe(!inside(mid));
					}
					expect(m.words.some((x) => x.text === 'new')).toBe(true);
				},
			),
			{ numRuns: 100 },
		);
	});
});

describe('coverage invariant and repair', () => {
	it('flags malformed coverage and repairDocument sorts and merges it', () => {
		expect(coverageProblem(undefined)).toBeNull();
		expect(
			coverageProblem([
				[0, 5],
				[5, 9],
			]),
		).toMatch(/sorted/);
		expect(coverageProblem([[3, 3]])).toMatch(/empty/);
		const { H, mediaId } = setup();
		H.ok([{ type: 'transcript.attach', mediaId, language: 'en', words: [w('a', 1, 2)] }]);
		const doc = structuredClone(H.doc);
		const t = Object.values(doc.transcripts)[0] as Transcript;
		t.coverage = [
			[s(5), s(8)],
			[0, s(2)],
			[s(1), s(3)],
			[s(9), s(9)],
		];
		expect(checkInvariants(doc).some((i) => (i as { invariant?: string }).invariant === 'INV-012')).toBe(
			true,
		);
		const fixed = repairDocument(doc, H.ids).document;
		expect((Object.values(fixed.transcripts)[0] as Transcript).coverage).toEqual([
			[0, s(3)],
			[s(5), s(8)],
		]);
		expect(checkInvariants(fixed)).toEqual([]);
	});
});

describe('segment scores in transcripts (spec 14 TC-003, v9)', () => {
	const seg = (a: number, b: number, avgLogprob: number, noSpeechProb = 0.01, compressionRatio = 1.2) => ({
		start: s(a),
		end: s(b),
		avgLogprob,
		noSpeechProb,
		compressionRatio,
	});

	it('attach stores sorted segments; replace swaps them; merge keeps those outside the coverage; undo/redo', () => {
		const { H, mediaId } = setup();
		const before = H.doc;
		const cmd = {
			type: 'transcript.attach',
			mediaId,
			language: 'es',
			words: [w('hola', 0.2, 0.8), w('adiós', 6, 6.5)],
			segments: [seg(5.9, 6.6, -0.8), seg(0.1, 1, -0.2)],
		};
		const r = H.ok([cmd]);
		const id = (r.results[0] as { transcriptId: string }).transcriptId;
		expect(transcriptSegments(H.doc.transcripts[id]!)).toEqual([seg(0.1, 1, -0.2), seg(5.9, 6.6, -0.8)]);
		expect(checkInvariants(H.doc)).toEqual([]);
		// undo = the previous document; redo = the same command again gives the same transcript
		expect(before.transcripts).toEqual({});
		const H2 = setup().H;
		const r2 = H2.ok([{ ...cmd, mediaId: Object.keys(H2.doc.media)[0]! }]);
		const id2 = (r2.results[0] as { transcriptId: string }).transcriptId;
		expect(H2.doc.transcripts[id2]!.segments).toEqual(H.doc.transcripts[id]!.segments);
		// merge inside [5 s, 10 s): the segment at 0.1 s stays, the one at 5.9 s is replaced
		H.ok([
			{
				type: 'transcript.attach',
				mediaId,
				language: 'es',
				words: [w('otra', 7, 7.5)],
				segments: [seg(6.9, 7.6, -0.4)],
				coverage: [[s(5), s(10)]],
				mode: 'merge',
			},
		]);
		expect(transcriptSegments(H.doc.transcripts[id]!).map((x) => x.avgLogprob)).toEqual([-0.2, -0.4]);
		// replace without segments drops them
		H.ok([{ type: 'transcript.attach', mediaId, language: 'es', words: [w('x', 1, 2)] }]);
		expect(H.doc.transcripts[id]!.segments).toBeUndefined();
	});

	it('refuses malformed segments in the command', () => {
		const { H, mediaId } = setup();
		for (const bad of [{ start: -1, end: 5 }, { start: 1.5, end: 2 }, { start: 0, end: 1, noSpeechProb: 2 }]) {
			const r = H.tx([{ type: 'transcript.attach', mediaId, language: 'en', words: [], segments: [bad] }]);
			expect(r.ok).toBe(false);
		}
	});

	it('malformed stored segments break INV-012 and repair drops them (lenient read)', () => {
		const { H, mediaId } = setup();
		H.ok([{ type: 'transcript.attach', mediaId, language: 'en', words: [w('a', 0, 1)], segments: [seg(0, 1, -0.1)] }]);
		const doc = structuredClone(H.doc);
		const t = Object.values(doc.transcripts)[0] as Transcript;
		t.segments = [seg(3, 4, -0.5), 'junk', { start: 2, end: 1 }, seg(0, 1, -0.1), { start: 0, end: 1, avgLogprob: 'x' }];
		expect(transcriptSegmentsProblem(t.segments)).toBeTruthy();
		expect(checkInvariants(doc).some((i) => (i as { invariant?: string }).invariant === 'INV-012')).toBe(true);
		const fixed = repairDocument(doc, H.ids);
		expect((Object.values(fixed.document.transcripts)[0] as Transcript).segments).toEqual([
			seg(0, 1, -0.1),
			seg(3, 4, -0.5),
		]);
		expect(checkInvariants(fixed.document)).toEqual([]);
		fc.assert(
			fc.property(fc.anything(), (x) => {
				const segs = normalizeTranscriptSegments(x);
				return transcriptSegmentsProblem(segs) === null;
			}),
			{ numRuns: 200 },
		);
	});

	it('the attach plan converts result segments (seconds) and distributes mix segments to the clip media', () => {
		const { H, mediaId } = setup();
		const media = transcriptAttachPlan(
			H.doc,
			{
				target: { type: 'media' },
				model: 'whisper-large-v3-turbo',
				language: 'es',
				task: 'transcribe',
				words: [w('hola', 0.2, 0.8)],
				speakers: {},
				segments: [{ start: 0.1, end: 1, avgLogprob: -0.3, noSpeechProb: 0.02, compressionRatio: 1.4 }],
			},
			{ mediaId, replace: true },
		);
		if ('error' in media) throw new Error(media.error);
		expect(media.commands[0]!.segments).toEqual([seg(0.1, 1, -0.3, 0.02, 1.4)]);
		// a mix: the clip plays media 0–20 s at sequence 0 s, so times stay; outside every clip → dropped
		const mix = transcriptAttachPlan(
			H.doc,
			{
				target: { type: 'sequence', sequenceId: H.seqId, range: { startFrame: 0, endFrame: 750 }, mixHash: 'h' },
				model: 'm',
				language: 'es',
				task: 'transcribe',
				words: [w('hola', 2, 2.5)],
				speakers: {},
				segments: [
					{ start: 1.9, end: 2.6, avgLogprob: -0.1 },
					{ start: 25, end: 26, avgLogprob: -2 },
				],
			},
			{ replace: true },
		);
		if ('error' in mix) throw new Error(mix.error);
		expect(mix.commands[0]!.segments).toEqual([{ start: s(1.9), end: s(2.6), avgLogprob: -0.1 }]);
		H.ok(mix.commands);
		expect(checkInvariants(H.doc)).toEqual([]);
	});
});
