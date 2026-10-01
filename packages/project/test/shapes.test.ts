// Shapes (S11:SHP-001…003, wp-m2-shapes): clip.addShape defaults and validation, clip.update {shape} merge,
// param.set / keyframe targets on `shape.*`, the anchor re-centring rule, invariants, snapshot and agent schema.
import { describe, expect, it } from 'vitest';
import {
	applyMatrix,
	buildRenderSnapshot,
	type Clip,
	checkInvariants,
	defaultRegistries,
	defaultShape,
	evaluate,
	evaluateShape,
	exportAgentSchema,
	flicksPerFrame,
	propertiesForClip,
	resolveSceneAt,
	type ShapeClip,
	shapeContainsPoint,
	shapeIntrinsicBox,
	type Vec2,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

type Ok = { ok: true; refs: Record<string, string> };
const F = flicksPerFrame({ num: 30, den: 1 });

function addShape(
	h: Harness,
	shape: Record<string, unknown>,
	extra: Record<string, unknown> = {},
): ShapeClip {
	const r = h.ok([{ type: 'clip.addShape', at: 0, track: 'V1', shape, ref: '$s', ...extra }]) as Ok;
	return h.seq.clips[r.refs.$s!] as ShapeClip;
}
const shapeOf = (h: Harness, id: string) => h.seq.clips[id] as ShapeClip;
const snapshot = (h: Harness) =>
	buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });

/** Sequence position of the geometry centre (centre of the layer box) at a frame. */
function centreOnScreen(h: Harness, id: string, frame = 0): Vec2 {
	const layer = resolveSceneAt(snapshot(h), frame).find((l) => l.clip.clipId === id)!;
	return applyMatrix(layer.props.matrix, [layer.props.box.width / 2, layer.props.box.height / 2]);
}

describe('clip.addShape (S11:SHP-003)', () => {
	it('defaults: 400×400 at the sequence centre, white fill, no stroke, radius 0, 5 s, graphics label', () => {
		const h = new Harness();
		const c = addShape(h, { type: 'rect' });
		expect(c).toMatchObject({ kind: 'shape', name: 'Rectangle', label: 'magenta', start: 0, duration: 150 });
		expect(c.shape).toEqual({
			type: 'rect',
			size: { value: [400, 400], keyframes: [] },
			fill: { value: [1, 1, 1, 1], keyframes: [] },
			stroke: null,
			cornerRadius: { value: 0, keyframes: [] },
		});
		expect(c.transform.position.value).toEqual([960, 540]);
		expect(c.transform.anchor.value).toEqual([200, 200]);
		expect(c.transform.scale.value).toBe(100);
		expect(centreOnScreen(h, c.id)).toEqual([960, 540]);
		expect(addShape(h, { type: 'ellipse' }, { at: 150 }).name).toBe('Ellipse');
	});

	it('takes size, fill, stroke, radius, transform, duration and name', () => {
		const h = new Harness();
		const c = addShape(
			h,
			{
				type: 'rect',
				size: [300, 100],
				fill: null,
				stroke: { color: [1, 0, 0, 1], width: 6, position: 'outside' },
				cornerRadius: 12,
			},
			{ duration: 60, name: 'Box', transform: { position: [100, 200] } },
		);
		expect(c.duration).toBe(60);
		expect(c.name).toBe('Box');
		expect(c.shape.fill).toBeNull();
		expect(c.shape.stroke).toEqual({
			color: { value: [1, 0, 0, 1], keyframes: [] },
			width: { value: 6, keyframes: [] },
			position: 'outside',
		});
		expect(c.shape.cornerRadius.value).toBe(12);
		// Box = size + the outside stroke on every side; anchor at its centre.
		expect(shapeIntrinsicBox(c.shape)).toEqual({ width: 312, height: 112 });
		expect(c.transform.anchor.value).toEqual([156, 56]);
		expect(c.transform.position.value).toEqual([100, 200]);
		// Stroke position defaults to center.
		const d = addShape(h, { type: 'ellipse', stroke: { color: [0, 0, 0, 1], width: 2 } }, { at: 60 });
		expect(d.shape.stroke?.position).toBe('center');
	});

	it('validates colours, sizes and the rectangle-only corner radius', () => {
		const h = new Harness();
		const fail = (shape: Record<string, unknown>) => {
			const r = h.tx([{ type: 'clip.addShape', at: 0, track: 'V1', shape }]);
			return r.ok ? null : r.errors[0]!;
		};
		expect(fail({ type: 'rect', fill: [2, 0, 0, 1] })?.code).toBe('E_INVALID_PARAM');
		expect(fail({ type: 'rect', size: [40000, 10] })?.code).toBe('E_INVALID_PARAM');
		expect(fail({ type: 'rect', stroke: { color: [0, 0, 0, 1], width: 5000 } })?.code).toBe(
			'E_INVALID_PARAM',
		);
		expect(fail({ type: 'ellipse', cornerRadius: 4 })?.code).toBe('E_INVALID_PARAM');
		expect(fail({ type: 'rect', size: [-1, 10] })?.code).toBe('E_SCHEMA');
		expect(fail({ type: 'star' })?.code).toBe('E_SCHEMA');
		expect(h.clips()).toHaveLength(0);
	});

	it('places like text: overwrite on the target track, creates missing tracks, refuses locked tracks', () => {
		const h = new Harness();
		addShape(h, { type: 'rect' }, { track: 'V5' });
		expect(h.seq.videoTracks.length).toBeGreaterThanOrEqual(5);
		const t = h.seq.videoTracks[0]!;
		h.ok([{ type: 'track.update', trackId: t.id, patch: { locked: true } }]);
		const r = h.tx([{ type: 'clip.addShape', at: 0, track: 'V1', shape: { type: 'rect' } }]);
		expect(r.ok ? null : r.errors[0]!.code).toBe('E_TRACK_LOCKED');
	});
});

describe('clip.update {shape} (S11:SHP-003)', () => {
	it('merges fill, stroke and radius; null removes fill / stroke', () => {
		const h = new Harness();
		const { id } = addShape(h, { type: 'rect' });
		const upd = (shape: unknown) => h.tx([{ type: 'clip.update', clipId: id, patch: { shape } }]);
		expect(upd({ fill: null }).ok).toBe(true);
		expect(shapeOf(h, id).shape.fill).toBeNull();
		expect(upd({ stroke: { width: 3 } }).ok).toBe(true);
		expect(shapeOf(h, id).shape.stroke).toEqual({
			color: { value: [0, 0, 0, 1], keyframes: [] },
			width: { value: 3, keyframes: [] },
			position: 'center',
		});
		expect(upd({ stroke: { color: [0, 1, 0, 1], position: 'inside' } }).ok).toBe(true);
		expect(shapeOf(h, id).shape.stroke).toMatchObject({
			color: { value: [0, 1, 0, 1] },
			width: { value: 3 },
			position: 'inside',
		});
		expect(upd({ cornerRadius: 20, fill: [0, 0, 1, 0.5] }).ok).toBe(true);
		expect(shapeOf(h, id).shape.cornerRadius.value).toBe(20);
		expect(shapeOf(h, id).shape.fill?.value).toEqual([0, 0, 1, 0.5]);
		expect(upd({ stroke: null }).ok).toBe(true);
		expect(shapeOf(h, id).shape.stroke).toBeNull();
	});

	it('accepts Animatables; a static value replaces keys; validates every key', () => {
		const h = new Harness();
		const { id } = addShape(h, { type: 'rect' });
		const key = (kid: string, time: number, value: unknown) => ({
			id: kid,
			time,
			value,
			interpolation: 'linear',
			easeIn: { influence: 1 / 3, slope: 0 },
			easeOut: { influence: 1 / 3, slope: 0 },
		});
		const size = {
			value: [100, 100],
			keyframes: [key('kf_A000000000000000', 0, [100, 100]), key('kf_B000000000000000', 30 * F, [300, 100])],
		};
		expect(h.tx([{ type: 'clip.update', clipId: id, patch: { shape: { size } } }]).ok).toBe(true);
		expect(shapeOf(h, id).shape.size.keyframes).toHaveLength(2);
		const bad = { ...size, keyframes: [key('kf_C000000000000000', 0, [-5, 1])] };
		const r = h.tx([{ type: 'clip.update', clipId: id, patch: { shape: { size: bad } } }]);
		expect(r.ok ? null : r.errors[0]!.code).toBe('E_INVALID_PARAM');
		expect(h.tx([{ type: 'clip.update', clipId: id, patch: { shape: { size: [50, 60] } } }]).ok).toBe(true);
		expect(shapeOf(h, id).shape.size).toEqual({ value: [50, 60], keyframes: [] });
	});

	it('refuses cornerRadius on ellipses and shape patches on other kinds', () => {
		const h = new Harness();
		const { id } = addShape(h, { type: 'ellipse' });
		const r = h.tx([{ type: 'clip.update', clipId: id, patch: { shape: { cornerRadius: 3 } } }]);
		expect(r.ok ? null : r.errors[0]!.code).toBe('E_INVALID_PARAM');
		const t = h.ok([
			{ type: 'clip.addText', at: 200, duration: 30, track: 'V1', content: { text: 'x' }, ref: '$t' },
		]) as Ok;
		const r2 = h.tx([{ type: 'clip.update', clipId: t.refs.$t, patch: { shape: { fill: null } } }]);
		expect(r2.ok ? null : r2.errors[0]!.code).toBe('E_INVALID_PARAM');
	});
});

describe('shape.* properties (param.set, keyframes, S11:SHP-003)', () => {
	it('param.set writes size, fill, stroke and radius; clamps negative sizes', () => {
		const h = new Harness();
		const { id } = addShape(h, { type: 'rect' });
		const set = (path: string[], value: unknown) =>
			h.tx([{ type: 'param.set', target: ['clip', id, ...path], value }]);
		expect(set(['shape', 'size'], [640, 360]).ok).toBe(true);
		expect(shapeOf(h, id).shape.size.value).toEqual([640, 360]);
		const clamped = set(['shape', 'size'], [-10, 20]);
		expect(clamped.ok && clamped.warnings.map((w) => w.code)).toEqual(['W_VALUE_CLAMPED']);
		expect(shapeOf(h, id).shape.size.value).toEqual([0, 20]);
		expect(set(['shape', 'cornerRadius'], 16).ok).toBe(true);
		expect(set(['shape', 'stroke', 'position'], 'outside').ok).toBe(true);
		expect(shapeOf(h, id).shape.stroke).toMatchObject({ position: 'outside', width: { value: 8 } });
		expect(set(['shape', 'stroke', 'position'], 'diagonal').ok).toBe(false);
	});

	it('creates a "None" fill or stroke on first write', () => {
		const h = new Harness();
		const { id } = addShape(h, { type: 'ellipse', fill: null });
		expect(h.tx([{ type: 'param.set', target: ['clip', id, 'shape', 'fill'], value: [1, 0, 0, 1] }]).ok).toBe(
			true,
		);
		expect(shapeOf(h, id).shape.fill).toEqual({ value: [1, 0, 0, 1], keyframes: [] });
		expect(
			h.tx([{ type: 'param.set', target: ['clip', id, 'shape', 'stroke', 'width'], value: 12 }]).ok,
		).toBe(true);
		expect(shapeOf(h, id).shape.stroke).toEqual({
			color: { value: [0, 0, 0, 1], keyframes: [] },
			width: { value: 12, keyframes: [] },
			position: 'center',
		});
		// Corner radius is not a property of ellipses.
		expect(h.tx([{ type: 'param.set', target: ['clip', id, 'shape', 'cornerRadius'], value: 4 }]).ok).toBe(
			false,
		);
	});

	it('keyframes on size, fill, stroke and radius go through the shared keyframe commands and evaluator', () => {
		const h = new Harness();
		const { id } = addShape(h, { type: 'rect', stroke: { color: [1, 1, 1, 1], width: 2 } });
		for (const key of [['size'], ['fill'], ['stroke', 'color'], ['stroke', 'width'], ['cornerRadius']])
			h.ok([
				{
					type: 'param.setAnimated',
					target: ['clip', id, 'shape', ...key],
					animated: true,
					at: { sequenceFrame: 0 },
				},
			]);
		h.ok([
			{
				type: 'param.set',
				target: ['clip', id, 'shape', 'size'],
				value: [800, 200],
				at: { sequenceFrame: 30 },
			},
			{
				type: 'param.set',
				target: ['clip', id, 'shape', 'fill'],
				value: [0, 0, 0, 1],
				at: { sequenceFrame: 30 },
			},
			{
				type: 'param.set',
				target: ['clip', id, 'shape', 'cornerRadius'],
				value: 50,
				at: { sequenceFrame: 30 },
			},
			{
				type: 'param.set',
				target: ['clip', id, 'shape', 'stroke', 'width'],
				value: 10,
				at: { sequenceFrame: 30 },
			},
		]);
		const s = shapeOf(h, id).shape;
		expect(evaluate(s.size, 15 * F)).toEqual([600, 300]);
		expect(evaluate(s.fill!, 15 * F)).toEqual([0.5, 0.5, 0.5, 1]);
		expect(evaluate(s.cornerRadius, 15 * F)).toBe(25);
		expect(evaluate(s.stroke!.width, 15 * F)).toBe(6);
		// keyframe.update / keyframe.remove find the keys by id (clipAnimatables covers shape.*).
		const kid = s.size.keyframes[1]!.id;
		h.ok([{ type: 'keyframe.update', keyframeId: kid, value: [400, 400] }]);
		expect(shapeOf(h, id).shape.size.keyframes[1]!.value).toEqual([400, 400]);
		h.ok([{ type: 'keyframe.remove', keyframeIds: [kid] }]);
		expect(shapeOf(h, id).shape.size.keyframes).toHaveLength(1);
		// Razor: both halves keep the keys (content time), the right one starts mid-animation.
		h.ok([{ type: 'clip.split', at: 15, scope: 'all-unlocked' }]);
		const parts = h.clips('V1') as ShapeClip[];
		expect(parts).toHaveLength(2);
		expect(parts[1]!.shape.cornerRadius.keyframes).toHaveLength(2);
	});
});

describe('anchor re-centring (shapes keep their place when their box changes)', () => {
	it('static size and stroke edits keep the geometry centre on screen', () => {
		const h = new Harness();
		const { id } = addShape(
			h,
			{ type: 'rect' },
			{ transform: { position: [500, 300], rotation: 30, scale: 50 } },
		);
		const at0 = centreOnScreen(h, id);
		h.ok([{ type: 'param.set', target: ['clip', id, 'shape', 'size'], value: [900, 120] }]);
		expect(shapeOf(h, id).transform.anchor.value).toEqual([450, 60]);
		expect(centreOnScreen(h, id)).toEqual(at0);
		h.ok([
			{
				type: 'clip.update',
				clipId: id,
				patch: { shape: { stroke: { color: [1, 0, 0, 1], width: 10, position: 'outside' } } },
			},
		]);
		expect(shapeOf(h, id).transform.anchor.value).toEqual([460, 70]);
		const c = centreOnScreen(h, id);
		expect(c[0]).toBeCloseTo(at0[0], 9);
		expect(c[1]).toBeCloseTo(at0[1], 9);
	});

	it('keyframes that grow or shrink the largest size move the anchor (value and keys) by half', () => {
		const h = new Harness();
		const { id } = addShape(h, { type: 'ellipse' });
		h.ok([
			{
				type: 'param.setAnimated',
				target: ['clip', id, 'transform', 'anchor'],
				animated: true,
				at: { sequenceFrame: 0 },
			},
			{
				type: 'param.setAnimated',
				target: ['clip', id, 'shape', 'size'],
				animated: true,
				at: { sequenceFrame: 0 },
			},
		]);
		h.ok([
			{
				type: 'param.set',
				target: ['clip', id, 'shape', 'size'],
				value: [1000, 400],
				at: { sequenceFrame: 60 },
			},
		]);
		const a = shapeOf(h, id).transform.anchor;
		expect(a.keyframes.map((k) => k.value)).toEqual([[500, 200]]);
		expect(centreOnScreen(h, id, 0)).toEqual([960, 540]);
		expect(centreOnScreen(h, id, 60)).toEqual([960, 540]);
		const big = shapeOf(h, id).shape.size.keyframes[1]!.id;
		h.ok([{ type: 'keyframe.remove', keyframeIds: [big] }]);
		expect(shapeOf(h, id).transform.anchor.keyframes[0]!.value).toEqual([200, 200]);
		expect(centreOnScreen(h, id, 60)).toEqual([960, 540]);
	});
});

describe('invariants, snapshot, properties and agent schema', () => {
	it('flags colours outside 0..1', () => {
		const h = new Harness();
		const { id } = addShape(h, { type: 'rect' });
		const doc = structuredClone(h.doc);
		(Object.values(doc.sequences)[0]!.clips[id] as ShapeClip).shape.fill!.value = [1.5, 0, 0, 1];
		expect(checkInvariants(doc).map((i) => i.message)).toContainEqual(expect.stringMatching(/colours/));
	});

	it('snapshot carries the unevaluated shape, its box and the Remotion engine', () => {
		const h = new Harness();
		const { id } = addShape(h, {
			type: 'rect',
			stroke: { color: [0, 0, 0, 1], width: 4, position: 'outside' },
		});
		const clip = snapshot(h)
			.videoTracks.flatMap((t) => t.clips)
			.find((c) => c.clipId === id)!;
		expect(clip.source).toEqual({ shape: shapeOf(h, id).shape });
		expect(clip.intrinsicBox).toEqual({ width: 408, height: 408 });
		expect(clip.engine).toBe('remotion');
	});

	it('properties: corner radius for rectangles only; all shape keys are listed for agents', () => {
		const h = new Harness();
		const rect = addShape(h, { type: 'rect' });
		const ell = addShape(h, { type: 'ellipse' }, { at: 150 });
		const keys = (c: Clip) =>
			propertiesForClip(c)
				.map((s) => s.key)
				.filter((k) => k.startsWith('shape.'));
		expect(keys(rect)).toEqual([
			'shape.size',
			'shape.fill',
			'shape.stroke.color',
			'shape.stroke.width',
			'shape.stroke.position',
			'shape.cornerRadius',
		]);
		expect(keys(ell)).not.toContain('shape.cornerRadius');
		const schema = exportAgentSchema(defaultRegistries());
		expect(schema.commands['clip.addShape']).toMatchObject({ implemented: true, owner: 'wp-m2-shapes' });
		const size = schema.properties.find((p) => p.key === 'shape.size');
		expect(size?.kinds).toEqual(['shape']);
		expect(schema.properties.find((p) => p.key === 'shape.cornerRadius')?.kinds).toEqual(['shape']);
	});
});

describe('evaluateShape / shapeContainsPoint (render/shape.ts)', () => {
	it('evaluates and clamps, centres the geometry in the box, drops zero-width strokes', () => {
		const shape = defaultShape('rect', {
			size: [100, 40],
			cornerRadius: 80,
			stroke: { color: [1, 0, 0, 1], width: 0 },
		});
		const g = evaluateShape(shape, 0, { width: 120, height: 60 });
		expect(g).toMatchObject({ size: [100, 40], origin: [10, 10], cornerRadius: 20, stroke: null });
		const ell = defaultShape('ellipse', { cornerRadius: 5 });
		expect(evaluateShape(ell, 0, { width: 400, height: 400 }).cornerRadius).toBe(0);
	});

	it('hit-tests the drawn geometry: ellipse interior, rounded corners and the outer stroke band', () => {
		const ell = evaluateShape(defaultShape('ellipse', { size: [200, 100] }), 0, { width: 200, height: 100 });
		expect(shapeContainsPoint(ell, [100, 50])).toBe(true);
		expect(shapeContainsPoint(ell, [5, 5])).toBe(false); // inside the box, outside the ellipse
		expect(shapeContainsPoint(ell, [199, 50])).toBe(true);
		const rect = defaultShape('rect', {
			size: [100, 100],
			cornerRadius: 30,
			stroke: { color: [0, 0, 0, 1], width: 10, position: 'outside' },
		});
		const g = evaluateShape(rect, 0, shapeIntrinsicBox(rect));
		expect(shapeContainsPoint(g, [5, 5])).toBe(false); // corner cut by the radius
		expect(shapeContainsPoint(g, [2, 60])).toBe(true); // on the outside stroke band
		expect(shapeContainsPoint(g, [60, 60])).toBe(true);
	});
});
