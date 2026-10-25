// Shared set-up for the keyframe assistant (easing) tests.
import { expect } from 'vitest';
import { type Animatable, type CubicEase, checkInvariants, evaluate, type Vec2 } from '../src/index.ts';
import { Harness } from './helpers.ts';

export const SEC = 705_600_000;

/** Reference CSS cubic-bezier: solve x(t) = u by bisection, return y(t). */
export function cssCubic(c: CubicEase, u: number): number {
	const bez = (t: number, a: number, b: number) =>
		3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 200; i++) {
		const mid = (lo + hi) / 2;
		if (bez(mid, c.x1, c.x2) < u) lo = mid;
		else hi = mid;
	}
	return bez((lo + hi) / 2, c.y1, c.y2);
}

type AnyClip = Record<string, unknown> & { transform: Record<string, Animatable<unknown>> };

/** A solid clip (300 frames on V1) with keyed properties. */
export function setup() {
	const h = new Harness();
	h.ok([{ type: 'clip.addSolid', at: 0, duration: 300, track: 'V1', color: [1, 0, 0, 1] }]);
	const id = h.clips('V1')[0]!.id;
	const clip = () => h.seq.clips[id] as unknown as AnyClip;
	const path = (prop: string) => ['clip', id, ...prop.split('.')];
	const anim = <T = unknown>(prop: string): Animatable<T> => {
		let cur: unknown = clip();
		for (const k of prop.split('.')) cur = (cur as Record<string, unknown>)[k];
		return cur as Animatable<T>;
	};
	/** Keys at sequence frames with values (Linear temporal; position gets its default Auto Bezier spatial). */
	const key = (prop: string, keys: [number, unknown][]) => {
		h.ok([
			{ type: 'param.setAnimated', target: path(prop), animated: true, at: { sequenceFrame: keys[0]![0] } },
			...keys.map(([f, value]) => ({
				type: 'param.set',
				target: path(prop),
				value,
				at: { sequenceFrame: f },
			})),
		]);
		return anim(prop).keyframes.map((k) => k.id);
	};
	return { h, id, clip, path, anim, key };
}

/** Values of an animatable at n + 1 evenly spaced times from t0 to t1. */
export function sample<T>(a: Animatable<T>, t0: number, t1: number, n = 200): T[] {
	return Array.from({ length: n + 1 }, (_, k) => evaluate(a, t0 + ((t1 - t0) * k) / n));
}

export function expectValid(h: Harness): void {
	expect(checkInvariants(h.doc)).toEqual([]);
}

/** Distance from p to the polyline. */
export function distanceToPolyline(p: Vec2, poly: readonly Vec2[]): number {
	let best = Number.POSITIVE_INFINITY;
	for (let k = 0; k + 1 < poly.length; k++) {
		const a = poly[k]!;
		const b = poly[k + 1]!;
		const dx = b[0] - a[0];
		const dy = b[1] - a[1];
		const L2 = dx * dx + dy * dy;
		const t = L2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
		best = Math.min(best, Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t));
	}
	return best;
}
