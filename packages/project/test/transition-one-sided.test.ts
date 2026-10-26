// One-sided transitions at free clip edges (spec 15 EA-024: overlay slides need `transition.add` to put a GPU
// transition — Smooth Slide — at a clip head or tail no other clip touches). Verified: `transition.add {clipId, edge}`
// at a free edge stores a transition with the other side null (alignment start-at-cut / end-at-cut), clamps its
// length to the clip, renders as a one-sided shader stage (from / to transparent over the clip's own frames, no
// handles), becomes two-sided where another clip abuts the edge, replaces an earlier transition on the same edge
// (INV-010), keeps invariants, undoes to the document before and redoes identically; refusals for a frame that is not
// an edit point, a missing edge, an audio transition on video and a locked track.
import { describe, expect, it } from 'vitest';
import { checkInvariants, flicksPerFrame, resolveVideoTransitions } from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

function setup(kind: 'image' | 'video' = 'image') {
	const h = new Harness();
	const m = (
		h.ok([{ type: 'media.register', asset: videoAsset({ kind, seconds: 60, width: 640, height: 360 }) }])
			.results[0] as {
			mediaId: string;
		}
	).mediaId;
	const F = flicksPerFrame(h.seq.settings.frameRate);
	const place = (at: number, len: number, track = 'V2') =>
		(
			h.ok([
				{
					type: 'clip.place',
					source: { mediaId: m },
					at,
					tracks: { video: track },
					video: true,
					audio: false,
					sourceRange: { in: { flicks: 0 }, out: { flicks: len * F } },
				},
			]).results[0] as { clipIds: string[] }
		).clipIds[0]!;
	return { h, place };
}

const slide = (clipId: string, edge: 'in' | 'out', extra: Record<string, unknown> = {}) => ({
	type: 'transition.add',
	clipId,
	edge,
	effectId: 'jasper.smooth-slide',
	duration: 30,
	params: { direction: 'down', animation: 'easeInOutQuad', motionBlur: 'high', shutterAngle: 360 },
	...extra,
});

describe('one-sided transitions at free clip edges', () => {
	it.each(['image', 'video'] as const)('a Smooth Slide at the free head and tail of a %s clip', (kind) => {
		const { h, place } = setup(kind);
		const c = place(100, 200);
		const before = h.doc;
		const r = h.ok([slide(c, 'in'), slide(c, 'out', { params: { direction: 'up' } })]);
		expect(r.results).toEqual([
			expect.objectContaining({
				duration: 30,
				alignment: 'start-at-cut',
				outgoingClipId: null,
				incomingClipId: c,
			}),
			expect.objectContaining({
				duration: 30,
				alignment: 'end-at-cut',
				outgoingClipId: c,
				incomingClipId: null,
			}),
		]);
		expect(checkInvariants(h.doc)).toEqual([]);
		const stages = [...resolveVideoTransitions(h.doc, h.seq).stages.values()].flat();
		expect(stages.map((s) => [s.sides, s.start, s.duration, s.incomingClipId, s.outgoingClipId])).toEqual([
			['in', 100, 30, c, null],
			['out', 270, 30, null, c],
		]);
		// no handles: the clip's own frames carry the slide
		const clips = resolveVideoTransitions(h.doc, h.seq).clips;
		expect(clips.get(c)?.headHandle ?? 0).toBe(0);
		expect(clips.get(c)?.tailHandle ?? 0).toBe(0);
		// undo = the document before; redo gives the same transitions
		const after = h.doc;
		h.doc = before;
		expect(Object.keys(h.seq.transitions)).toHaveLength(0);
		h.ok([slide(c, 'in'), slide(c, 'out', { params: { direction: 'up' } })]);
		const strip = (d: typeof h.doc) =>
			Object.values(d.sequences[h.seqId]!.transitions).map(({ id: _id, ...t }) => t);
		expect(strip(h.doc)).toEqual(strip(after));
	});

	it('is clamped to the clip, becomes two-sided where a clip abuts, and replaces the edge’s earlier transition', () => {
		const { h, place } = setup('video');
		const a = place(100, 20);
		const r = h.ok([slide(a, 'in')]);
		expect(r.results[0]).toMatchObject({ outgoingClipId: null });
		const stage = [...resolveVideoTransitions(h.doc, h.seq).stages.values()].flat()[0]!;
		expect([stage.start, stage.duration]).toEqual([100, 20]);
		const b = place(120, 200);
		const two = h.ok([slide(b, 'in', { duration: 10 })]);
		expect(two.results[0]).toMatchObject({ outgoingClipId: a, incomingClipId: b, alignment: 'center' });
		// one transition per edge: the head slide of `a` stays, b's head now shares the edit with a's tail
		const again = h.ok([slide(a, 'in', { params: { direction: 'left' } })]);
		const onHead = Object.values(h.seq.transitions).filter((t) => t.incomingClipId === a);
		expect(onHead).toHaveLength(1);
		expect(onHead[0]!.id).toBe((again.results[0] as { transitionId: string }).transitionId);
		expect(onHead[0]!.params.direction!.value).toBe('left');
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('refusals: not an edit point, no edge, wrong medium, locked track', () => {
		const { h, place } = setup();
		const c = place(100, 200);
		const notEdit = h.tx([
			{ type: 'transition.add', trackId: 'V2', at: 150, effectId: 'jasper.smooth-slide', duration: 30 },
		]);
		expect(notEdit.ok).toBe(false);
		if (!notEdit.ok) expect(notEdit.errors[0]!.message).toMatch(/not an edit point/);
		const noEdge = h.tx([{ type: 'transition.add', clipId: c, effectId: 'jasper.smooth-slide' }]);
		expect(noEdge.ok).toBe(false);
		const audio = h.tx([
			{ type: 'transition.add', clipId: c, edge: 'in', effectId: 'jasper.constant-power' },
		]);
		expect(audio.ok).toBe(false);
		if (!audio.ok) expect(audio.errors[0]!.code).toBe('E_TRACK_KIND');
		const track = h.seq.videoTracks[1]!.id;
		h.ok([{ type: 'track.update', trackId: track, patch: { locked: true } }]);
		const locked = h.tx([slide(c, 'in')]);
		expect(locked.ok).toBe(false);
	});
});
