// Cut map properties (spec 13 SH-001): on random timelines the cuts are sorted, unique, inside the sequence and the
// analysed range, name existing clips, and do not change under edits that leave the picture alone (Add Edit, an
// empty track on top, a title, a hidden clip, restricting the range).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Clip,
	CUT_KINDS,
	clipToRange,
	type PictureCut,
	type ProjectDocument,
	pictureCuts,
	type Rational,
	type Sequence,
	sequenceDuration,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

type Spec = {
	track: number;
	media: number;
	start: number;
	duration: number;
	sourceIn: number;
	scale: number;
};

const specArb = fc.record({
	track: fc.integer({ min: 0, max: 2 }),
	media: fc.integer({ min: 0, max: 2 }),
	start: fc.integer({ min: 0, max: 600 }),
	duration: fc.integer({ min: 1, max: 120 }),
	sourceIn: fc.integer({ min: 0, max: 400 }),
	scale: fc.constantFrom(100, 100, 100, 120, 80, 60, 40),
});

const base = (() => {
	const h = new Harness({ preset: 'hd-1080p-59.94' });
	const media = [0, 1, 2].map(() => h.registerVideo({ seconds: 60, audio: false }));
	const r = h.ok([{ type: 'clip.place', source: { mediaId: media[0] }, at: 0, tracks: { video: 'V1' } }]);
	const template = h.seq.clips[(r.results[0] as { clipIds: string[] }).clipIds[0]!]!;
	const doc = structuredClone(h.doc);
	const seq = doc.sequences[h.seqId]!;
	seq.clips = {};
	return { doc, seqId: h.seqId, media, template };
})();

/** A document with the clips of `specs` (later specs lose where they would overlap an earlier one on a track). */
function build(specs: Spec[]): { doc: ProjectDocument; seq: Sequence } {
	const doc = structuredClone(base.doc);
	const seq = doc.sequences[base.seqId]!;
	const F = (705_600_000 * seq.settings.frameRate.den) / seq.settings.frameRate.num;
	const taken: [number, number][][] = [[], [], []];
	const clips: Record<string, Clip> = {};
	specs.forEach((s, i) => {
		const end = s.start + s.duration;
		if (taken[s.track]!.some(([a, b]) => s.start < b && a < end)) return;
		taken[s.track]!.push([s.start, end]);
		const c = structuredClone(base.template) as Clip & {
			mediaId: string;
			transform: { scale: { value: number } };
		};
		c.id = `c${i}`;
		c.trackId = seq.videoTracks[s.track]!.id;
		c.mediaId = base.media[s.media]!;
		c.start = s.start;
		c.duration = s.duration;
		c.sourceIn = s.sourceIn * F;
		c.linkId = null;
		c.transform.scale.value = s.scale;
		clips[c.id] = c;
	});
	seq.clips = clips;
	seq.links = {};
	return { doc, seq };
}

const shape = (cuts: PictureCut[]) => cuts.map((c) => `${c.frame}:${c.kind}`);

function checkWellFormed(seq: Sequence, cuts: PictureCut[], range?: { start: number; end: number }) {
	const duration = sequenceDuration(seq);
	for (let i = 0; i < cuts.length; i++) {
		const c = cuts[i]!;
		expect(Number.isInteger(c.frame)).toBe(true);
		expect(c.frame).toBeGreaterThan(0);
		expect(c.frame).toBeLessThan(duration);
		if (range) {
			expect(c.frame).toBeGreaterThanOrEqual(range.start);
			expect(c.frame).toBeLessThan(range.end);
		}
		if (i) expect(c.frame).toBeGreaterThan(cuts[i - 1]!.frame);
		expect(CUT_KINDS).toContain(c.kind);
		expect(c.outgoingClipId || c.incomingClipId).toBeTruthy();
		for (const id of [c.outgoingClipId, c.incomingClipId]) if (id) expect(seq.clips[id]).toBeDefined();
		expect(seq.videoTracks.some((t) => t.id === c.trackId)).toBe(true);
	}
}

describe('pictureCuts properties', () => {
	it('cuts are sorted, unique and inside the sequence and the range', () => {
		fc.assert(
			fc.property(
				fc.array(specArb, { minLength: 1, maxLength: 25 }),
				fc.integer({ min: 0, max: 700 }),
				fc.integer({ min: 0, max: 700 }),
				(specs, x, y) => {
					const { doc, seq } = build(specs);
					checkWellFormed(seq, pictureCuts(doc, seq.id));
					const range = { start: Math.min(x, y), end: Math.max(x, y) };
					const ranged = pictureCuts(doc, seq.id, { range });
					checkWellFormed(seq, ranged, range);
					// A range is a filter of the whole map.
					expect(shape(ranged)).toEqual(
						shape(pictureCuts(doc, seq.id)).filter((s) => {
							const f = Number(s.split(':')[0]);
							return f >= range.start && f < range.end;
						}),
					);
				},
			),
			{ numRuns: 150 },
		);
	});

	it('is stable under edits that leave the picture alone', () => {
		fc.assert(
			fc.property(
				fc.array(specArb, { minLength: 1, maxLength: 20 }),
				fc.nat(),
				fc.double({ min: 0.05, max: 0.95, noNaN: true }),
				(specs, pick, where) => {
					const { doc, seq } = build(specs);
					const before = shape(pictureCuts(doc, seq.id));
					const ids = Object.keys(seq.clips);
					const victim = seq.clips[ids[pick % ids.length]!]!;
					const rate = seq.settings.frameRate as Rational;
					// Add Edit (a through edit) inside one clip.
					if (victim.duration >= 2) {
						const at =
							victim.start + Math.max(1, Math.min(victim.duration - 1, Math.round(victim.duration * where)));
						const split = structuredClone(doc);
						const s = split.sequences[seq.id]!;
						const left = clipToRange(victim, victim.start, at, rate)!;
						const right = {
							...clipToRange(victim, at, victim.start + victim.duration, rate)!,
							id: `${victim.id}r`,
						};
						s.clips = { ...s.clips, [left.id]: left, [right.id]: right };
						expect(shape(pictureCuts(split, seq.id))).toEqual(before);
					}
					// An empty track on top, then a disabled full-frame clip and a title on it.
					const extra = structuredClone(doc);
					const s2 = extra.sequences[seq.id]!;
					const top = { ...s2.videoTracks[0]!, id: 'trk_top', name: null };
					s2.videoTracks = [...s2.videoTracks, top];
					expect(shape(pictureCuts(extra, seq.id))).toEqual(before);
					const hidden = {
						...structuredClone(victim),
						id: 'hidden',
						trackId: top.id,
						enabled: false,
					} as Clip;
					s2.clips = { ...s2.clips, hidden };
					expect(shape(pictureCuts(extra, seq.id))).toEqual(before);
					// Clips added on top of the old last frame would change the duration; keep the title inside it.
					const end = sequenceDuration(seq);
					const title = {
						...structuredClone(victim),
						id: 'title',
						kind: 'text',
						trackId: top.id,
						enabled: true,
						start: 0,
						duration: Math.max(1, end),
						content: { text: 'Title' },
						box: { width: 1920, height: 1080 },
					} as unknown as Clip;
					s2.clips = { ...s2.clips, title };
					expect(shape(pictureCuts(extra, seq.id))).toEqual(before);
				},
			),
			{ numRuns: 150 },
		);
	});
});
