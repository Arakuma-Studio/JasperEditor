// AGENTS §4: Advanced 3D's fixed limits are said, never silent. The renderer draws at most 32 lights and 48 shadow maps a
// frame and supersamples by what the GPU holds; `advanced3dLimitsOf` is what the preview's chip says and
// `advanced3dLimitWarnings` what the export plan says.
import { describe, expect, it } from 'vitest';
import {
	ADVANCED_MAX_LIGHTS,
	ADVANCED_MAX_SHADOW_TILES,
	advanced3dLimitsOf,
	advanced3dLimitWarnings,
	advancedSupersampling,
	buildRenderSnapshot,
	shadowTileCount,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const light = (clipId: string, type: string, castsShadows = true) =>
	({ clipId, type, castsShadows }) as Parameters<typeof advanced3dLimitsOf>[0][number];

describe('Advanced 3D limits of a frame', () => {
	it('names the lights past 32, in drawing order; environment lights do not count', () => {
		const lights = [
			light('env', 'environment'),
			...Array.from({ length: ADVANCED_MAX_LIGHTS + 2 }, (_, i) => light(`l${i}`, 'ambient', false)),
		];
		expect(advanced3dLimitsOf(lights).droppedLights).toEqual(['l32', 'l33']);
		expect(advanced3dLimitsOf(lights.slice(0, 33)).droppedLights).toEqual([]);
	});

	it('names the lights whose shadow maps do not fit, as the renderer skips them', () => {
		expect(shadowTileCount(light('p', 'point'))).toBe(6);
		expect(shadowTileCount(light('s', 'spot'))).toBe(1);
		expect(shadowTileCount(light('a', 'ambient'))).toBe(0);
		expect(shadowTileCount(light('n', 'spot', false))).toBe(0);
		// Eight point lights fill 48 maps; a ninth casts none, a spot after it still fits nowhere either.
		const points = Array.from({ length: 9 }, (_, i) => light(`p${i}`, 'point'));
		expect(advanced3dLimitsOf(points).shadowless).toEqual(['p8']);
		// A spot needs one map: 7 points (42) and 6 spots (48) fit, the 7th spot does not.
		const mixed = [...points.slice(0, 7), ...Array.from({ length: 7 }, (_, i) => light(`s${i}`, 'spot'))];
		expect(advanced3dLimitsOf(mixed).shadowless).toEqual(['s6']);
		expect(ADVANCED_MAX_SHADOW_TILES).toBe(48);
	});

	it('supersamples by what the render buffers hold, 1× to 4×', () => {
		expect(advancedSupersampling(4, 1920, 1080, 16384)).toBe(4);
		expect(advancedSupersampling(4, 1920, 1080, 4096)).toBe(2);
		expect(advancedSupersampling(4, 3840, 2160, 4096)).toBe(1);
		expect(advancedSupersampling(8, 640, 360, 16384)).toBe(4);
		expect(advancedSupersampling(Number.NaN, 640, 360, 16384)).toBe(1);
		expect(advancedSupersampling(2, 0, 0, Number.NaN)).toBe(2);
	});
});

describe('the export plan’s warnings', () => {
	function scene(lights: number) {
		const h = new Harness();
		const r = h.ok([{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1] }]);
		const solid = (r.results[0] as { clipId: string }).clipId;
		h.ok([
			{ type: 'clip.set3d', clipIds: [solid], enabled: true },
			{ type: 'sequence.set3dRenderer', renderer: 'advanced' },
		]);
		h.ok(
			Array.from({ length: lights }, () => ({
				type: 'clip.addLight',
				at: 0,
				lightType: 'point',
				castsShadows: true,
			})),
		);
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		return { snap, solid };
	}

	it('say which lights and shadows a frame leaves out', () => {
		const { snap } = scene(ADVANCED_MAX_LIGHTS + 1);
		const w = advanced3dLimitWarnings(snap, { start: 0, end: 60 });
		const codes = w.map((x) => x.code);
		expect(codes).toEqual(['THREE_D_LIGHTS_LIMIT', 'THREE_D_SHADOWS_LIMIT']);
		expect(w[0]!.itemIds).toHaveLength(1);
		// 32 point lights drawn, 8 with shadows: 24 cast none.
		expect(w[1]!.itemIds).toHaveLength(ADVANCED_MAX_LIGHTS - 8);
	});

	it('say nothing within the limits, outside the range, or for Classic 3D', () => {
		expect(advanced3dLimitWarnings(scene(8).snap, { start: 0, end: 60 })).toEqual([]);
		const { snap } = scene(ADVANCED_MAX_LIGHTS + 1);
		expect(advanced3dLimitWarnings(snap, { start: 60, end: 90 })).toEqual([]);
		const classic = { ...snap, scene3d: { ...snap.scene3d!, renderer: 'classic' as const } };
		expect(advanced3dLimitWarnings(classic, { start: 0, end: 60 })).toEqual([]);
	});
});
