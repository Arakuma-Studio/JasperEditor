import { describe, expect, it } from 'vitest';
import { readbackSize } from '../src/color/scopes/capture.ts';

describe('scope readback', () => {
	it('reads back at most 256 px wide, keeping the aspect', () => {
		expect(readbackSize(1920, 1080)).toEqual({ width: 256, height: 144 });
		expect(readbackSize(200, 100)).toEqual({ width: 200, height: 100 });
		expect(readbackSize(0, 100)).toBeNull();
	});
});
