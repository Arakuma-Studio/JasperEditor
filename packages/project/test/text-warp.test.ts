// Spec 19 TL-110. `fixtures/patchy-warp-meshes.json` is the output of Patchy's own `warp_mesh.cpp` at the pinned commit
// (licenses/ported/patchy-warp.md), compiled and run once: the port must reproduce it control point by control point.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	applyWarpDistortion,
	defaultEffectRegistry,
	elevateWarpMeshToCubic,
	evaluateWarpMesh,
	gpuPadding,
	planGpuEffect,
	styleWarpMesh,
	TEXT_WARP,
	TEXT_WARP_EFFECT_ID,
	WARP_STYLES,
	type WarpParams,
	warpBounds,
	warpIsIdentity,
	warpMapPoint,
	warpSurface,
} from '../src/index.ts';

type Golden = {
	style: string;
	bend: number;
	rotate: boolean;
	h: number;
	v: number;
	uOrder: number;
	vOrder: number;
	xs: number[];
	ys: number[];
	at: [number, number];
};
const GOLDEN: Golden[] = JSON.parse(
	readFileSync(join(__dirname, 'fixtures', 'patchy-warp-meshes.json'), 'utf8'),
);

const params = (over: Partial<WarpParams> = {}): WarpParams => ({
	style: 'arc',
	bend: 50,
	horizontal: 0,
	vertical: 0,
	rotateVertical: false,
	...over,
});
const lowerFirst = (s: string) => s[0]!.toLowerCase() + s.slice(1);

describe('warp meshes (spec 19 TL-110)', () => {
	it('has the 15 styles of Photoshop', () => {
		expect(WARP_STYLES).toHaveLength(15);
		expect(new Set(GOLDEN.map((g) => lowerFirst(g.style)))).toEqual(new Set(WARP_STYLES));
	});

	it.each(GOLDEN.map((g) => [`${g.style} ${g.bend} ${g.rotate ? 'V' : 'H'} ${g.h}/${g.v}`, g] as const))(
		'reproduces Patchy: %s',
		(_, g) => {
			const m = styleWarpMesh(lowerFirst(g.style) as (typeof WARP_STYLES)[number], g.bend, g.rotate, 300, 100);
			applyWarpDistortion(m, g.h, g.v);
			expect([m.uOrder, m.vOrder]).toEqual([g.uOrder, g.vOrder]);
			m.xs.forEach((x, i) => {
				expect(x).toBeCloseTo(g.xs[i]!, 6);
			});
			m.ys.forEach((y, i) => {
				expect(y).toBeCloseTo(g.ys[i]!, 6);
			});
			const [x, y] = evaluateWarpMesh(elevateWarpMeshToCubic(m), 0.3, 0.7);
			expect(x).toBeCloseTo(g.at[0], 6);
			expect(y).toBeCloseTo(g.at[1], 6);
		},
	);

	it('a flat warp maps the box onto itself, in every style', () => {
		for (const style of WARP_STYLES) {
			const s = warpSurface(params({ style, bend: 0 }), 300, 100)!;
			const [x, y] = warpMapPoint(s, 0.25, 0.75);
			expect(x).toBeCloseTo(0.25, 6);
			expect(y).toBeCloseTo(0.75, 6);
		}
	});

	it('elevation keeps the surface', () => {
		for (const style of WARP_STYLES) {
			const m = styleWarpMesh(style, 60, false, 300, 100);
			const c = elevateWarpMeshToCubic(m);
			expect([c.uOrder, c.vOrder]).toEqual([4, 4]);
			for (const [u, v] of [
				[0, 0],
				[0.2, 0.9],
				[0.5, 0.5],
				[1, 1],
			] as const) {
				const a = evaluateWarpMesh(m, u, v);
				const b = evaluateWarpMesh(c, u, v);
				expect(b[0]).toBeCloseTo(a[0], 8);
				expect(b[1]).toBeCloseTo(a[1], 8);
			}
		}
	});

	it('keeps the warped frame centred on the box, so a bend does not drift the title', () => {
		for (const style of WARP_STYLES)
			for (const bend of [-100, -40, 25, 100]) {
				const s = warpSurface(params({ style, bend }), 320, 90)!;
				const edge = warpBounds(s, { x0: 0, y0: 0, x1: 1, y1: 1 }, 64);
				expect((edge.x0 + edge.x1) / 2).toBeCloseTo(0.5, 1);
				expect((edge.y0 + edge.y1) / 2).toBeCloseTo(0.5, 1);
			}
	});

	it('is continuous past the box, and straight there', () => {
		const s = warpSurface(params({ style: 'bulge', bend: 80 }), 300, 100)!;
		const [ax, ay] = warpMapPoint(s, 1, 0.5);
		const [bx, by] = warpMapPoint(s, 1.0001, 0.5);
		expect(Math.hypot(bx - ax, by - ay)).toBeLessThan(0.01);
		const at = (u: number) => warpMapPoint(s, u, 0.5);
		const [x1, y1] = at(1.5);
		const [x2, y2] = at(2);
		const [x3, y3] = at(2.5);
		expect(x3 - x2).toBeCloseTo(x2 - x1, 8);
		expect(y3 - y2).toBeCloseTo(y2 - y1, 8);
	});

	it('never produces a non-finite surface (fuzz)', () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...WARP_STYLES),
				fc.double({ min: -1000, max: 1000, noNaN: true }),
				fc.double({ min: -1000, max: 1000, noNaN: true }),
				fc.double({ min: -1000, max: 1000, noNaN: true }),
				fc.boolean(),
				fc.double({ min: 1, max: 8192, noNaN: true }),
				fc.double({ min: 1, max: 8192, noNaN: true }),
				(style, bend, horizontal, vertical, rotateVertical, w, h) => {
					const s = warpSurface({ style, bend, horizontal, vertical, rotateVertical }, w, h);
					expect(s).not.toBeNull();
					expect([...s!].every(Number.isFinite)).toBe(true);
				},
			),
			{ numRuns: 300 },
		);
	});

	it('refuses degenerate boxes', () => {
		expect(warpSurface(params(), 0, 100)).toBeNull();
		expect(warpSurface(params(), 100, Number.NaN)).toBeNull();
	});
});

describe('Warp Text effect (spec 19 TL-110)', () => {
	const ctx = { width: 400, height: 100, pxScale: 1, fps: 30 };
	const P = {
		style: 'arc',
		orientation: 'horizontal',
		bend: 50,
		horizontalDistortion: 0,
		verticalDistortion: 0,
	};

	it('is registered, and every number animates', () => {
		const spec = defaultEffectRegistry.get(TEXT_WARP_EFFECT_ID);
		expect(spec?.category).toBe('Distort');
		const animatable = spec!.params.filter((p) => p.type === 'number' && p.animatable).map((p) => p.name);
		expect(animatable).toEqual(['bend', 'horizontalDistortion', 'verticalDistortion']);
		expect(spec!.params.find((p) => p.name === 'style')?.options).toEqual([...WARP_STYLES]);
	});

	it('flat is a pass-through, a bend is a mesh of the same lattice at every resolution', () => {
		const flat = planGpuEffect(TEXT_WARP, { id: 'f', params: { ...P, bend: 0 } }, frame(1), {
			width: 400,
			height: 100,
		});
		expect(flat.passes[0]!.vertex).toBeUndefined();
		const a = planGpuEffect(TEXT_WARP, { id: 'f', params: P }, frame(1), { width: 400, height: 100 });
		const b = planGpuEffect(TEXT_WARP, { id: 'f', params: P }, frame(2), { width: 800, height: 200 });
		expect(a.passes[0]!.vertex?.vertices).toBe(b.passes[0]!.vertex?.vertices);
		const patch = (x: typeof a) => x.uniforms.find((u) => u.name === 'u_twPatch')?.value;
		expect(patch(a)).toEqual(patch(b));
	});

	it('pads what the warp reaches, and counts what the input already reaches', () => {
		const alone = gpuPadding(TEXT_WARP, P, ctx);
		expect(Math.max(alone.left, alone.top, alone.right, alone.bottom)).toBeGreaterThan(10);
		const big = 400;
		const padded = gpuPadding(TEXT_WARP, P, {
			...ctx,
			inputPadding: { left: big, top: big, right: big, bottom: big },
		});
		// A wide glow around the title comes along: what it reaches past the warped frame stays inside the canvas.
		const s = warpSurface({ ...params(), bend: 50 }, ctx.width, ctx.height)!;
		const b = warpBounds(s, {
			x0: -big / ctx.width,
			y0: -big / ctx.height,
			x1: 1 + big / ctx.width,
			y1: 1 + big / ctx.height,
		});
		expect(big + padded.left).toBeGreaterThanOrEqual(-b.x0 * ctx.width);
		expect(big + padded.right).toBeGreaterThanOrEqual((b.x1 - 1) * ctx.width);
		expect(big + padded.top).toBeGreaterThanOrEqual(-b.y0 * ctx.height);
		expect(big + padded.bottom).toBeGreaterThanOrEqual((b.y1 - 1) * ctx.height);
	});

	it('a flat warp asks for no padding', () => {
		expect(gpuPadding(TEXT_WARP, { ...P, bend: 0 }, ctx)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
		expect(warpIsIdentity(params({ bend: 0 }))).toBe(true);
	});

	function frame(pxScale: number) {
		return { ...ctx, pxScale, frame: 0, duration: 10, seed: 0, progress: 0 };
	}
});
