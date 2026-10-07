// Vector shape commands (wp shapes): clip.addShape {type: 'vector'}, shape.* item commands, property keys through
// param.set / keyframes, conversion of rectangles and ellipses, presets, invariants and repair.
import { describe, expect, it } from 'vitest';
import {
	applyMatrix,
	buildRenderSnapshot,
	checkInvariants,
	evaluate,
	evaluateShape,
	evaluateVectorShape,
	flicksPerFrame,
	type LegacyShapeData,
	propertiesForClip,
	repairDocument,
	resolveSceneAt,
	SHAPE_PRESETS,
	type ShapeClip,
	type ShapeItem,
	shapeGeom,
	type Vec2,
	type VectorShapeData,
} from '../../src/index.ts';
import { createCounterIdSource } from '../../src/ids.ts';
import { Harness } from '../helpers.ts';

const F = flicksPerFrame({ num: 30, den: 1 });

function addVector(h: Harness, shape: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	const r = h.ok([{ type: 'clip.addShape', at: 0, track: 'V1', shape: { type: 'vector', ...shape }, ref: '$s', ...extra }]);
	return r.refs.$s!;
}
const clipOf = (h: Harness, id: string) => h.seq.clips[id] as ShapeClip;
const contentsOf = (h: Harness, id: string) => (clipOf(h, id).shape as VectorShapeData).contents;
const snapshot = (h: Harness) => buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });

describe('clip.addShape type vector', () => {
	it('creates a frame-sized layer whose contents sit around the frame centre', () => {
		const h = new Harness();
		const id = addVector(h, {
			contents: [
				{ type: 'rect', size: [200, 100] },
				{ type: 'stroke', color: '#ff0000', width: 4 },
				{ type: 'fill', color: [0, 0, 1, 1] },
			],
		});
		const c = clipOf(h, id);
		expect(c.name).toBe('Shape');
		expect(c.transform.anchor.value).toEqual([960, 540]);
		expect(c.transform.position.value).toEqual([960, 540]);
		const items = contentsOf(h, id);
		expect(items.map((i) => [i.type, i.name])).toEqual([
			['rect', 'Rectangle Path 1'],
			['stroke', 'Stroke 1'],
			['fill', 'Fill 1'],
		]);
		expect(items[1]).toMatchObject({ color: { value: [1, 0, 0, 1] }, width: { value: 4 } });
		expect(items.every((i) => i.id.startsWith('shp_'))).toBe(true);
		const layer = resolveSceneAt(snapshot(h), 0).find((l) => l.clip.clipId === id)!;
		expect(layer.props.box).toEqual({ width: 1920, height: 1080 });
		// Content (0, 0) = box centre lands on the position.
		expect(applyMatrix(layer.props.matrix, [960, 540])).toEqual([960, 540]);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('takes a preset and refuses rect fields, unknown presets and bad items', () => {
		const h = new Harness();
		const id = addVector(h, { preset: 'star' });
		expect(contentsOf(h, id).map((i) => i.type)).toEqual(['polystar', 'fill']);
		for (const bad of [
			{ type: 'vector', size: [1, 1] },
			{ type: 'vector', preset: 'nope' },
			{ type: 'vector', contents: [{ type: 'rect', size: [-5, 10] }] },
			{ type: 'vector', contents: [{ type: 'fill', color: [2, 0, 0, 1] }] },
			{ type: 'vector', contents: [{ type: 'rect', bogus: 1 }] },
			{ type: 'rect', contents: [] },
		]) {
			const r = h.tx([{ type: 'clip.addShape', at: 200, track: 'V1', shape: bad }]);
			expect(r.ok, JSON.stringify(bad)).toBe(false);
		}
	});

	it('builds every preset into valid contents', () => {
		for (const p of SHAPE_PRESETS) {
			const h = new Harness();
			const r = h.tx([{ type: 'clip.addShape', at: 0, track: 'V1', shape: { type: 'vector', preset: p.id }, ref: '$s' }]);
			if (!r.ok) throw new Error(`${p.id}: ${JSON.stringify(r.errors)}`);
			const id = r.refs.$s!;
			expect(contentsOf(h, id).length, p.id).toBeGreaterThan(0);
			expect(checkInvariants(h.doc), p.id).toEqual([]);
			const draws = evaluateVectorShape(contentsOf(h, id), 0.5 * 30 * F);
			expect(draws.length, p.id).toBeGreaterThan(0);
		}
	});

	it('expands SVG path data with several subpaths into several path items', () => {
		const h = new Harness();
		const id = addVector(h, {
			contents: [{ type: 'path', path: 'M0 0 L10 0 L10 10 Z M20 20 h5 v5 z' }, { type: 'fill', fillRule: 'evenodd' }],
		});
		const items = contentsOf(h, id);
		expect(items.map((i) => i.type)).toEqual(['path', 'path', 'fill']);
		const p = items[1] as Extract<ShapeItem, { type: 'path' }>;
		expect(p.path.value.closed).toBe(true);
		expect(p.path.value.vertices.map((v) => v.p)).toEqual([[20, 20], [25, 20], [25, 25]]);
	});
});

describe('shape item commands', () => {
	const setup = () => {
		const h = new Harness();
		const id = addVector(h, { contents: [{ type: 'ellipse', size: [100, 100] }, { type: 'fill', color: '#00ff00' }] });
		return { h, id };
	};

	it('adds, groups, moves, duplicates and removes items', () => {
		const { h, id } = setup();
		const add = h.ok([{ type: 'shape.addItems', clipId: id, items: [{ type: 'trim', end: 50 }], ref: '$t' }]);
		const trimId = add.refs.$t!;
		expect(contentsOf(h, id).map((i) => i.type)).toEqual(['ellipse', 'fill', 'trim']);
		const [e, f] = contentsOf(h, id);
		const g = h.ok([{ type: 'shape.groupItems', clipId: id, itemIds: [f!.id, e!.id], ref: '$g' }]).refs.$g!;
		let top = contentsOf(h, id);
		expect(top.map((i) => i.type)).toEqual(['group', 'trim']);
		expect((top[0] as Extract<ShapeItem, { type: 'group' }>).contents.map((i) => i.id)).toEqual([e!.id, f!.id]);
		h.ok([{ type: 'shape.moveItem', clipId: id, itemId: trimId, parentId: g, index: 1 }]);
		top = contentsOf(h, id);
		expect((top[0] as Extract<ShapeItem, { type: 'group' }>).contents.map((i) => i.type)).toEqual(['ellipse', 'trim', 'fill']);
		expect(h.tx([{ type: 'shape.moveItem', clipId: id, itemId: g, parentId: g, index: 0 }]).ok).toBe(false);
		const dup = h.ok([{ type: 'shape.duplicateItem', clipId: id, itemId: g, ref: '$d' }]).refs.$d!;
		top = contentsOf(h, id);
		expect(top[0]!.id).toBe(dup);
		expect(top[0]!.name).toBe('Group 2');
		expect(checkInvariants(h.doc)).toEqual([]);
		h.ok([{ type: 'shape.removeItems', clipId: id, itemIds: [g, trimId] }]);
		expect(contentsOf(h, id).map((i) => i.id)).toEqual([dup]);
		expect(h.tx([{ type: 'shape.removeItems', clipId: id, itemIds: ['shp_missing'] }]).ok).toBe(false);
	});

	it('updates items: static values, enums, dashes / taper / wave, validation', () => {
		const h = new Harness();
		const id = addVector(h, { contents: [{ type: 'path', path: 'M0 0 L100 0' }, { type: 'stroke' }] });
		const st = contentsOf(h, id)[1]!;
		h.ok([
			{
				type: 'shape.updateItem',
				clipId: id,
				itemId: st.id,
				patch: { width: 12, lineCap: 'round', dashes: [10, 5, 2], taper: { startLength: 30 }, wave: { amount: 50 }, name: 'Outline' },
			},
		]);
		const s = contentsOf(h, id)[1] as Extract<ShapeItem, { type: 'stroke' }>;
		expect(s.name).toBe('Outline');
		expect(s.width.value).toBe(12);
		expect(s.lineCap).toBe('round');
		expect(s.dashes!.segments.map((x) => [x.dash.value, x.gap.value])).toEqual([
			[10, 5],
			[2, 2],
		]);
		expect(s.taper!.startLength.value).toBe(30);
		expect(s.taper!.units).toBe('percent');
		expect(s.wave!.amount.value).toBe(50);
		h.ok([{ type: 'shape.updateItem', clipId: id, itemId: st.id, patch: { dashes: null, enabled: false } }]);
		expect(contentsOf(h, id)[1]).toMatchObject({ dashes: null, enabled: false });
		for (const patch of [{ lineCap: 'pointy' }, { width: -3 }, { roundness: 3 }, { color: 'red' }])
			expect(h.tx([{ type: 'shape.updateItem', clipId: id, itemId: st.id, patch }]).ok, JSON.stringify(patch)).toBe(false);
	});

	it('animates item fields through param.set and the keyframe commands', () => {
		const h = new Harness();
		const id = addVector(h, { contents: [{ type: 'rect' }, { type: 'fill' }] });
		const rect = contentsOf(h, id)[0]!;
		const target = ['clip', id, 'shape', 'items', rect.id, 'size'];
		h.ok([{ type: 'param.setAnimated', target, animated: true, at: { sequenceFrame: 0 } }]);
		h.ok([{ type: 'param.set', target, value: [300, 50], at: { sequenceFrame: 30 } }]);
		const r = contentsOf(h, id)[0] as Extract<ShapeItem, { type: 'rect' }>;
		expect(r.size.keyframes.map((k) => k.value)).toEqual([
			[100, 100],
			[300, 50],
		]);
		expect(evaluate(r.size, 15 * F)).toEqual([200, 75]);
		// The keyframe machinery sees the property (move, remove).
		const kf = r.size.keyframes[1]!.id;
		h.ok([{ type: 'keyframe.move', keyframeIds: [kf], delta: { frames: 10 } }]);
		expect((contentsOf(h, id)[0] as Extract<ShapeItem, { type: 'rect' }>).size.keyframes[1]!.time).toBe(40 * F);
		// Ranges clamp, wrong kinds fail.
		const round = ['clip', id, 'shape', 'items', rect.id, 'roundness'];
		const res = h.ok([{ type: 'param.set', target: round, value: -5 }]);
		expect(res.warnings.some((w) => w.code === 'W_VALUE_CLAMPED')).toBe(true);
		expect(h.tx([{ type: 'param.set', target: [...round.slice(0, 5), 'nope'], value: 1 }]).ok).toBe(false);
		// Specs are listed for the clip (agent schema / Effect Controls).
		const keys = propertiesForClip(clipOf(h, id)).map((s) => s.key);
		expect(keys).toContain(`shape.items.${rect.id}.size`);
		expect(keys).not.toContain('shape.size');
	});

	it('animates paths and gradients between keyframes', () => {
		const h = new Harness();
		const id = addVector(h, {
			contents: [
				{ type: 'path', path: 'M0 0 L100 0 L100 100 Z' },
				{ type: 'gradientFill', gradientType: 'radial', endPoint: [50, 0] },
			],
		});
		const [p, g] = contentsOf(h, id);
		const pt = ['clip', id, 'shape', 'items', p!.id, 'path'];
		h.ok([{ type: 'param.setAnimated', target: pt, animated: true, at: { sequenceFrame: 0 } }]);
		h.ok([
			{
				type: 'param.set',
				target: pt,
				value: { closed: true, vertices: [[0, 0], [200, 0], [200, 200], [0, 200]].map((p) => ({ p, in: [0, 0], out: [0, 0] })) },
				at: { sequenceFrame: 10 },
			},
		]);
		const path = (contentsOf(h, id)[0] as Extract<ShapeItem, { type: 'path' }>).path;
		expect(path.keyframes[0]!.interpolation).toBe('linear');
		const mid = evaluate(path, 5 * F);
		expect(mid.vertices).toHaveLength(4);
		// Interpolated by the shared mask/shape path interpolation (vertex correspondence, path/interp.ts).
		const xs = mid.vertices.map((v) => v.p[0]);
		expect(Math.max(...xs)).toBeGreaterThan(100);
		expect(Math.max(...xs)).toBeLessThan(200);
		// A malformed path is refused.
		expect(h.tx([{ type: 'param.set', target: pt, value: { closed: false, vertices: [{ p: [0, 'x'] }] } }]).ok).toBe(false);
		const gt = ['clip', id, 'shape', 'items', g!.id, 'colors'];
		h.ok([{ type: 'param.setAnimated', target: gt, animated: true, at: { sequenceFrame: 0 } }]);
		h.ok([
			{
				type: 'param.set',
				target: gt,
				value: { colors: [{ position: 0, color: [1, 0, 0] }, { position: 0.5, color: [0, 1, 0] }, { position: 1, color: [0, 0, 1] }], opacities: [{ position: 0, opacity: 1 }] },
				at: { sequenceFrame: 10 },
			},
		]);
		const colors = (contentsOf(h, id)[1] as Extract<ShapeItem, { type: 'gradientFill' }>).colors;
		const m = evaluate(colors, 5 * F);
		expect(m.colors.length).toBeGreaterThanOrEqual(3);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('shape.convertToVector', () => {
	it('keeps the picture: geometry, paint, keyframes and screen position', () => {
		const h = new Harness();
		const r = h.ok([
			{
				type: 'clip.addShape',
				at: 0,
				track: 'V1',
				shape: { type: 'rect', size: [300, 120], cornerRadius: 20, stroke: { color: [1, 0, 0, 1], width: 6, position: 'outside' } },
				transform: { position: [400, 300] },
				ref: '$s',
			},
		]);
		const id = r.refs.$s!;
		h.ok([{ type: 'param.setAnimated', target: ['clip', id, 'shape', 'size'], animated: true, at: { sequenceFrame: 0 } }]);
		h.ok([{ type: 'param.set', target: ['clip', id, 'shape', 'size'], value: [400, 200], at: { sequenceFrame: 20 } }]);
		const before = resolveSceneAt(snapshot(h), 10).find((l) => l.clip.clipId === id)!;
		const legacy = clipOf(h, id).shape as LegacyShapeData;
		const g = evaluateShape(legacy, 10 * F, before.props.box);
		const centreBefore = applyMatrix(before.props.matrix, [g.origin[0] + g.size[0] / 2, g.origin[1] + g.size[1] / 2]);
		h.ok([{ type: 'shape.convertToVector', clipId: id }]);
		const c = clipOf(h, id);
		expect(c.shape.type).toBe('vector');
		const items = contentsOf(h, id);
		expect(items.map((i) => i.type)).toEqual(['rect', 'stroke', 'fill']);
		expect(items[1]).toMatchObject({ position: 'outside', width: { value: 6 } });
		const after = resolveSceneAt(snapshot(h), 10).find((l) => l.clip.clipId === id)!;
		expect(after.props.box).toEqual({ width: 1920, height: 1080 });
		const centreAfter = applyMatrix(after.props.matrix, [960, 540]);
		expect(centreAfter[0]).toBeCloseTo(centreBefore[0], 6);
		expect(centreAfter[1]).toBeCloseTo(centreBefore[1], 6);
		const draws = evaluateVectorShape(items, 10 * F);
		const b = shapeGeom.pathBounds(draws.find((d) => d.kind === 'fill')!.paths)!;
		expect([b.x1 - b.x0, b.y1 - b.y0]).toEqual(g.size as Vec2);
		// Legacy commands are refused on vector shapes and vice versa.
		expect(h.tx([{ type: 'clip.update', clipId: id, patch: { shape: { fill: null } } }]).ok).toBe(false);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('invariants and repair', () => {
	it('flags malformed items and duplicate ids; repair fixes them', () => {
		const h = new Harness();
		const id = addVector(h, { contents: [{ type: 'rect' }, { type: 'fill' }] });
		const doc = JSON.parse(JSON.stringify(h.doc));
		const clip = Object.values(doc.sequences as Record<string, { clips: Record<string, ShapeClip> }>)[0]!.clips[id]!;
		const items = (clip.shape as VectorShapeData).contents;
		items[1]!.id = items[0]!.id;
		const bad = JSON.parse(JSON.stringify(items[0])) as { id: string; size: { value: number[] } };
		bad.id = 'shp_bad';
		bad.size.value = [-5, 10];
		items.push(bad as never);
		const issues = checkInvariants(doc);
		expect(issues.some((i) => i.invariant === 'INV-001')).toBe(true);
		expect(issues.some((i) => i.invariant === 'INV-012')).toBe(true);
		const { document, report } = repairDocument(doc, createCounterIdSource(99));
		expect(report.map((r) => r.action)).toEqual(expect.arrayContaining(['drop-shape-item', 'reid-shape-item']));
		expect(checkInvariants(document)).toEqual([]);
	});
});
