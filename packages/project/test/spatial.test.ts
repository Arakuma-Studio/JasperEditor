// Spatial interpolation of vec2 point keys (S03:KF-021, KF-030, KF-031; wave1 spatial-motion-path): golden
// evaluation, the commands, load of documents written before the field existed, and the S03 §12.5 copy rules
// (split, duplicate, keyframe paste, paste attributes) keeping the tangents.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	type Animatable,
	arcLengthTable,
	autoSlope,
	type BezierSegment,
	bezierPoint,
	buildClipsPayload,
	buildKeyframesPayload,
	type Clip,
	checkInvariants,
	contentTimeAt,
	effectiveTangents,
	evaluate,
	hasCurvedSpatialPath,
	type Keyframe,
	loadProject,
	pathPointAt,
	type Rational,
	type Spatial,
	spatialSegment,
	type Vec2,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const F = 23_520_000; // flicks per frame at 30 fps
const LIN = { influence: 1 / 3, slope: 1 };
const EASY = { influence: 1 / 3, slope: 0 };

function key(
	frame: number,
	value: Vec2,
	spatial?: Spatial['mode'] | Spatial,
	extra: Partial<Keyframe<Vec2>> = {},
) {
	const s: Spatial | undefined =
		typeof spatial === 'string' ? { mode: spatial, inTangent: [0, 0], outTangent: [0, 0] } : spatial;
	return {
		id: `kf_${String(frame).padStart(16, '0')}`,
		time: frame * F,
		value,
		interpolation: 'linear',
		easeIn: LIN,
		easeOut: LIN,
		...(s ? { spatial: s } : {}),
		...extra,
	} as Keyframe<Vec2>;
}
const anim = (keyframes: Keyframe<Vec2>[]): Animatable<Vec2> => ({ value: [0, 0], keyframes });
const at = (a: Animatable<Vec2>, frame: number) => evaluate(a, frame * F);
const lerp = (a: Vec2, b: Vec2, p: number): Vec2 => [a[0] + p * (b[0] - a[0]), a[1] + p * (b[1] - a[1])];
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('spatial evaluation (S03:KF-030, KF-031)', () => {
	const A: Vec2 = [0, 0];
	const B: Vec2 = [300, 300];
	const C: Vec2 = [600, 0];

	it('keys without spatial data (and linear keys) evaluate exactly like the component lerp', () => {
		for (const mode of [undefined, 'linear'] as const) {
			const a = anim([key(0, A, mode), key(30, B, mode), key(60, C, mode)]);
			for (let f = 0; f <= 60; f++) {
				const [k0, k1, f0] = f < 30 ? [A, B, 0] : [B, C, 30];
				expect(at(a, f)).toEqual(lerp(k0, k1, (f - f0) / 30));
			}
			expect(hasCurvedSpatialPath(a)).toBe(false);
		}
	});

	it('two Auto Bezier keys move on the straight line exactly like linear ones', () => {
		const a = anim([key(0, A, 'auto-bezier'), key(30, B, 'auto-bezier')]);
		expect(spatialSegment(a.keyframes, 0)).toBeNull();
		for (let f = 0; f <= 30; f++) expect(at(a, f)).toEqual(lerp(A, B, f / 30));
	});

	it('Auto Bezier tangents are Catmull-Rom (next − prev) / 6; the path passes through every key', () => {
		const kfs = [key(0, A, 'auto-bezier'), key(30, B, 'auto-bezier'), key(60, C, 'auto-bezier')];
		expect(effectiveTangents(kfs, 1)).toEqual({ inTangent: [-100, 0], outTangent: [100, 0] });
		expect(effectiveTangents(kfs, 0).outTangent).toEqual([50, 50]); // missing prev = the key itself
		expect(effectiveTangents(kfs, 2).inTangent).toEqual([-50, 50]);
		const a = anim(kfs);
		expect(at(a, 0)).toEqual(A);
		expect(at(a, 30)).toEqual(B);
		expect(at(a, 60)).toEqual(C);
		expect(spatialSegment(kfs, 0)).toEqual([A, [50, 50], [200, 300], B]);
		expect(hasCurvedSpatialPath(a)).toBe(true);
		// Golden (independent 10⁶-step arc-length integration): segment length 432.959, arc midpoint
		// (132.913, 170.778) — reached at half the segment's time with Linear temporal.
		expect(arcLengthTable(spatialSegment(kfs, 0)!)[64]).toBeCloseTo(432.959, 1);
		const mid = at(a, 15);
		expect(mid[0]).toBeCloseTo(132.913, 1);
		expect(mid[1]).toBeCloseTo(170.778, 1);
	});

	it('Linear temporal keeps a constant speed along the curve (arc-length reparameterization)', () => {
		const a = anim([key(0, A, 'auto-bezier'), key(30, B, 'auto-bezier'), key(60, C, 'auto-bezier')]);
		const steps: number[] = [];
		for (let f = 0; f < 30; f++) steps.push(dist(at(a, f), at(a, f + 1)));
		const mean = steps.reduce((x, y) => x + y, 0) / steps.length;
		for (const s of steps) expect(Math.abs(s - mean) / mean).toBeLessThan(0.01);
		// The raw Bézier parameter would not: its first and middle steps differ by far more.
		const seg = spatialSegment(a.keyframes, 0)!;
		const raw0 = dist(bezierPoint(seg, 0), bezierPoint(seg, 1 / 30));
		const raw15 = dist(bezierPoint(seg, 15 / 30), bezierPoint(seg, 16 / 30));
		expect(Math.abs(raw0 - raw15) / raw15).toBeGreaterThan(0.05);
	});

	it('pathPointAt maps progress to arc length; a symmetric arc has its arc midpoint at t = 0.5', () => {
		const seg: BezierSegment = [
			[0, 0],
			[0, 55.23],
			[44.77, 100],
			[100, 100],
		];
		const m = pathPointAt(seg, 0.5);
		const b = bezierPoint(seg, 0.5);
		expect(m[0]).toBeCloseTo(b[0], 6);
		expect(m[1]).toBeCloseTo(b[1], 6);
		// Quarter circle of radius 100: arc length ≈ 157.08.
		expect(arcLengthTable(seg)[64]).toBeCloseTo(157.08, 0);
		expect(arcLengthTable(seg)).toBe(arcLengthTable([...seg] as BezierSegment)); // cached by content
		expect(pathPointAt(seg, 0)).toEqual([0, 0]);
		expect(pathPointAt(seg, 1)).toEqual([100, 100]);
		// Overshoot continues along the end tangent.
		const over = pathPointAt(seg, 1.1);
		expect(over[1]).toBeCloseTo(100, 6);
		expect(over[0]).toBeCloseTo(100 + 15.708, 1);
	});

	it('temporal easing controls the speed along the path', () => {
		const kfs = [
			key(0, A, 'continuous-bezier', { interpolation: 'bezier', easeOut: EASY }),
			key(30, C, 'continuous-bezier', { interpolation: 'bezier', easeIn: EASY }),
		];
		kfs[0]!.spatial!.outTangent = [0, 300];
		kfs[1]!.spatial!.inTangent = [0, 300];
		const a = anim(kfs);
		const seg = spatialSegment(kfs, 0)!;
		const total = arcLengthTable(seg)[64]!;
		// Symmetric ease on a symmetric arc: half the time = half the arc.
		const mid = at(a, 15);
		expect(mid[0]).toBeCloseTo(300, 6);
		// Easy ease starts slower than the constant speed would.
		expect(dist(at(a, 0), at(a, 1))).toBeLessThan(total / 30 / 2);
	});

	it('Bezier / Continuous keys use their stored tangents; a linear neighbour contributes none', () => {
		const kfs = [key(0, A), key(30, C, { mode: 'bezier', inTangent: [-100, 200], outTangent: [0, 0] })];
		expect(spatialSegment(kfs, 0)).toEqual([A, A, [500, 200], C]);
		const p = evaluate(anim(kfs), 15 * F);
		expect(p[1]).toBeGreaterThan(50);
		// Hold temporal steps whatever the path.
		const held = anim([key(0, A, 'auto-bezier', { interpolation: 'hold' }), key(30, B), key(60, C)]);
		expect(at(held, 20)).toEqual(A);
	});

	it('temporal Auto Bezier measures speeds along a curved path', () => {
		const kfs = [
			key(0, A, 'auto-bezier', { interpolation: 'auto-bezier' }),
			key(30, B, 'auto-bezier', { interpolation: 'auto-bezier' }),
			key(90, C, 'auto-bezier', { interpolation: 'auto-bezier' }),
		];
		const l0 = arcLengthTable(spatialSegment(kfs, 0)!)[64]!;
		const l1 = arcLengthTable(spatialSegment(kfs, 1)!)[64]!;
		expect(autoSlope(kfs, 1, 'out')).toBeCloseTo((l0 + l1) / 90 / (l1 / 60), 9);
		const straight = kfs.map((k) => ({ ...k, spatial: undefined }));
		expect(autoSlope(straight, 1, 'out')).toBeCloseTo(600 / 90 / (Math.hypot(300, 300) / 60), 9);
	});
});

// ---------------------------------------------------------------- commands

type VClip = Extract<Clip, { kind: 'solid' }>;

function withSolid(duration = 90) {
	const h = new Harness();
	h.ok([{ type: 'clip.addSolid', at: 0, duration, track: 'V1', color: [1, 0, 0, 1] }]);
	const id = h.clips('V1')[0]!.id;
	return { h, id };
}
const clipOf = (h: Harness, id: string) => h.seq.clips[id] as VClip;
const posKeys = (h: Harness, id: string) => clipOf(h, id).transform.position.keyframes;
const pos = (id: string) => ['clip', id, 'transform', 'position'];
/** Position keys at frames 0, 30, 60 made like the Program monitor does (stopwatch + param.set). */
function threeKeys(h: Harness, id: string) {
	h.ok([
		{ type: 'param.setAnimated', target: pos(id), animated: true, at: { sequenceFrame: 0 } },
		{ type: 'param.set', target: pos(id), value: [0, 0], at: { sequenceFrame: 0 } },
		{ type: 'param.set', target: pos(id), value: [300, 300], at: { sequenceFrame: 30 } },
		{ type: 'param.set', target: pos(id), value: [600, 0], at: { sequenceFrame: 60 } },
	]);
	return posKeys(h, id);
}
const evalAt = (h: Harness, c: VClip, frame: number) =>
	evaluate(c.transform.position, contentTimeAt(c, frame, h.seq.settings.frameRate as Rational));

describe('spatial commands (S03:KF-021, OVL-020)', () => {
	it('new position / anchor keys are Auto Bezier spatial with Linear temporal; other vectors stay plain', () => {
		const { h, id } = withSolid();
		const keys = threeKeys(h, id);
		expect(keys.map((k) => [k.interpolation, k.spatial?.mode])).toEqual([
			['linear', 'auto-bezier'],
			['linear', 'auto-bezier'],
			['linear', 'auto-bezier'],
		]);
		// Stored auto tangents are refreshed (a cache; evaluation derives them).
		expect(keys[1]!.spatial).toMatchObject({ inTangent: [-100, 0], outTangent: [100, 0] });
		h.ok([
			{ type: 'keyframe.add', target: ['clip', id, 'transform', 'anchor'], at: { sequenceFrame: 0 } },
			{ type: 'keyframe.add', target: ['clip', id, 'transform', 'scale'], at: { sequenceFrame: 0 } },
		]);
		const c = clipOf(h, id);
		expect(c.transform.anchor.keyframes[0]!.spatial?.mode).toBe('auto-bezier');
		expect(c.transform.scale.keyframes[0]!.spatial).toBeUndefined();
		// Spatial data on a non-point property is refused.
		expect(
			h.tx([
				{
					type: 'keyframe.add',
					target: ['clip', id, 'transform', 'scale'],
					at: { sequenceFrame: 10 },
					spatial: { mode: 'bezier' },
				},
			]),
		).toMatchObject({ ok: false, errors: [{ code: 'E_INVALID_PARAM' }] });
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('corner pin corners are points whose new keys stay straight', () => {
		const { h, id } = withSolid();
		h.ok([{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.corner-pin', ref: '$pin' }]);
		const fx = clipOf(h, id).effects[0]!;
		h.ok([{ type: 'keyframe.add', target: ['effect', fx.id, 'topLeft'], at: { sequenceFrame: 0 } }]);
		const k = clipOf(h, id).effects[0]!.params.topLeft!.keyframes[0]!;
		expect(k.spatial).toBeUndefined();
		h.ok([{ type: 'keyframe.setSpatialInterpolation', keyframeIds: [k.id], mode: 'bezier' }]);
		expect(clipOf(h, id).effects[0]!.params.topLeft!.keyframes[0]!.spatial?.mode).toBe('bezier');
	});

	it('keyframe.setSpatialInterpolation: Linear zeroes, Bezier starts from the auto tangents, Continuous aligns', () => {
		const { h, id } = withSolid();
		const keys = threeKeys(h, id);
		const mid = keys[1]!.id;
		h.ok([{ type: 'keyframe.setSpatialInterpolation', keyframeIds: keys.map((k) => k.id), mode: 'linear' }]);
		expect(posKeys(h, id)[1]!.spatial).toEqual({ mode: 'linear', inTangent: [0, 0], outTangent: [0, 0] });
		const c = clipOf(h, id);
		expect(evalAt(h, c, 15)).toEqual([150, 150]);
		h.ok([{ type: 'keyframe.setSpatialInterpolation', keyframeIds: [mid], mode: 'bezier' }]);
		expect(posKeys(h, id)[1]!.spatial).toEqual({
			mode: 'bezier',
			inTangent: [-100, 0],
			outTangent: [100, 0],
		});
		h.ok([{ type: 'keyframe.setTangents', keyframeId: mid, inTangent: [0, -50], breakContinuity: true }]);
		expect(posKeys(h, id)[1]!.spatial).toEqual({ mode: 'bezier', inTangent: [0, -50], outTangent: [100, 0] });
		h.ok([{ type: 'keyframe.setSpatialInterpolation', keyframeIds: [mid], mode: 'continuous-bezier' }]);
		// The in tangent turns opposite the out tangent and keeps its length (50).
		const s = posKeys(h, id)[1]!.spatial!;
		expect(s.mode).toBe('continuous-bezier');
		expect(s.outTangent).toEqual([100, 0]);
		expect(s.inTangent[0]).toBeCloseTo(-50, 9);
		expect(s.inTangent[1]).toBeCloseTo(0, 9);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('keyframe.setTangents: auto → continuous (other side opposite), Alt breaks, Bezier stays independent', () => {
		const { h, id } = withSolid();
		const mid = threeKeys(h, id)[1]!.id;
		h.ok([{ type: 'keyframe.setTangents', keyframeId: mid, outTangent: [0, 200] }]);
		let s = posKeys(h, id)[1]!.spatial!;
		expect(s.mode).toBe('continuous-bezier');
		expect(s.outTangent).toEqual([0, 200]);
		expect(s.inTangent[0]).toBeCloseTo(0, 9);
		expect(s.inTangent[1]).toBeCloseTo(-100, 9); // length 100 kept
		h.ok([{ type: 'keyframe.setTangents', keyframeId: mid, inTangent: [-30, 0], breakContinuity: true }]);
		s = posKeys(h, id)[1]!.spatial!;
		expect(s).toEqual({ mode: 'bezier', inTangent: [-30, 0], outTangent: [0, 200] });
		h.ok([{ type: 'keyframe.setTangents', keyframeId: mid, outTangent: [10, 10] }]);
		expect(posKeys(h, id)[1]!.spatial).toEqual({ mode: 'bezier', inTangent: [-30, 0], outTangent: [10, 10] });
		// Both sides opposite → continuous; moving the key keeps its (relative) tangents.
		h.ok([
			{ type: 'keyframe.setSpatialInterpolation', keyframeIds: [mid], mode: 'auto-bezier' },
			{ type: 'keyframe.setTangents', keyframeId: mid, inTangent: [-20, 0], outTangent: [40, 0] },
			{ type: 'keyframe.update', keyframeId: mid, value: [310, 320] },
		]);
		expect(posKeys(h, id)[1]).toMatchObject({
			value: [310, 320],
			spatial: { mode: 'continuous-bezier', inTangent: [-20, 0], outTangent: [40, 0] },
		});
		expect(h.tx([{ type: 'keyframe.setTangents', keyframeId: mid }])).toMatchObject({ ok: false });
	});

	it('keyframe.add / keyframe.update accept spatial data', () => {
		const { h, id } = withSolid();
		h.ok([
			{
				type: 'keyframe.add',
				target: pos(id),
				at: { sequenceFrame: 0 },
				value: [0, 0],
				spatial: { mode: 'linear' },
			},
			{
				type: 'keyframe.add',
				target: pos(id),
				at: { sequenceFrame: 30 },
				value: [100, 0],
				spatial: { mode: 'bezier', inTangent: [0, 50], outTangent: [0, -50] },
			},
		]);
		const k = posKeys(h, id);
		expect(k.map((x) => x.spatial?.mode)).toEqual(['linear', 'bezier']);
		expect(k[1]!.spatial).toMatchObject({ inTangent: [0, 50], outTangent: [0, -50] });
		h.ok([{ type: 'keyframe.update', keyframeId: k[0]!.id, spatial: { mode: 'auto-bezier' } }]);
		expect(posKeys(h, id)[0]!.spatial).toEqual({
			mode: 'auto-bezier',
			inTangent: [-100 / 6, 0],
			outTangent: [100 / 6, 0],
		});
	});
	// The solver fits segments along chords, so curved paths are reduced conservatively (here: not at all, the
	// sagitta between surviving keys exceeds the tolerance); the guarantee is what matters.
	it('keyframes.simplify keeps a curved path within the tolerance (verified with the evaluator)', () => {
		const { h, id } = withSolid(90);
		const commands: unknown[] = [
			{ type: 'param.setAnimated', target: pos(id), animated: true, at: { sequenceFrame: 0 } },
		];
		for (let f = 0; f < 90; f += 3) {
			const a = (f / 90) * Math.PI * 2;
			commands.push({
				type: 'param.set',
				target: pos(id),
				value: [960 + 300 * Math.cos(a), 540 + 300 * Math.sin(a)],
				at: { sequenceFrame: f },
			});
		}
		h.ok(commands);
		const before = clipOf(h, id);
		const ref = Array.from({ length: 90 }, (_, f) => evalAt(h, before, f));
		h.ok([{ type: 'keyframes.simplify', tolerance: 0.5, clipIds: [id] }]);
		const after = clipOf(h, id);
		expect(after.transform.position.keyframes.length).toBeLessThanOrEqual(30);
		expect(after.transform.position.keyframes.every((k) => k.spatial?.mode === 'auto-bezier')).toBe(true);
		for (let f = 0; f < 90; f++) expect(dist(evalAt(h, after, f), ref[f]!)).toBeLessThanOrEqual(0.5 + 1e-9);
	});
});

// ---------------------------------------------------------------- load, split, duplicate, paste

describe('documents and copies (S01:MIG-005, S03 §12.5)', () => {
	it('a document written before spatial interpolation loads unchanged and evaluates as before', () => {
		const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures/v5/basic.jasper'), 'utf8'));
		const doc = raw.document ?? raw;
		const clip = Object.values(
			Object.values(doc.sequences as Record<string, { clips: Record<string, VClip> }>)[0]!.clips,
		).find((c) => c.transform)!;
		const old = [key(0, [0, 0]), key(30, [300, 300]), key(60, [600, 0])].map(({ spatial: _s, ...k }) => k);
		clip.transform.position = { value: [0, 0], keyframes: old as Keyframe<Vec2>[] };
		const loaded = loadProject(raw);
		expect(loaded.issues).toEqual([]);
		const seq = Object.values(loaded.document.sequences)[0]!;
		const c = seq.clips[clip.id] as VClip;
		expect(c.transform.position.keyframes.every((k) => k.spatial === undefined)).toBe(true);
		for (let f = 0; f <= 60; f++)
			expect(evaluate(c.transform.position, f * F)).toEqual(
				f < 30 ? lerp([0, 0], [300, 300], f / 30) : lerp([300, 300], [600, 0], (f - 30) / 30),
			);
		// Spatial data round-trips through load; a broken one is an invariant issue.
		c.transform.position.keyframes[1]!.spatial = { mode: 'bezier', inTangent: [1, 2], outTangent: [3, 4] };
		const again = loadProject(JSON.parse(JSON.stringify(loaded.document)));
		expect(
			(Object.values(again.document.sequences)[0]!.clips[clip.id] as VClip).transform.position.keyframes[1]!
				.spatial,
		).toEqual({
			mode: 'bezier',
			inTangent: [1, 2],
			outTangent: [3, 4],
		});
		const bad = JSON.parse(JSON.stringify(loaded.document));
		(Object.values(bad.sequences)[0] as { clips: Record<string, VClip> }).clips[clip.id]!.opacity.keyframes =
			[{ ...key(0, [0, 0], 'bezier'), value: 50 } as never];
		expect(checkInvariants(bad).map((i) => i.invariant)).toContain('INV-011');
	});

	it('split keeps the curve on both halves (new ids, tangents kept)', () => {
		const { h, id } = withSolid();
		threeKeys(h, id);
		h.ok([{ type: 'keyframe.setTangents', keyframeId: posKeys(h, id)[1]!.id, outTangent: [50, 120] }]);
		const before = clipOf(h, id);
		const ref = Array.from({ length: 90 }, (_, f) => evalAt(h, before, f));
		h.ok([{ type: 'clip.split', at: 40, clipIds: [id] }]);
		const [left, right] = h.clips('V1') as VClip[];
		for (let f = 0; f < 90; f++) {
			const c = f < 40 ? left! : right!;
			const v = evalAt(h, c, f);
			expect(v[0]).toBeCloseTo(ref[f]![0], 9);
			expect(v[1]).toBeCloseTo(ref[f]![1], 9);
		}
		const lk = left!.transform.position.keyframes;
		const rk = right!.transform.position.keyframes;
		expect(rk.map((k) => k.spatial)).toEqual(lk.map((k) => k.spatial));
		expect(rk.some((k) => lk.some((l) => l.id === k.id))).toBe(false);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('duplicate, keyframe paste and paste attributes keep the tangents', () => {
		const { h, id } = withSolid();
		threeKeys(h, id);
		h.ok([{ type: 'keyframe.setTangents', keyframeId: posKeys(h, id)[1]!.id, outTangent: [50, 120] }]);
		const spatial = posKeys(h, id).map((k) => k.spatial);
		h.ok([{ type: 'clip.duplicate', clipIds: [id], tracks: ['V2'], at: 0 }]);
		const dup = h.clips('V2')[0] as VClip;
		expect(dup.transform.position.keyframes.map((k) => k.spatial)).toEqual(spatial);

		h.ok([{ type: 'clip.addSolid', at: 100, duration: 90, track: 'V1', color: [0, 1, 0, 1] }]);
		const other = h.clips('V1')[1]!.id;
		const payload = JSON.parse(
			JSON.stringify(
				buildKeyframesPayload(
					h.doc,
					id,
					posKeys(h, id).map((k) => k.id),
				),
			),
		);
		h.ok([{ type: 'keyframe.paste', payload, clipId: other, at: { frames: 0 } }]);
		expect(posKeys(h, other).map((k) => k.spatial)).toEqual(spatial);
		// Pasted onto a non-point property of the same kind (shape size): the spatial data is dropped.
		h.ok([{ type: 'clip.addShape', at: 200, duration: 60, track: 'V1', shape: { type: 'rect' } }]);
		const shape = h.clips('V1')[2]!.id;
		payload.keyframes.tracks[0].address = { property: 'shape.size' };
		h.ok([{ type: 'keyframe.paste', payload, clipId: shape, at: { frames: 0 } }]);
		const size = (h.seq.clips[shape] as Extract<Clip, { kind: 'shape' }>).shape.size.keyframes;
		expect(size.length).toBe(3);
		expect(size.every((k) => k.spatial === undefined)).toBe(true);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('paste attributes onto a reversed clip traverses the path backwards (tangents swap)', () => {
		const { h, id } = withSolid();
		threeKeys(h, id);
		h.ok([
			{ type: 'keyframe.setTangents', keyframeId: posKeys(h, id)[1]!.id, outTangent: [50, 120] },
			{
				type: 'keyframe.setTangents',
				keyframeId: posKeys(h, id)[1]!.id,
				inTangent: [-10, 0],
				breakContinuity: true,
			},
		]);
		const src = clipOf(h, id);
		const m = h.registerVideo({ seconds: 20 });
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 100, tracks: { video: 'V2' } }]);
		const v = h.clips('V2')[0]!.id;
		h.ok([
			{
				type: 'clip.trim',
				clipId: v,
				edge: 'out',
				mode: 'regular',
				deltaFrames: 90 - h.seq.clips[v]!.duration,
			},
		]);
		h.ok([{ type: 'clip.setSpeed', clipIds: [v], reverse: true, ripple: false }]);
		const payload = JSON.parse(JSON.stringify(buildClipsPayload(h.doc, h.seqId, [id])));
		h.ok([{ type: 'clip.pasteAttributes', payload, clipIds: [v], attributes: { motion: true } }]);
		const dst = h.seq.clips[v] as unknown as VClip;
		expect(dst.duration).toBe(90);
		const mid = dst.transform.position.keyframes[1]!;
		expect(mid.spatial).toMatchObject({ mode: 'bezier', inTangent: [50, 120], outTangent: [-10, 0] });
		// The reversed copy runs the same path backwards in content time (its key times mirror the source's).
		const k0 = src.transform.position.keyframes;
		const k1 = dst.transform.position.keyframes;
		const mirror = (t: number) => k1[0]!.time + k0[k0.length - 1]!.time - t;
		for (let t = k0[0]!.time; t <= k0[k0.length - 1]!.time; t += F / 2) {
			const a = evaluate(src.transform.position, t);
			const b = evaluate(dst.transform.position, mirror(t));
			expect(b[0]).toBeCloseTo(a[0], 6);
			expect(b[1]).toBeCloseTo(a[1], 6);
		}
	});
});
