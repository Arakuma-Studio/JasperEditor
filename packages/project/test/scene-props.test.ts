import { describe, expect, it } from 'vitest';
import {
	type Animatable,
	buildRenderSnapshot,
	EASE_PRESETS,
	resolveCachedLayerProps,
	resolveLayerProps,
	resolveSceneAt,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

function fixture() {
	const h = new Harness();
	h.ok([
		{ type: 'clip.addSolid', at: 0, duration: 300, track: 'V1', color: [0.2, 0.5, 1, 1], ref: '$clip' },
		{ type: 'effect.add', target: { clipId: '$clip' }, effectId: 'jasper.lumetri' },
	]);
	const snapshot = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
	return { snapshot, clip: snapshot.videoTracks[0]!.clips[0]! };
}

function animate<T>(property: Animatable<T>, end: T) {
	property.keyframes = [property.value, end].map((value, i) => ({
		id: `kf-${i}`,
		time: i * 100,
		value,
		interpolation: 'linear',
		easeIn: EASE_PRESETS.linear,
		easeOut: EASE_PRESETS.linear,
	}));
}

describe('immutable render clip prop cache', () => {
	it('shares static props with scene resolution and invalidates on replacement clips', () => {
		const { snapshot, clip } = fixture();
		const props = resolveCachedLayerProps(clip, 0);
		expect(resolveCachedLayerProps(clip, 100)).toBe(props);
		expect(resolveSceneAt(snapshot, 40)[0]!.props).toBe(props);
		const changed = { ...clip, opacity: { value: 25, keyframes: [] } };
		expect(resolveCachedLayerProps(changed, 100)).toEqual(resolveLayerProps(changed, 100));
		expect(resolveCachedLayerProps(changed, 100)).not.toBe(props);
		expect(resolveCachedLayerProps(changed, 100).opacity).toBe(25);
		expect(resolveCachedLayerProps(clip, 100)).toBe(props);
	});

	it.each(['opacity', 'position', 'anchor', 'scale', 'scaleWidth', 'rotation', 'effect'] as const)(
		'preserves animated %s across forward and backward seeks',
		(channel) => {
			const clip = structuredClone(fixture().clip);
			if (channel === 'opacity') animate(clip.opacity, 0);
			else if (channel === 'effect') animate(clip.effects[0]!.params.exposure!, 2);
			else if (channel === 'position' || channel === 'anchor') animate(clip.transform![channel], [10, 20]);
			else animate(clip.transform![channel], 50);
			const first = resolveCachedLayerProps(clip, 0);
			for (const time of [0, 75, 100, 30, 0]) {
				const actual = resolveCachedLayerProps(clip, time);
				expect(actual).toEqual(resolveLayerProps(clip, time));
				expect(actual).not.toBe(first);
			}
			expect(resolveCachedLayerProps(clip, 100)).not.toEqual(first);
		},
	);
});
