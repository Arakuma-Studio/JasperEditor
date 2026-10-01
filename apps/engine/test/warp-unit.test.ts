// S09:TRK-032: the worker kernel samples straight-alpha images on pixel centres,
// interpolates premultiplied colour, and emits BT.709 TV-range ProRes input.
import { describe, expect, it } from 'vitest';
import { warpFrame } from '../src/export/warp/kernel.ts';

const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;

describe('warp pixel contract', () => {
	it('preserves an identity-mapped image and makes uncovered pixels transparent', () => {
		const src = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
		const dst = new Uint8Array(3 * 4).fill(99);
		warpFrame(src, 2, 1, dst, 3, 1, 'rgba', [...identity], 1, [0, 0, 3, 1]);
		expect([...dst]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0]);
	});

	it('interpolates premultiplied colours at half pixels without a dark halo', () => {
		const src = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]);
		const dst = new Uint8Array(3 * 4);
		warpFrame(src, 2, 1, dst, 3, 1, 'rgba', [1, 0, -0.5, 0, 1, 0, 0, 0, 1], 1, [0, 0, 3, 1]);
		expect([...dst.subarray(4, 8)]).toEqual([255, 255, 255, 128]);
	});

	it('applies opacity and emits BT.709 TV-range YUVA with straight alpha', () => {
		const red = new Uint8Array([255, 0, 0, 255]);
		const rgba = new Uint8Array(4);
		warpFrame(red, 1, 1, rgba, 1, 1, 'rgba', [...identity], 0.5, [0, 0, 1, 1]);
		expect([...rgba]).toEqual([255, 0, 0, 128]);
		const yuva = new Uint8Array(8);
		warpFrame(red, 1, 1, yuva, 1, 1, 'yuva444p10', [...identity], 1, [0, 0, 1, 1]);
		// Red in BT.709 TV range: Y 250, Cb 409, Cr 960; 10-bit full alpha 1023.
		expect([...new Uint16Array(yuva.buffer)]).toEqual([250, 409, 960, 1023]);
	});
});
