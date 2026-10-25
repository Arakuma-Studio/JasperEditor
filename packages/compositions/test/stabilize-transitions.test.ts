// Regression: structural sharing must not keep a track's previous transitions when only a transition changed
// (an Effect Controls edit of a transition param left the Program monitor drawing the old values).
import type { Command } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { stabilizeRenderDoc } from '../src/stabilize.ts';
import { fxSnapshot } from './fx-media.ts';

const doc = (params: Record<string, unknown>) =>
	fxSnapshot([
		{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1] } as Command,
		{ type: 'clip.addSolid', at: 30, duration: 30, track: 'V1', color: [0, 0, 1, 1] } as Command,
		{
			type: 'transition.add',
			trackId: 'V1',
			at: 30,
			effectId: 'jasper.smooth-slide',
			duration: 12,
			params,
		} as Command,
	]);

describe('stabilizeRenderDoc and transitions', () => {
	it('takes the new transitions of a track whose clips did not change', () => {
		const a = doc({ direction: 'left' });
		const b = doc({ direction: 'up' });
		const out = stabilizeRenderDoc(a, b);
		expect(out.videoTracks[0]!.transitions![0]!.params.direction!.value).toBe('up');
	});
});
