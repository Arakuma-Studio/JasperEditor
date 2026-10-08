// The per-sequence invariant memo (golden-fuzz scale work) returns exactly what an uncached check returns: on
// documents edited by random command sequences (sharing untouched sequences between versions), on corrupted copies
// (duplicate ids across sequences, missing media, broken clips) and after repairs.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	checkInvariantsUncached,
	createCounterIdSource,
	defaultRegistries,
	type ProjectDocument,
	repairDocument,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const effects = defaultRegistries().effects;
const same = (d: ProjectDocument) =>
	expect(checkInvariants(d, { effects })).toEqual(checkInvariantsUncached(d, { effects }));

function project(): Harness {
	const h = new Harness();
	const m = h.registerVideo({ seconds: 20 });
	h.ok([
		{ type: 'sequence.create', name: 'B', ref: '$b' },
		{
			type: 'clip.place',
			source: { mediaId: m },
			at: 0,
			sourceRange: { in: { seconds: 0 }, out: { seconds: 4 } },
		},
		{ type: 'clip.addText', at: 10, duration: 40, track: 'V2', content: { text: 'x' }, ref: '$t' },
		{ type: 'effect.add', target: { clipId: '$t' }, effectId: 'jasper.gaussian-blur' },
	]);
	return h;
}

describe('per-sequence invariant memo', () => {
	it('equals the uncached check across edits that leave other sequences shared', () => {
		const h = project();
		same(h.doc);
		const seqs = Object.keys(h.doc.sequences);
		fc.assert(
			fc.property(
				fc.array(fc.tuple(fc.integer({ min: 0, max: 200 }), fc.boolean()), { maxLength: 8 }),
				(ops) => {
					for (const [at, solid] of ops) {
						h.tx([
							solid
								? { type: 'clip.addSolid', at, duration: 10, track: 'V3', color: [1, 0, 0, 1] }
								: { type: 'marker.add', frame: at, name: 'm' },
						]);
						same(h.doc);
					}
					return true;
				},
			),
			{ numRuns: 40 },
		);
		expect(seqs.length).toBe(2);
	});

	it('equals the uncached check on corrupted documents (duplicate ids across sequences, dangling media)', () => {
		const h = project();
		checkInvariants(h.doc, { effects }); // memoize every sequence
		const [s1, s2] = Object.keys(h.doc.sequences);
		// Every table shared with the memoized document (a memo hit for the first sequence); one of its clips copied
		// into the second sequence: the replayed id collides and the check falls back to the uncached walk.
		const clip = Object.values(h.doc.sequences[s1!]!.clips)[0]!;
		const second = structuredClone(h.doc.sequences[s2!]!);
		second.clips[clip.id] = { ...clip, trackId: second.videoTracks[0]!.id, linkId: null } as never;
		const d = { ...h.doc, sequences: { [s1!]: h.doc.sequences[s1!]!, [s2!]: second } } as ProjectDocument;
		same(d);
		expect(checkInvariants(d, { effects }).some((i) => i.message.includes('Duplicate id'))).toBe(true);
		const e = structuredClone(h.doc) as ProjectDocument;
		e.sequences[s1!] = h.doc.sequences[s1!]!;
		e.media = {};
		same(e);
		const repaired = repairDocument(e, createCounterIdSource(5)).document;
		same(repaired);
	});
});
