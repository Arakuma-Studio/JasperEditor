// @vitest-environment node
// Sound design Phase 4 verification: the curves the preview graph schedules on an automated AudioParam while playing
// (`curvePoints` / `followCurve`, src/audio/automation.ts). Linear pieces through the curve's own values: within
// AUTOMATION_TOLERANCE of a dB ramp everywhere, corners on the keyframes (break points), flat stretches one point.
import { describe, expect, it } from 'vitest';
import { AUTOMATION_TOLERANCE, curvePoints } from '../src/audio/automation.ts';
import { clipLevelsAnimated, graphAppliesLevels } from '../src/audio/graph.ts';

const SR = 48000;
const db = (x: number) => 10 ** (x / 20);

/** The piecewise-linear schedule's value at `dt` (start value `v0` at 0). */
function scheduled(v0: number, pts: [number, number][], dt: number): number {
	let a: [number, number] = [0, v0];
	for (const p of pts) {
		if (dt <= p[0]) return a[1] + ((p[1] - a[1]) * (dt - a[0])) / (p[0] - a[0] || 1);
		a = p;
	}
	return a[1];
}

describe('followed automation curves', () => {
	it('a flat stretch is one point at the horizon', () => {
		expect(curvePoints(() => 0.5, SR, 0.12)).toEqual([[0.12, 0.5]]);
	});

	it('a −24 dB stop-before dip (30 ms ramps) is followed within the tolerance, corners on its keyframes', () => {
		// keys (s after now): 0.02 → 0 dB, 0.05 → −24 dB, 0.08 → −24 dB, 0.11 → 0 dB (linear in dB between them)
		const keys: [number, number][] = [
			[0.02, 0],
			[0.05, -24],
			[0.08, -24],
			[0.11, 0],
		];
		const lane = (t: number) => {
			if (t <= keys[0]![0]) return keys[0]![1];
			for (let i = 1; i < keys.length; i++)
				if (t <= keys[i]![0]) {
					const [a, va] = keys[i - 1]!;
					const [b, vb] = keys[i]!;
					return va + ((vb - va) * (t - a)) / (b - a);
				}
			return keys[keys.length - 1]![1];
		};
		const value = (t: number) => db(lane(t));
		const pts = curvePoints(
			value,
			SR,
			0.12,
			keys.map((k) => k[0]),
		);
		for (const [k] of keys) expect(pts.some(([t]) => Math.abs(t - k) < 1e-12)).toBe(true);
		let worst = 0;
		for (let i = 0; i <= 0.12 * SR; i++) {
			const t = i / SR;
			worst = Math.max(worst, Math.abs(scheduled(value(0), pts, t) - value(t)) / value(t));
		}
		expect(worst).toBeLessThan(2 * AUTOMATION_TOLERANCE);
		// ≈ 0.4 ms pieces on the 0.8 dB/ms ramps, nothing on the flat parts (measured 257 points for 5 760 samples)
		expect(pts.length).toBeLessThan(400);
	});

	it('hostile values are scheduled as 0, never NaN', () => {
		const pts = curvePoints((t) => (t > 0.05 ? Number.NaN : 1), SR, 0.12);
		expect(pts.every(([t, v]) => Number.isFinite(t) && Number.isFinite(v))).toBe(true);
		expect(pts[pts.length - 1]![1]).toBe(0);
	});

	it('the graph applies a clip level that changes over time (Volume keyframes, fades, nested gain)', () => {
		const still = { effects: [], volumeDb: { value: 0, keyframes: [] }, fades: [], nestGain: undefined };
		expect(graphAppliesLevels(still)).toBe(false);
		const keyed = {
			...still,
			volumeDb: {
				value: 0,
				keyframes: [
					{
						id: 'k',
						time: 0,
						value: -6,
						interpolation: 'linear' as const,
						easeIn: { influence: 1 / 3, slope: 0 },
						easeOut: { influence: 1 / 3, slope: 0 },
					},
				],
			},
		};
		expect(clipLevelsAnimated(keyed)).toBe(true);
		expect(graphAppliesLevels(keyed)).toBe(true);
		expect(
			clipLevelsAnimated({
				...still,
				fades: [{ type: 'in', start: 0, frames: 10, curve: 'linear' }] as never,
			}),
		).toBe(true);
	});
});
