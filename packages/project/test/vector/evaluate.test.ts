import { describe, expect, it } from 'vitest';
import {
	buildShapeItems,
	checkInvariants,
	evaluateVectorShape,
	FLICKS_PER_SECOND,
	planIsCssExact,
	type ShapeClip,
	type ShapeItem,
	shapeBoolean,
	shapeGeom,
	shapeItemMatrix,
	shapeItemsText,
	type VectorShapeData,
	vectorRenderPlan,
	vectorShapeBounds,
	vectorShapeContainsPoint,
	vectorShapeIsTimeDependent,
} from '../../src/index.ts';
import { ellipseShapePath, polystarShapePath, rectShapePath } from '../../src/vector/primitives.ts';
import { Harness } from '../helpers.ts';

let n = 0;
const ids = { item: () => `shp_${n++}`, keyframe: () => `kf_${n++}` };
const build = (items: unknown[]) => buildShapeItems(items, ids);
const len = (p: shapeGeom.BezPath) => shapeGeom.pathLength(p);

describe('primitives', () => {
	it('rectangles start at the top right and run clockwise; reversed runs the other way', () => {
		const r = rectShapePath([100, 50], [0, 0], 0);
		expect(r[0]!.segs[0]![0]).toEqual([50, -25]);
		expect(r[0]!.segs[0]![3]).toEqual([50, 25]);
		expect(shapeGeom.signedArea(r)).toBeCloseTo(5000, 9);
		expect(shapeGeom.signedArea(rectShapePath([100, 50], [0, 0], 0, 'reversed'))).toBeCloseTo(-5000, 9);
		const rr = rectShapePath([100, 50], [0, 0], 1000);
		expect(Math.abs(shapeGeom.signedArea(rr))).toBeCloseTo(50 * 50 + Math.PI * 625, -1);
	});
	it('ellipses start at the top; polystars have 2n vertices with the first point up', () => {
		const e = ellipseShapePath([100, 60], [10, 0]);
		expect(e[0]!.segs[0]![0]).toEqual([10, -30]);
		const s = polystarShapePath({
			star: true,
			points: 5,
			position: [0, 0],
			rotation: 0,
			innerRadius: 20,
			outerRadius: 50,
			innerRoundness: 0,
			outerRoundness: 0,
		});
		expect(s[0]!.segs).toHaveLength(10);
		expect(s[0]!.segs[0]![0][0]).toBeCloseTo(0, 9);
		expect(s[0]!.segs[0]![0][1]).toBeCloseTo(-50, 9);
		const p = polystarShapePath({
			star: false,
			points: 6,
			position: [0, 0],
			rotation: 30,
			innerRadius: 0,
			outerRadius: 50,
			innerRoundness: 0,
			outerRoundness: 50,
		});
		expect(p[0]!.segs).toHaveLength(6);
		expect(p[0]!.segs.every((c) => !shapeGeom.isLine(c))).toBe(true);
	});
});

describe('stacking', () => {
	it('a Trim Paths below a stroke still trims it; paths below a paint are not painted by it', () => {
		const items = build([
			{ type: 'path', path: 'M0 0 L100 0' },
			{ type: 'stroke', width: 2 },
			{ type: 'trim', end: 50 },
			{ type: 'rect', size: [10, 10] },
		]);
		const d = evaluateVectorShape(items, 0);
		expect(d).toHaveLength(1);
		expect(len(d[0]!.paths)).toBeCloseTo(50, 3);
	});

	it('operators reach the paths of nested groups (in the group space they live in)', () => {
		const items = build([
			{
				type: 'group',
				contents: [{ type: 'path', path: 'M0 0 L100 0' }, { type: 'stroke' }],
				transform: { scale: [200, 200] },
			},
			{ type: 'trim', end: 25 },
		]);
		const d = evaluateVectorShape(items, 0);
		// The group doubles the 100 px line; a quarter of 200 px is drawn.
		expect(len(d[0]!.paths)).toBeCloseTo(50, 3);
		expect(d[0]!.xf).toEqual([2, 0, 0, 2, 0, 0]);
	});

	it('items higher in the list draw on top; composite "above" lifts a paint over the paints before it', () => {
		const items = build([
			{ type: 'rect' },
			{ type: 'stroke', color: '#00ff00' },
			{ type: 'fill', color: '#ff0000' },
			{ type: 'fill', color: '#0000ff', composite: 'above' },
		]);
		const d = evaluateVectorShape(items, 0);
		expect(d.map((x) => x.paint.type === 'solid' && x.paint.color.slice(0, 3))).toEqual([
			[0, 0, 1],
			[0, 1, 0],
			[1, 0, 0],
		]);
	});

	it('Merge Paths merges the paths above it and drops the paints above it', () => {
		const items = build([
			{ type: 'rect', size: [100, 100] },
			{ type: 'fill', color: '#ff0000' },
			{ type: 'rect', size: [50, 50] },
			{ type: 'mergePaths', mode: 'subtract' },
			{ type: 'fill', color: '#00ff00' },
		]);
		const d = evaluateVectorShape(items, 0);
		expect(d).toHaveLength(1);
		expect(shapeBoolean.filledArea(d[0]!.paths)).toBeCloseTo(7500, 3);
	});

	it('Repeater copies paths and paints with a compounding transform and an opacity ramp', () => {
		const items = build([
			{ type: 'rect', size: [10, 10] },
			{ type: 'fill' },
			{
				type: 'repeater',
				copies: 3,
				transform: { position: [20, 0], rotation: 90, startOpacity: 100, endOpacity: 40 },
			},
			{ type: 'trim', end: 50 },
		]);
		const d = evaluateVectorShape(items, 0);
		expect(d).toHaveLength(3);
		// Below (default): the original on top, later copies under it.
		expect(d.map((x) => Math.round(x.opacity * 100))).toEqual([100, 70, 40]);
		for (const x of d) expect(len(x.paths)).toBeCloseTo(20, 3);
		const cx = d.map((x) => {
			const b = shapeGeom.pathBounds(x.paths)!;
			return Math.round((b.x0 + b.x1) / 2);
		});
		expect(new Set(cx).size).toBe(3);
		// Fractional copies: the last copy's opacity scales by the fraction.
		const frac = evaluateVectorShape(
			build([{ type: 'rect' }, { type: 'fill' }, { type: 'repeater', copies: 2.5 }]),
			0,
		);
		expect(frac).toHaveLength(3);
		expect(frac[2]!.opacity).toBeCloseTo(0.5, 9);
	});

	it('group opacity multiplies; a group blend mode chains the group (copies are separate instances)', () => {
		const items = build([
			{
				type: 'group',
				blendMode: 'multiply',
				transform: { opacity: 50 },
				contents: [{ type: 'rect' }, { type: 'fill', opacity: 50 }],
			},
			{ type: 'repeater', copies: 2 },
		]);
		const d = evaluateVectorShape(items, 0);
		expect(d.map((x) => x.opacity)).toEqual([0.25, 0.25]);
		expect(d[0]!.groups[0]!.blend).toBe('multiply');
		expect(d[0]!.groups[0]!.key).not.toBe(d[1]!.groups[0]!.key);
	});

	it('disabled items are skipped; paths honour their direction for trims', () => {
		const items = build([
			{ type: 'path', path: 'M0 0 L100 0', direction: 'reversed' },
			{ type: 'stroke' },
			{ type: 'fill', enabled: false },
			{ type: 'trim', end: 10 },
		]);
		const d = evaluateVectorShape(items, 0);
		expect(d).toHaveLength(1);
		const b = shapeGeom.pathBounds(d[0]!.paths)!;
		expect(b.x0).toBeCloseTo(90, 6);
	});
});

describe('render plan', () => {
	it('inside / outside strokes clip / cut with the geometry; CSS-exact detection', () => {
		const items = build([
			{ type: 'rect' },
			{ type: 'stroke', position: 'outside', width: 4 },
			{ type: 'fill', blendMode: 'dissolve' },
		]);
		const plan = vectorRenderPlan(evaluateVectorShape(items, 0));
		expect(plan.map((p) => p.kind)).toEqual(['fill', 'stroke']);
		expect(plan[1]!.cut).toBeTruthy();
		expect(plan[1]!.stroke!.width).toBe(8);
		expect(planIsCssExact(plan)).toBe(false);
		const css = vectorRenderPlan(
			evaluateVectorShape(build([{ type: 'rect' }, { type: 'fill', blendMode: 'multiply' }]), 0),
		);
		expect(planIsCssExact(css)).toBe(true);
	});
	it('tapered and waved strokes become fill outlines', () => {
		const items = build([
			{ type: 'path', path: 'M0 0 L200 0' },
			{ type: 'stroke', width: 20, taper: { units: 'pixels', startLength: 100, startWidth: 0 } },
		]);
		const plan = vectorRenderPlan(evaluateVectorShape(items, 0));
		expect(plan[0]!.stroke).toBeNull();
		expect(plan[0]!.d.length).toBeGreaterThan(10);
	});
});

describe('queries', () => {
	it('bounds, hit-testing, item matrices and text summaries', () => {
		const items = build([
			{
				type: 'group',
				name: 'G',
				transform: { position: [100, 0] },
				contents: [{ type: 'ellipse', size: [50, 50] }, { type: 'stroke', width: 10 }, { type: 'fill' }],
			},
		]);
		const d = evaluateVectorShape(items, 0);
		const b = vectorShapeBounds(d)!;
		expect(b.x0).toBeLessThanOrEqual(70);
		expect(b.x1).toBeGreaterThanOrEqual(130);
		expect(vectorShapeContainsPoint(d, [100, 0])).toBe(true);
		expect(vectorShapeContainsPoint(d, [128, 0])).toBe(true); // stroke band
		expect(vectorShapeContainsPoint(d, [140, 0])).toBe(false);
		const g = items[0] as Extract<ShapeItem, { type: 'group' }>;
		expect(shapeItemMatrix(items, g.contents[0]!.id, 0)).toEqual([1, 0, 0, 1, 100, 0]);
		expect(shapeItemsText(items)).toBe('G {Ellipse Path 1, Stroke 1, Fill 1}');
	});
	it('time dependence: keyframes, expressions and self-animating Wiggle Paths', () => {
		expect(vectorShapeIsTimeDependent(build([{ type: 'rect' }, { type: 'fill' }]))).toBe(false);
		expect(vectorShapeIsTimeDependent(build([{ type: 'rect' }, { type: 'wiggle' }]))).toBe(true);
		expect(vectorShapeIsTimeDependent(build([{ type: 'rect' }, { type: 'wiggle', speed: 0 }]))).toBe(false);
		const keyed = build([
			{
				type: 'rect',
				size: {
					value: [1, 1],
					keyframes: [
						{
							id: 'k',
							time: 0,
							value: [1, 1],
							interpolation: 'linear',
							easeIn: { influence: 0.3, slope: 0 },
							easeOut: { influence: 0.3, slope: 0 },
						},
					],
				},
			},
		]);
		expect(vectorShapeIsTimeDependent(keyed)).toBe(true);
		const w = build([{ type: 'rect', size: [100, 100] }, { type: 'wiggle', size: 20 }, { type: 'fill' }]);
		const a = evaluateVectorShape(w, 0);
		const b = evaluateVectorShape(w, FLICKS_PER_SECOND / 3);
		expect(a[0]!.paths).not.toEqual(b[0]!.paths);
	});
});

describe('shape.convertToPath', () => {
	it('turns a polystar into a path with the same geometry at that time', () => {
		const h = new Harness();
		const r = h.ok([
			{
				type: 'clip.addShape',
				at: 0,
				track: 'V1',
				shape: { type: 'vector', contents: [{ type: 'polystar', direction: 'reversed' }, { type: 'fill' }] },
				ref: '$s',
			},
		]);
		const id = r.refs.$s!;
		const contents = () => ((h.seq.clips[id] as ShapeClip).shape as VectorShapeData).contents;
		const before = evaluateVectorShape(contents(), 0)[0]!.paths;
		const star = contents()[0]!;
		h.ok([{ type: 'shape.convertToPath', clipId: id, itemId: star.id }]);
		expect(contents()[0]!.type).toBe('path');
		const after = evaluateVectorShape(contents(), 0)[0]!.paths;
		expect(shapeGeom.toSvgPath(after)).toBe(shapeGeom.toSvgPath(before));
		expect(h.tx([{ type: 'shape.convertToPath', clipId: id, itemId: contents()[1]!.id }]).ok).toBe(false);
	});
});

describe('shape.editPath', () => {
	it('moves, inserts, converts, removes and closes vertices; keyframed paths get keys', () => {
		const h = new Harness();
		const r = h.ok([
			{
				type: 'clip.addShape',
				at: 0,
				track: 'V1',
				shape: {
					type: 'vector',
					contents: [{ type: 'path', path: 'M0 0 L100 0 L100 100' }, { type: 'stroke' }],
				},
				ref: '$s',
			},
		]);
		const id = r.refs.$s!;
		const clip = () => h.seq.clips[id] as ShapeClip;
		const path = () =>
			((clip().shape as VectorShapeData).contents[0] as Extract<ShapeItem, { type: 'path' }>).path;
		const itemId = (clip().shape as VectorShapeData).contents[0]!.id;
		const edit = (ops: unknown[], extra: Record<string, unknown> = {}) =>
			h.ok([{ type: 'shape.editPath', clipId: id, itemId, ops, ...extra }]);
		edit([{ op: 'moveVertices', vertices: [1], delta: [10, 5] }]);
		expect(path().value.vertices[1]!.p).toEqual([110, 5]);
		edit([{ op: 'insertVertex', segment: 0, t: 0.5 }]);
		expect(path().value.vertices).toHaveLength(4);
		edit([{ op: 'convert', vertices: [1], to: 'smooth' }]);
		expect(path().value.vertices[1]!.out).not.toEqual([0, 0]);
		edit([{ op: 'setClosed', closed: true }]);
		expect(path().value.closed).toBe(true);
		edit([{ op: 'removeVertices', vertices: [1] }]);
		expect(path().value.vertices).toHaveLength(3);
		expect(
			h.tx([{ type: 'shape.editPath', clipId: id, itemId, ops: [{ op: 'removeVertices', vertices: [0] }] }])
				.ok,
		).toBe(false);
		expect(
			h.tx([
				{
					type: 'shape.editPath',
					clipId: id,
					itemId,
					ops: [{ op: 'addFeatherPoint', point: { segment: 0, t: 0.5, radius: 3, tension: 0 } }],
				},
			]).ok,
		).toBe(false);
		h.ok([
			{
				type: 'param.setAnimated',
				target: ['clip', id, 'shape', 'items', itemId, 'path'],
				animated: true,
				at: { sequenceFrame: 0 },
			},
		]);
		edit([{ op: 'moveVertices', vertices: [0], delta: [0, 50] }], { at: { sequenceFrame: 20 } });
		expect(path().keyframes).toHaveLength(2);
		edit([{ op: 'insertVertex', segment: 0, t: 0.5 }]);
		expect(path().keyframes.every((k) => k.value.vertices.length === 4)).toBe(true);
		const st = (clip().shape as VectorShapeData).contents[1]!.id;
		expect(
			h.tx([{ type: 'shape.editPath', clipId: id, itemId: st, ops: [{ op: 'setClosed', closed: false }] }])
				.ok,
		).toBe(false);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});
