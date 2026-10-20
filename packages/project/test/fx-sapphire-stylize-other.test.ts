import { expect, it } from 'vitest';
import { defaultEffectRegistry, fxTimeSamples } from '../src/index.ts';

it('S_PixelMosh requests the previous frame and hold frame, and none when flow warp is disabled', () => {
	const spec = defaultEffectRegistry.get('jasper.s.pixel-mosh')!;
	const params = {
		...Object.fromEntries(spec.params.map((p) => [p.name, p.default])),
		frameInterval: 10,
		varyFrameInterval: 0,
	};
	const samples = (frame: number, useFlowWarp = true) =>
		fxTimeSamples(
			spec,
			{ ...params, useFlowWarp },
			{ frame, fps: 30, duration: 60, headHandle: 0, tailHandle: 0, seed: 0.1 },
		);
	expect(samples(10)).toEqual([]);
	expect(samples(11)).toEqual([-1]);
	expect(samples(17)).toEqual([-1, -7]);
	expect(samples(17, false)).toEqual([]);
});
