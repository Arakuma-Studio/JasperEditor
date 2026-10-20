import { describe, expect, it } from 'vitest';

import {
	cornerPinInverse,
	MAT3_IDENTITY,
	mat3Apply,
	mat3Invert,
	mat3Mul,
	squareToQuad,
	warpTransformForward,
} from '../src/registry/fx/sapphire-distort-warp/math.ts';
import { parallaxAmount } from '../src/registry/fx/sapphire-distort-warp.ts';

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

describe('projective maths', () => {
	it('squareToQuad maps the unit square onto the quad; invert round-trips', () => {
		const q: [number, number][] = [
			[-0.4, -0.2],
			[0.3, -0.25],
			[0.45, 0.2],
			[-0.3, 0.3],
		];
		const m = squareToQuad(q[0]!, q[1]!, q[2]!, q[3]!)!;
		const corners: [number, number][] = [
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
		];
		corners.forEach(([x, y], i) => {
			const r = mat3Apply(m, x, y)!;
			expect(close(r[0], q[i]![0], 1e-9) && close(r[1], q[i]![1], 1e-9)).toBe(true);
		});
		const id = mat3Mul(m, mat3Invert(m)!);
		for (const [i, v] of id.entries()) expect(close(v, MAT3_IDENTITY[i]!, 1e-9)).toBe(true);
		expect(mat3Invert([1, 2, 3, 2, 4, 6, 0, 0, 1])).toBeNull();
	});

	it('cornerPinInverse maps each pinned corner (frame units) back to its source corner', () => {
		const aspect = 9 / 16;
		const pins = { tl: [0.1, 0.38], tr: [0.69, 0], br: [0.81, 0.93], bl: [0.22, 0.89] } as const;
		const inv = cornerPinInverse(pins, aspect)!;
		const f = (n: readonly [number, number]) => [n[0] - 0.5, (n[1] - 0.5) * aspect] as const;
		const at = (n: readonly [number, number]) => mat3Apply(inv, f(n)[0], f(n)[1])!;
		expect(at(pins.tl).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0]);
		expect(at(pins.tr).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 0]);
		expect(at(pins.br).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 1]);
		expect(at(pins.bl).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1]);
		expect(
			cornerPinInverse({ tl: [0.5, 0.5], tr: [0.5, 0.5], br: [0.5, 0.5], bl: [0.5, 0.5] }, aspect),
		).toBeNull();
	});

	const T0 = {
		scale: [1, 1] as [number, number],
		shift: [0, 0] as [number, number],
		zDist: 1,
		rotate: 0,
		swivel: 0,
		tilt: 0,
		perspectiveAmount: 1,
		shear: [0, 0] as [number, number],
	};

	it('S_WarpTransform: identity, shift, rotation (clockwise on screen), Z Dist, perspective', () => {
		const m = (o: Partial<typeof T0>) => warpTransformForward({ ...T0, ...o });
		const ap = (o: Partial<typeof T0>, x: number, y: number) => mat3Apply(m(o), x, y)!;
		expect(ap({}, 0.3, -0.1)).toEqual([0.3, -0.1]);
		expect(ap({ shift: [0.1, 0.2] }, 0, 0)).toEqual([0.1, 0.2]);
		const r = ap({ rotate: 90 }, 0.2, 0); // right → down on screen (y down)
		expect(close(r[0], 0, 1e-12) && close(r[1], 0.2, 1e-12)).toBe(true);
		expect(ap({ zDist: 2 }, 0.4, 0)).toEqual([0.2, 0]);
		// Swivel: the right half recedes (smaller), the left comes closer.
		const right = ap({ swivel: 40 }, 0.5, 0.2);
		const left = ap({ swivel: 40 }, -0.5, 0.2);
		expect(Math.abs(right[1])).not.toBeCloseTo(Math.abs(left[1]), 3);
	});
});

describe('other TypeScript hooks', () => {
	it('S_ParallaxStrips fades out (End) or in (Start) with clip time, or follows Manual Amount', () => {
		const p = { mode: 'automatic', fade: 'end' };
		expect(parallaxAmount(p, 0, 100)).toBe(1);
		expect(parallaxAmount(p, 99, 100)).toBe(0);
		expect(parallaxAmount({ ...p, fade: 'start' }, 0, 100)).toBe(0);
		expect(parallaxAmount({ ...p, fade: 'start' }, 99, 100)).toBe(1);
		expect(parallaxAmount({ ...p, mode: 'manual', manualAmount: 0.3 }, 99, 100)).toBe(0.3);
	});
});
