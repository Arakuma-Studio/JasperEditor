import { describe, expect, it } from 'vitest';
import {
	type BezierPath,
	convertVertices,
	correspondPaths,
	DEFAULT_PATH_INTERP,
	ellipsePath,
	evaluate,
	flattenPath,
	insertVertexAt,
	interpolatePaths,
	type Keyframe,
	lerpPathValues,
	nearestOnPath,
	pathLength,
	pathSignedArea,
	pathToSvg,
	pathWithVertexCount,
	polygonPath,
	rectPath,
	removeVertices,
	reversePath,
	rotatePathStart,
	similarityAffine,
	tracePaths,
	transformPath,
	vertexPathsCross,
} from '../src/index.ts';

function star(c: [number, number], r: number, k: number, rot: number): BezierPath {
	const pts: [number, number][] = [];
	for (let i = 0; i < 2 * k; i++) {
		const a = rot + (i * Math.PI) / k;
		const rr = i % 2 === 0 ? r : r * 0.5;
		pts.push([c[0] + rr * Math.cos(a), c[1] + rr * Math.sin(a)]);
	}
	return polygonPath(pts, true);
}

describe('path model', () => {
	it('flattens an ellipse onto the ellipse', () => {
		const e = ellipsePath([100, 50], [40, 20]);
		const { pts } = flattenPath(e, 0.05);
		expect(pts.length).toBeGreaterThan(16);
		for (const q of pts) {
			const v = ((q[0] - 100) / 40) ** 2 + ((q[1] - 50) / 20) ** 2;
			expect(Math.abs(v - 1)).toBeLessThan(0.01);
		}
		// Clockwise on screen (y down): positive area ≈ π·a·b.
		expect(pathSignedArea(e)).toBeCloseTo(Math.PI * 40 * 20, -1);
	});

	it('polygons flatten to their corners', () => {
		const r = rectPath(0, 0, 10, 5);
		expect(flattenPath(r, 0.1).pts).toEqual([
			[0, 0],
			[10, 0],
			[10, 5],
			[0, 5],
		]);
		expect(pathLength(r)).toBeCloseTo(30, 9);
		expect(pathToSvg(r)).toBe('M 0 0 C 0 0 10 0 10 0 C 10 0 10 5 10 5 C 10 5 0 5 0 5 C 0 5 0 0 0 0 Z');
	});

	it('inserting a vertex keeps the outline; removing and converting vertices', () => {
		const e = ellipsePath([0, 0], [10, 10]);
		const { path, index } = insertVertexAt(e, 1, 0.5);
		expect(index).toBe(2);
		expect(path.vertices).toHaveLength(5);
		expect(pathLength(path)).toBeCloseTo(pathLength(e), 2);
		const v = path.vertices[2]!.p;
		expect(Math.hypot(v[0], v[1])).toBeCloseTo(10, 1);
		const back = removeVertices(path, [2]);
		expect(back.vertices).toHaveLength(4);
		const c = convertVertices(e, [0], 'corner');
		expect(c.vertices[0]!.in).toEqual([0, 0]);
		const s = convertVertices(rectPath(0, 0, 6, 6), [1], 'smooth');
		// Neighbours (0,0) and (6,6): handle (6/6, 6/6).
		expect(s.vertices[1]!.out).toEqual([1, 1]);
		expect(s.vertices[1]!.in).toEqual([-1, -1]);
	});

	it('nearest point, transforms, reversal and rotation', () => {
		const r = rectPath(0, 0, 10, 10);
		const n = nearestOnPath(r, [5, -2])!;
		expect(n.segment).toBe(0);
		expect(n.t).toBeCloseTo(0.5, 6);
		expect(n.distance).toBeCloseTo(2, 6);
		const m = transformPath(r, similarityAffine([5, 5], { rotation: 90 }));
		expect(m.vertices[0]!.p[0]).toBeCloseTo(10, 9);
		expect(m.vertices[0]!.p[1]).toBeCloseTo(0, 9);
		const rev = reversePath(rectPath(-5, -5, 5, 5));
		expect(rev.vertices[0]!.p).toEqual([-5, -5]);
		expect(rev.vertices[1]!.p).toEqual([-5, 5]);
		const rot = rotatePathStart(r, 2);
		expect(rot.vertices[0]!.p).toEqual([10, 10]);
	});
});

describe('smart path interpolation (port of effectcraft interp.rs)', () => {
	it('splitting keeps the outline', () => {
		const e = ellipsePath([50, 50], [40, 20]);
		const m = pathWithVertexCount(e, 23);
		expect(m.vertices).toHaveLength(23);
		expect(Math.abs(pathLength(m) - pathLength(e))).toBeLessThan(0.05);
		for (const v of m.vertices) {
			const q = ((v.p[0] - 50) / 40) ** 2 + ((v.p[1] - 50) / 20) ** 2;
			expect(Math.abs(q - 1)).toBeLessThan(0.01);
		}
	});

	it('correspondence finds the rotation and vertex paths do not cross', () => {
		const a = star([100, 100], 60, 5, 0);
		const b0 = star([140, 110], 50, 5, 0.3);
		const b = rotatePathStart(b0, 3);
		const o = { ...DEFAULT_PATH_INTERP, firstVerticesMatch: false, addVertices: null };
		const [ra, rb] = correspondPaths(a, b, o);
		expect(ra.vertices.length).toBe(rb.vertices.length);
		expect(rb.vertices[0]!.p[0]).toBeCloseTo(b0.vertices[0]!.p[0], 9);
		expect(vertexPathsCross(ra, rb)).toBeLessThanOrEqual(1);
		const [xa, xb] = correspondPaths(a, b, { ...o, firstVerticesMatch: true });
		expect(vertexPathsCross(xa, xb)).toBeGreaterThan(5);
		const c = ellipsePath([100, 100], [60, 60]);
		const [pa, pb] = correspondPaths(a, c, { ...DEFAULT_PATH_INTERP, firstVerticesMatch: false });
		expect(pa.vertices.length).toBe(pb.vertices.length);
		expect(pa.vertices.length).toBeGreaterThanOrEqual(25);
		expect(vertexPathsCross(pa, pb)).toBeLessThanOrEqual(pa.vertices.length / 10);
	});

	it('rigid interpolation turns instead of collapsing', () => {
		const a = polygonPath([
			[-50, -10],
			[50, -10],
			[50, 10],
			[-50, 10],
		]);
		const b = polygonPath([
			[10, -50],
			[10, 50],
			[-10, 50],
			[-10, -50],
		]);
		const mid = interpolatePaths(a, b, 0.5, { linear: false, bendingResistance: 100 });
		const len = Math.hypot(
			mid.vertices[1]!.p[0] - mid.vertices[0]!.p[0],
			mid.vertices[1]!.p[1] - mid.vertices[0]!.p[1],
		);
		expect(len).toBeCloseTo(100, 6);
		const lin = interpolatePaths(a, b, 0.5, { linear: true, bendingResistance: 0 });
		expect(
			Math.hypot(
				lin.vertices[1]!.p[0] - lin.vertices[0]!.p[0],
				lin.vertices[1]!.p[1] - lin.vertices[0]!.p[1],
			),
		).toBeLessThan(80);
	});

	it('Mask Path keyframes: vertex-wise for equal counts, smart matching otherwise', () => {
		const a = rectPath(0, 0, 10, 10);
		const b = transformPath(a, [1, 0, 0, 1, 100, 20]);
		const kf = (id: string, time: number, value: BezierPath): Keyframe<BezierPath> => ({
			id,
			time,
			value,
			interpolation: 'linear',
			easeIn: { influence: 1 / 3, slope: 1 },
			easeOut: { influence: 1 / 3, slope: 1 },
		});
		const anim = { value: a, keyframes: [kf('a', 0, a), kf('b', 100, b)] };
		const mid = evaluate(anim, 50);
		expect(mid.vertices[0]!.p).toEqual([50, 10]);
		expect(mid.vertices[2]!.p).toEqual([60, 20]);
		const e = ellipsePath([5, 5], [5, 5]);
		const tri = polygonPath([
			[0, 0],
			[10, 0],
			[5, 10],
		]);
		const m = lerpPathValues(tri, e, 0.5);
		expect(m.vertices.length).toBe(4);
		expect(m.vertices.every((v) => v.p.every(Number.isFinite))).toBe(true);
		const anim2 = { value: tri, keyframes: [kf('a', 0, tri), kf('b', 100, e)] };
		expect(evaluate(anim2, 50).vertices).toHaveLength(4);
		expect(evaluate(anim2, 0)).toBe(tri);
	});
});

describe('auto-trace (port of effectcraft trace.rs)', () => {
	const raster = (paths: { path: BezierPath }[], w: number, h: number) => {
		// Even-odd point-in-polygon of the flattened outlines at pixel centres.
		const polys = paths.map((p) => flattenPath(p.path, 0.05).pts);
		const out = new Float32Array(w * h);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				let inside = false;
				for (const poly of polys)
					for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
						const a = poly[i]!;
						const b = poly[j]!;
						const py = y + 0.5;
						if (a[1] > py !== b[1] > py && x + 0.5 < ((b[0] - a[0]) * (py - a[1])) / (b[1] - a[1]) + a[0])
							inside = !inside;
					}
				out[y * w + x] = inside ? 1 : 0;
			}
		return out;
	};
	const iou = (a: ArrayLike<number>, b: ArrayLike<number>) => {
		let i = 0;
		let u = 0;
		for (let k = 0; k < a.length; k++) {
			const x = (a[k] as number) >= 0.5;
			const y = (b[k] as number) >= 0.5;
			if (x && y) i++;
			if (x || y) u++;
		}
		return i / u;
	};

	it('traces a disc and a square with a hole', () => {
		const w = 120;
		const h = 80;
		const field = new Float32Array(w * h);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const fx = x + 0.5;
				const fy = y + 0.5;
				const disc = (fx - 30) ** 2 + (fy - 40) ** 2 <= 400;
				const sq = fx >= 60 && fx < 110 && fy >= 15 && fy < 65;
				const hole = fx >= 75 && fx < 95 && fy >= 30 && fy < 50;
				field[y * w + x] = disc || (sq && !hole) ? 1 : 0;
			}
		for (const round of [0, 0.5, 1]) {
			const t = tracePaths(field, w, h, { cornerRoundness: round });
			expect(t).toHaveLength(3);
			expect(t.filter((x) => x.depth === 1)).toHaveLength(1);
			expect(iou(field, raster(t, w, h))).toBeGreaterThan(round >= 1 ? 0.88 : 0.96);
		}
		const t0 = tracePaths(field, w, h, { cornerRoundness: 0, tolerance: 1 });
		const sq = t0.find((x) => x.depth === 0 && x.path.vertices.every((v) => v.p[0] > 55))!;
		expect(sq.path.vertices.length).toBeLessThanOrEqual(8);
	});

	it('minimum area, threshold and edge-touching shapes', () => {
		const w = 40;
		const h = 40;
		const field = new Float32Array(w * h);
		for (let y = 2; y < 4; y++) for (let x = 2; x < 4; x++) field[y * w + x] = 1;
		for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) field[y * w + x] = 0.6;
		expect(tracePaths(field, w, h, { minArea: 10 })).toHaveLength(1);
		expect(tracePaths(field, w, h, { minArea: 1 })).toHaveLength(2);
		expect(tracePaths(field, w, h, { threshold: 0.7 })).toHaveLength(0);
		const full = new Float32Array(100).fill(1);
		const t = tracePaths(full, 10, 10);
		expect(t).toHaveLength(1);
		expect(Math.abs(Math.abs(t[0]!.area) - 100)).toBeLessThan(2);
	});
});
