import { type Animatable, EASE_PRESETS, type Ease, type Interpolation, type Keyframe } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { sampleVelocityCurve, timeMapOf } from '../src/panels/effectControls/graph.ts';

const RATE = { num: 30, den: 1 };
const F = 705_600_000 / 30;
const LIN = EASE_PRESETS.linear;
const clip = { start: 10, duration: 60, sourceIn: 0, speed: { rate: 1, reverse: false } };
const map = timeMapOf(clip, RATE);
const range = { start: 0, end: 80 };

function kf<T>(
	id: string,
	frame: number,
	value: T,
	interpolation: Interpolation = 'linear',
	easeIn: Ease = LIN,
	easeOut: Ease = LIN,
): Keyframe<T> {
	return { id, time: frame * F, value, interpolation, easeIn: { ...easeIn }, easeOut: { ...easeOut } };
}
const anim = <T>(keyframes: Keyframe<T>[]): Animatable<T> => ({ value: keyframes[0]!.value, keyframes });

function curveVelocityAt(pts: { x: number; y: number }[], x: number, side: 'in' | 'out'): number {
	const at = pts.filter((p) => Math.abs(p.x - x) < 1e-6);
	return side === 'in' ? at[0]!.y : at[at.length - 1]!.y;
}

describe('velocity curve', () => {
	it('is the derivative of evaluate in units per second: constant on linear segments, zero outside', () => {
		// 0 → 90 over 30 frames at 30 fps = 90 units / s.
		const a = anim([kf('a', 0, 0), kf('b', 30, 90)]);
		const v = sampleVelocityCurve(a, map, range, 300);
		const inside = v.filter((p) => p.x > 10.5 && p.x < 39.5);
		expect(inside.length).toBeGreaterThan(0);
		for (const p of inside) expect(p.y).toBeCloseTo(90, 6);
		expect(v[0]!.y).toBe(0);
		expect(v[v.length - 1]!.y).toBe(0);
	});
	it('eases to zero speed at an Ease Out key and steps at keys with different in/out speeds', () => {
		const a = anim([
			kf('a', 0, 0, 'bezier', LIN, { influence: 1 / 3, slope: 0 }),
			kf('b', 30, 90),
			kf('c', 45, 0),
		]);
		const v = sampleVelocityCurve(a, map, range, 300);
		expect(Math.abs(curveVelocityAt(v, 10, 'out'))).toBeLessThan(0.5); // ≈ 0 (one-sided step)
		expect(curveVelocityAt(v, 40, 'in')).toBeGreaterThan(0);
		expect(curveVelocityAt(v, 40, 'out')).toBeCloseTo(-180, 3); // 90 down over 15 frames
	});
	it('vec2 velocity is the speed along the path; reversed clips flip the sign of numbers', () => {
		const p = anim<[number, number]>([kf('a', 0, [0, 0]), kf('b', 30, [30, 40])]);
		const v = sampleVelocityCurve(p, map, range, 300);
		expect(v.find((q) => q.x > 20 && q.x < 30)!.y).toBeCloseTo(50, 6);
		const rev = timeMapOf({ ...clip, speed: { rate: 1, reverse: true } }, RATE);
		const n = sampleVelocityCurve(anim([kf('a', 0, 0), kf('b', 30, 90)]), rev, range, 300);
		expect(n.find((q) => q.x > 45 && q.x < 60)!.y).toBeCloseTo(-90, 6);
		for (let i = 1; i < n.length; i++) expect(n[i]!.x).toBeGreaterThanOrEqual(n[i - 1]!.x - 1e-9);
	});
	it('holds have zero velocity', () => {
		const v = sampleVelocityCurve(anim([kf('a', 0, 0, 'hold'), kf('b', 30, 90)]), map, range, 300);
		expect(v.length).toBeGreaterThan(0);
		expect(v.every((p) => p.y === 0)).toBe(true);
	});
});
