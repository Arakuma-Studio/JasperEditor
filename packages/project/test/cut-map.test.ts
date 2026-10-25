// Cut map (spec 13 §2 SH-001; docs/wp-notes/auto-subtitles.md "Cut map"): every rule and edge case of
// `pictureCuts` on documents built through the real commands.
import { describe, expect, it } from 'vitest';
import {
	type Animatable,
	analyzePictureCuts,
	type Clip,
	CutMapError,
	clipConvexPolygon,
	contentTimeAt,
	evaluate,
	flicksPerFrame,
	type PictureCut,
	pictureCuts,
	type Rational,
	type Sequence,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const F = (h: Harness, seqId = h.seqId) =>
	flicksPerFrame(h.doc.sequences[seqId]!.settings.frameRate as Rational);

/** Places media frames `[from, to)` (at the sequence rate) at `at` on a video track; returns the video clip id. */
function put(
	h: Harness,
	mediaId: string,
	at: number,
	from: number,
	to: number,
	track = 'V1',
	seqId?: string,
) {
	const f = F(h, seqId ?? h.seqId);
	const r = h.ok([
		{
			type: 'clip.place',
			...(seqId ? { sequenceId: seqId } : {}),
			source: { mediaId },
			at,
			tracks: { video: track },
			sourceRange: { in: { flicks: from * f }, out: { flicks: to * f } },
		},
	]);
	return (r.results[0] as { clipIds: string[] }).clipIds[0]!;
}

function setup(preset?: string) {
	const h = new Harness(preset ? { preset } : {});
	const a = h.registerVideo({ seconds: 120, audio: false });
	const b = h.registerVideo({ seconds: 120, audio: false });
	const c = h.registerVideo({ seconds: 120, audio: false });
	return { h, a, b, c };
}

const brief = (cuts: PictureCut[]) => cuts.map((c) => [c.frame, c.kind]);
const cutsOf = (h: Harness, opts: Parameters<typeof pictureCuts>[2] = {}, seqId = h.seqId) =>
	pictureCuts(h.doc, seqId, opts);
const trackId = (h: Harness, label: string, seqId = h.seqId) => {
	const s = h.doc.sequences[seqId]!;
	const n = Number(label.slice(1)) - 1;
	return (label[0] === 'V' ? s.videoTracks : s.captionTracks)[n]!.id;
};

describe('pictureCuts: sources, gaps, through edits, jump cuts', () => {
	it('reports a cut between two sources with both clips', () => {
		const { h, a, b } = setup();
		const x = put(h, a, 0, 0, 90);
		const y = put(h, b, 90, 0, 90);
		expect(cutsOf(h)).toEqual([
			{ frame: 90, kind: 'cut', trackId: trackId(h, 'V1'), outgoingClipId: x, incomingClipId: y },
		]);
	});

	it('never reports frame 0 or the sequence end', () => {
		const { h, a } = setup();
		put(h, a, 0, 0, 90);
		expect(cutsOf(h)).toEqual([]);
	});

	it('reports cuts to and from black around a gap (one-sided)', () => {
		const { h, a, b } = setup();
		const x = put(h, a, 0, 0, 60);
		const y = put(h, b, 90, 0, 60);
		const cuts = cutsOf(h);
		expect(cuts).toEqual([
			{ frame: 60, kind: 'cut', trackId: trackId(h, 'V1'), outgoingClipId: x },
			{ frame: 90, kind: 'cut', trackId: trackId(h, 'V1'), incomingClipId: y },
		]);
	});

	it('excludes through edits (Add Edit) and reports jump cuts of one source', () => {
		const { h, a } = setup();
		const x = put(h, a, 0, 0, 120);
		h.ok([{ type: 'clip.split', at: 50, clipIds: [x] }]);
		expect(cutsOf(h)).toEqual([]);
		// Same source, 30 source frames skipped at the cut: a jump cut.
		put(h, a, 120, 150, 200);
		expect(brief(cutsOf(h))).toEqual([[120, 'jump']]);
		expect(cutsOf(h, { includeJumpCuts: false })).toEqual([]);
	});

	it('treats a speed change with continuous content as no cut', () => {
		const { h, a } = setup();
		const x = put(h, a, 0, 0, 60);
		h.ok([{ type: 'clip.split', at: 30, clipIds: [x] }]);
		const right = Object.values(h.seq.clips).find((c) => c.start === 30)!;
		h.ok([{ type: 'clip.setSpeed', clipIds: [right.id], rate: 2, ripple: false }]);
		expect(cutsOf(h)).toEqual([]);
	});

	it('cut on a clip’s first and last frame: range bounds are [start, end)', () => {
		const { h, a, b } = setup();
		put(h, a, 0, 0, 90);
		put(h, b, 90, 0, 90);
		expect(brief(cutsOf(h, { range: { start: 90, end: 91 } }))).toEqual([[90, 'cut']]);
		expect(cutsOf(h, { range: { start: 91, end: 180 } })).toEqual([]);
		expect(cutsOf(h, { range: { start: 0, end: 90 } })).toEqual([]);
		expect(cutsOf(h, { range: { start: 89, end: 89 } })).toEqual([]);
		// One-frame clips: a cut on each side.
		put(h, a, 180, 300, 301);
		put(h, b, 181, 300, 400);
		expect(brief(cutsOf(h))).toEqual([
			[90, 'cut'],
			[180, 'cut'],
			[181, 'cut'],
		]);
	});
});

describe('pictureCuts: tracks, kinds and visibility', () => {
	it('a full-frame clip on an upper track cuts in and out; hidden tracks and disabled clips do not', () => {
		const { h, a, b } = setup();
		const x = put(h, a, 0, 0, 300);
		const y = put(h, b, 100, 0, 50, 'V2');
		expect(cutsOf(h)).toEqual([
			{ frame: 100, kind: 'cut', trackId: trackId(h, 'V2'), outgoingClipId: x, incomingClipId: y },
			{ frame: 150, kind: 'cut', trackId: trackId(h, 'V1'), outgoingClipId: y, incomingClipId: x },
		]);
		h.ok([{ type: 'clip.update', clipId: y, patch: { enabled: false } }]);
		expect(cutsOf(h)).toEqual([]);
		h.ok([{ type: 'clip.update', clipId: y, patch: { enabled: true } }]);
		h.ok([{ type: 'track.update', trackId: 'V2', patch: { output: false } }]);
		expect(cutsOf(h)).toEqual([]);
	});

	it('ignores text, shape, adjustment and caption clips', () => {
		const { h, a } = setup();
		put(h, a, 0, 0, 300);
		h.ok([
			{ type: 'clip.addText', at: 20, duration: 50, track: 'V2', content: { text: 'Title' } },
			{
				type: 'clip.addShape',
				at: 40,
				duration: 50,
				track: 'V3',
				shape: { type: 'rect', size: [1920, 1080], fill: [1, 0, 0, 1] },
			},
			{ type: 'track.add', kind: 'video', count: 1 },
		]);
		h.ok([{ type: 'clip.addAdjustment', at: 60, duration: 50, track: 'V4' }]);
		h.ok([{ type: 'caption.add', at: 10, duration: 30, text: 'Hello' }]);
		expect(cutsOf(h)).toEqual([]);
	});

	it('ignores Transparent Video and treats a solid as a picture', () => {
		const { h, a } = setup();
		put(h, a, 0, 0, 300);
		const t = h.ok([{ type: 'synthetic.create', kind: 'transparent', ref: '$t' }]).refs.$t!;
		h.ok([{ type: 'clip.place', source: { syntheticId: t }, at: 50, tracks: { video: 'V2' } }]);
		expect(cutsOf(h)).toEqual([]);
		h.ok([{ type: 'clip.addSolid', at: 200, duration: 30, track: 'V3', color: [0, 0, 0, 1] }]);
		expect(brief(cutsOf(h))).toEqual([
			[200, 'cut'],
			[230, 'cut'],
		]);
	});

	it('outputTrackId keeps only the tracks below it; trackIds restricts further', () => {
		const { h, a, b, c } = setup();
		put(h, a, 0, 0, 300);
		put(h, b, 50, 0, 50, 'V2');
		put(h, c, 200, 0, 50, 'V3');
		expect(brief(cutsOf(h))).toEqual([
			[50, 'cut'],
			[100, 'cut'],
			[200, 'cut'],
			[250, 'cut'],
		]);
		expect(brief(cutsOf(h, { outputTrackId: trackId(h, 'V3') }))).toEqual([
			[50, 'cut'],
			[100, 'cut'],
		]);
		expect(brief(cutsOf(h, { trackIds: [trackId(h, 'V1'), trackId(h, 'V3')] }))).toEqual([
			[200, 'cut'],
			[250, 'cut'],
		]);
		h.ok([{ type: 'caption.addTrack' }]);
		expect(cutsOf(h, { outputTrackId: trackId(h, 'C1') })).toHaveLength(4);
	});

	it('refuses a missing sequence, unknown tracks, audio output tracks and bad options', () => {
		const { h, a } = setup();
		put(h, a, 0, 0, 30);
		const code = (fn: () => unknown) => {
			try {
				fn();
			} catch (e) {
				expect(e).toBeInstanceOf(CutMapError);
				return (e as CutMapError).code;
			}
			return null;
		};
		expect(code(() => pictureCuts(h.doc, 'nope'))).toBe('E_NOT_FOUND');
		expect(code(() => cutsOf(h, { outputTrackId: 'nope' }))).toBe('E_NOT_FOUND');
		expect(code(() => cutsOf(h, { outputTrackId: h.seq.audioTracks[0]!.id }))).toBe('E_INVALID_PARAM');
		expect(code(() => cutsOf(h, { trackIds: [h.seq.audioTracks[0]!.id] }))).toBe('E_INVALID_PARAM');
		expect(code(() => cutsOf(h, { overlayCoverage: 0 }))).toBe('E_INVALID_PARAM');
		expect(code(() => cutsOf(h, { range: { start: 10, end: 5 } }))).toBe('E_INVALID_PARAM');
		expect(code(() => cutsOf(h, { bogus: true } as never))).toBe('E_INVALID_PARAM');
	});
});

describe('pictureCuts: overlays and coverage', () => {
	const scaled = (h: Harness, clipId: string, scale: number) =>
		h.ok([{ type: 'param.set', target: ['clip', clipId, 'transform', 'scale'], value: scale }]);

	it('an overlay at or above the coverage threshold comes and goes; below it, nothing', () => {
		const { h, a, b } = setup();
		put(h, a, 0, 0, 300);
		const pip = put(h, b, 100, 0, 60, 'V2');
		scaled(h, pip, 75); // 56.25 % of the frame
		expect(cutsOf(h)).toEqual([
			{ frame: 100, kind: 'overlay', trackId: trackId(h, 'V2'), incomingClipId: pip },
			{ frame: 160, kind: 'overlay', trackId: trackId(h, 'V2'), outgoingClipId: pip },
		]);
		expect(cutsOf(h, { includeOverlays: false })).toEqual([]);
		scaled(h, pip, 60); // 36 %
		expect(cutsOf(h)).toEqual([]);
		expect(brief(cutsOf(h, { overlayCoverage: 0.3 }))).toEqual([
			[100, 'overlay'],
			[160, 'overlay'],
		]);
	});

	it('a cut under an overlay is still a cut; one entry per frame', () => {
		const { h, a, b, c } = setup();
		put(h, a, 0, 0, 120);
		const y = put(h, b, 120, 0, 180);
		const pip = put(h, c, 60, 0, 120, 'V2');
		scaled(h, pip, 80);
		const cuts = cutsOf(h);
		expect(brief(cuts)).toEqual([
			[60, 'overlay'],
			[120, 'cut'],
			[180, 'overlay'],
		]);
		expect(cuts[1]!.incomingClipId).toBe(y);
		// The overlay and the base change at the same frame: the cut wins.
		const pip2 = put(h, c, 120, 500, 560, 'V3');
		scaled(h, pip2, 80);
		expect(brief(cutsOf(h).filter((x) => x.frame === 120))).toEqual([[120, 'cut']]);
	});

	it('coverage follows Crop and position (off-frame parts do not count)', () => {
		const { h, a, b } = setup();
		put(h, a, 0, 0, 300);
		const y = put(h, b, 100, 0, 60, 'V2');
		h.ok([{ type: 'effect.add', target: { clipId: y }, effectId: 'jasper.crop', params: { left: 60 } }]);
		expect(cutsOf(h)).toEqual([]); // 40 % visible
		const z = put(h, b, 200, 0, 60, 'V3');
		h.ok([{ type: 'effect.add', target: { clipId: z }, effectId: 'jasper.crop', params: { left: 40 } }]);
		expect(brief(cutsOf(h))).toEqual([
			[200, 'overlay'],
			[260, 'overlay'],
		]); // 60 %, so not full: an overlay
		// Moved 70 % off the right edge: 30 % on screen.
		h.ok([
			{
				type: 'effect.remove',
				effectInstanceId: (h.seq.clips[z] as { effects: { id: string }[] }).effects[0]!.id,
			},
		]);
		h.ok([
			{ type: 'param.set', target: ['clip', z, 'transform', 'position'], value: [960 + 1920 * 0.7, 540] },
		]);
		expect(cutsOf(h)).toEqual([]);
	});

	it('a translucent or blended full-frame clip is an overlay, not a cut', () => {
		const { h, a, b } = setup();
		put(h, a, 0, 0, 300);
		const y = put(h, b, 100, 0, 60, 'V2');
		h.ok([{ type: 'param.set', target: ['clip', y, 'opacity'], value: 50 }]);
		expect(brief(cutsOf(h))).toEqual([
			[100, 'overlay'],
			[160, 'overlay'],
		]);
		h.ok([
			{ type: 'param.set', target: ['clip', y, 'opacity'], value: 100 },
			{ type: 'param.set', target: ['clip', y, 'blendMode'], value: 'screen' },
		]);
		expect(brief(cutsOf(h))).toEqual([
			[100, 'overlay'],
			[160, 'overlay'],
		]);
		h.ok([{ type: 'param.set', target: ['clip', y, 'blendMode'], value: 'normal' }]);
		expect(brief(cutsOf(h))).toEqual([
			[100, 'cut'],
			[160, 'cut'],
		]);
	});

	it('a scaled-down main picture with nothing below stays the base (its cuts are cuts)', () => {
		const { h, a, b } = setup();
		const x = put(h, a, 0, 0, 90);
		const y = put(h, b, 90, 0, 90);
		scaled(h, x, 90);
		scaled(h, y, 90);
		expect(brief(cutsOf(h))).toEqual([[90, 'cut']]);
	});

	it('an animated overlay is detected on the exact frame it crosses the threshold', () => {
		const { h, a, b } = setup();
		put(h, a, 0, 0, 300);
		const pip = put(h, b, 100, 0, 100, 'V2');
		h.ok([
			{
				type: 'param.setAnimated',
				target: ['clip', pip, 'transform', 'scale'],
				animated: true,
				at: { sequenceFrame: 100 },
			},
			{
				type: 'param.set',
				target: ['clip', pip, 'transform', 'scale'],
				value: 0,
				at: { sequenceFrame: 100 },
			},
			{
				type: 'param.set',
				target: ['clip', pip, 'transform', 'scale'],
				value: 100,
				at: { sequenceFrame: 160 },
			},
		]);
		const kf = (h.seq.clips[pip] as { transform: { scale: { keyframes: { interpolation: string }[] } } })
			.transform.scale.keyframes;
		expect(kf).toHaveLength(2);
		const cuts = cutsOf(h);
		// Linear 0 → 100 % over 60 frames: (s/100)² ≥ 0.5 from s ≥ 70.71 %, frame 100 + ⌈42.43⌉ (when linear).
		const first = cuts[0]!;
		expect(first.kind).toBe('overlay');
		expect(first.incomingClipId).toBe(pip);
		// Oracle: the first frame whose evaluated scale covers half the frame ((s/100)² ≥ 0.5).
		const clip = h.seq.clips[pip]!;
		const rate = h.seq.settings.frameRate as Rational;
		let expected = -1;
		for (let f = clip.start; f < clip.start + clip.duration && expected < 0; f++) {
			const sc = evaluate(
				(clip as { transform: { scale: Animatable<number> } }).transform.scale,
				contentTimeAt(clip, f, rate),
			);
			if ((sc / 100) ** 2 >= 0.5) expected = f;
		}
		expect(expected).toBeGreaterThan(100);
		expect(first.frame).toBe(expected);
		// Full and opaque at 160: the base moves to the overlay (it was visible already) → overlay, then it ends.
		expect(brief(cuts.slice(1))).toEqual([
			[160, 'overlay'],
			[200, 'cut'],
		]);
	});
});

describe('pictureCuts: animated pictures', () => {
	it('a keyframed punch-in that stays full-frame is no cut; a fade-out to nothing is no cut', () => {
		const { h, a, b } = setup();
		const x = put(h, a, 0, 0, 90);
		put(h, b, 90, 0, 90);
		h.ok([
			{ type: 'param.setAnimated', target: ['clip', x, 'transform', 'scale'], animated: true, at: { frames: 0 } },
			{ type: 'param.set', target: ['clip', x, 'transform', 'scale'], value: 100, at: { frames: 0 } },
			{ type: 'param.set', target: ['clip', x, 'transform', 'scale'], value: 130, at: { frames: 89 } },
		]);
		expect(brief(cutsOf(h))).toEqual([[90, 'cut']]);
		const y = put(h, b, 300, 0, 60);
		h.ok([
			{ type: 'param.setAnimated', target: ['clip', y, 'opacity'], animated: true, at: { frames: 30 } },
			{ type: 'param.set', target: ['clip', y, 'opacity'], value: 100, at: { frames: 30 } },
			{ type: 'param.set', target: ['clip', y, 'opacity'], value: 0, at: { frames: 59 } },
			{ type: 'clip.addSolid', at: 400, duration: 10, track: 'V1', color: [0, 0, 0, 1] },
		]);
		// To black at 180, from black at 300 and 400; the fade reaches 0 on y's last frame (359): no cut at 359 or 360.
		expect(brief(cutsOf(h))).toEqual([
			[90, 'cut'],
			[180, 'cut'],
			[300, 'cut'],
			[400, 'cut'],
		]);
	});
});

describe('pictureCuts: transitions', () => {
	it('a two-sided transition contributes its edit point and its span as a cut zone', () => {
		const { h, a, b } = setup();
		const x = put(h, a, 0, 100, 190);
		const y = put(h, b, 90, 100, 190);
		const r = h.ok([
			{
				type: 'transition.add',
				clipId: y,
				edge: 'in',
				effectId: 'jasper.cross-dissolve',
				duration: 10,
				ref: '$t',
			},
		]);
		const tid = r.refs.$t ?? Object.keys(h.seq.transitions)[0]!;
		expect(cutsOf(h)).toEqual([
			{
				frame: 90,
				kind: 'cut',
				trackId: trackId(h, 'V1'),
				outgoingClipId: x,
				incomingClipId: y,
				transitionId: tid,
				zone: { start: 85, end: 95 },
			},
		]);
	});

	it('overlapping transition spans each keep their own zone', () => {
		const { h, a, b, c } = setup();
		put(h, a, 0, 100, 160);
		const y = put(h, b, 60, 100, 108);
		const z = put(h, c, 68, 100, 160);
		h.ok([
			{
				type: 'transition.add',
				clipId: y,
				edge: 'in',
				effectId: 'jasper.cross-dissolve',
				duration: 8,
				alignment: 'start-at-cut',
			},
			{
				type: 'transition.add',
				clipId: z,
				edge: 'in',
				effectId: 'jasper.cross-dissolve',
				duration: 8,
				alignment: 'end-at-cut',
			},
		]);
		const cuts = cutsOf(h);
		expect(cuts.map((c) => [c.frame, c.zone])).toEqual([
			[60, { start: 60, end: 68 }],
			[68, { start: 60, end: 68 }],
		]);
	});

	it('one-sided transitions make no zone; a fade to or from black is not a cut', () => {
		const { h, a, b } = setup();
		const x = put(h, a, 0, 0, 60);
		const y = put(h, b, 90, 0, 60);
		h.ok([
			{ type: 'transition.add', clipId: x, edge: 'out', effectId: 'jasper.cross-dissolve', duration: 15 },
		]);
		expect(brief(cutsOf(h))).toEqual([[90, 'cut']]);
		h.ok([
			{ type: 'transition.add', clipId: y, edge: 'in', effectId: 'jasper.cross-dissolve', duration: 15 },
		]);
		expect(cutsOf(h)).toEqual([]);
	});

	it('a fade over another picture still cuts at the edge (without a zone)', () => {
		const { h, a, b } = setup();
		put(h, a, 0, 0, 300);
		const y = put(h, b, 100, 0, 60, 'V2');
		h.ok([
			{ type: 'transition.add', clipId: y, edge: 'out', effectId: 'jasper.cross-dissolve', duration: 15 },
		]);
		const cuts = cutsOf(h);
		expect(brief(cuts)).toEqual([
			[100, 'cut'],
			[160, 'cut'],
		]);
		expect(cuts[1]!.zone).toBeUndefined();
	});
});

describe('pictureCuts: nested sequences', () => {
	function nestSetup(preset?: string, innerPreset?: string) {
		const s = setup(preset);
		const { h, a, b } = s;
		const inner = h.ok([
			{ type: 'sequence.create', name: 'Inner', ref: '$n', ...(innerPreset ? { preset: innerPreset } : {}) },
		]).refs.$n!;
		const ia = put(h, a, 0, 0, 20, 'V1', inner);
		const ib = put(h, b, 20, 100, 140, 'V1', inner);
		return { ...s, inner, ia, ib };
	}
	const placeNest = (h: Harness, inner: string, at: number, track = 'V1') =>
		(
			h.ok([{ type: 'clip.place', source: { sequenceId: inner }, at, tracks: { video: track } }])
				.results[0] as {
				clipIds: string[];
			}
		).clipIds[0]!;

	it('maps a nested cut to the parent with the nest clip and the nested clips', () => {
		const { h, inner, ia, ib } = nestSetup();
		const n = placeNest(h, inner, 100);
		expect(cutsOf(h)).toEqual([
			{
				frame: 100,
				kind: 'cut',
				trackId: trackId(h, 'V1'),
				incomingClipId: n,
				nested: { incoming: { sequenceId: inner, clipId: ia, nestPath: [n] } },
			},
			{
				frame: 120,
				kind: 'cut',
				trackId: trackId(h, 'V1'),
				outgoingClipId: n,
				incomingClipId: n,
				nested: {
					outgoing: { sequenceId: inner, clipId: ia, nestPath: [n] },
					incoming: { sequenceId: inner, clipId: ib, nestPath: [n] },
				},
			},
		]);
	});

	it('follows nest speed, reverse and trims', () => {
		const fast = nestSetup();
		const n = placeNest(fast.h, fast.inner, 100);
		fast.h.ok([{ type: 'clip.setSpeed', clipIds: [n], rate: 2, ripple: false }]);
		expect(fast.h.seq.clips[n]!.duration).toBe(30);
		expect(brief(cutsOf(fast.h))).toEqual([
			[100, 'cut'],
			[110, 'cut'],
		]);
		const back = nestSetup();
		const r = placeNest(back.h, back.inner, 100);
		back.h.ok([{ type: 'clip.setSpeed', clipIds: [r], reverse: true, ripple: false }]);
		expect(back.h.seq.clips[r]!.duration).toBe(60);
		// Reversed: frame i shows nested frame 59 − i; nested 20 → 19 happens at i = 40.
		expect(brief(cutsOf(back.h))).toEqual([
			[100, 'cut'],
			[140, 'cut'],
		]);
		const trimmed = nestSetup();
		const t = placeNest(trimmed.h, trimmed.inner, 100);
		trimmed.h.ok([{ type: 'clip.trim', clipId: t, edge: 'in', deltaFrames: 5 }]);
		expect(brief(cutsOf(trimmed.h))).toEqual([
			[105, 'cut'],
			[120, 'cut'],
		]);
	});

	it('maps a nested transition zone', () => {
		const { h, inner, ib } = nestSetup();
		h.ok([
			{
				type: 'transition.add',
				sequenceId: inner,
				clipId: ib,
				edge: 'in',
				effectId: 'jasper.cross-dissolve',
				duration: 10,
				alignment: 'center',
			},
		]);
		const n = placeNest(h, inner, 100);
		const [opening, cut] = cutsOf(h);
		expect(opening!.frame).toBe(100);
		expect(cut!.frame).toBe(120);
		expect(cut!.transitionId).toBeUndefined();
		expect(cut!.nested?.transition).toEqual({
			sequenceId: inner,
			transitionId: Object.keys(h.doc.sequences[inner]!.transitions)[0],
			nestPath: [n],
		});
		expect(cut!.zone).toEqual({ start: 115, end: 125 });
	});

	it('a nest of the same source continuing a parent clip is not a cut', () => {
		const { h, a, inner } = nestSetup();
		put(h, a, 0, 0, 100);
		// Parent shows source frames 0–99 then a nest whose first clip shows source frames 0–19 again: a jump.
		placeNest(h, inner, 100);
		expect(brief(cutsOf(h))).toEqual([
			[100, 'jump'],
			[120, 'cut'],
		]);
		// …and continuing frame 100 instead: no cut at all.
		const doc = structuredClone(h.doc);
		const ia = Object.values(doc.sequences[inner]!.clips).find((c) => c.start === 0)!;
		ia.sourceIn = 100 * F(h);
		expect(brief(pictureCuts(doc, h.seqId))).toEqual([[120, 'cut']]);
	});

	it('conforms a nested sequence of another rate (25 fps inside 59.94)', () => {
		const { h, inner } = nestSetup('hd-1080p-59.94', 'hd-1080p-25');
		placeNest(h, inner, 100);
		// Nested frame 20 at 25 fps = 0.8 s = 47.95 frames at 59.94 → frame 48 after the nest's start.
		expect(brief(cutsOf(h))).toEqual([
			[100, 'cut'],
			[148, 'cut'],
		]);
	});

	it('detects nesting cycles without hanging and warns', () => {
		const { h, inner } = nestSetup();
		const n = placeNest(h, inner, 100);
		const doc = structuredClone(h.doc);
		const innerSeq = doc.sequences[inner]!;
		const loop = {
			...structuredClone(doc.sequences[h.seqId]!.clips[n]!),
			id: 'loop',
			start: 0,
			sequenceId: h.seqId,
		};
		(loop as Clip).trackId = innerSeq.videoTracks[1]!.id;
		innerSeq.clips = { ...innerSeq.clips, loop: loop as Clip };
		const r = analyzePictureCuts(doc, h.seqId);
		expect(r.warnings.map((w) => w.code)).toContain('nest-cycle');
		expect(brief(r.cuts)).toEqual([
			[100, 'cut'],
			[120, 'cut'],
		]);
	});

	it('follows nests eight levels deep and flattens deeper ones with a warning', () => {
		const { h, a, b } = setup();
		const chain = (levels: number) => {
			let deepest = h.ok([{ type: 'sequence.create', name: `L${levels}`, ref: '$s' }]).refs.$s!;
			put(h, a, 0, 0, 30, 'V1', deepest);
			put(h, b, 30, 0, 60, 'V1', deepest);
			for (let i = levels - 1; i >= 1; i--) {
				const s = h.ok([{ type: 'sequence.create', name: `L${i}`, ref: '$s' }]).refs.$s!;
				h.ok([
					{
						type: 'clip.place',
						sequenceId: s,
						source: { sequenceId: deepest },
						at: 0,
						tracks: { video: 'V1' },
					},
				]);
				deepest = s;
			}
			return deepest;
		};
		const eight = chain(8);
		const s = h.ok([{ type: 'sequence.create', name: 'Root8', ref: '$r' }]).refs.$r!;
		h.ok([
			{ type: 'clip.place', sequenceId: s, source: { sequenceId: eight }, at: 0, tracks: { video: 'V1' } },
		]);
		const r8 = analyzePictureCuts(h.doc, s);
		expect(brief(r8.cuts)).toEqual([[30, 'cut']]);
		expect(r8.warnings).toEqual([]);
		const nine = chain(9);
		const s9 = h.ok([{ type: 'sequence.create', name: 'Root9', ref: '$r' }]).refs.$r!;
		h.ok([
			{ type: 'clip.place', sequenceId: s9, source: { sequenceId: nine }, at: 0, tracks: { video: 'V1' } },
		]);
		const r9 = analyzePictureCuts(h.doc, s9);
		expect(r9.cuts).toEqual([]);
		expect(r9.warnings.map((w) => w.code)).toContain('nest-depth');
	});
});

describe('pictureCuts: frame rates', () => {
	for (const preset of [
		'hd-1080p-23.976',
		'hd-1080p-25',
		'hd-1080p-29.97',
		'hd-1080p-59.94',
		'hd-1080p-60',
	]) {
		it(`cuts land on clip edges at ${preset.slice(9)} fps`, () => {
			const { h, a, b } = setup(preset);
			const rA = h.ok([
				{
					type: 'clip.place',
					source: { mediaId: a },
					at: 0,
					tracks: { video: 'V1' },
					sourceRange: { in: { seconds: 0 }, out: { seconds: 2.5 } },
				},
			]);
			const x = h.seq.clips[(rA.results[0] as { clipIds: string[] }).clipIds[0]!]!;
			const end = x.start + x.duration;
			put(h, b, end, 0, 100);
			put(h, a, end + 100, 1000, 1100);
			expect(brief(cutsOf(h))).toEqual([
				[end, 'cut'],
				[end + 100, 'cut'],
			]);
			// The jump: same source, discontinuous; a through edit at a rational rate is exact.
			const seq = h.seq;
			const last = Object.values(seq.clips).find((c) => c.start === end + 100)!;
			h.ok([{ type: 'clip.split', at: end + 137, clipIds: [last.id] }]);
			expect(brief(cutsOf(h))).toEqual([
				[end, 'cut'],
				[end + 100, 'cut'],
			]);
		});
	}
});

describe('pictureCuts: damaged data', () => {
	it('never throws on unreadable Motion values or a missing nested sequence', () => {
		const { h, a, b } = setup();
		const x = put(h, a, 0, 0, 90);
		put(h, b, 90, 0, 90, 'V2');
		const doc = structuredClone(h.doc);
		const seq = doc.sequences[h.seqId] as Sequence;
		(seq.clips[x] as { transform: { scale: unknown } }).transform.scale = {
			value: Number.NaN,
			keyframes: [],
		};
		seq.clips = { ...seq.clips };
		expect(() => analyzePictureCuts(doc, h.seqId)).not.toThrow();
		const nest = {
			...structuredClone(seq.clips[x]!),
			id: 'n1',
			kind: 'nest-video',
			sequenceId: 'missing',
			start: 200,
		} as unknown as Clip;
		seq.clips = { ...seq.clips, n1: nest };
		const r = analyzePictureCuts(doc, h.seqId);
		expect(r.warnings.map((w) => w.code)).toContain('nest-missing');
	});
});

describe('clipConvexPolygon', () => {
	it('intersects convex polygons of either orientation', () => {
		const sq = (x: number, y: number, s: number): [number, number][] => [
			[x, y],
			[x + s, y],
			[x + s, y + s],
			[x, y + s],
		];
		const area = (p: [number, number][]) =>
			Math.abs(
				p.reduce((s, a, i) => s + a[0] * p[(i + 1) % p.length]![1] - p[(i + 1) % p.length]![0] * a[1], 0),
			) / 2;
		expect(area(clipConvexPolygon(sq(0, 0, 2), sq(1, 1, 2)))).toBeCloseTo(1);
		expect(area(clipConvexPolygon(sq(0, 0, 2).reverse(), sq(1, 1, 2)))).toBeCloseTo(1);
		expect(clipConvexPolygon(sq(0, 0, 1), sq(5, 5, 1))).toEqual([]);
	});
});
