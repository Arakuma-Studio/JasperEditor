// edit-ux: Match Frame / Reverse Match Frame queries and trim-mode edit point helpers.
import { describe, expect, it } from 'vitest';
import {
	flicksPerFrame,
	matchFrame,
	nearestEditPoints,
	nextTrimType,
	RATES,
	reverseMatchFrame,
	rollPair,
	trimSides,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const F = flicksPerFrame(RATES.r30);
const fl = (n: number) => ({ flicks: n * F });

function twoClips() {
	const h = new Harness();
	const mediaId = h.registerVideo({ seconds: 20 });
	const itemId = Object.values(h.doc.items).find((i) => i.kind === 'media' && i.mediaId === mediaId)!.id;
	h.ok([
		{
			type: 'clip.sourceEdit',
			source: { projectItemId: itemId },
			sourceIn: fl(30),
			sourceOut: fl(90),
			playhead: 0,
		},
		{
			type: 'clip.sourceEdit',
			source: { projectItemId: itemId },
			sourceIn: fl(300),
			sourceOut: fl(360),
			playhead: 60,
		},
	]);
	return { h, itemId, mediaId };
}

describe('match frame', () => {
	it('finds the topmost clip and the source frame; reverse match returns the sequence frame', () => {
		const { h, itemId, mediaId } = twoClips();
		const m = matchFrame(h.doc, h.seqId, 70)!;
		expect(m.itemId).toBe(itemId);
		expect(m.mediaId).toBe(mediaId);
		expect(m.sourceTime).toBe(310 * F);
		expect(m.clipId).toBe(h.clips('V1')[1]!.id);
		expect([m.sourceIn, m.sourceOut]).toEqual([300 * F, 360 * F]);
		// Only A1 targeted: the audio clip.
		expect(matchFrame(h.doc, h.seqId, 70, { trackIds: [h.seq.audioTracks[0]!.id] })!.clipId).toBe(
			h.clips('A1')[1]!.id,
		);
		expect(matchFrame(h.doc, h.seqId, 500)).toBeNull();
		const r = reverseMatchFrame(h.doc, h.seqId, { itemId, time: 45 * F })!;
		expect(r.frame).toBe(15);
		expect(reverseMatchFrame(h.doc, h.seqId, { itemId, time: 200 * F })).toBeNull();
	});
	it('reverse speed clips map back exactly', () => {
		const { h, itemId } = twoClips();
		const v = h.clips('V1')[0]!;
		h.ok([{ type: 'clip.setSpeed', clipIds: [v.id], reverse: true, ripple: false }]);
		const m = matchFrame(h.doc, h.seqId, 10)!;
		const back = reverseMatchFrame(h.doc, h.seqId, { itemId, time: m.sourceTime }, { near: 10 })!;
		expect(back.frame).toBe(10);
	});
});

describe('trim mode helpers', () => {
	it('nearest edit points per track, roll pairs and sides', () => {
		const { h } = twoClips();
		const [a, b] = h.clips('V1');
		const pts = nearestEditPoints(h.seq, 58, 'roll');
		// One roll per track at the cut, stored on the outgoing clip's Out edge.
		expect(pts).toHaveLength(2);
		expect(pts[0]).toEqual({ clipId: a!.id, edge: 'out', mode: 'roll' });
		expect(rollPair(h.seq, { clipId: b!.id, edge: 'in' })).toEqual([a!.id, b!.id]);
		expect(trimSides(h.seq, { clipId: b!.id, edge: 'in' })).toEqual({ outgoing: a!.id, incoming: b!.id });
		expect(trimSides(h.seq, { clipId: b!.id, edge: 'out' })).toEqual({ outgoing: b!.id, incoming: null });
		const rippleIn = nearestEditPoints(h.seq, 58, 'rippleIn', [h.seq.videoTracks[0]!.id]);
		expect(rippleIn).toEqual([{ clipId: b!.id, edge: 'in', mode: 'ripple' }]);
		expect(nearestEditPoints(h.seq, 118, 'trimOut', [h.seq.videoTracks[0]!.id])).toEqual([
			{ clipId: b!.id, edge: 'out', mode: 'regular' },
		]);
		expect(['ripple', 'roll', 'regular'].map((t) => nextTrimType(t as never))).toEqual([
			'roll',
			'regular',
			'ripple',
		]);
	});
});
