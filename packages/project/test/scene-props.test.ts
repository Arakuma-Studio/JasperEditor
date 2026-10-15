import { describe, expect, it } from 'vitest';
import {
	type Animatable,
	buildRenderSnapshot,
	EASE_PRESETS,
	flicksPerFrame,
	resolveSceneAt,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

function fixture() {
	const h = new Harness();
	h.ok([
		{ type: 'clip.addSolid', at: 0, duration: 300, track: 'V1', color: [0.2, 0.5, 1, 1], ref: '$clip' },
		{ type: 'effect.add', target: { clipId: '$clip' }, effectId: 'jasper.lumetri' },
	]);
	const snapshot = structuredClone(
		buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null }),
	);
	return { snapshot, clip: snapshot.videoTracks[0]!.clips[0]! };
}

function animate<T>(property: Animatable<T>, start: T, end: T, frameFlicks: number) {
	property.value = start;
	property.keyframes = [start, end].map((value, i) => ({
		id: `kf-${i}`,
		time: i * 100 * frameFlicks,
		value,
		interpolation: 'linear',
		easeIn: EASE_PRESETS.linear,
		easeOut: EASE_PRESETS.linear,
	}));
}

describe('scene animation across seeks', () => {
	it.each(['opacity', 'position', 'anchor', 'scale', 'scaleWidth', 'rotation', 'effect'] as const)(
		'preserves animated %s across forward and backward seeks',
		(channel) => {
			const { snapshot, clip } = fixture();
			const F = flicksPerFrame(snapshot.settings.fps);
			if (channel === 'opacity') animate(clip.opacity, 0, 100, F);
			else if (channel === 'effect') animate(clip.effects[0]!.params.exposure!, 0, 2, F);
			else if (channel === 'position' || channel === 'anchor')
				animate(clip.transform![channel], [0, 0], [100, 200], F);
			else animate(clip.transform![channel], 0, 100, F);
			for (const frame of [0, 75, 100, 30, 0]) {
				const props = resolveSceneAt(snapshot, frame)[0]!.props;
				if (channel === 'opacity') expect(props.opacity).toBeCloseTo(frame, 9);
				else if (channel === 'effect') expect(props.effects[0]!.params.exposure).toBeCloseTo(frame / 50, 9);
				else if (channel === 'position' || channel === 'anchor') {
					expect(props.transform![channel][0]).toBeCloseTo(frame, 9);
					expect(props.transform![channel][1]).toBeCloseTo(frame * 2, 9);
				} else expect(props.transform![channel]).toBeCloseTo(frame, 9);
			}
		},
	);
});
