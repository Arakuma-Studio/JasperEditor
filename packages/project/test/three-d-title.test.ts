// Spec 19 §9, the model: bevel bands, inflate and backplates on outlines traced from alpha, including thin strokes and
// CJK-like strokes; surfaces; their commands with undo and refusals; animation paths; repair and load.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allAnimatables } from '../src/commands/handlers/keyframe.ts';
import {
	anim,
	type BevelProfile,
	buildRenderSnapshot,
	buildTitleSolid,
	checkInvariants,
	costClassOf,
	createCounterIdSource,
	distanceField,
	ENVIRONMENT_PRESETS,
	FLICKS_PER_SECOND,
	hullShape,
	inflateCurveFn,
	isoShapes,
	type Layer3D,
	layerIsPhysical,
	layerSurfacesAt,
	loopArea,
	MAX_BEVEL_BANDS,
	MAX_SLOTS,
	type MediaHandle,
	type Mesh,
	newLayer3D,
	newSurface,
	offsetShapes,
	plateFaceSlot,
	propertiesForClip,
	repairDocument,
	type Shape2D,
	SLOT_BACK,
	SLOT_BAND0,
	SLOT_FACE,
	SLOT_SIDE,
	type SolidGeometry,
	SURFACE_PRESETS,
	sceneLookAt,
	shapesOfAlpha,
	snapshotGlNeeds,
	solidGeometryAt,
	surfaceAt,
	THREE_D_NEEDS_FLOAT,
	threeDProblem,
	unitBevel,
} from '../src/index.ts';
import { TL_ENV_PRESETS } from '../src/registry/fx/glsl/title-env.ts';
import { Harness } from './helpers.ts';

const PROFILES: BevelProfile[] = ['flat', 'chamfer', 'round', 'cove', 'step', 'inset', 'tube'];
const solidG = (o: Partial<SolidGeometry> = {}): SolidGeometry => ({
	mode: 'extrude',
	depth: 20,
	bevelStyle: 'none',
	bevelDepth: 2,
	holeBevel: 100,
	position: 'inside',
	bands: [],
	inflate: null,
	plates: [],
	...o,
});
const band = (width: number, depth: number, profile: BevelProfile = 'round') => ({
	width,
	depth,
	profile,
	curve: 0,
	segments: 6,
});
const plate = (o: Partial<SolidGeometry['plates'][number]> = {}): SolidGeometry['plates'][number] => ({
	enabled: true,
	shape: 'contour',
	grow: 10,
	depth: 8,
	gap: 0,
	corner: 0,
	fillCounters: false,
	bevelWidth: 0,
	bevelDepth: 0,
	bevelProfile: 'chamfer',
	...o,
});

type Rect = [number, number, number, number];
/** Alpha of filled rectangles with antialiased edges, like a drawn glyph. */
const raster = (w: number, h: number, rects: readonly Rect[]) => {
	const a = new Float32Array(w * h);
	for (const [x0, y0, x1, y1] of rects)
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const cover =
					Math.max(0, Math.min(x + 1, x1) - Math.max(x, x0)) *
					Math.max(0, Math.min(y + 1, y1) - Math.max(y, y0));
				a[y * w + x] = Math.max(a[y * w + x]!, cover * 255);
			}
	return (x: number, y: number) => a[y * w + x]!;
};
const traced = (w: number, h: number, rects: readonly Rect[]) => shapesOfAlpha(w, h, raster(w, h, rects));

/** A CJK-like glyph: a box with crossing hairlines. */
const KANJI: Rect[] = [
	[10, 10, 90, 13],
	[10, 48, 90, 51],
	[10, 87, 90, 90],
	[10, 10, 13, 90],
	[48, 10, 51, 90],
	[87, 10, 90, 90],
	[28, 22, 31, 42],
	[68, 58, 71, 80],
];

const tri = (m: Mesh, t: number) => [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!] as const;
const pos = (m: Mesh, v: number) =>
	[m.vertices[v * 9]!, m.vertices[v * 9 + 1]!, m.vertices[v * 9 + 2]!] as const;
const slotOf = (m: Mesh, v: number) => m.vertices[v * 9 + 8]!;

/**
 * Open edges of a mesh, by position: a closed solid has none. Triangulation drops collinear ring points, so a long cap
 * edge may meet two strip edges: that is a T-junction, not a hole, and such edges are split before counting.
 */
function openEdges(m: Mesh): number {
	// A gap under 0.02 px is rounding of offset rings, not a hole.
	const key = (v: number) =>
		pos(m, v)
			.map((x) => Math.round(x * 50))
			.join(',');
	const pts = new Map<string, readonly [number, number, number]>();
	const count = new Map<string, number>();
	const add = (k1: string, k2: string) => {
		if (k1 === k2) return;
		const k = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
		count.set(k, (count.get(k) ?? 0) + 1);
	};
	for (let t = 0; t < m.indices.length; t += 3) {
		const [a, b, c] = tri(m, t);
		for (const v of [a, b, c]) pts.set(key(v), pos(m, v));
		add(key(a), key(b));
		add(key(b), key(c));
		add(key(c), key(a));
	}
	const open = () => [...count].filter(([, n]) => n % 2).map(([k]) => k.split('|') as [string, string]);
	const list = open();
	if (list.length > 2000) return list.length;
	const verts = [...new Set(list.flat())];
	for (const [k1, k2] of list) {
		const a = pts.get(k1)!;
		const b = pts.get(k2)!;
		const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
		const l2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
		const on = verts
			.map((k) => {
				const p = pts.get(k)!;
				const t = ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / l2;
				const e = Math.hypot(a[0] + d[0] * t - p[0], a[1] + d[1] * t - p[1], a[2] + d[2] * t - p[2]);
				return { k, t, e };
			})
			.filter((q) => q.t > 1e-6 && q.t < 1 - 1e-6 && q.e < 0.03)
			.sort((p, q) => p.t - q.t);
		if (!on.length) continue;
		count.delete(k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`);
		const chain = [k1, ...on.map((q) => q.k), k2];
		for (let i = 0; i + 1 < chain.length; i++) add(chain[i]!, chain[i + 1]!);
	}
	return open().length;
}

/** Normals are finite and unit length. */
function checkNormals(m: Mesh): void {
	for (let v = 0; v < m.vertices.length / 9; v++) {
		const l = Math.hypot(m.vertices[v * 9 + 3]!, m.vertices[v * 9 + 4]!, m.vertices[v * 9 + 5]!);
		expect(Math.abs(l - 1)).toBeLessThan(1e-2);
	}
}

const slots = (m: Mesh) => new Set(Array.from({ length: m.vertices.length / 9 }, (_, v) => slotOf(m, v)));
const inside = (shapes: readonly Shape2D[], x: number, y: number, pad: number) => {
	const f = distanceField(shapes, 4, 0.5)!;
	const i = Math.round((x - f.x0) / f.step);
	const j = Math.round((y - f.y0) / f.step);
	return f.d[j * f.nx + i]! <= pad;
};

describe('bevel profiles (TL-070)', () => {
	it.each(PROFILES)('%s is a connected path from the inner edge to the outer edge', (p) => {
		const pieces = unitBevel(p, 6, 0);
		const pts = pieces.flat();
		expect(pts[0]!.o).toBeCloseTo(0);
		expect(pts[pts.length - 1]!.o).toBeCloseTo(1);
		for (let k = 1; k < pieces.length; k++) {
			const a = pieces[k - 1]![pieces[k - 1]!.length - 1]!;
			const b = pieces[k]![0]!;
			expect(a.o).toBeCloseTo(b.o);
			expect(a.h).toBeCloseTo(b.h);
		}
	});

	it('the curve bends the drop', () => {
		const mid = (c: number) => unitBevel('chamfer', 8, c)[0]![4]!.h;
		expect(mid(0.5)).toBeLessThan(0.5);
		expect(mid(-0.5)).toBeGreaterThan(0.5);
	});
});

describe('solids on traced outlines', () => {
	const square = traced(100, 100, [[10, 10, 90, 90]]);
	const ring = traced(120, 120, [
		[10, 10, 110, 30],
		[10, 90, 110, 110],
		[10, 10, 30, 110],
		[90, 10, 110, 110],
	]);

	it('six bands make a closed solid with one slot per band', () => {
		const g = solidG({ bands: Array.from({ length: 6 }, (_, i) => band(3, 3, PROFILES[i]!)) });
		const m = buildTitleSolid(square, g);
		expect(openEdges(m)).toBe(0);
		checkNormals(m);
		for (const s of [SLOT_FACE, SLOT_SIDE, SLOT_BACK, SLOT_BAND0, SLOT_BAND0 + 5])
			expect(slots(m).has(s)).toBe(true);
	});

	it('inside keeps the silhouette: nothing passes the traced outline', () => {
		const m = buildTitleSolid(ring, solidG({ bands: [band(5, 5), band(3, 2, 'chamfer')] }));
		for (let v = 0; v < m.vertices.length / 9; v++) {
			const [x, y] = pos(m, v);
			expect(inside(ring, x, y, 0.25)).toBe(true);
		}
	});

	it('the face insets by the band width and the wall stands at the outline', () => {
		const m = buildTitleSolid(square, solidG({ bands: [band(5, 4, 'chamfer')], depth: 10 }));
		let faceX = 0;
		let wallX = 0;
		let z = 0;
		for (let v = 0; v < m.vertices.length / 9; v++) {
			const [x, , pz] = pos(m, v);
			if (slotOf(m, v) === SLOT_FACE) faceX = Math.max(faceX, x);
			if (slotOf(m, v) === SLOT_SIDE) wallX = Math.max(wallX, x);
			z = Math.max(z, pz);
		}
		expect(wallX).toBeCloseTo(90, 0);
		expect(faceX).toBeCloseTo(85, 0);
		expect(z).toBeCloseTo(14, 3);
	});

	it('bevel normals face the viewer and outwards', () => {
		const m = buildTitleSolid(square, solidG({ bands: [band(5, 5, 'chamfer')] }));
		for (let v = 0; v < m.vertices.length / 9; v++) {
			if (slotOf(m, v) !== SLOT_BAND0) continue;
			const nz = m.vertices[v * 9 + 5]!;
			expect(nz).toBeLessThan(0);
		}
	});

	it('thin strokes narrow the bevel instead of inverting it', () => {
		const stroke = traced(200, 40, [[10, 18, 190, 21]]);
		const m = buildTitleSolid(stroke, solidG({ bands: [band(6, 6)] }));
		expect(openEdges(m)).toBe(0);
		checkNormals(m);
		for (let v = 0; v < m.vertices.length / 9; v++) {
			const [, y] = pos(m, v);
			expect(y).toBeGreaterThan(17);
			expect(y).toBeLessThan(22);
		}
	});

	it('a kanji of hairlines: bands, plates and outward bevels stay closed and in bounds', () => {
		const shapes = traced(100, 100, KANJI);
		for (const position of ['inside', 'center', 'outside'] as const) {
			const m = buildTitleSolid(
				shapes,
				solidG({ position, bands: [band(4, 4), band(2, 3, 'tube')], plates: [plate()] }),
			);
			expect(openEdges(m)).toBe(0);
			checkNormals(m);
		}
	});

	it('property: bands on noisy traced strokes never leave the outline, always close', {
		timeout: 300_000,
	}, () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(
						fc.integer({ min: 4, max: 80 }),
						fc.integer({ min: 4, max: 80 }),
						fc.integer({ min: 2, max: 40 }),
						fc.integer({ min: 2, max: 40 }),
					),
					{ minLength: 1, maxLength: 7 },
				),
				fc.double({ min: 0.5, max: 12, noNaN: true }),
				(rs, width) => {
					const rects = rs.map(([x, y, w, h]): Rect => [x + 0.3, y + 0.6, x + w / 2 + 1, y + h / 2 + 1]);
					const shapes = traced(100, 100, rects);
					if (!shapes.length) return;
					const m = buildTitleSolid(shapes, solidG({ bands: [band(width, 4)] }));
					expect(openEdges(m)).toBe(0);
					for (let i = 0; i < m.vertices.length; i++) expect(Number.isFinite(m.vertices[i]!)).toBe(true);
				},
			),
			{ numRuns: 30 },
		);
	});

	it('a hostile trace is bounded: more detail than the budget coarsens the outline', () => {
		const comb: Rect[] = [];
		for (let x = 2; x < 1500; x += 4) comb.push([x, 2, x + 2, 300]);
		const shapes = traced(1600, 320, comb);
		const m = buildTitleSolid(
			shapes,
			solidG({ bands: Array.from({ length: 6 }, () => ({ ...band(1, 1), segments: 24 })) }),
		);
		expect(m.vertices.length / 9).toBeLessThan(16_000_000);
	});
});

describe('offsets (TL-073)', () => {
	it('grows by the distance, round at corners, and stays simple', () => {
		const square = traced(100, 100, [[20, 20, 80, 80]]);
		const big = offsetShapes(square, 10, 1)[0]!;
		const xs = big.outer.map((p) => p[0]);
		expect(Math.max(...xs)).toBeCloseTo(90, 0);
		expect(Math.min(...xs)).toBeCloseTo(10, 0);
		// Round corner: the diagonal point sits 10 px from the old corner, not on the square's corner.
		const corner = Math.min(...big.outer.map((p) => Math.hypot(p[0] - 90, p[1] - 90)));
		expect(corner).toBeGreaterThan(2);
	});

	it('merges shapes it grows into each other, and closes counters', () => {
		const two = traced(100, 40, [
			[10, 10, 40, 30],
			[46, 10, 90, 30],
		]);
		expect(two).toHaveLength(2);
		expect(offsetShapes(two, 5, 1)).toHaveLength(1);
		const ring = traced(100, 100, [
			[10, 10, 90, 20],
			[10, 80, 90, 90],
			[10, 10, 20, 90],
			[80, 10, 90, 90],
		]);
		expect(ring[0]!.holes).toHaveLength(1);
		expect(offsetShapes(ring, 2, 1)[0]!.holes).toHaveLength(1);
		expect(offsetShapes(ring, 2, 1, true)[0]!.holes).toHaveLength(0);
		expect(offsetShapes(ring, 32, 1)[0]!.holes).toHaveLength(0);
	});

	it('a hull has no notches; hull, box and contour plates sit behind the title, growing cumulatively', () => {
		const l = traced(100, 100, [
			[10, 10, 30, 90],
			[10, 70, 90, 90],
		]);
		const hull = hullShape(l)!;
		expect(Math.abs(loopArea(hull.outer))).toBeGreaterThan(Math.abs(loopArea(l[0]!.outer)) * 1.2);
		const m = buildTitleSolid(
			l,
			solidG({
				depth: 10,
				plates: [
					plate({ shape: 'hull', depth: 5 }),
					plate({ shape: 'box', corner: 6, depth: 5, gap: 2 }),
					plate({ depth: 4 }),
				],
			}),
		);
		const ofSlot = (s: number) => {
			let z0 = Number.POSITIVE_INFINITY;
			let x1 = Number.NEGATIVE_INFINITY;
			for (let v = 0; v < m.vertices.length / 9; v++)
				if (slotOf(m, v) === s) {
					const [x, , z] = pos(m, v);
					z0 = Math.min(z0, z);
					x1 = Math.max(x1, x);
				}
			return { z0, x1 };
		};
		expect(ofSlot(plateFaceSlot(0)).z0).toBeCloseTo(10, 3);
		expect(ofSlot(plateFaceSlot(1)).z0).toBeCloseTo(17, 3);
		expect(ofSlot(plateFaceSlot(2)).z0).toBeCloseTo(22, 3);
		expect(ofSlot(plateFaceSlot(1)).x1).toBeCloseTo(110, 0);
		expect(openEdges(m)).toBe(0);
	});

	it('a negative gap sinks a plate, never past the wall top', () => {
		const s = traced(60, 60, [[10, 10, 50, 50]]);
		const m = buildTitleSolid(s, solidG({ depth: 10, plates: [plate({ gap: -100, depth: 5 })] }));
		let z0 = Number.POSITIVE_INFINITY;
		for (let v = 0; v < m.vertices.length / 9; v++)
			if (slotOf(m, v) === plateFaceSlot(0)) z0 = Math.min(z0, pos(m, v)[2]);
		expect(z0).toBeCloseTo(0, 3);
	});

	it('distance field: iso-lines of a square at ±d', () => {
		const s = traced(100, 100, [[20, 20, 80, 80]]);
		const f = distanceField(s, 12, 0.5)!;
		const inner = isoShapes(f, -5)[0]!;
		expect(Math.max(...inner.outer.map((p) => p[0]))).toBeCloseTo(75, 0);
	});
});

describe('inflate (TL-072)', () => {
	const inflated = (
		height: number,
		smoothness: number,
		curve = [
			{ x: 0, y: 0 },
			{ x: 1, y: 1 },
		],
	) =>
		solidG({
			mode: 'inflate',
			depth: 6,
			inflate: { height, curve, smoothness, detail: 1 },
		});

	it('rises from the edge to the ridge, closed, with a flat back', () => {
		const s = traced(120, 60, [[10, 10, 110, 50]]);
		const m = buildTitleSolid(s, inflated(20, 60));
		expect(openEdges(m)).toBe(0);
		checkNormals(m);
		let centre = Number.POSITIVE_INFINITY;
		let edge = Number.NEGATIVE_INFINITY;
		let back = 0;
		for (let v = 0; v < m.vertices.length / 9; v++) {
			const [x, y, z] = pos(m, v);
			if (slotOf(m, v) === SLOT_FACE) {
				if (Math.abs(y - 30) < 2 && Math.abs(x - 60) < 30) centre = Math.min(centre, z);
				edge = Math.max(edge, z);
			}
			if (slotOf(m, v) === SLOT_BACK) back = z;
		}
		expect(centre).toBeLessThan(2);
		expect(edge).toBeCloseTo(20, 1);
		expect(back).toBeCloseTo(26, 1);
	});

	it('the ridge of a hairline is lower than the ridge of a wide stroke: one scale for the title', () => {
		const s = traced(200, 100, [
			[10, 10, 90, 90],
			[120, 45, 190, 49],
		]);
		const m = buildTitleSolid(s, inflated(30, 60));
		let hair = Number.POSITIVE_INFINITY;
		let wide = Number.POSITIVE_INFINITY;
		for (let v = 0; v < m.vertices.length / 9; v++) {
			if (slotOf(m, v) !== SLOT_FACE) continue;
			const [x, , z] = pos(m, v);
			if (x > 110) hair = Math.min(hair, z);
			else wide = Math.min(wide, z);
		}
		expect(wide).toBeLessThan(hair - 5);
	});

	it('a curve shapes the profile: a plateau rises faster', () => {
		const dome = inflateCurveFn([
			{ x: 0, y: 0 },
			{ x: 0.3, y: 0.9 },
			{ x: 1, y: 1 },
		]);
		expect(dome(0.3)).toBeCloseTo(0.9);
		expect(dome(0.15)).toBeGreaterThan(0.3);
		expect(dome(0)).toBe(0);
		expect(dome(1)).toBe(1);
	});

	it('fuzz: traced strokes inflate to closed meshes', { timeout: 300_000 }, () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(
						fc.integer({ min: 4, max: 60 }),
						fc.integer({ min: 4, max: 60 }),
						fc.integer({ min: 3, max: 30 }),
						fc.integer({ min: 3, max: 30 }),
					),
					{ minLength: 1, maxLength: 5 },
				),
				(rs) => {
					const shapes = traced(
						80,
						80,
						rs.map(([x, y, w, h]): Rect => [x + 0.2, y + 0.7, x + w, y + h]),
					);
					if (!shapes.length) return;
					const m = buildTitleSolid(shapes, inflated(12, 40));
					expect(openEdges(m)).toBe(0);
				},
			),
			{ numRuns: 25 },
		);
	});
});

describe('surfaces (TL-071, TL-074)', () => {
	it('every preset is valid, and gives metals their colour and glass its transmission', () => {
		for (const [id, p] of Object.entries(SURFACE_PRESETS)) {
			const td = newLayer3D(true, 'text');
			td.material.pbr = newSurface(p.values);
			expect(threeDProblem(td), id).toBeNull();
		}
		const gold = surfaceAt(newSurface(SURFACE_PRESETS.gold!.values), 0);
		expect(gold.metalness).toBe(1);
		expect(gold.useColor).toBe(true);
		expect(gold.ramp?.stops.length).toBe(7);
		expect(surfaceAt(newSurface(SURFACE_PRESETS.glass!.values), 0).transmission).toBe(1);
	});

	it('values animate and clamp', () => {
		const s = newSurface();
		s.roughness = { value: 30, keyframes: [] };
		s.metalness = anim(1000);
		expect(surfaceAt(s, 0).metalness).toBe(1);
		s.ior = anim(Number.NaN);
		expect(surfaceAt(s, 0).ior).toBe(1.5);
	});

	it('each slot takes its own surface, an absent one the base', () => {
		const td = newLayer3D(true, 'text') as Layer3D;
		td.material.pbr = newSurface({ metalness: 10 });
		td.geometry!.surfaces = { side: newSurface({ metalness: 20 }) };
		td.geometry!.bands = [
			{
				id: 'b',
				width: anim(1),
				depth: anim(1),
				profile: 'round',
				curve: anim(0),
				segments: 6,
				material: newSurface({ metalness: 30 }),
			},
		];
		const out = layerSurfacesAt(td, 0);
		expect(out).toHaveLength(MAX_SLOTS);
		expect(out[SLOT_FACE]!.metalness).toBeCloseTo(0.1);
		expect(out[SLOT_SIDE]!.metalness).toBeCloseTo(0.2);
		expect(out[SLOT_BAND0]!.metalness).toBeCloseTo(0.3);
		expect(out[SLOT_BACK]!.metalness).toBeCloseTo(0.1);
		expect(layerIsPhysical(td)).toBe(true);
		expect(layerIsPhysical(newLayer3D(true, 'text'))).toBe(false);
	});

	it('the environment presets are the reflection presets of looks, by name and order (TL-038)', () => {
		expect([...ENVIRONMENT_PRESETS]).toEqual([...TL_ENV_PRESETS]);
	});
});

function textClip(h: Harness): string {
	const r = h.ok([
		{ type: 'clip.addText', at: 0, duration: 60, track: 'V1', content: { text: 'GOLD' } } as never,
	]);
	const id = (r.results[0] as { clipId: string }).clipId;
	h.ok([{ type: 'clip.set3d', clipIds: [id], enabled: true }]);
	return id;
}
const clipOf = (h: Harness, id: string) =>
	h.doc.sequences[h.seqId]!.clips[id] as unknown as { threeD: Layer3D };
const clean = (h: Harness) => expect(checkInvariants(h.doc)).toEqual([]);
const fails = (h: Harness, commands: unknown[], code: string) =>
	expect((h.tx(commands) as { errors?: { code?: string }[] }).errors?.[0]?.code).toBe(code);

describe('commands', () => {
	it('threeD.setSurface: preset, values, clear, undo', () => {
		const h = new Harness();
		const id = textClip(h);
		const before = h.doc;
		h.ok([{ type: 'threeD.setSurface', clipIds: [id], preset: 'gold', values: { roughness: 22 } }]);
		const after = h.doc;
		const td = clipOf(h, id).threeD;
		expect((td.material.pbr as ReturnType<typeof newSurface>).roughness.value).toBe(22);
		clean(h);
		// History restores documents by identity: one command, one step, and the old document is untouched.
		expect(clipOf({ doc: before, seqId: h.seqId } as Harness, id).threeD.material.pbr).toBeUndefined();
		h.doc = before;
		h.doc = after;
		expect(clipOf(h, id).threeD.material.pbr).toBeDefined();
		h.ok([{ type: 'threeD.setSurface', clipIds: [id], surface: 'side', preset: 'chrome' }]);
		expect((clipOf(h, id).threeD.geometry!.surfaces as { side?: unknown }).side).toBeDefined();
		h.ok([{ type: 'threeD.setSurface', clipIds: [id], surface: 'side', clear: true }]);
		expect((clipOf(h, id).threeD.geometry!.surfaces as { side?: unknown }).side).toBeUndefined();
		clean(h);
	});

	it('refuses unknown presets, unknown surfaces, clips that are not 3D and locked tracks', () => {
		const h = new Harness();
		const id = textClip(h);
		fails(h, [{ type: 'threeD.setSurface', clipIds: [id], preset: 'mithril' }], 'E_INVALID_PARAM');
		fails(h, [{ type: 'threeD.setSurface', clipIds: [id], surface: 'bnd_nope' }], 'E_NOT_FOUND');
		const r = h.ok([{ type: 'clip.addSolid', at: 100, duration: 30, track: 'V1', color: [1, 0, 0, 1] }]);
		const solid = (r.results[0] as { clipId: string }).clipId;
		fails(h, [{ type: 'threeD.setSurface', clipIds: [solid], preset: 'gold' }], 'E_INVALID_PARAM');
		h.ok([{ type: 'clip.set3d', clipIds: [solid], enabled: true }]);
		fails(h, [{ type: 'threeD.addBand', clipId: solid }], 'E_INVALID_PARAM');
		const track = h.doc.sequences[h.seqId]!.videoTracks[0]!.id;
		h.ok([{ type: 'track.update', trackId: track, patch: { locked: true } }]);
		fails(h, [{ type: 'threeD.addBand', clipId: id }], 'E_TRACK_LOCKED');
	});

	it('bands: six at most, E_LIMIT for a seventh, reorder and remove with undo', () => {
		const h = new Harness();
		const id = textClip(h);
		const ids: string[] = [];
		for (let i = 0; i < MAX_BEVEL_BANDS; i++) {
			const r = h.ok([
				{ type: 'threeD.addBand', clipId: id, width: i + 1, preset: i === 0 ? 'gold' : undefined },
			]);
			ids.push((r.results[0] as { bandId: string }).bandId);
		}
		fails(h, [{ type: 'threeD.addBand', clipId: id }], 'E_LIMIT');
		clean(h);
		const was = h.doc;
		h.ok([{ type: 'threeD.reorderBand', clipId: id, bandId: ids[5]!, index: 0 }]);
		expect((clipOf(h, id).threeD.geometry!.bands as { id: string }[])[0]!.id).toBe(ids[5]);
		h.doc = was;
		expect((clipOf(h, id).threeD.geometry!.bands as { id: string }[])[0]!.id).toBe(ids[0]);
		h.ok([{ type: 'threeD.removeBand', clipId: id, bandId: ids[0]! }]);
		expect(clipOf(h, id).threeD.geometry!.bands).toHaveLength(5);
		fails(h, [{ type: 'threeD.removeBand', clipId: id, bandId: ids[0]! }], 'E_NOT_FOUND');
		clean(h);
	});

	it('backplates: three at most, shapes and presets, remove with undo', () => {
		const h = new Harness();
		const id = textClip(h);
		const ids: string[] = [];
		for (const shape of ['contour', 'hull', 'box'] as const) {
			const r = h.ok([{ type: 'threeD.addBackplate', clipId: id, shape, preset: 'black-gloss' }]);
			ids.push((r.results[0] as { plateId: string }).plateId);
		}
		fails(h, [{ type: 'threeD.addBackplate', clipId: id }], 'E_LIMIT');
		clean(h);
		h.ok([{ type: 'threeD.setSurface', clipIds: [id], surface: `${ids[0]}.face`, preset: 'gold' }]);
		const was = h.doc;
		h.ok([{ type: 'threeD.removeBackplate', clipId: id, plateId: ids[1]! }]);
		expect(clipOf(h, id).threeD.geometry!.backplates).toHaveLength(2);
		h.doc = was;
		expect(clipOf(h, id).threeD.geometry!.backplates).toHaveLength(3);
		clean(h);
	});

	it('threeD.setGeometry: mode and inflate options', () => {
		const h = new Harness();
		const id = textClip(h);
		h.ok([
			{ type: 'threeD.setGeometry', clipIds: [id], mode: 'inflate', inflate: { height: 44, detail: 2 } },
		]);
		const g = clipOf(h, id).threeD.geometry!;
		expect(g.mode).toBe('inflate');
		expect((g.inflate as { height: { value: number } }).height.value).toBe(44);
		clean(h);
		const eval_ = solidGeometryAt({ kind: 'text', threeD: clipOf(h, id).threeD }, 0)!;
		expect(eval_.mode).toBe('inflate');
		expect(eval_.inflate!.height).toBe(44);
	});

	it('param.set creates inflate options when the mode is chosen, as the Properties row does', () => {
		const h = new Harness();
		const id = textClip(h);
		h.ok([{ type: 'param.set', target: ['clip', id, 'threeD', 'geometry', 'mode'], value: 'inflate' }]);
		expect(clipOf(h, id).threeD.geometry!.inflate).toBeDefined();
		clean(h);
	});

	it('numbers animate: bands, surfaces, plates, by param.set and keyframes, and survive a razor cut', () => {
		const h = new Harness();
		const id = textClip(h);
		const b = (h.ok([{ type: 'threeD.addBand', clipId: id }]).results[0] as { bandId: string }).bandId;
		h.ok([{ type: 'threeD.setSurface', clipIds: [id], surface: b, preset: 'chrome' }]);
		const key = ['clip', id, 'threeD', 'surface', b, 'roughness'];
		h.ok([{ type: 'keyframe.add', target: key, at: { sequenceFrame: 0 }, value: 10 } as never]);
		h.ok([{ type: 'keyframe.add', target: key, at: { sequenceFrame: 30 }, value: 50 } as never]);
		const width = ['clip', id, 'threeD', 'band', b, 'width'];
		h.ok([{ type: 'param.set', target: width, value: 9 }]);
		const band0 = (
			clipOf(h, id).threeD.geometry!.bands as {
				width: { value: number };
				material: { roughness: { keyframes: unknown[] } };
			}[]
		)[0]!;
		expect(band0.width.value).toBe(9);
		expect(band0.material.roughness.keyframes).toHaveLength(2);
		const paths = allAnimatables(h.doc as never).map((a) => a.path.join('.'));
		expect(paths).toContain(key.join('.'));
		expect(paths).toContain(width.join('.'));
		clean(h);
	});

	it('a razor cut keeps bands, surfaces and their keys on both sides', () => {
		const h = new Harness();
		const id = textClip(h);
		const b = (
			h.ok([{ type: 'threeD.addBand', clipId: id, preset: 'gold' }]).results[0] as { bandId: string }
		).bandId;
		const key = ['clip', id, 'threeD', 'band', b, 'width'];
		h.ok([{ type: 'keyframe.add', target: key, at: { sequenceFrame: 0 }, value: 2 } as never]);
		h.ok([{ type: 'keyframe.add', target: key, at: { sequenceFrame: 50 }, value: 12 } as never]);
		h.ok([{ type: 'clip.split', at: 30, clipIds: [id] }]);
		const parts = Object.values(h.doc.sequences[h.seqId]!.clips).filter(
			(c) => c.kind === 'text',
		) as unknown as { threeD: Layer3D }[];
		expect(parts).toHaveLength(2);
		for (const p of parts) {
			expect(solidGeometryAt({ kind: 'text', threeD: p.threeD }, 0)?.bands).toHaveLength(1);
			expect(
				(p.threeD.geometry!.bands as { width: { keyframes: unknown[] } }[])[0]!.width.keyframes.length,
			).toBeGreaterThan(0);
		}
		clean(h);
	});

	it('every dynamic property is listed for agents and Effect Controls', () => {
		const h = new Harness();
		const id = textClip(h);
		const b = (
			h.ok([{ type: 'threeD.addBand', clipId: id, preset: 'gold' }]).results[0] as { bandId: string }
		).bandId;
		const specs = propertiesForClip(h.doc.sequences[h.seqId]!.clips[id]!).map((s) => s.key);
		expect(specs).toContain(`threeD.band.${b}.width`);
		expect(specs).toContain(`threeD.surface.${b}.metalness`);
	});

	it('sequence.set3dRenderer: tone mapping, exposure and glint, keyed in sequence time', () => {
		const h = new Harness();
		textClip(h);
		h.ok([
			{
				type: 'sequence.set3dRenderer',
				renderer: 'advanced',
				toneMapping: 'agx',
				exposure: 1,
				glint: { enabled: true, threshold: 2, rays: 6, tint: [1, 0.8, 0.5, 1] },
			},
		]);
		const three = h.doc.sequences[h.seqId]!.threeD!;
		expect(three.toneMapping).toBe('agx');
		expect(three.exposure?.value).toBe(1);
		expect(three.glint?.rays).toBe(6);
		clean(h);
		const path = ['scene3d', h.seqId, 'glintThreshold'];
		h.ok([{ type: 'keyframe.add', target: path, at: { sequenceFrame: 0 }, value: 1 } as never]);
		h.ok([{ type: 'keyframe.add', target: path, at: { sequenceFrame: 30 }, value: 3 } as never]);
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: media, resolveFont: () => 'f.woff2' });
		expect(snap.scene3d?.toneMapping).toBe('agx');
		const fps = { num: 30, den: 1 };
		expect(sceneLookAt(snap.scene3d, 0, fps).glint!.threshold).toBeCloseTo(1);
		expect(sceneLookAt(snap.scene3d, 30, fps).glint!.threshold).toBeCloseTo(3);
		expect(sceneLookAt(snap.scene3d, 0, fps).exposure).toBeCloseTo(2);
		fails(h, [{ type: 'sequence.set3dRenderer', glint: { rays: 3 } }], 'E_SCHEMA');
	});

	it('light.settings: environment preset and rotation on environment lights only', () => {
		const h = new Harness();
		const r = h.ok([
			{
				type: 'clip.addLight',
				at: 0,
				duration: 30,
				lightType: 'environment',
				environmentPreset: 'chromeBands',
			},
		]);
		const id = (r.results[0] as { clipId: string }).clipId;
		const clip = () =>
			h.doc.sequences[h.seqId]!.clips[id] as unknown as {
				light: { environmentPreset?: string; environmentRotation?: { value: number } };
			};
		expect(clip().light.environmentPreset).toBe('chromeBands');
		h.ok([{ type: 'light.settings', clipId: id, environmentRotation: 90 }]);
		expect(clip().light.environmentRotation?.value).toBe(90);
		const s = h.ok([{ type: 'clip.addLight', at: 0, duration: 30, lightType: 'spot' }]);
		fails(
			h,
			[
				{
					type: 'light.settings',
					clipId: (s.results[0] as { clipId: string }).clipId,
					environmentPreset: 'neon',
				},
			],
			'E_INVALID_PARAM',
		);
	});
});

const media = (): MediaHandle => ({
	url: 'x',
	proxyUrl: null,
	kind: 'video',
	width: 1920,
	height: 1080,
	durationFlicks: 10 * FLICKS_PER_SECOND,
	hasAudio: false,
	rotation: 0,
});

describe('routing and the float refusal', () => {
	it('a sequence that uses none of this stays on the 8-bit path; physical surfaces and tone mapping need float', () => {
		const h = new Harness();
		const id = textClip(h);
		h.ok([{ type: 'sequence.set3dRenderer', renderer: 'advanced' }]);
		const snap = () =>
			buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: media, resolveFont: () => 'f.woff2' });
		const float = () => snapshotGlNeeds(snap()).find((n) => n.kind === '3d')?.float;
		expect(float()).toBeUndefined();
		h.ok([{ type: 'threeD.setSurface', clipIds: [id], preset: 'gold' }]);
		expect(float()?.code).toBe(THREE_D_NEEDS_FLOAT);
		h.ok([{ type: 'threeD.setSurface', clipIds: [id], clear: true }]);
		expect(float()).toBeUndefined();
		h.ok([{ type: 'sequence.set3dRenderer', toneMapping: 'aces' }]);
		expect(float()?.code).toBe(THREE_D_NEEDS_FLOAT);
		h.ok([{ type: 'sequence.set3dRenderer', renderer: 'classic' }]);
		expect(float()).toBeUndefined();
	});

	it('cost class (TL-078)', () => {
		const td = newLayer3D(true, 'text');
		expect(costClassOf(undefined, undefined)).toBe('fast');
		expect(costClassOf(td, undefined)).toBe('3d');
		const glass = newLayer3D(true, 'text');
		glass.material.pbr = newSurface(SURFACE_PRESETS.glass!.values);
		expect(costClassOf(glass, undefined)).toBe('3d-heavy');
		expect(costClassOf(td, { supersampling: 2 })).toBe('3d-heavy');
	});
});

describe('repair and load', () => {
	const broken = (h: Harness, id: string, f: (td: Record<string, unknown>) => void) => {
		const doc = JSON.parse(JSON.stringify(h.doc));
		f(doc.sequences[h.seqId].clips[id].threeD);
		return doc;
	};

	it('INV-012 reports, repair fixes, and repair is idempotent', () => {
		const h = new Harness();
		const id = textClip(h);
		h.ok([{ type: 'threeD.addBand', clipId: id }]);
		const doc = broken(h, id, (td) => {
			(td.geometry as Record<string, unknown>).bands = [
				{ id: 'x' },
				...(td.geometry as { bands: unknown[] }).bands,
				7,
			];
			(td.material as Record<string, unknown>).pbr = { base: 'color', roughness: 'loud' };
		});
		expect(checkInvariants(doc).some((i) => i.invariant === 'INV-012')).toBe(true);
		const ids = createCounterIdSource();
		const fixed = repairDocument(doc, ids);
		expect(fixed.report.some((r) => r.action === 'drop-3d-band')).toBe(true);
		expect(fixed.report.some((r) => r.action === 'repair-3d-surface')).toBe(true);
		expect(checkInvariants(fixed.document)).toEqual([]);
		expect(repairDocument(fixed.document, ids).report).toEqual([]);
	});

	it('property: junk in every lenient field neither crashes repair nor survives it', {
		timeout: 300_000,
	}, () => {
		const junk = fc.oneof(
			fc.constant(null),
			fc.integer(),
			fc.string(),
			fc.array(fc.anything(), { maxLength: 3 }),
			fc.dictionary(fc.string({ maxLength: 8 }), fc.anything(), { maxKeys: 4 }),
		);
		const h = new Harness();
		const id = textClip(h);
		h.ok([{ type: 'threeD.addBand', clipId: id }]);
		h.ok([{ type: 'threeD.addBackplate', clipId: id }]);
		fc.assert(
			fc.property(junk, junk, junk, junk, junk, (a, b, c, d, e) => {
				const doc = broken(h, id, (td) => {
					const g = td.geometry as Record<string, unknown>;
					g.bands = a;
					g.backplates = b;
					g.inflate = c;
					g.surfaces = d;
					(td.material as Record<string, unknown>).pbr = e;
				});
				const fixed = repairDocument(doc, createCounterIdSource());
				expect(checkInvariants(fixed.document).filter((i) => i.invariant === 'INV-012')).toEqual([]);
				expect(repairDocument(fixed.document, createCounterIdSource()).report).toEqual([]);
			}),
			{ numRuns: 200 },
		);
	});
});
