// Keys pasted / re-timed onto a clip running the other way (keyframes-blend): exact frames (the reversed mapping
// spans the clip's first to last frame, like contentTimeAt — it used to land one frame off) and mirrored eases, so
// the target shows at every sequence frame what the source shows at the same offset.
import { describe, expect, it } from 'vitest';
import {
	buildClipsPayload,
	buildKeyframesPayload,
	type Clip,
	contentTimeAt,
	evaluate,
	type Rational,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

type VClip = Extract<Clip, { kind: 'solid' }>;
const EASY = { influence: 1 / 3, slope: 0 };
const STEEP = { influence: 0.6, slope: 1.8 };

function source(h: Harness) {
	h.ok([{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1] }]);
	const id = h.clips('V1')[0]!.id;
	const op = ['clip', id, 'opacity'];
	h.ok([
		{
			type: 'keyframe.add',
			target: op,
			at: { sequenceFrame: 0 },
			value: 0,
			interpolation: 'bezier',
			easeOut: EASY,
		},
		{
			type: 'keyframe.add',
			target: op,
			at: { sequenceFrame: 20 },
			value: 80,
			interpolation: 'bezier',
			easeIn: STEEP,
			easeOut: EASY,
		},
		{ type: 'keyframe.add', target: op, at: { sequenceFrame: 45 }, value: 30 },
	]);
	return id;
}

function reversedTarget(h: Harness, duration = 60) {
	const m = h.registerVideo({ seconds: 20 });
	h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 100, tracks: { video: 'V2' } }]);
	const v = h.clips('V2')[0]!.id;
	h.ok([
		{
			type: 'clip.trim',
			clipId: v,
			edge: 'out',
			mode: 'regular',
			deltaFrames: duration - h.seq.clips[v]!.duration,
		},
	]);
	h.ok([{ type: 'clip.setSpeed', clipIds: [v], reverse: true, ripple: false }]);
	return v;
}

const valueAt = (h: Harness, c: Clip, j: number) =>
	evaluate(
		(c as unknown as VClip).opacity,
		contentTimeAt(c, c.start + j, h.seq.settings.frameRate as Rational),
	);

describe('reversed paste (keyframes-blend)', () => {
	it('paste attributes: every frame matches the source at the same offset (frames exact, eases mirrored)', () => {
		const h = new Harness();
		const id = source(h);
		const v = reversedTarget(h);
		const payload = JSON.parse(JSON.stringify(buildClipsPayload(h.doc, h.seqId, [id])));
		h.ok([{ type: 'clip.pasteAttributes', payload, clipIds: [v], attributes: { opacity: true } }]);
		const src = h.seq.clips[id]!;
		const dst = h.seq.clips[v]!;
		for (let j = 0; j < 60; j++) expect(valueAt(h, dst, j)).toBeCloseTo(valueAt(h, src, j), 6);
		// Keys at exact frames: the source's key frames 0, 20, 45 are the target's offsets 0, 20, 45.
		const F = 705_600_000 / 30;
		const frames = (dst as unknown as VClip).opacity.keyframes
			.map((k) => (dst.sourceIn + (dst.duration - 1) * F * dst.speed.rate - k.time) / (F * dst.speed.rate))
			.sort((a, b) => a - b);
		expect(frames.map((f) => Math.round(f * 1e6) / 1e6)).toEqual([0, 20, 45]);
	});

	it('keyframe.paste onto a reversed clip mirrors the eases too', () => {
		const h = new Harness();
		const id = source(h);
		const v = reversedTarget(h);
		const keys = (h.seq.clips[id] as unknown as VClip).opacity.keyframes.map((k) => k.id);
		const payload = JSON.parse(JSON.stringify(buildKeyframesPayload(h.doc, id, keys)));
		h.ok([{ type: 'keyframe.paste', payload, clipId: v, at: { sequenceFrame: 100 } }]);
		const src = h.seq.clips[id]!;
		const dst = h.seq.clips[v]!;
		for (let j = 0; j <= 45; j++) expect(valueAt(h, dst, j)).toBeCloseTo(valueAt(h, src, j), 6);
	});
});
