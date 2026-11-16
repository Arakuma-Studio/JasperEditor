import { describe, expect, it } from 'vitest';
import type { EffectParams } from '../src/registry/effects.ts';
import { cornerPinBlurPadding, planCornerPinBlur } from '../src/render/corner-pin-blur.ts';

// A 400×200 layer whose pinned quad (half the box) travels `speed` box widths per frame to the right.
const W = 400;
const H = 200;
const pinAt = (x: number) => ({
	topLeft: [x, 0.25],
	topRight: [x + 0.5, 0.25],
	bottomRight: [x + 0.5, 0.75],
	bottomLeft: [x, 0.75],
});
function moving(speed: number, shutter: Record<string, unknown>) {
	const at = (f: number) => ({ ...pinAt(0.1 + speed * f), ...shutter }) as EffectParams;
	return { params: at(2), ctx: { width: W, height: H, pxScale: 1, frame: 2, paramsAt: at } };
}

describe('Corner Pin motion blur plan', () => {
	it('blurs only with its own shutter angle: Transform’s composition shutter and angle 0 leave the picture alone', () => {
		for (const shutter of [
			{},
			{ useCompShutterAngle: true, shutterAngle: 360 },
			{ useCompShutterAngle: false, shutterAngle: 0 },
		]) {
			const { params, ctx } = moving(0.2, shutter);
			expect(planCornerPinBlur(params, ctx).taps).toBe(1);
			expect(cornerPinBlurPadding(params, ctx)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
		}
	});

	it('takes about one tap per pixel the pinned corners travel, up to the quality cap, and pads the smear', () => {
		// 0.05 box widths per frame = 20 px of layer travel per frame; shutter 360 = one frame centred on the frame.
		const slow = moving(0.05, { useCompShutterAngle: false, shutterAngle: 360 });
		const plan = planCornerPinBlur(slow.params, slow.ctx);
		expect(plan.taps).toBeGreaterThanOrEqual(20);
		expect(plan.taps).toBeLessThanOrEqual(21);
		expect(plan.jitter).toBe(false);
		// The quad is half the box wide: half a frame of travel (10 px) is 20 px of pre-pin layer px on each side.
		const pad = cornerPinBlurPadding(slow.params, slow.ctx);
		expect(pad.left).toBeGreaterThanOrEqual(20);
		expect(pad.right).toBeGreaterThanOrEqual(20);
		expect(pad.left).toBeLessThanOrEqual(22);
		expect([pad.top, pad.bottom]).toEqual([0, 0]);

		const fast = moving(0.5, { useCompShutterAngle: false, shutterAngle: 360 });
		const caps = (['draft', 'auto', 'high'] as const).map(
			(q) => planCornerPinBlur({ ...fast.params, mbQuality: q }, fast.ctx).taps,
		);
		expect(caps).toEqual([16, 64, 96]);
		expect(planCornerPinBlur(fast.params, fast.ctx).jitter).toBe(true);
	});
});
