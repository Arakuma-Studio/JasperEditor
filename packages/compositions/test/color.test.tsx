import {
	applyLut,
	bakeColorRun,
	bakeLut,
	defaultEffectRegistry,
	LUMETRI_EFFECT_ID,
	serializeCube,
} from '@jasper/project';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadLutAsset } from '../src/color/luts.ts';
import { applyLutRgba8 } from '../src/index.ts';

afterEach(() => vi.unstubAllGlobals());

describe('LUT assets (S06:LUT-003)', () => {
	it('reuses an imported LUT when a render URL is re-signed', async () => {
		const cube = serializeCube(
			bakeLut(3, (c) => {
				c[0] = 1 - c[0];
			}),
		);
		const fetchImpl = vi.fn(async () => new Response(cube)) as unknown as typeof fetch;
		vi.stubGlobal('fetch', fetchImpl);
		const first = await loadLutAsset('/media/lut-cache-case?sig=a');
		const second = await loadLutAsset('/media/lut-cache-case?sig=b');
		expect(first?.size).toBe(3);
		expect(second?.size).toBe(3);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('a malformed LUT settles as unavailable instead of blocking the render', async () => {
		const fetchImpl = vi.fn(async () => new Response('LUT_3D_SIZE 2\n0 0 0\n')) as unknown as typeof fetch;
		vi.stubGlobal('fetch', fetchImpl);
		expect(await loadLutAsset('/media/lut-invalid-case')).toBeNull();
	});
});

describe('CPU colour pass (S06:CG-043)', () => {
	it('matches the independent project LUT reference and leaves alpha untouched', () => {
		const lut = bakeColorRun(
			[
				{
					id: 'grade',
					effectId: LUMETRI_EFFECT_ID,
					effectVersion: 1,
					enabled: true,
					params: { exposure: 0.4, contrast: 20, saturation: 130, midtonesWheel: [0.2, -0.1] },
				},
			],
			defaultEffectRegistry,
			{ lut: () => null },
			33,
		)!;
		const n = 40_000;
		const pixels = new Uint8ClampedArray(n * 4);
		for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 2654435761) >>> 24;
		const source = Uint8ClampedArray.from(pixels);
		applyLutRgba8(lut, pixels);
		let maxDifference = 0;
		let maxAlphaDifference = 0;
		const color: [number, number, number] = [0, 0, 0];
		for (let p = 0; p < pixels.length; p += 4) {
			color[0] = source[p]! / 255;
			color[1] = source[p + 1]! / 255;
			color[2] = source[p + 2]! / 255;
			applyLut(lut, color);
			for (let k = 0; k < 3; k++)
				maxDifference = Math.max(maxDifference, Math.abs(pixels[p + k]! - Math.round(color[k]! * 255)));
			maxAlphaDifference = Math.max(maxAlphaDifference, Math.abs(pixels[p + 3]! - source[p + 3]!));
		}
		expect(maxDifference).toBeLessThanOrEqual(1);
		expect(maxAlphaDifference).toBe(0);
	});
});
