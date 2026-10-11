// Ported from FilmCraft crates/audio-dsp/src/ducking.rs tests, plus planDucking.
import { describe, expect, it } from 'vitest';
import {
	activeRegions,
	type DuckKeyframe,
	duckKeyframes,
	envelopeDb,
	FLOOR_DB,
	planDucking,
	sensitivityThresholdDb,
} from '../src/index.ts';

const kf = (pairs: [number, number][]): DuckKeyframe[] => pairs.map(([t, db]) => ({ t, db }));

function strictlyIncreasing(k: DuckKeyframe[]): boolean {
	return k.every((v, i) => i === 0 || v.t > k[i - 1].t);
}

describe('ducking analysis', () => {
	it('envelope levels', () => {
		const sr = 1000;
		// 1 s silence, 1 s of a ±0.1 square wave (−20 dBFS RMS)
		const x = new Float32Array(2000).map((_, i) => (i < 1000 ? 0 : i % 2 === 0 ? 0.1 : -0.1));
		const e = envelopeDb([x, x], sr, 0.01, 0.02);
		expect(e.length).toBe(200);
		expect(e[10]).toBe(FLOOR_DB);
		expect(Math.abs(e[150] + 20)).toBeLessThan(0.01);
		expect(e[100]).toBeLessThan(-20);
		expect(e[100]).toBeGreaterThan(-30);
		expect(envelopeDb([], sr, 0.01, 0.02).length).toBe(0);
		expect(envelopeDb([new Float32Array(0)], sr, 0.01, 0.02).length).toBe(0);
	});

	it('activity bridges gaps, then drops blips', () => {
		const hop = 0.01;
		const env = new Float32Array(300).fill(-80);
		// speech 0.50–1.00 and 1.10–1.50 (gap 0.1 s → bridged), blip 2.00–2.03 (dropped)
		for (const [a, b] of [
			[50, 100],
			[110, 150],
			[200, 203],
		])
			env.fill(-20, a, b);
		let r = activeRegions(env, hop, -40, 0.2, 0.1);
		expect(r.length).toBe(1);
		expect(Math.abs(r[0][0] - 0.5)).toBeLessThan(1e-6);
		expect(Math.abs(r[0][1] - 1.5)).toBeLessThan(1e-6);
		r = activeRegions(env, hop, -40, 0, 0.1);
		expect(r.length).toBe(2);
		const env2 = new Float32Array(10).fill(-80);
		env2.fill(0, 5);
		expect(activeRegions(env2, 0.1, -40, 0, 0)).toEqual([[0.5, 1]]);
	});

	it('sensitivity mapping', () => {
		expect(sensitivityThresholdDb(5)).toBe(-40);
		expect(sensitivityThresholdDb(0)).toBe(-20);
		expect(sensitivityThresholdDb(10)).toBe(-60);
		expect(sensitivityThresholdDb(99)).toBe(-60);
		expect(sensitivityThresholdDb(-3)).toBe(-20);
	});

	it('duck keyframes: basic and merged', () => {
		expect(duckKeyframes([[2, 4]], 0, 10, 0, 15, 0.5)).toEqual(
			kf([
				[1.5, 0],
				[2, -15],
				[4, -15],
				[4.5, 0],
			]),
		);
		// ramps overlap (4.5 > 4.8 − 0.5 = 4.3) → stay ducked
		expect(
			duckKeyframes(
				[
					[2, 4],
					[4.8, 6],
				],
				0,
				10,
				-3,
				12,
				0.5,
			),
		).toEqual(
			kf([
				[1.5, -3],
				[2, -15],
				[6, -15],
				[6.5, -3],
			]),
		);
		const k = duckKeyframes(
			[
				[5, 6],
				[1, 2],
			],
			0,
			10,
			0,
			10,
			0.25,
		);
		expect(k.length).toBe(8);
		expect(strictlyIncreasing(k)).toBe(true);
		expect(duckKeyframes([], 0, 10, 0, 10, 0.5)).toEqual([]);
	});

	it('duck keyframes are clamped to the clip', () => {
		expect(duckKeyframes([[-1, 2]], 0, 10, 0, 10, 0.5)).toEqual(
			kf([
				[0, -10],
				[2, -10],
				[2.5, 0],
			]),
		);
		let k = duckKeyframes([[0.25, 2]], 0, 10, 0, 10, 0.5);
		expect(k[0]).toEqual({ t: 0, db: -5 });
		expect(k[1]).toEqual({ t: 0.25, db: -10 });
		expect(duckKeyframes([[8, 12]], 0, 10, 0, 10, 0.5)).toEqual(
			kf([
				[7.5, 0],
				[8, -10],
				[10, -10],
			]),
		);
		k = duckKeyframes([[8, 9.75]], 0, 10, 0, 10, 0.5);
		expect(k[k.length - 1]).toEqual({ t: 10, db: -5 });
		expect(duckKeyframes([[11, 12]], 0, 10, 0, 10, 0.5)).toEqual([]);
		k = duckKeyframes([[2, 3]], 0, 10, 0, 10, 0);
		expect(strictlyIncreasing(k)).toBe(true);
		expect(k.length).toBe(4);
		expect(duckKeyframes([[2, 4]], 0, 10, 0, -15, 0.5)).toEqual(duckKeyframes([[2, 4]], 0, 10, 0, 15, 0.5));
	});

	it('planDucking: trigger activity → keyframes in sequence time', () => {
		const sr = 8000;
		// target clip 10 s … 16 s; dialogue (−20 dBFS square) at 1.0–2.5 s and 2.6–3.0 s (bridged), a 20 ms blip
		// at 4.0 s (dropped) and a quiet −70 dBFS hum throughout
		const n = 6 * sr;
		const x = new Float32Array(n).map((_, i) => {
			const t = i / sr;
			const on = (t >= 1 && t < 2.5) || (t >= 2.6 && t < 3) || (t >= 4 && t < 4.02);
			return (on ? 0.1 : 0.000316) * (i % 2 ? 1 : -1);
		});
		const plan = planDucking({
			trigger: [x],
			sampleRate: sr,
			target: { start: 10, end: 16 },
			sensitivity: 5,
			amountDb: 12,
			fadeS: 0.5,
		});
		expect(plan.thresholdDb).toBe(-40);
		expect(plan.regions.length).toBe(1);
		const [a, b] = plan.regions[0];
		expect(Math.abs(a - 10.98)).toBeLessThan(0.03);
		expect(Math.abs(b - 13.02)).toBeLessThan(0.03);
		expect(plan.keyframes.length).toBe(4);
		expect(plan.keyframes[0].db).toBe(0);
		expect(plan.keyframes[1].db).toBe(-12);
		expect(plan.keyframes[2].db).toBe(-12);
		expect(plan.keyframes[3].db).toBe(0);
		expect(plan.keyframes[0].t).toBeCloseTo(a - 0.5, 9);
		expect(plan.keyframes[3].t).toBeCloseTo(b + 0.5, 9);
		expect(
			planDucking({
				trigger: [x],
				sampleRate: sr,
				target: { start: 10, end: 16 },
				sensitivity: 0,
				amountDb: 12,
				fadeS: 0.5,
			}).keyframes,
		).toEqual([]);
		const p2 = planDucking({
			trigger: [x],
			sampleRate: sr,
			target: { start: 10, end: 16 },
			sensitivity: 5,
			amountDb: 6,
			fadeS: 0.1,
			baseDb: -3,
			minOnS: 0.01,
		});
		expect(p2.regions.length).toBe(2);
		expect(p2.keyframes.every((k) => k.db === -3 || k.db === -9)).toBe(true);
		expect(strictlyIncreasing(p2.keyframes)).toBe(true);
	});
});
