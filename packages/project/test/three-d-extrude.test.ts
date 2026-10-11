import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	earcut,
	extrudeShapes,
	loopArea,
	nestLoops,
	shapesOfAlpha,
	simplifyLoop,
	traceContours,
} from '../src/index.ts';

type P = [number, number];
const triArea = (d: number[], t: number[]) => {
	let s = 0;
	for (let i = 0; i < t.length; i += 3) {
		const [a, b, c] = [t[i]!, t[i + 1]!, t[i + 2]!];
		s +=
			Math.abs(
				(d[2 * b]! - d[2 * a]!) * (d[2 * c + 1]! - d[2 * a + 1]!) -
					(d[2 * c]! - d[2 * a]!) * (d[2 * b + 1]! - d[2 * a + 1]!),
			) / 2;
	}
	return s;
};

describe('earcut', () => {
	it('triangulates a square with a square hole (area = outer − hole)', () => {
		const data = [0, 0, 10, 0, 10, 10, 0, 10, 3, 3, 3, 7, 7, 7, 7, 3];
		const t = earcut(data, [4]);
		expect(t.length / 3).toBe(8);
		expect(triArea(data, t)).toBeCloseTo(100 - 16, 9);
	});

	it('triangulates random star polygons exactly (property)', () => {
		fc.assert(
			fc.property(fc.integer({ min: 5, max: 40 }), fc.integer({ min: 1, max: 1e6 }), (n, seed) => {
				let s = seed;
				const rnd = () => {
					s = (Math.imul(s, 1103515245) + 12345) >>> 0;
					return s / 4294967296;
				};
				const data: number[] = [];
				for (let i = 0; i < n; i++) {
					const a = (i / n) * Math.PI * 2;
					const r = 5 + 10 * rnd();
					data.push(Math.cos(a) * r, Math.sin(a) * r);
				}
				const pts: P[] = [];
				for (let i = 0; i < n; i++) pts.push([data[2 * i]!, data[2 * i + 1]!]);
				const t = earcut(data);
				expect(t.length / 3).toBe(n - 2);
				expect(triArea(data, t)).toBeCloseTo(Math.abs(loopArea(pts)), 6);
			}),
			{ numRuns: 60 },
		);
	});
});

describe('contours', () => {
	const disc = (cx: number, cy: number, r: number) => (x: number, y: number) => {
		const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
		return Math.max(0, Math.min(255, (r - d + 0.5) * 255));
	};

	it('traces a disc with sub-pixel accuracy', () => {
		const loops = traceContours(64, 64, disc(32, 32, 20));
		expect(loops.length).toBe(1);
		for (const p of loops[0]!) expect(Math.abs(Math.hypot(p[0] - 32, p[1] - 32) - 20)).toBeLessThan(0.1);
		expect(Math.abs(loopArea(loops[0]!))).toBeCloseTo(Math.PI * 400, -1);
		const simple = simplifyLoop(loops[0]!, 0.35);
		expect(simple.length).toBeLessThan(loops[0]!.length);
		expect(simple.length).toBeGreaterThan(16);
	});

	it('sorts a ring into an outline with a hole, and two discs into two shapes', () => {
		const outer = disc(32, 32, 20);
		const inner = disc(32, 32, 9);
		const ring = (x: number, y: number) => Math.max(0, outer(x, y) - inner(x, y));
		const shapes = shapesOfAlpha(64, 64, ring);
		expect(shapes.length).toBe(1);
		expect(shapes[0]!.holes.length).toBe(1);
		const two = nestLoops(
			traceContours(64, 32, (x, y) => Math.max(disc(16, 16, 8)(x, y), disc(48, 16, 8)(x, y))),
		);
		expect(two.length).toBe(2);
		expect(two.every((s) => s.holes.length === 0)).toBe(true);
	});
});

describe('extrusion', () => {
	const square: P[] = [
		[0, 0],
		[100, 0],
		[100, 100],
		[0, 100],
	];
	const hole: P[] = [
		[30, 30],
		[30, 70],
		[70, 70],
		[70, 30],
	];
	const closed = (m: ReturnType<typeof extrudeShapes>) => {
		// Weld by position, then every edge must be used by exactly two triangles.
		const key = (i: number) =>
			`${m.vertices[i * 9]!.toFixed(4)},${m.vertices[i * 9 + 1]!.toFixed(4)},${m.vertices[i * 9 + 2]!.toFixed(4)}`;
		const edges = new Map<string, number>();
		for (let t = 0; t < m.indices.length; t += 3)
			for (let e = 0; e < 3; e++) {
				const a = key(m.indices[t + e]!);
				const b = key(m.indices[t + ((e + 1) % 3)]!);
				const k = a < b ? `${a}|${b}` : `${b}|${a}`;
				edges.set(k, (edges.get(k) ?? 0) + 1);
			}
		return [...edges.values()].every((c) => c === 2);
	};

	it('a flat shape is its front face only; an extruded one is a closed solid with outward normals', () => {
		const flat = extrudeShapes([{ outer: square, holes: [] }], {
			depth: 0,
			bevelStyle: 'none',
			bevelDepth: 0,
			holeBevel: 100,
		});
		expect(flat.indices.length / 3).toBe(2);
		for (const style of ['none', 'angular', 'convex', 'concave'] as const) {
			const m = extrudeShapes([{ outer: square, holes: [hole] }], {
				depth: 40,
				bevelStyle: style,
				bevelDepth: 6,
				holeBevel: 50,
			});
			expect(closed(m), style).toBe(true);
			// Normals point away from the solid's centre line: walls of the outer square outwards, of the hole inwards.
			for (let i = 0; i < m.vertices.length / 9; i++) {
				const [x, y, z, nx, ny, nz] = Array.from(m.vertices.slice(i * 9, i * 9 + 6));
				if (z! <= 1e-6) expect(nz).toBeLessThanOrEqual(1e-6);
				if (z! >= 40 - 1e-6) expect(nz).toBeGreaterThanOrEqual(-1e-6);
				const onOuter = x! < 1e-6 || x! > 100 - 1e-6 || y! < 1e-6 || y! > 100 - 1e-6;
				if (onOuter && Math.abs(nz!) < 0.99) expect(nx! * (x! - 50) + ny! * (y! - 50)).toBeGreaterThan(0);
				const onHole = Math.abs(x! - 30) < 1e-6 && y! > 31 && y! < 69 && z! > 7 && z! < 33;
				if (onHole) expect(nx!).toBeGreaterThan(0.9);
			}
		}
	});

	it('the bevel insets the faces by the bevel depth and the hole bevel by its percentage', () => {
		const m = extrudeShapes([{ outer: square, holes: [hole] }], {
			depth: 40,
			bevelStyle: 'angular',
			bevelDepth: 6,
			holeBevel: 50,
		});
		const front: P[] = [];
		for (let i = 0; i < m.vertices.length / 9; i++)
			if (m.vertices[i * 9 + 2] === 0 && m.vertices[i * 9 + 8] === 0)
				front.push([m.vertices[i * 9]!, m.vertices[i * 9 + 1]!]);
		const xs = front.map((p) => p[0]);
		expect(Math.min(...xs)).toBeCloseTo(6, 6);
		expect(Math.max(...xs)).toBeCloseTo(94, 6);
		// Hole edge at x 30 moves 3 px into the solid (away from the hole): x 27.
		expect(xs.some((x) => Math.abs(x - 27) < 1e-6)).toBe(true);
	});
});
