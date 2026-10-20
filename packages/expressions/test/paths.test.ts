// Path methods of shape items (After Effects' Path property: points, inTangents, outTangents, isClosed,
// pointOnPath, tangentOnPath, normalOnPath) and our toLayer / fromLayer space helpers. Expected values come from
// test/geometry.ts (dense sampling, hand-written affine maps), not from the vector kernel.
import type { ShapeClip, ShapeItem, VectorShapeData } from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateExpressionText, loadExpressionEngine, storedTimeAtFrame } from '../src/index.ts';
import { basicDoc, type Doc } from './fixture.ts';
import { along, applyA, type Cub, dist, groupMatrix, line, measure, mulA, type Pt, T } from './geometry.ts';

beforeAll(async () => {
	await loadExpressionEngine();
});

const K = 0.5522847498307936;
const G = { position: [100, 50] as Pt, rotation: 30, scale: [200, 50] as Pt, anchor: [5, -5] as Pt };

function shapeDoc() {
	const d = basicDoc();
	d.tx([
		{
			type: 'clip.addShape',
			at: 0,
			duration: 120,
			track: 'V4',
			name: 'Logo',
			shape: {
				type: 'vector',
				contents: [
					{
						type: 'group',
						name: 'G',
						transform: G,
						contents: [
							{ type: 'rect', name: 'R', size: [200, 100], position: [10, 20] },
							{ type: 'rect', name: 'RR', size: [200, 100], position: [10, 20], direction: 'reversed' },
							{ type: 'ellipse', name: 'E', size: [100, 60] },
							{ type: 'polystar', name: 'S', points: 5, outerRadius: 100, innerRadius: 40 },
							{ type: 'path', name: 'B', path: 'M0 0 C100 0 100 100 200 100' },
							{ type: 'stroke' },
						],
					},
					{ type: 'group', name: 'Flat', transform: { scale: [0, 100] }, contents: [{ type: 'ellipse' }] },
				],
			},
			ref: '$s',
		},
	]);
	return d;
}

/** Evaluates `text` on the title's Source Text (a string property) at `frame`; JSON-decodes the result. */
function ev(d: Doc, text: string, frame = 30): { value: unknown; error: string | null } {
	const ref = { seq: d.seqId, owner: d.refs.$title!, path: 'text.content' };
	const st = evaluateExpressionText(d.doc, ref, `var L = thisComp.layer("Logo");\nJSON.stringify(${text})`, storedTimeAtFrame(d.doc, ref, frame));
	return { value: st.error ? null : JSON.parse(String(st.value)), error: st.error };
}
const val = (d: Doc, text: string, frame = 30) => {
	const r = ev(d, text, frame);
	if (r.error) throw new Error(r.error);
	return r.value as never;
};

// The outlines, built by hand in After Effects' vertex order.
const rect = (w: number, h: number, x: number, y: number): Cub[] => {
	const tr: Pt = [x + w / 2, y - h / 2];
	const br: Pt = [x + w / 2, y + h / 2];
	const bl: Pt = [x - w / 2, y + h / 2];
	const tl: Pt = [x - w / 2, y - h / 2];
	return [line(tr, br), line(br, bl), line(bl, tl), line(tl, tr)];
};
const RECT = rect(200, 100, 10, 20);
const ELLIPSE: Cub[] = (() => {
	const [rx, ry] = [50, 30];
	return [
		[[0, -ry], [rx * K, -ry], [rx, -ry * K], [rx, 0]],
		[[rx, 0], [rx, ry * K], [rx * K, ry], [0, ry]],
		[[0, ry], [-rx * K, ry], [-rx, ry * K], [-rx, 0]],
		[[-rx, 0], [-rx, -ry * K], [-rx * K, -ry], [0, -ry]],
	];
})();
const STAR: Cub[] = (() => {
	const v: Pt[] = [];
	for (let i = 0; i < 10; i++) {
		const a = -Math.PI / 2 + (i * Math.PI) / 5;
		const r = i % 2 ? 40 : 100;
		v.push([r * Math.cos(a), r * Math.sin(a)]);
	}
	return v.map((p, i) => line(p, v[(i + 1) % 10]!));
})();
const BEZ: Cub[] = [
	[
		[0, 0],
		[100, 0],
		[100, 100],
		[200, 100],
	],
];
const reversed = (segs: Cub[]): Cub[] => segs.map((c) => [c[3], c[2], c[1], c[0]] as Cub).reverse();

const item = (name: string) => `L.content("G").content(${JSON.stringify(name)})`;

describe('path methods', { timeout: 120_000 }, () => {
	it('points / inTangents / outTangents / isClosed follow After Effects’ vertex model, in the group’s space', () => {
		const d = shapeDoc();
		expect(val(d, `${item('R')}.path.points()`)).toEqual([
			[110, -30],
			[110, 70],
			[-90, 70],
			[-90, -30],
		]);
		expect(val(d, `${item('R')}.path.inTangents()`)).toEqual([
			[0, 0],
			[0, 0],
			[0, 0],
			[0, 0],
		]);
		expect(val(d, `${item('R')}.path.isClosed()`)).toBe(true);
		// Reversed: same first vertex, the other way round.
		expect(val(d, `${item('RR')}.path.points()`)).toEqual([
			[110, -30],
			[-90, -30],
			[-90, 70],
			[110, 70],
		]);
		const e = val(d, `[${item('E')}.path.points(), ${item('E')}.path.outTangents(), ${item('E')}.path.inTangents()]`) as Pt[][];
		expect(e[0]).toEqual([
			[0, -30],
			[50, 0],
			[0, 30],
			[-50, 0],
		]);
		expect(e[1]![0]![0]).toBeCloseTo(50 * K, 9);
		expect(e[2]![1]![1]).toBeCloseTo(-30 * K, 9);
		expect(val(d, `${item('B')}.path.points()`)).toEqual([
			[0, 0],
			[200, 100],
		]);
		expect(val(d, `[${item('B')}.path.outTangents()[0], ${item('B')}.path.inTangents()[1], ${item('B')}.path.isClosed()]`)).toEqual([
			[100, 0],
			[-100, 0],
			false,
		]);
		expect(val(d, `${item('S')}.path.points().length`)).toBe(10);
		// the property object: AE's name and match name
		expect(val(d, `[${item('B')}.path.name, ${item('B')}.path.matchName]`)).toEqual(['Path', 'ADBE Vector Shape']);
	});

	it('pointOnPath / tangentOnPath / normalOnPath run along arc length within 0.01 px (rect, ellipse, star, bezier, reversed)', () => {
		const d = shapeDoc();
		const cases: [string, Cub[], boolean][] = [
			['R', RECT, true],
			['RR', reversed(RECT), true],
			['E', ELLIPSE, true],
			['S', STAR, true],
			['B', BEZ, false],
		];
		const us = [0, 0.07, 0.25, 0.33, 0.47, 0.61, 0.9, 1];
		for (const [name, segs] of cases) {
			const got = val(d, `[${us.join(', ')}].map(function (u) { var p = ${item(name)}.path; return [p.pointOnPath(u), p.tangentOnPath(u), p.normalOnPath(u)]; })`) as Pt[][];
			const m = measure(segs);
			us.forEach((u, i) => {
				const ref = m(u);
				expect(dist(got[i]![0]!, ref.p), `${name} @${u}`).toBeLessThan(0.01);
				const [tan, nor] = [got[i]![1]!, got[i]![2]!];
				expect(Math.hypot(tan[0], tan[1])).toBeCloseTo(1, 9);
				expect(nor[0]).toBeCloseTo(-tan[1], 12);
				expect(nor[1]).toBeCloseTo(tan[0], 12);
				// away from vertices the tangent matches the curve direction
				if (u > 0 && u < 1 && name !== 'S') expect(dist(tan, ref.tan), `${name} tangent @${u}`).toBeLessThan(1e-3);
			});
		}
		// rect: a quarter of the way is 50 px into the bottom edge (100 down the right edge first), heading left
		expect(val(d, `${item('R')}.path.pointOnPath(0.25)`)).toEqual([60, 70]);
		expect(val(d, `${item('R')}.path.tangentOnPath(0.25)`)).toEqual([-1, 0]);
		expect(val(d, `${item('R')}.path.normalOnPath(0.25)`)).toEqual([0, -1]);
		// default percentage 0.5; out-of-range percentages clamp (After Effects clamps, closed paths do not wrap)
		expect(val(d, `${item('B')}.path.pointOnPath()`)).toEqual(val(d, `${item('B')}.path.pointOnPath(0.5)`));
		expect(val(d, `${item('R')}.path.pointOnPath(1.25)`)).toEqual([110, -30]);
		expect(val(d, `${item('B')}.path.pointOnPath(-3)`)).toEqual([0, 0]);
		expect(val(d, `${item('B')}.path.pointOnPath(7)`)).toEqual([200, 100]);
	});

	it('animated paths evaluate at t (default time); toLayer / fromLayer map the group space to layer pixels', () => {
		const d = shapeDoc();
		const clip = d.doc.sequences[d.seqId]!.clips[d.refs.$s!] as ShapeClip;
		const g = (clip.shape as VectorShapeData).contents[0] as Extract<ShapeItem, { type: 'group' }>;
		const r = g.contents[0]!.id;
		d.tx([
			{ type: 'keyframe.add', target: ['clip', '$s', 'shape', 'items', r, 'size'], at: { frames: 0 }, value: [200, 100], interpolation: 'linear' },
			{ type: 'keyframe.add', target: ['clip', '$s', 'shape', 'items', r, 'size'], at: { frames: 60 }, value: [400, 300], interpolation: 'linear' },
		]);
		expect(val(d, `${item('R')}.path.points()[0]`, 30)).toEqual([160, -80]);
		expect(val(d, `${item('R')}.path.points(2)[0]`, 30)).toEqual([210, -130]);
		expect(val(d, `${item('R')}.path.points(0)[0]`, 30)).toEqual([110, -30]);
		const p30 = val(d, `${item('R')}.path.pointOnPath(0.25)`, 30) as Pt;
		expect(dist(p30, along(rect(300, 200, 10, 20), 0.25).p)).toBeLessThan(0.01);
		expect(dist(val(d, `${item('R')}.path.pointOnPath(0.25, 2)`, 30) as Pt, along(rect(400, 300, 10, 20), 0.25).p)).toBeLessThan(0.01);

		// group G's contents space → layer pixels: the group transform, then the layer box centre (1920×1080 frame).
		const M = mulA(T(960, 540), groupMatrix(G));
		const pts: Pt[] = [
			[0, 0],
			[37, -12],
		];
		for (const p of pts) {
			const got = val(d, `${item('R')}.toLayer(${JSON.stringify(p)})`) as Pt;
			expect(dist(got, applyA(M, p))).toBeLessThan(1e-9);
			expect(dist(val(d, `${item('R')}.fromLayer(${JSON.stringify(got)})`) as Pt, p)).toBeLessThan(1e-9);
		}
		const v = val(d, `${item('R')}.toLayerVec([1, 0])`) as Pt;
		expect(dist(v, [M[0], M[1]])).toBeLessThan(1e-12);
		// the group itself lives at the top level: its space is the layer's contents (centred on the box)
		expect(val(d, 'L.content("G").toLayer([0, 0])')).toEqual([960, 540]);
	});

	it('bad arguments are expression errors, never crashes; evaluation carries on afterwards', () => {
		const d = shapeDoc();
		expect(ev(d, `${item('R')}.path.pointOnPath(NaN)`).error).toMatch(/pointOnPath: percentage must be a finite number/);
		expect(ev(d, `${item('R')}.path.tangentOnPath("half")`).error).toMatch(/finite number/);
		expect(ev(d, `${item('R')}.path.points(Infinity)`).error).toMatch(/points: time must be a finite number/);
		expect(ev(d, `${item('R')}.toLayer([1])`).error).toMatch(/toLayer: expected a point/);
		expect(ev(d, `${item('R')}.trimPath()`).error).toMatch(/is not a Trim Paths/);
		expect(ev(d, 'L.content("Flat").content(1).fromLayer([0, 0])').error).toMatch(/not invertible/);
		expect(ev(d, 'L.content("G").path.points()').error).not.toBeNull();
		expect(ev(d, 'createPath([[0, 0]], [], [], false)').error).toMatch(/createPath\(\): no property takes a path value/);
		expect(ev(d, 'thisLayer.content("x")').error).toMatch(/not a shape/);
		expect(val(d, `${item('R')}.path.pointOnPath(0.25)`)).toEqual([60, 70]);
	});

	it('bounds the measured size: a path of more than 50 000 segments is refused with an error', () => {
		const d = basicDoc();
		d.tx([
			{
				type: 'clip.addShape',
				at: 0,
				track: 'V4',
				name: 'Logo',
				shape: {
					type: 'vector',
					contents: [
						{ type: 'polystar', name: 'Dense', points: 100, outerRadius: 100, innerRadius: 90 },
						{ type: 'repeater', copies: 300 },
						{ type: 'trim', name: 'T', mode: 'individual' },
						{ type: 'stroke' },
					],
				},
			},
		]);
		expect(ev(d, 'L.content("T").trimPath().pointOnPath(0.5)').error).toMatch(/at most 50000/);
		expect(val(d, 'L.content("Dense").path.points().length')).toBe(200);
	});
});
