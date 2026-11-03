// AGENTS §4: the preview's chip says what Advanced 3D's fixed limits leave out at a frame (the export plan warns the same:
// apps/engine/test/three-d-hdr.test.ts). No GPU here: the supersampling part needs one and is covered by the plan's test.
import type { Command } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { advancedLimitChip } from '../src/three-d/scope.tsx';
import { fxSnapshot } from './fx-media.ts';

function scene(lights: number, renderer: 'advanced' | 'classic' = 'advanced') {
	return fxSnapshot([
		{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1], ref: '$s' },
		{ type: 'clip.set3d', clipIds: ['$s'], enabled: true },
		{ type: 'sequence.set3dRenderer', renderer },
		...Array.from({ length: lights }, () => ({
			type: 'clip.addLight',
			at: 0,
			duration: 30,
			lightType: 'point',
			castsShadows: true,
		})),
	] as Command[]);
}

const comp = { width: 1280, height: 720 };

describe('the 3D limits chip', () => {
	it('names lights past 32, then shadow maps past 48', () => {
		expect(advancedLimitChip(scene(33), 0, comp)).toBe('Only 32 lights are drawn: 1 left out');
		expect(advancedLimitChip(scene(9), 0, comp)).toBe(
			'Only 48 shadow maps are drawn: 1 light(s) cast no shadow',
		);
	});

	it('is absent within the limits, where the lights are off, and for Classic 3D', () => {
		expect(advancedLimitChip(scene(8), 0, comp)).toBeNull();
		expect(advancedLimitChip(scene(33), 40, comp)).toBeNull();
		expect(advancedLimitChip(scene(33, 'classic'), 0, comp)).toBeNull();
	});
});
