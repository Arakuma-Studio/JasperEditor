// Two-sided audio crossfades (S10:TUI-052): transition.add / applyDefault on audio edit points, their
// resolution into handles + gain ramps, the snapshot fields and the gain law of the two curves.
import { describe, expect, it } from 'vitest';
import {
	audioFadeGain,
	buildRenderSnapshot,
	checkInvariants,
	type MediaHandle,
	type RenderAudioFade,
	resolveAudioFades,
	resolveAudioTransitions,
	type Transition,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const HANDLE: MediaHandle = {
	url: '/m',
	proxyUrl: null,
	kind: 'audio',
	width: null,
	height: null,
	durationFlicks: null,
	hasAudio: true,
	rotation: 0,
};
const snapshotOf = (h: Harness, range?: { start: number; end: number }) =>
	buildRenderSnapshot(h.doc, h.seqId, {
		...(range ? { range } : {}),
		resolveMedia: () => HANDLE,
		resolveFont: () => null,
	});
const transitions = (h: Harness) => Object.values(h.seq.transitions) as Transition[];

/**
 * Two audio clips on A1 cut at frame 100 (10 s = 300 frames of media each): A = media `aIn`…`aIn + 100`,
 * B = media `bIn`…`bIn + 100`. Handles: A's tail = 200 − aIn, B's head = bIn.
 */
function twoAudioClips(aIn = 30, bIn = 60) {
	const h = new Harness();
	const a = h.registerVideo({ kind: 'audio' });
	const b = h.registerVideo({ kind: 'audio' });
	const r = h.ok([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 0,
			sourceRange: { in: { sourceFrames: aIn }, out: { sourceFrames: aIn + 100 } },
			ref: '$a',
		},
		{
			type: 'clip.place',
			source: { mediaId: b },
			at: 100,
			sourceRange: { in: { sourceFrames: bIn }, out: { sourceFrames: bIn + 100 } },
			ref: '$b',
		},
	]);
	const trackId = h.seq.audioTracks[0]!.id;
	expect(h.spans('A1')).toEqual([
		[0, 100],
		[100, 200],
	]);
	return { h, a: r.refs.$a!, b: r.refs.$b!, trackId };
}

describe('transition.add on an audio edit point (S10:TUI-052)', () => {
	const cases: {
		alignment: Transition['alignment'];
		span: [number, number];
		head: number;
		tail: number;
	}[] = [
		{ alignment: 'center', span: [90, 110], head: 10, tail: 10 },
		{ alignment: 'start-at-cut', span: [100, 120], head: 0, tail: 20 },
		{ alignment: 'end-at-cut', span: [80, 100], head: 20, tail: 0 },
	];
	for (const c of cases) {
		it(`creates a two-sided ${c.alignment} crossfade with handles and ramps over [${c.span}]`, () => {
			const { h, a, b, trackId } = twoAudioClips();
			const r = h.ok([
				{
					type: 'transition.add',
					trackId,
					at: 100,
					effectId: 'jasper.constant-power',
					duration: 20,
					alignment: c.alignment,
				},
			]);
			expect(r.results[0]).toMatchObject({
				duration: 20,
				alignment: c.alignment,
				outgoingClipId: a,
				incomingClipId: b,
			});
			expect(r.warnings).toEqual([]);
			expect(checkInvariants(h.doc)).toEqual([]);

			const res = resolveAudioTransitions(h.doc, h.seq);
			const fade = (type: 'in' | 'out'): RenderAudioFade => ({
				type,
				start: c.span[0],
				frames: 20,
				curve: 'equal-power',
			});
			expect(res.clips.get(a)).toEqual({ headHandle: 0, tailHandle: c.tail, fades: [fade('out')] });
			expect(res.clips.get(b)).toEqual({ headHandle: c.head, tailHandle: 0, fades: [fade('in')] });
			expect(res.skipped).toEqual([]);
			expect(resolveAudioFades(h.seq, h.doc).get(b)).toEqual([fade('in')]);

			const snap = snapshotOf(h);
			const [sa, sb] = snap.audioClips;
			expect(sa).toMatchObject({ clipId: a, fades: [fade('out')] });
			expect(sb).toMatchObject({ clipId: b, fades: [fade('in')] });
			expect(sa!.headHandle).toBeUndefined();
			expect(sa!.tailHandle).toBe(c.tail || undefined);
			expect(sb!.headHandle).toBe(c.head || undefined);
			expect(sb!.tailHandle).toBeUndefined();
		});
	}

	it('shortens a crossfade to the media handles (W_TRANSITION_SHORTENED) and refuses one without room', () => {
		// A's media ends 4 frames after its out-point; B's starts 30 frames before its in-point.
		const { h, trackId } = twoAudioClips(196, 30);
		const add = (alignment: Transition['alignment'], duration = 20) =>
			h.tx([
				{
					type: 'transition.add',
					trackId,
					at: 100,
					effectId: 'jasper.constant-gain',
					duration,
					alignment,
				},
			]);
		const centred = add('center');
		expect(centred.ok).toBe(true);
		if (centred.ok) {
			expect(centred.results[0]).toMatchObject({ duration: 8 }); // 4 before the cut, 4 after
			expect(centred.warnings.map((w) => w.code)).toEqual(['W_TRANSITION_SHORTENED']);
		}
		expect(add('end-at-cut').ok).toBe(true); // only needs B's head
		expect(transitions(h)).toHaveLength(1); // the new one replaced the centred one
		const noTail = twoAudioClips(200, 30);
		const refused = noTail.h.tx([
			{
				type: 'transition.add',
				trackId: noTail.trackId,
				at: 100,
				effectId: 'jasper.constant-power',
				duration: 20,
				alignment: 'start-at-cut',
			},
		]);
		expect(refused.ok === false && refused.errors[0]!.code).toBe('E_OUT_OF_MEDIA');
	});

	it('keeps clipId + edge on an audio clip a one-sided fade, also where another clip touches it', () => {
		const { h, a, b } = twoAudioClips();
		const r = h.ok([
			{ type: 'transition.add', clipId: b, edge: 'in', effectId: 'jasper.constant-power', duration: 10 },
		]);
		expect(r.results[0]).toMatchObject({
			outgoingClipId: null,
			incomingClipId: b,
			alignment: 'start-at-cut',
		});
		expect(resolveAudioTransitions(h.doc, h.seq).clips.get(b)).toEqual({
			headHandle: 0,
			tailHandle: 0,
			fades: [{ type: 'in', start: 100, frames: 10, curve: 'equal-power' }],
		});
		expect(resolveAudioTransitions(h.doc, h.seq).clips.has(a)).toBe(false);
	});

	it('degrades at render time when the clips are trimmed after the crossfade was added', () => {
		const { h, a, b, trackId } = twoAudioClips();
		h.ok([{ type: 'transition.add', trackId, at: 100, effectId: 'jasper.constant-power', duration: 20 }]);
		// Move B's in-point to its media start: no head handle left, the centred span shrinks to 1 frame.
		const t = transitions(h)[0]!;
		const bClip = h.seq.clips[b]!;
		h.doc = {
			...h.doc,
			sequences: {
				...h.doc.sequences,
				[h.seqId]: { ...h.seq, clips: { ...h.seq.clips, [b]: { ...bClip, sourceIn: 0 } } },
			},
		};
		const res = resolveAudioTransitions(h.doc, h.seq);
		expect(res.clips.get(a)).toEqual({
			headHandle: 0,
			tailHandle: 1,
			fades: [{ type: 'out', start: 100, frames: 1, curve: 'equal-power' }],
		});
		expect(res.clips.get(b)!.headHandle).toBe(0);
		expect(t.duration).toBe(20);
	});
});

describe('transition.applyDefault with media [audio] (S10:TUI-052)', () => {
	it('creates a centred crossfade where two audio clips meet and fades at the free edges', () => {
		const { h, a, b } = twoAudioClips();
		const r = h.ok([{ type: 'transition.applyDefault', clipIds: [a, b], edges: 'both', media: ['audio'] }]);
		expect((r.results[0] as { transitionIds: string[] }).transitionIds).toHaveLength(3);
		const two = transitions(h).filter((t) => t.outgoingClipId && t.incomingClipId);
		expect(two).toEqual([
			expect.objectContaining({
				effectId: 'jasper.constant-power',
				outgoingClipId: a,
				incomingClipId: b,
				alignment: 'center',
				duration: 30,
			}),
		]);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('skips an audio edit point without handles (no fall back to fades there)', () => {
		const { h, a, b } = twoAudioClips(200, 0);
		const r = h.ok([{ type: 'transition.applyDefault', clipIds: [a, b], edges: 'both', media: ['audio'] }]);
		expect((r.results[0] as { transitionIds: string[] }).transitionIds).toHaveLength(2);
		expect(transitions(h).map((t) => [t.outgoingClipId, t.incomingClipId])).toEqual([
			[null, a],
			[b, null],
		]);
	});
});

describe('snapshot of an audio crossfade', () => {
	it('includes a clip whose handle reaches into the range, and warns about crossfades without room', () => {
		const { h, a, b, trackId } = twoAudioClips();
		h.ok([
			{
				type: 'transition.add',
				trackId,
				at: 100,
				effectId: 'jasper.constant-power',
				duration: 20,
				alignment: 'center',
			},
		]);
		// [105, 150): A ends at 100 but plays its tail handle up to 110.
		expect(snapshotOf(h, { start: 105, end: 150 }).audioClips.map((c) => c.clipId)).toEqual([a, b]);
		expect(snapshotOf(h, { start: 110, end: 150 }).audioClips.map((c) => c.clipId)).toEqual([b]);
		// [50, 92): B starts at 100 but plays from 90.
		expect(snapshotOf(h, { start: 50, end: 92 }).audioClips.map((c) => c.clipId)).toEqual([a, b]);
		expect(snapshotOf(h, { start: 50, end: 90 }).audioClips.map((c) => c.clipId)).toEqual([a]);

		const bClip = h.seq.clips[b]!;
		const aClip = h.seq.clips[a]!;
		h.doc = {
			...h.doc,
			sequences: {
				...h.doc.sequences,
				[h.seqId]: {
					...h.seq,
					clips: {
						...h.seq.clips,
						[a]: { ...aClip, sourceIn: 4_704_000_000 },
						[b]: { ...bClip, sourceIn: 0 },
					},
				},
			},
		};
		const snap = snapshotOf(h);
		expect(snap.warnings).toEqual([
			expect.objectContaining({ code: 'TRANSITION_SKIPPED', clipId: transitions(h)[0]!.id }),
		]);
		expect(snap.audioClips.every((c) => !c.fades && !c.headHandle && !c.tailHandle)).toBe(true);
	});
});

describe('gain law of the crossfade curves', () => {
	const span = { start: 90, frames: 20 };
	const out = (curve: RenderAudioFade['curve']): RenderAudioFade[] => [{ type: 'out', ...span, curve }];
	const inc = (curve: RenderAudioFade['curve']): RenderAudioFade[] => [{ type: 'in', ...span, curve }];
	const frames = Array.from({ length: 401 }, (_, i) => 85 + i * 0.075); // 85…115, fractional too

	it('constant power: outgoing² + incoming² = 1 (within 0.5 dB) across the span', () => {
		for (const f of frames) {
			const p = audioFadeGain(out('equal-power'), f) ** 2 + audioFadeGain(inc('equal-power'), f) ** 2;
			expect(Math.abs(10 * Math.log10(p))).toBeLessThan(0.5);
			expect(p).toBeCloseTo(1, 12);
		}
		expect(audioFadeGain(out('equal-power'), 100)).toBeCloseTo(Math.SQRT1_2, 12);
		expect(audioFadeGain(inc('equal-power'), 100)).toBeCloseTo(Math.SQRT1_2, 12);
	});

	it('constant gain: outgoing + incoming = 1 across the span', () => {
		for (const f of frames) {
			const s = audioFadeGain(out('linear'), f) + audioFadeGain(inc('linear'), f);
			expect(s).toBeCloseTo(1, 12);
		}
		expect(audioFadeGain(out('linear'), 95)).toBeCloseTo(0.75, 12);
		expect(audioFadeGain(inc('linear'), 95)).toBeCloseTo(0.25, 12);
	});
});
