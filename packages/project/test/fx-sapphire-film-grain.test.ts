import { describe, expect, it } from 'vitest';

import { grainFrame } from '../src/registry/fx/sapphire-film-grain/common.ts';
import { jpegQualityScale, jpegSteps } from '../src/registry/fx/sapphire-film-grain/digital.ts';

describe('sapphire-film-grain maths', () => {
	it('Grain Hold: Frame = new pattern each frame; 3:2 = 4 patterns per 5 frames', () => {
		expect([0, 1, 2, 3].map((f) => grainFrame('frame', f))).toEqual([0, 1, 2, 3]);
		const pd = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((f) => grainFrame('pulldown0', f));
		expect(pd).toEqual([0, 0, 1, 2, 3, 4, 4, 5, 6, 7]);
	});

	it('JPEG quantiser follows libjpeg quality scaling', () => {
		expect(jpegQualityScale(0.5)).toBe(100);
		expect(jpegQualityScale(0.1)).toBe(500);
		expect(jpegQualityScale(1)).toBe(0);
		const s = jpegSteps(0.5);
		expect(s.luma[0]).toBeCloseTo(16 / 255);
		expect(s.chroma[63]).toBeCloseTo(99 / 255);
		expect(jpegSteps(1).luma.every((v) => v === 1 / 255)).toBe(true);
		expect(jpegSteps(0.1).luma[0]).toBeCloseTo(80 / 255);
	});
});
