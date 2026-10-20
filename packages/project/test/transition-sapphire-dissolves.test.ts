import { describe, expect, it } from 'vitest';
import { transitionSpec } from '../src/index.ts';
import {
	dissolveMix,
	dissolveTiming,
	envelope,
	peakTime,
	sapphirePoint,
	slowCurve,
} from '../src/registry/transitions/sapphire-dissolves/common.ts';

describe('Sapphire dissolve timing and migration', () => {
	it('Slow In / Slow Out ease the ends and keep 0 → 0, 1 → 1, monotone', () => {
		for (const [a, b] of [
			[0, 0],
			[0.2, 0.2],
			[1, 0],
			[0.5, 1],
		] as const) {
			expect(slowCurve(0, a, b)).toBe(0);
			expect(slowCurve(1, a, b)).toBe(1);
			let prev = 0;
			for (let i = 1; i <= 50; i++) {
				const v = slowCurve(i / 50, a, b);
				expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
				prev = v;
			}
		}
		expect(slowCurve(0.25, 0, 0)).toBeCloseTo(0.25);
		expect(slowCurve(0.1, 1, 1)).toBeLessThan(0.05); // a slow start
	});

	it('Shift Peak moves the peak; the envelope is 0 at the ends and 1 at the peak', () => {
		expect(peakTime(0.5, 0)).toBe(0.5);
		expect(peakTime(0.3, -0.2)).toBeCloseTo(0.5);
		expect(peakTime(0, 0.3)).toBe(0);
		expect(peakTime(1, 0.3)).toBe(1);
		expect(envelope(0)).toBe(0);
		expect(envelope(1)).toBeCloseTo(0, 12);
		expect(envelope(0.5)).toBe(1);
	});

	it('Dissolve Speed narrows the cross fade around the peak', () => {
		expect(dissolveMix(0.25, 1)).toBeCloseTo(0.25);
		expect(dissolveMix(0.25, 3)).toBe(0);
		expect(dissolveMix(0.5, 10)).toBe(0.5);
		expect(dissolveMix(0.6, 10)).toBe(1);
	});

	it('every combination keeps the ends: env 0, mix 0 at progress 0 and 1 at progress 1', () => {
		for (const dissolveSpeed of [1, 3, 11])
			for (const shiftPeak of [-0.45, 0, 0.3])
				for (const slow of [0, 0.5, 1]) {
					const p = { dissolveSpeed, shiftPeak, slowIn: slow, slowOut: 1 - slow };
					expect(dissolveTiming(p, 0)).toMatchObject({ env: 0, mix: 0, t: 0 });
					const end = dissolveTiming(p, 1);
					expect(end.mix).toBe(1);
					expect(end.env).toBeCloseTo(0, 12);
				}
		const peak = dissolveTiming({ shiftPeak: 0.2 }, 0.7);
		expect(peak.env).toBeCloseTo(1);
		expect(peak.mix).toBeCloseTo(0.5);
	});

	it('converts Sapphire centred points to frame-normalised ones', () => {
		expect(sapphirePoint(0, 0)).toEqual([0.5, 0.5]);
		expect(sapphirePoint(1, 0)).toEqual([1, 0.5]);
		expect(sapphirePoint(0, 0.5625)).toEqual([0.5, 0]); // y up, half widths on a 16:9 frame
	});

	it('S_DissolveLuma v1 params migrate to Sapphire’s Use Luma Of / Softness / Smooth Pattern', () => {
		const migrate = transitionSpec('jasper.s.dissolve-luma')!.migrate!;
		expect(migrate(1, { lumaFrom: 'from', width: 0.25, invert: false, blurLuma: 57.6 })).toMatchObject({
			useLumaOf: 'foreground',
			invertPattern: true,
			softness: 0.125,
			smoothPattern: expect.closeTo(1, 9),
		});
		expect(migrate(1, { lumaFrom: 'to', invert: true })).toMatchObject({
			useLumaOf: 'background',
			invertPattern: true,
		});
		expect(migrate(2, { softness: 0.3 })).toEqual({ softness: 0.3 });
	});
});
