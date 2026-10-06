// Transitions and fades (S01 §13): handlers, handle math and their resolution for rendering.
import { describe, expect, it } from 'vitest';
import {
	audioFadeGain,
	buildRenderSnapshot,
	checkInvariants,
	clipHandles,
	fadeFactor,
	fitTransitionDuration,
	type MediaHandle,
	resolveVideoTransitions,
	type Transition,
	transitionSpan,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const HANDLE: MediaHandle = {
	url: '/m',
	proxyUrl: null,
	kind: 'video',
	width: 1920,
	height: 1080,
	durationFlicks: null,
	hasAudio: false,
	rotation: 0,
};
const snapshotOf = (h: Harness, range?: { start: number; end: number }) =>
	buildRenderSnapshot(h.doc, h.seqId, {
		...(range ? { range } : {}),
		resolveMedia: () => HANDLE,
		resolveFont: () => null,
	});

/** Two 10 s clips (300 frames of media each) cut at frame 100: A = media 30…130, B = media 60…160. */
function twoClips() {
	const h = new Harness();
	const a = h.registerVideo({ audio: false });
	const b = h.registerVideo({ audio: false });
	const r = h.ok([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 0,
			sourceRange: { in: { sourceFrames: 30 }, out: { sourceFrames: 130 } },
			ref: '$a',
		},
		{
			type: 'clip.place',
			source: { mediaId: b },
			at: 100,
			sourceRange: { in: { sourceFrames: 60 }, out: { sourceFrames: 160 } },
			ref: '$b',
		},
	]);
	return { h, a: r.refs.$a!, b: r.refs.$b! };
}
const transitions = (h: Harness) => Object.values(h.seq.transitions) as Transition[];

describe('transition geometry (S01:TRN-003)', () => {
	it('centres a transition with the extra frame after the cut', () => {
		expect(transitionSpan(100, 12, 'center')).toEqual({ start: 94, end: 106 });
		expect(transitionSpan(100, 13, 'center')).toEqual({ start: 94, end: 107 }); // ceil after, floor before
		expect(transitionSpan(100, 12, 'start-at-cut')).toEqual({ start: 100, end: 112 });
		expect(transitionSpan(100, 12, 'end-at-cut')).toEqual({ start: 88, end: 100 });
	});

	it('fits the duration into the clips and their media handles', () => {
		const fit = (o: Partial<Parameters<typeof fitTransitionDuration>[0]>) =>
			fitTransitionDuration({
				effectId: 'jasper.cross-dissolve',
				wanted: 20,
				alignment: 'center',
				outgoing: { duration: 100, tail: 100 },
				incoming: { duration: 100, head: 100 },
				...o,
			});
		expect(fit({})).toBe(20);
		expect(fit({ outgoing: { duration: 100, tail: 4 } })).toBe(8); // 4 after the cut, 4 before
		expect(fit({ incoming: { duration: 100, head: 0 } })).toBe(1); // a 1-frame span lies after the cut
		expect(fit({ incoming: { duration: 100, head: 0 }, alignment: 'start-at-cut' })).toBe(20);
		expect(fit({ outgoing: { duration: 100, tail: 0 }, alignment: 'start-at-cut' })).toBe(0);
		expect(fit({ outgoing: { duration: 100, tail: 0 }, alignment: 'end-at-cut' })).toBe(20);
		expect(fit({ outgoing: { duration: 12, tail: 100 } })).toBe(12); // never longer than a clip (INV-010)
		// A centred dip to black needs no handles: each clip fades on its own frames.
		expect(
			fit({
				effectId: 'jasper.dip-to-black',
				outgoing: { duration: 100, tail: 0 },
				incoming: { duration: 100, head: 0 },
			}),
		).toBe(20);
		expect(fit({ outgoing: null, incoming: { duration: 8, head: 0 } })).toBe(8); // a fade
	});
});

describe('transition.add / update / remove', () => {
	it('adds a centred cross dissolve at a cut, addressed by clip edge or by track + frame', () => {
		const { h, a, b } = twoClips();
		const r = h.ok([
			{
				type: 'transition.add',
				clipId: b,
				edge: 'in',
				effectId: 'jasper.cross-dissolve',
				duration: 12,
				ref: '$t',
			},
		]);
		expect(r.results[0]).toMatchObject({
			duration: 12,
			alignment: 'center',
			outgoingClipId: a,
			incomingClipId: b,
		});
		expect(r.warnings).toEqual([]);
		expect(transitions(h)).toHaveLength(1);
		expect(transitions(h)[0]).toMatchObject({
			id: r.refs.$t,
			effectId: 'jasper.cross-dissolve',
			effectVersion: 1,
			duration: 12,
			alignment: 'center',
			params: {},
		});
		expect(checkInvariants(h.doc)).toEqual([]);
		// The same edit point by track + frame replaces it (one transition per clip edge, INV-010).
		const r2 = h.ok([
			{ type: 'transition.add', trackId: 'V1', at: 100, effectId: 'jasper.dip-to-black', duration: 20 },
		]);
		expect(r2.results[0]).toMatchObject({ duration: 20, outgoingClipId: a, incomingClipId: b });
		expect(transitions(h)).toHaveLength(1);
		expect(transitions(h)[0]!.effectId).toBe('jasper.dip-to-black');
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('shortens to the media handles with a warning and refuses when nothing fits', () => {
		const h = new Harness();
		const a = h.registerVideo({ seconds: 4, audio: false }); // 120 frames
		const b = h.registerVideo({ seconds: 4, audio: false });
		const p = h.ok([
			// A uses media 0…115 (5 frames of tail handle), B uses media 3…120 (3 frames of head handle).
			{
				type: 'clip.place',
				source: { mediaId: a },
				at: 0,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 115 } },
				ref: '$a',
			},
			{
				type: 'clip.place',
				source: { mediaId: b },
				at: 115,
				sourceRange: { in: { sourceFrames: 3 }, out: { sourceFrames: 120 } },
				ref: '$b',
			},
		]);
		expect(clipHandles(h.doc, h.seq, h.seq.clips[p.refs.$a!]!)).toEqual({ head: 0, tail: 5 });
		expect(clipHandles(h.doc, h.seq, h.seq.clips[p.refs.$b!]!)).toEqual({ head: 3, tail: 0 });
		const r = h.ok([
			{
				type: 'transition.add',
				clipId: p.refs.$b,
				edge: 'in',
				effectId: 'jasper.cross-dissolve',
				duration: 30,
			},
		]);
		// centre: floor(d/2) ≤ 3 before the cut and ceil(d/2) ≤ 5 after it → d = 7
		expect(r.results[0]).toMatchObject({ duration: 7 });
		expect(r.warnings.map((w) => w.code)).toEqual(['W_TRANSITION_SHORTENED']);
		const frozen = h.tx([
			{
				type: 'transition.add',
				clipId: p.refs.$b,
				edge: 'in',
				effectId: 'jasper.cross-dissolve',
				duration: 30,
				handles: 'freeze',
			},
		]);
		expect(frozen.ok).toBe(false);
		if (!frozen.ok) expect(frozen.errors[0]!.code).toBe('E_NOT_IMPLEMENTED');

		// Clips that use their whole media have no handles: a dissolve is refused with a way out…
		const h2 = new Harness();
		const m = h2.registerVideo({ seconds: 2, audio: false });
		const q = h2.ok([
			{ type: 'clip.place', source: { mediaId: m }, at: 0, ref: '$a' },
			{ type: 'clip.place', source: { mediaId: m }, at: 60, ref: '$b' },
		]);
		const none = h2.tx([
			{
				type: 'transition.add',
				clipId: q.refs.$b,
				edge: 'in',
				effectId: 'jasper.cross-dissolve',
				duration: 12,
			},
		]);
		expect(none.ok).toBe(false);
		if (!none.ok) {
			expect(none.errors[0]!.code).toBe('E_OUT_OF_MEDIA');
		}
		// …while a dip to black (each clip fades on its own frames) fits.
		expect(
			h2.ok([
				{
					type: 'transition.add',
					clipId: q.refs.$b,
					edge: 'in',
					effectId: 'jasper.dip-to-black',
					duration: 12,
				},
			]).results[0],
		).toMatchObject({ duration: 12 });
	});

	it('makes one-sided fades at free clip edges and audio fades on audio tracks', () => {
		const h = new Harness();
		const v = h.registerVideo({ audio: true });
		const p = h.ok([
			{
				type: 'clip.place',
				source: { mediaId: v },
				at: 10,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 90 } },
			},
		]);
		const [videoClip, audioClip] = (p.results[0] as { clipIds: string[] }).clipIds;
		const r = h.ok([
			{
				type: 'transition.add',
				clipId: videoClip,
				edge: 'in',
				effectId: 'jasper.dip-to-black',
				duration: 15,
			},
			{
				type: 'transition.add',
				clipId: videoClip,
				edge: 'out',
				effectId: 'jasper.cross-dissolve',
				duration: 20,
				alignment: 'center',
			},
			{
				type: 'transition.add',
				clipId: audioClip,
				edge: 'out',
				effectId: 'jasper.constant-power',
				duration: 30,
			},
		]);
		expect(r.results.map((x) => (x as { alignment: string }).alignment)).toEqual([
			'start-at-cut',
			'end-at-cut',
			'end-at-cut',
		]);
		expect(transitions(h).map((t) => [t.outgoingClipId, t.incomingClipId])).toEqual([
			[null, videoClip],
			[videoClip, null],
			[audioClip, null],
		]);
		expect(checkInvariants(h.doc)).toEqual([]);
		// Kind mismatch and unknown ids are refused.
		const wrong = h.tx([
			{ type: 'transition.add', clipId: audioClip, edge: 'in', effectId: 'jasper.cross-dissolve' },
		]);
		expect(wrong.ok === false && wrong.errors[0]!.code).toBe('E_TRACK_KIND');
		const unknown = h.tx([
			{ type: 'transition.add', clipId: videoClip, edge: 'in', effectId: 'jasper.not-a-transition' },
		]);
		expect(unknown.ok === false && unknown.errors[0]!.code).toBe('E_UNKNOWN_EFFECT');
		const nowhere = h.tx([
			{ type: 'transition.add', trackId: 'V1', at: 55, effectId: 'jasper.cross-dissolve' },
		]);
		expect(nowhere.ok === false && nowhere.errors[0]!.code).toBe('E_INVALID_PARAM');

		const snap = snapshotOf(h);
		expect(snap.audioClips[0]!.fades).toEqual([{ type: 'out', start: 70, frames: 30, curve: 'equal-power' }]);
		expect(audioFadeGain(snap.audioClips[0]!.fades, 70)).toBe(1);
		expect(audioFadeGain(snap.audioClips[0]!.fades, 85)).toBeCloseTo(Math.SQRT1_2, 12);
		expect(audioFadeGain(snap.audioClips[0]!.fades, 100)).toBeCloseTo(0, 12);
	});

	it('updates duration and alignment, removes, and applies the default transition', () => {
		const { h, a, b } = twoClips();
		const r = h.ok([
			{
				type: 'transition.add',
				clipId: a,
				edge: 'out',
				effectId: 'jasper.cross-dissolve',
				duration: 12,
				ref: '$t',
			},
		]);
		const id = r.refs.$t!;
		expect(
			h.ok([{ type: 'transition.update', transitionId: id, duration: 24, alignment: 'end-at-cut' }])
				.results[0],
		).toEqual({
			transitionId: id,
			effectId: 'jasper.cross-dissolve',
			duration: 24,
			alignment: 'end-at-cut',
		});
		// end-at-cut needs 24 frames before B's in-point (B has 60): fine; 80 does not fit.
		const long = h.ok([{ type: 'transition.update', transitionId: id, duration: 80 }]);
		expect(long.results[0]).toMatchObject({ duration: 60 });
		expect(long.warnings.map((w) => w.code)).toEqual(['W_TRANSITION_SHORTENED']);
		expect(h.ok([{ type: 'transition.remove', transitionIds: [id] }]).deleted).toContain(id);
		expect(transitions(h)).toEqual([]);
		const gone = h.tx([{ type: 'transition.remove', transitionIds: [id] }]);
		expect(gone.ok === false && gone.errors[0]!.code).toBe('E_NOT_FOUND');

		// Default transition: a cross dissolve of settings.defaultTransitionFrames at every edge of the clips.
		const d = h.ok([{ type: 'transition.applyDefault', clipIds: [a, b], edges: 'both' }]);
		expect((d.results[0] as { transitionIds: string[] }).transitionIds).toHaveLength(3); // head of A, the cut, tail of B
		expect(transitions(h).map((t) => t.duration)).toEqual([30, 30, 30]);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('follows its clips: removed when they are separated, moved to the right part by a split', () => {
		const { h, a, b } = twoClips();
		h.ok([
			{ type: 'transition.add', clipId: b, edge: 'in', effectId: 'jasper.cross-dissolve', duration: 12 },
		]);
		const moved = h.ok([{ type: 'clip.move', clipIds: [b], deltaFrames: 40 }]);
		expect(moved.warnings.map((w) => w.code)).toContain('W_TRANSITION_REMOVED');
		expect(transitions(h)).toEqual([]);
		h.ok([{ type: 'transition.add', clipId: a, edge: 'out', effectId: 'jasper.dip-to-black', duration: 10 }]);
		h.ok([{ type: 'clip.split', at: 50, clipIds: [a] }]);
		const right = h.clips('V1').find((c) => c.start === 50)!;
		expect(transitions(h)[0]!.outgoingClipId).toBe(right.id);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('transitions in the render snapshot', () => {
	it('gives a cross dissolve handles on both clips and a ramp on the incoming one', () => {
		const { h, a, b } = twoClips();
		h.ok([
			{ type: 'transition.add', clipId: b, edge: 'in', effectId: 'jasper.cross-dissolve', duration: 12 },
		]);
		const snap = snapshotOf(h);
		const [ca, cb] = snap.videoTracks[0]!.clips;
		expect(ca).toMatchObject({ clipId: a, start: 0, duration: 100, tailHandle: 6 });
		expect(ca!.headHandle).toBeUndefined();
		expect(ca!.fades).toBeUndefined(); // opaque footage stays opaque under the incoming clip
		expect(cb).toMatchObject({ clipId: b, start: 100, duration: 100, headHandle: 6 });
		const startMix = fadeFactor(cb!.fades, 94);
		const endMix = fadeFactor(cb!.fades, 105);
		expect(startMix).toBeGreaterThan(0);
		expect(endMix).toBeLessThan(1);
		expect(endMix).toBeGreaterThan(startMix);
		expect(fadeFactor(cb!.fades, 99) + fadeFactor(cb!.fades, 100)).toBeCloseTo(1, 12);
		expect(snap.videoTracks[0]!.mattes).toBeUndefined();
		// A range that starts inside the outgoing handle still includes the outgoing clip.
		expect(snapshotOf(h, { start: 103, end: 120 }).videoTracks[0]!.clips.map((c) => c.clipId)).toEqual([
			a,
			b,
		]);
		expect(snapshotOf(h, { start: 106, end: 120 }).videoTracks[0]!.clips.map((c) => c.clipId)).toEqual([b]);
	});

	it('gives a dip to black a matte and two ramps that meet on a black frame', () => {
		const { h, a, b } = twoClips();
		h.ok([{ type: 'transition.add', clipId: b, edge: 'in', effectId: 'jasper.dip-to-black', duration: 12 }]);
		const snap = snapshotOf(h);
		const [ca, cb] = snap.videoTracks[0]!.clips;
		expect(ca!.tailHandle).toBeUndefined();
		expect(cb!.headHandle).toBeUndefined();
		expect(snap.videoTracks[0]!.mattes).toEqual([
			{ id: expect.any(String), start: 94, duration: 12, color: [0, 0, 0, 1] },
		]);
		expect(fadeFactor(ca!.fades, 94)).toBeGreaterThan(0);
		expect(fadeFactor(ca!.fades, 99)).toBe(0); // the outgoing clip's last frame is black
		expect(fadeFactor(cb!.fades, 100)).toBeGreaterThan(0);
		expect(fadeFactor(cb!.fades, 105)).toBeGreaterThan(fadeFactor(cb!.fades, 100));
		expect([a, b]).toEqual([ca!.clipId, cb!.clipId]);
	});

	it('fades both clips when the outgoing one is not opaque, and clamps to the handles at render time', () => {
		const { h, a, b } = twoClips();
		h.ok([
			{ type: 'transition.add', clipId: b, edge: 'in', effectId: 'jasper.cross-dissolve', duration: 12 },
			{ type: 'param.set', target: ['clip', a, 'opacity'], value: 80 },
		]);
		const [ca] = snapshotOf(h).videoTracks[0]!.clips;
		expect(fadeFactor(ca!.fades, 94)).toBeGreaterThan(fadeFactor(ca!.fades, 105));

		// The media of B is relinked to a file that starts at B's in-point: no head handle is left.
		const { h: h2, b: b2 } = twoClips();
		h2.ok([
			{ type: 'transition.add', clipId: b2, edge: 'in', effectId: 'jasper.cross-dissolve', duration: 12 },
		]);
		const clip = h2.seq.clips[b2]!;
		const doc = {
			...h2.doc,
			sequences: { [h2.seqId]: { ...h2.seq, clips: { ...h2.seq.clips, [b2]: { ...clip, sourceIn: 0 } } } },
		};
		const resolved = resolveVideoTransitions(doc, doc.sequences[h2.seqId]!);
		// centre with no head handle: only the frame after the cut remains.
		expect(resolved.clips.get(b2)!.headHandle).toBe(0);
		expect([...resolved.clips.values()].find((c) => c.tailHandle > 0)!.tailHandle).toBe(1);
	});

	it('draws one-sided fades on the clip itself', () => {
		const { h, a, b } = twoClips();
		h.ok([
			{ type: 'transition.add', clipId: a, edge: 'in', effectId: 'jasper.dip-to-black', duration: 10 },
			{ type: 'transition.add', clipId: b, edge: 'out', effectId: 'jasper.cross-dissolve', duration: 10 },
		]);
		const snap = snapshotOf(h);
		const [ca, cb] = snap.videoTracks[0]!.clips;
		expect(fadeFactor(ca!.fades, 0)).toBe(0); // starts on black
		expect(fadeFactor(cb!.fades, 199)).toBe(0); // ends transparent
		expect(fadeFactor(cb!.fades, 190)).toBeGreaterThan(0);
		expect(snap.videoTracks[0]!.mattes).toEqual([
			{ id: expect.any(String), start: 0, duration: 10, color: [0, 0, 0, 1] },
		]);
	});
});
