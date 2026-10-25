import { describe, expect, it } from 'vitest';
import { transitionSpec } from '../src/index.ts';
import { dissolveTiming, sapphirePoint } from '../src/registry/transitions/sapphire-dissolves/common.ts';

describe('Sapphire dissolve timing and migration', () => {
	it('timing eases, shifts and narrows the dissolve while preserving its endpoints', () => {
		for (const [slowIn, slowOut] of [
			[0, 0],
			[0.2, 0.2],
			[1, 0],
			[0.5, 1],
		] as const) {
			expect(dissolveTiming({ slowIn, slowOut }, 0).t).toBe(0);
			expect(dissolveTiming({ slowIn, slowOut }, 1).t).toBe(1);
			let previous = 0;
			for (let i = 1; i <= 50; i++) {
				const progress = dissolveTiming({ slowIn, slowOut }, i / 50).t;
				expect(progress).toBeGreaterThanOrEqual(previous - 1e-12);
				previous = progress;
			}
		}
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
		expect(dissolveTiming({ slowIn: 1, slowOut: 1 }, 0.1).t).toBeLessThan(0.05);
		expect(dissolveTiming({ shiftPeak: -0.2 }, 0.3)).toMatchObject({
			env: expect.closeTo(1, 12),
			mix: expect.closeTo(0.5, 12),
		});
		expect(dissolveTiming({}, 0.25).mix).toBeCloseTo(0.25);
		expect(dissolveTiming({ dissolveSpeed: 3 }, 0.25).mix).toBe(0);
		expect(dissolveTiming({ dissolveSpeed: 10 }, 0.5).mix).toBe(0.5);
		expect(dissolveTiming({ dissolveSpeed: 10 }, 0.6).mix).toBe(1);
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
