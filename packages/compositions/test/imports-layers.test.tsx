// imports workstream: the frame a Lottie layer shows (interpreted time → file time → Lottie frame, Frame Sampling) and
// the picture scale of vector layers (largest Motion scale, power of two, capped).
import {
	type Animatable,
	anim as constant,
	defaultSpeed,
	defaultTransform,
	EASE_PRESETS,
	FLICKS_PER_SECOND,
	type MediaHandle,
	type RenderVisualClip,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { lottieFrameForLayer } from '../src/layers/LottieLayer.tsx';
import { VECTOR_MAX_SIDE, vectorRasterScale } from '../src/layers/VectorLayer.tsx';

const S = FLICKS_PER_SECOND;
const lottie = { fps: 25, inFrame: 5, outFrame: 55, width: 100, height: 100 };
const media: MediaHandle = {
	url: '/lottie.json',
	proxyUrl: null,
	kind: 'animated-image',
	width: 100,
	height: 100,
	durationFlicks: 2 * S,
	hasAudio: false,
	rotation: 0,
	lottie,
};

function layer(
	contentTime: number,
	extra: Pick<RenderVisualClip, 'mediaTime' | 'loop'> = {},
): Parameters<typeof lottieFrameForLayer>[0] {
	return {
		clip: {
			clipId: 'lottie-clip',
			kind: 'animated-image',
			trackId: 'V1',
			name: 'Animation',
			start: 0,
			duration: 50,
			sourceIn: 0,
			speed: defaultSpeed(),
			source: { mediaId: 'animation' },
			transform: defaultTransform({ width: 100, height: 100 }, { width: 100, height: 100 }),
			opacity: constant(100),
			blendMode: 'normal',
			effects: [],
			intrinsicBox: { width: 100, height: 100 },
			engine: 'remotion',
			bounded: true,
			...extra,
		},
		contentTime,
		media,
	};
}

describe('Lottie layer frames', () => {
	it('samples the Lottie frame at the clip time', () => {
		expect(lottieFrameForLayer(layer(0))).toBe(5);
		expect(lottieFrameForLayer(layer(S))).toBe(30);
		expect(lottieFrameForLayer(layer(10 * S))).toBe(54);
		expect(lottieFrameForLayer({ ...layer(0), media: null })).toBeNull();
	});

	it('follows an assumed frame rate and a loop (Interpret Footage)', () => {
		// Assumed at twice the rate: one interpreted second shows two file seconds.
		expect(lottieFrameForLayer(layer(0.5 * S, { mediaTime: { scale: 2 } }))).toBe(30);
		// Loop twice: the second pass starts again at the first frame.
		expect(lottieFrameForLayer(layer(2 * S, { mediaTime: { scale: 1, period: 2 * S } }))).toBe(5);
		expect(lottieFrameForLayer(layer(2.04 * S, { mediaTime: { scale: 1, period: 2 * S } }))).toBe(6);
	});
});

describe('vector picture scale', () => {
	const anim = (value: number, keys: number[] = []): Animatable<number> => ({
		value,
		keyframes: keys.map((v, i) => ({
			id: `k${i}`,
			time: i,
			value: v,
			interpolation: 'linear',
			easeIn: EASE_PRESETS.linear,
			easeOut: EASE_PRESETS.linear,
		})),
	});
	const clip = (
		scale: Animatable<number>,
		uniform = true,
		width = anim(100),
	): Pick<RenderVisualClip, 'transform'> => ({
		transform: {
			...defaultTransform({ width: 100, height: 100 }, { width: 100, height: 100 }),
			scale,
			scaleWidth: width,
			uniformScale: uniform,
		},
	});

	it('is the largest Motion scale rounded up to a power of two', () => {
		expect(vectorRasterScale(clip(anim(100)), { width: 400, height: 300 })).toBe(1);
		expect(vectorRasterScale(clip(anim(50)), { width: 400, height: 300 })).toBe(1);
		expect(vectorRasterScale(clip(anim(100, [100, 300])), { width: 400, height: 300 })).toBe(4);
		expect(vectorRasterScale(clip(anim(100), false, anim(250)), { width: 400, height: 300 })).toBe(4);
	});

	it('never makes a picture larger than the cap', () => {
		const s = vectorRasterScale(clip(anim(10_000)), { width: 1000, height: 500 });
		expect(s * 1000).toBeLessThanOrEqual(VECTOR_MAX_SIDE);
		expect(vectorRasterScale(clip(anim(100)), { width: 20_000, height: 10 })).toBe(1);
	});
});
