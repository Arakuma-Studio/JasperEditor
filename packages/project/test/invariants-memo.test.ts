import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	createCounterIdSource,
	defaultRegistries,
	type ProjectDocument,
	repairDocument,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const effects = defaultRegistries().effects;
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
	it('detects duplicate clip IDs and removed media after checking shared sequences', () => {
		const h = project();
		expect(checkInvariants(h.doc, { effects })).toEqual([]);
		const [s1, s2] = Object.keys(h.doc.sequences);
		// Every table shared with the memoized document (a memo hit for the first sequence); one of its clips copied
		// into the second sequence: the replayed id collides and the check falls back to the uncached walk.
		const clip = Object.values(h.doc.sequences[s1!]!.clips)[0]!;
		const second = structuredClone(h.doc.sequences[s2!]!);
		second.clips[clip.id] = { ...clip, trackId: second.videoTracks[0]!.id, linkId: null } as never;
		const d = { ...h.doc, sequences: { [s1!]: h.doc.sequences[s1!]!, [s2!]: second } } as ProjectDocument;
		expect(
			checkInvariants(d, { effects }).some((i) => i.invariant === 'INV-001' && i.path?.includes(clip.id)),
		).toBe(true);
		const e = { ...h.doc, media: {} } as ProjectDocument;
		expect(
			checkInvariants(e, { effects }).some((i) => i.invariant === 'INV-006' && i.path?.includes(clip.id)),
		).toBe(true);
		const repaired = repairDocument(e, createCounterIdSource(5)).document;
		expect(checkInvariants(repaired, { effects })).toEqual([]);
		expect(repaired.sequences[s1!]!.clips[clip.id]).toBeUndefined();
	});
});
