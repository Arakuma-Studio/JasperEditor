// Gallery previews cover the poster with the template's declared canvas (App QA N7).
import { describe, expect, it } from 'vitest';
import { mgPreviewFraming } from '../src/index.ts';

describe('mgPreviewFraming', () => {
	it('covers the preview with the hinted canvas, centred; null without a usable hint', () => {
		expect(mgPreviewFraming({ canvas: { width: 1080, height: 1920 } }, { width: 640, height: 360 })).toEqual({
			canvas: { width: 1080, height: 1920 },
			scale: 640 / 1080,
		});
		expect(
			mgPreviewFraming({ canvas: { width: 1920, height: 1080 } }, { width: 640, height: 360 })!.scale,
		).toBe(1 / 3);
		expect(mgPreviewFraming(undefined, { width: 640, height: 360 })).toBeNull();
		for (const bad of [
			{ width: 0, height: 10 },
			{ width: Number.NaN, height: 10 },
			{ width: '9', height: 16 },
			{},
		])
			expect(mgPreviewFraming({ canvas: bad }, { width: 640, height: 360 })).toBeNull();
		expect(mgPreviewFraming({ canvas: { width: 1080, height: 1920 } }, { width: 0, height: 360 })).toBeNull();
	});
});
