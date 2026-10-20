// Tests ported from EffectCraft's crates/path/src/ops/tests.rs (MIT OR Apache-2.0).
import { describe, expect, it } from 'vitest';
import { filledArea } from '../../src/vector/boolean.ts';
import {
	type BezPath,
	circlePath,
	lineCubic,
	pathBounds,
	pathLength,
	polyline,
	signedArea,
} from '../../src/vector/geom.ts';
import {
	DEFAULT_WIGGLE,
	merge,
	offset,
	puckerBloat,
	reverse,
	roundCorners,
	trim,
	trimIndividually,
	twist,
	wiggle,
	zigzag,
} from '../../src/vector/ops.ts';

const sq = (x: number, y: number, s: number): BezPath => [
	polyline(
		[
			[x, y],
			[x + s, y],
			[x + s, y + s],
			[x, y + s],
		],
		true,
	),
];
const circle = (x: number, y: number, r: number): BezPath => [circlePath([x, y], r)];
const line = (x0: number, y0: number, x1: number, y1: number): BezPath => [
	{ segs: [lineCubic([x0, y0], [x1, y1])], closed: false },
];
const len = (ps: BezPath[]) => ps.reduce((a, p) => a + pathLength(p), 0);
const area = (ps: BezPath[]) => filledArea(ps.flat(), 'nonzero');
const onCurve = (p: BezPath) => {
	const out: [number, number][] = [];
	for (const sp of p) {
		out.push([sp.segs[0]![0][0], sp.segs[0]![0][1]]);
		sp.segs.forEach((c, i) => {
			if (!(sp.closed && i === sp.segs.length - 1)) out.push([c[3][0], c[3][1]]);
		});
	}
	return out;
};
const close = (a: number, b: number, tol: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('trim', () => {
	it('trims half a square, with and without offset', () => {
		close(len(trim([sq(0, 0, 100)], 0, 50, 0)), 200, 0.5);
		close(len(trim([sq(0, 0, 100)], 0, 50, 270)), 200, 0.5);
	});
	it('keeps an empty slot', () => {
		const t = trim([sq(0, 0, 10)], 30, 30, 0);
		expect(t).toHaveLength(1);
		expect(t[0]).toHaveLength(0);
	});
	it('is one piece across the start of a closed path', () => {
		expect(trim([sq(0, 0, 100)], 0, 50, 270)[0]).toHaveLength(1);
	});
	it('simultaneously trims each path by its own length', () => {
		const t = trim([sq(0, 0, 100), sq(200, 0, 50)], 0, 50, 0);
		close(pathLength(t[0]!), 200, 0.5);
		close(pathLength(t[1]!), 100, 0.5);
	});
	it('individually trims sequentially', () => {
		const paths = [sq(0, 0, 100), sq(200, 0, 100)];
		let t = trimIndividually(paths, 0, 50, 0);
		close(pathLength(t[0]!), 400, 0.5);
		expect(pathLength(t[1]!)).toBeLessThan(1e-6);
		t = trimIndividually(paths, 25, 75, 0);
		close(pathLength(t[0]!), 200, 0.5);
		close(pathLength(t[1]!), 200, 0.5);
		t = trimIndividually([sq(0, 0, 100), sq(200, 0, 25)], 10, 90, 45);
		close(len(t), 0.8 * 500, 0.5);
	});
	it('reverse flips orientation', () => {
		const s = sq(0, 0, 10);
		const r = reverse([s])[0]!;
		close(signedArea(r), -signedArea(s), 1e-9);
	});
});

describe('round corners', () => {
	it('rounds a square like the rectangle roundness', () => {
		const r = roundCorners([sq(0, 0, 100)], 10)[0]!;
		close(Math.abs(signedArea(r)), 10000 - (4 - Math.PI) * 100, 1);
	});
	it('clamps to half a segment', () => {
		close(Math.abs(signedArea(roundCorners([sq(0, 0, 20)], 100)[0]!)), Math.PI * 100, 2);
	});
	it('keeps open endpoints when rounding corners', () => {
		const open: BezPath = [
			polyline(
				[
					[0, 0],
					[100, 0],
					[100, 100],
				],
				false,
			),
		];
		const r = roundCorners([open], 20)[0]!;
		const pts = onCurve(r);
		expect(pts[0]).toEqual([0, 0]);
		close(pts[pts.length - 1]![0], 100, 1e-9);
		close(pts[pts.length - 1]![1], 100, 1e-9);
	});
});

describe('offset', () => {
	it('grows a square with a miter', () => {
		const o = offset([sq(0, 0, 100)], 10, 'miter', 4, 1, 0);
		close(area(o), 120 * 120, 1);
		const b = pathBounds(o[0]!)!;
		close(b.x0, -10, 1e-3);
		close(b.x1, 110, 1e-3);
	});
	it('round and bevel joins', () => {
		close(area(offset([sq(0, 0, 100)], 10, 'round', 4, 1, 0)), 10000 + 4000 + Math.PI * 100, 2);
		close(area(offset([sq(0, 0, 100)], 10, 'bevel', 4, 1, 0)), 10000 + 4000 + 200, 2);
	});
	it('negative shrinks', () => {
		close(area(offset([sq(0, 0, 100)], -10, 'miter', 4, 1, 0)), 6400, 1);
		expect(area(offset([sq(0, 0, 100)], -60, 'miter', 4, 1, 0))).toBeLessThan(1e-6);
	});
	it('circle offsets preserve the analytic area', () => {
		close(area(offset([circle(0, 0, 50)], 10, 'round', 4, 1, 0)), Math.PI * 3600, 3600 * Math.PI * 1e-3);
		const o = offset([circle(0, 0, 50)], -20, 'round', 4, 1, 0);
		close(area(o), Math.PI * 900, 900 * Math.PI * 1e-3);
	});
	it('is independent of orientation', () => {
		const s = sq(0, 0, 100);
		close(area(offset([s], 5, 'miter', 4, 1, 0)), area(offset(reverse([s]), 5, 'miter', 4, 1, 0)), 1e-3);
	});
	it('copies', () => {
		const o = offset([sq(0, 0, 100)], 10, 'miter', 4, 3, 0);
		expect(o[0]).toHaveLength(3);
		const b = pathBounds(o[0]!)!;
		close(b.x1 - b.x0, 160, 1e-3);
		const o2 = offset([sq(0, 0, 100)], 10, 'miter', 4, 1, 1);
		const b2 = pathBounds(o2[0]!)!;
		close(b2.x1 - b2.x0, 140, 1e-3);
	});
	it('outlines an open path', () => {
		close(area(offset([line(0, 0, 100, 0)], 5, 'miter', 4, 1, 0)), 1000, 1);
	});
});

describe('pucker & bloat', () => {
	it('bloat moves vertices inwards and bulges', () => {
		const b = puckerBloat([sq(-50, -50, 100)], 50)[0]!;
		for (const p of onCurve(b)) {
			close(Math.abs(p[0]), 25, 1e-9);
			close(Math.abs(p[1]), 25, 1e-9);
		}
		const bb = pathBounds(b)!;
		expect(bb.x1 - bb.x0).toBeGreaterThan(51);
	});
	it('pucker moves vertices outwards', () => {
		const s = sq(-50, -50, 100);
		const p = puckerBloat([s], -50)[0]!;
		for (const q of onCurve(p)) {
			close(Math.abs(q[0]), 75, 1e-9);
			close(Math.abs(q[1]), 75, 1e-9);
		}
		expect(area([p])).toBeLessThan(area([s]) * 2.25);
	});
});

describe('twist', () => {
	it('rotates by distance', () => {
		const t = twist([line(0, 0, 100, 0)], 90, [0, 0])[0]!;
		const pts = onCurve(t);
		close(Math.hypot(...pts[0]!), 0, 1e-9);
		const end = pts[pts.length - 1]!;
		close(end[0], 0, 1e-9);
		close(end[1], 100, 1e-9);
		for (const p of pts) {
			const r = Math.hypot(p[0], p[1]);
			if (r > 1e-9) close(Math.atan2(p[1], p[0]), ((Math.PI / 2) * r) / 100, 1e-9);
		}
	});
	it('keeps a centred circle round', () => {
		const c = circle(0, 0, 50);
		close(area(twist([c], 120, [0, 0])), area([c]), 1);
	});
});

describe('zig zag', () => {
	it('zigzag coordinates follow amplitude and alternate sides', () => {
		const z = zigzag([line(0, 0, 100, 0)], 5, 3, false)[0]!;
		const pts = onCurve(z);
		expect(pts.at(-1)?.[0]).toBe(100);
		pts.forEach((p, i) => {
			close(p[0], 25 * i, 1e-6);
			close(Math.abs(p[1]), 5, 1e-9);
			if (i > 0) expect(p[1] * pts[i - 1]![1]).toBeLessThan(0);
		});
	});
});

describe('wiggle', () => {
	it('is deterministic and time varying', () => {
		const s = [sq(0, 0, 100)];
		const w = DEFAULT_WIGGLE;
		const a = wiggle(s, w, 0.5);
		expect(a).toEqual(wiggle(s, w, 0.5));
		expect(a).not.toEqual(wiggle(s, w, 0.75));
		expect(a).not.toEqual(wiggle(s, { ...w, seed: 3 }, 0.5));
		const w1 = { ...w, speed: 1 };
		const p1 = wiggle(s, { ...w1, temporalPhase: 360 }, 0.25)[0]!;
		const p2 = wiggle(s, w1, 1.25)[0]!;
		onCurve(p1).forEach((p, i) => {
			close(p[0], onCurve(p2)[i]![0], 1e-9);
		});
	});
	it('spatial phase shifts the pattern continuously', () => {
		const s = [line(0, 0, 1000, 0)];
		const w = { ...DEFAULT_WIGGLE, smooth: false, detail: 20, correlation: 0 };
		const a = onCurve(wiggle(s, w, 0.3)[0]!);
		const b = onCurve(wiggle(s, { ...w, spatialPhase: 360 }, 0.3)[0]!);
		// One revolution = one point along: point i of b displaces like point i+1 of a.
		for (let i = 0; i + 1 < a.length; i++) close(b[i]![1], a[i + 1]![1], 1e-9);
		const c = onCurve(wiggle(s, { ...w, spatialPhase: 10 }, 0.3)[0]!);
		expect(Math.abs(c[3]![1] - a[3]![1])).toBeLessThan(w.size);
	});
	it('displacement is bounded', () => {
		const w = { ...DEFAULT_WIGGLE, size: 7, detail: 50, smooth: false };
		for (const t of [0, 0.3, 1.7, 9.1]) {
			const pts = onCurve(wiggle([line(0, 0, 1000, 0)], w, t)[0]!);
			expect(pts).toHaveLength(52);
			expect(pts.every((p) => Math.abs(p[1]) <= 7 * 1.0001)).toBe(true);
			expect(pts.some((p) => Math.abs(p[1]) > 0.1)).toBe(true);
		}
	});
	it('full correlation translates', () => {
		const s = [sq(0, 0, 100)];
		const w = { ...DEFAULT_WIGGLE, correlation: 100, smooth: false };
		close(area(wiggle(s, w, 0.4)), 10000, 1e-6);
		expect(wiggle(s, { ...w, size: 0 }, 1)[0]).toBe(s[0]);
	});
});

describe('merge', () => {
	const ie = (a: BezPath, b: BezPath) => {
		const aa = area([a]);
		const ab = area([b]);
		const u = area([merge([a, b], 'add')]);
		const i = area([merge([a, b], 'intersect')]);
		const s = area([merge([a, b], 'subtract')]);
		const x = area([merge([a, b], 'exclude')]);
		const tol = 1e-3 * (aa + ab);
		expect(i).toBeGreaterThan(1);
		close(u, aa + ab - i, tol);
		close(s, aa - i, tol);
		close(x, u - i, tol);
	};
	it('rect inclusion-exclusion', () => {
		ie(sq(0, 0, 100), sq(50, 30, 100));
		close(area([merge([sq(0, 0, 100), sq(50, 30, 100)], 'intersect')]), 3500, 1e-6);
	});
	it('edge cases', () => {
		const a = sq(0, 0, 10);
		const b = sq(100, 0, 10);
		expect(area([merge([a, b], 'intersect')])).toBeLessThan(1e-9);
		close(area([merge([a, b], 'add')]), 200, 1e-6);
		expect(merge([a, b], 'merge')).toHaveLength(2);
		close(area([merge([sq(0, 0, 100), sq(0, 0, 50), sq(50, 50, 50)], 'subtract')]), 5000, 1e-6);
		expect(merge([], 'add')).toHaveLength(0);
	});
	it('fill rules', () => {
		const p = [...sq(0, 0, 100), ...sq(50, 0, 100)];
		close(filledArea(p, 'nonzero'), 15000, 1e-6);
		close(filledArea(p, 'evenodd'), 10000, 1e-6);
	});
});

// Inclusion–exclusion for one pair of filled shapes, under every merge mode.
const inclusionExclusion = (a: BezPath, b: BezPath) => {
	const aa = area([a]);
	const ab = area([b]);
	const u = area([merge([a, b], 'add')]);
	const i = area([merge([a, b], 'intersect')]);
	const s = area([merge([a, b], 'subtract')]);
	const x = area([merge([a, b], 'exclude')]);
	const tol = 2e-3 * (aa + ab) + 1e-6;
	expect(Math.abs(u - (aa + ab - i))).toBeLessThanOrEqual(tol);
	expect(Math.abs(s - (aa - i))).toBeLessThanOrEqual(tol);
	expect(Math.abs(x - (u - i))).toBeLessThanOrEqual(tol);
	expect(u + 1e-6).toBeGreaterThanOrEqual(Math.max(aa, ab) - tol);
};

describe('merge at tangencies', () => {
	// The circle's bottom vertex (0, 2) lies on the square's top edge. Coincident leftward edges have atan2
	// angles +π and −π; PathBool must treat them as one direction (patches/path-bool@1.0.4.patch).
	it('a circle resting on a square edge', () => {
		const c = circle(0, -19, 21);
		const s = sq(-1, 2, 10);
		const add = area([merge([c, s], 'add')]);
		close(add, area([c]) + 100, 1e-6);
		expect(area([merge([c, s], 'intersect')])).toBeLessThan(1e-6);
		close(area([merge([c, s], 'subtract')]), area([c]), 1e-6);
		close(area([merge([s, c], 'subtract')]), 100, 1e-6);
		inclusionExclusion(c, s);
		inclusionExclusion(s, c);
	});
	it('circles tangent to squares on every side and to circles inside and out', () => {
		for (const r of [5, 21]) {
			const c = circle(0, 0, r);
			for (const off of [-12, -10 - r / 2, -1, 0, 1]) {
				for (const s of [sq(off, r, 12), sq(off, -r - 12, 12), sq(r, off, 12), sq(-r - 12, off, 12)]) {
					inclusionExclusion(c, s);
					inclusionExclusion(s, c);
				}
			}
			for (const [dx, dy] of [
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
			] as const)
				for (const d of [r + 13, Math.abs(r - 13)]) inclusionExclusion(c, circle(dx * d, dy * d, 13));
		}
	});
});

describe('merge (property)', () => {
	it('inclusion–exclusion holds for random rectangles and circles (curve booleans are robust)', async () => {
		const fc = (await import('fast-check')).default;
		const shape = fc.oneof(
			fc.record({
				k: fc.constant('sq' as const),
				x: fc.integer({ min: -100, max: 100 }),
				y: fc.integer({ min: -100, max: 100 }),
				s: fc.integer({ min: 10, max: 150 }),
			}),
			fc.record({
				k: fc.constant('c' as const),
				x: fc.integer({ min: -100, max: 100 }),
				y: fc.integer({ min: -100, max: 100 }),
				s: fc.integer({ min: 10, max: 120 }),
			}),
		);
		const mk = (v: { k: 'sq' | 'c'; x: number; y: number; s: number }): BezPath =>
			v.k === 'sq' ? sq(v.x, v.y, v.s) : circle(v.x, v.y, v.s / 2);
		fc.assert(
			fc.property(shape, shape, (a0, b0) => inclusionExclusion(mk(a0), mk(b0))),
			{ numRuns: 150, seed: 0x5eed },
		);
	});
	it('inclusion–exclusion holds for circles touching squares (tangencies are the hard case)', async () => {
		const fc = (await import('fast-check')).default;
		const pair = fc.record({
			cx: fc.integer({ min: -60, max: 60 }),
			cy: fc.integer({ min: -60, max: 60 }),
			r: fc.integer({ min: 3, max: 60 }),
			s: fc.integer({ min: 5, max: 120 }),
			side: fc.integer({ min: 0, max: 3 }),
			t: fc.double({ min: 0, max: 1, noNaN: true }),
		});
		fc.assert(
			fc.property(pair, ({ cx, cy, r, s, side, t }) => {
				const off = Math.round(-s - 1 + t * (s + 2));
				const b = [
					sq(cx + off, cy + r, s),
					sq(cx + off, cy - r - s, s),
					sq(cx + r, cy + off, s),
					sq(cx - r - s, cy + off, s),
				][side]!;
				inclusionExclusion(circle(cx, cy, r), b);
			}),
			{ numRuns: 60, seed: 0x7a6 },
		);
	});
});
