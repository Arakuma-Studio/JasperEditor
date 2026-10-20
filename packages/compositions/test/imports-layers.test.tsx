// Lottie frames follow interpreted time → file time → frame sampling.
import {
	anim as constant,
	defaultSpeed,
	defaultTransform,
	type MediaHandle,
	type RenderVisualClip,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { lottieFrameForLayer } from '../src/layers/LottieLayer.tsx';

// Serialized time unit specified by docs/ARCHITECTURE.md, independent of the conversion under test.
const S = 705_600_000;
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
