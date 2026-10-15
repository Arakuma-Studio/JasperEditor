import { describe, expect, it } from 'vitest';
import { frameStep } from '../src/registry/transitions/sapphire-swish-other/common.ts';
import { flutterAt, flutterPattern } from '../src/registry/transitions/sapphire-swish-other/cuts.ts';

describe('Sapphire transition timing', () => {
	it('frame step: the span ramp step × Start/End', () => {
		expect(frameStep({}, { duration: 19, hasFrom: true, hasTo: true })).toBeCloseTo(1 / 20, 12);
		expect(frameStep({}, { duration: 10, hasFrom: false, hasTo: true })).toBeCloseTo(1 / 10, 12);
		expect(
			frameStep({ startPercent: 25, endPercent: 75 }, { duration: 19, hasFrom: true, hasTo: true }),
		).toBeCloseTo(0.025, 12);
		expect(
			frameStep({ startPercent: 50, endPercent: 50 }, { duration: 19, hasFrom: true, hasTo: true }),
		).toBe(0);
	});

	it('FlutterCut: cycles from the start to the end lengths, colour frames, inverts, ends on B', () => {
		const p = { color1Frames: 1, color1Position: 'afterFrom', fromStartFrames: 3, toEndFrames: 3 };
		expect(
			flutterPattern(p, 12)
				.map((f) => ({ from: 'F', to: 'T', color1: 'C', color2: 'W' })[f.show])
				.join(''),
		).toBe('FFFCTTFFCTTT');
		const def = flutterPattern({}, 9);
		expect(def.map((f) => f.show[0]).join('')).toBe('fftt' + 'fftt' + 't');
		const four = flutterPattern(
			{ fromStartFrames: 4, fromEndFrames: 1, toStartFrames: 1, toEndFrames: 4 },
			16,
		);
		expect(four[0]!.show).toBe('from');
		expect(four.at(-1)!.show).toBe('to');
		expect(fromCount(four.slice(0, 5))).toBeGreaterThan(fromCount(four.slice(-5)));
		const inv = flutterPattern({ invert: 'from', normalBefore: 1, invertLength: 1 }, 8);
		expect(inv.map((f) => (f.invert ? 'i' : '.')).join('')).toBe('.i...i..');
		const custom = flutterPattern({ invert: 'custom', normalBefore: 0, invertLength: 1, normalAfter: 1 }, 6);
		expect(custom.map((f) => (f.invert ? 'i' : '.')).join('')).toBe('i.i.i.');
		const both = flutterPattern({ color2Frames: 1, color2Position: 'afterBoth' }, 7);
		expect(both.map((f) => f.show[0]).join('')).toBe('ffcttct');
		expect(flutterAt({}, 0, 9)).toEqual({ show: 'from', invert: false });
		expect(flutterAt({}, 1, 9)).toEqual({ show: 'to', invert: false });
		expect(flutterAt({}, 0.5, 9).show).toBe(def[4]!.show);
	});
});

function fromCount(frames: { show: string }[]): number {
	return frames.filter((f) => f.show === 'from').length;
}
