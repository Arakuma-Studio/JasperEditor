// A native effect mapping alone does not prove rendering: GPU shaders require a composition stage.
// Time-dependent shaders cannot use still bakes; seeded shaders require the clip id in the bake key.
import {
	createEffectRegistry,
	defaultEffectRegistry,
	defineShaderEffect,
	type RenderVisualClip,
	TITLE_LOOK_EFFECT_ID,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { nativeBlockers } from '../src/export/planner.ts';
import { contentBleed, isStaticLayer } from '../src/layer-bake/layer.ts';

const frag = 'void main() { fragColor = texture(u_source, v_uv); }';
const noise = defineShaderEffect({
	id: 'test.noise',
	label: 'Noise',
	category: 'Stylize',
	params: [],
	gpu: { passes: [{ frag }] },
});
const still = defineShaderEffect({
	id: 'test.still',
	label: 'Still',
	category: 'Stylize',
	params: [],
	gpu: { passes: [{ frag }], timeInvariant: true },
});
const registry = createEffectRegistry([...defaultEffectRegistry.list(), noise, still]);
const caps = { native: true, remotionLocal: 'ready' as const, fframes: 'ready' as const, mgMasters: true };
const fx = (effectId: string) => ({
	id: `fx_${effectId}`,
	effectId,
	effectVersion: 1,
	enabled: true,
	params: {},
});

function clip(kind: string, effectIds: string[]): RenderVisualClip {
	const z = { value: 0, keyframes: [] };
	return {
		clipId: 'clp_X',
		kind,
		trackId: 'trk',
		name: 'X',
		start: 0,
		duration: 30,
		sourceIn: 0,
		speed: { rate: 1, reverse: false },
		source: kind === 'shape' ? { shape: {} } : { mediaId: 'm' },
		transform: {
			position: { value: [0, 0], keyframes: [] },
			anchor: { value: [0, 0], keyframes: [] },
			scale: { value: 100, keyframes: [] },
			scaleWidth: z,
			rotation: z,
			uniformScale: true,
		},
		opacity: { value: 100, keyframes: [] },
		blendMode: 'normal',
		effects: effectIds.map(fx),
		intrinsicBox: { width: 100, height: 100 },
		engine: 'native',
		bounded: true,
	} as unknown as RenderVisualClip;
}

describe('GPU shader effects in the export planner and layer bakes', () => {
	it('a shader effect blocks the native path (the clip renders through Remotion)', () => {
		expect(nativeBlockers(clip('video', ['test.noise']), caps, [], registry).join()).toContain('test.noise');
		expect(nativeBlockers(clip('video', []), caps, [], registry)).toEqual([]);
	});

	it('a Track Matte Key reading tracks goes to the Remotion path, not a layer bake that draws the clip alone', () => {
		const bake = { id: 'layer-bake', claimsLayer: () => true, bakes: () => 'remotion' as const };
		const keyed = (params: Record<string, unknown>): RenderVisualClip => ({
			...clip('video', []),
			effects: [
				{
					...fx('jasper.track-matte-key'),
					params: Object.fromEntries(
						Object.entries(params).map(([k, v]) => [k, { value: v, keyframes: [] }]),
					),
				},
			] as never,
		});
		expect(nativeBlockers(keyed({ matteTrack: 'trk_M' }), caps, [bake], registry).join()).toMatch(
			/Track Matte Key reading track trk_M/,
		);
		const plate = keyed({ matteTrack: 'trk_M', decontaminate: 'cleanPlate', cleanPlateTrack: 'trk_P' });
		expect(nativeBlockers(plate, caps, [bake], registry).join()).toContain('trk_M, trk_P');
		// Matte = None: nothing to read, the bake draws the key (a pass-through).
		expect(nativeBlockers(keyed({ matteTrack: '' }), caps, [bake], registry)).toEqual([]);
	});

	it('a look routes like any GPU effect: not native, a still bake unless something in it moves (spec 19)', () => {
		const look = (appearance: unknown, kind = 'shape'): RenderVisualClip => {
			const c = clip(kind, []);
			return { ...c, effects: [{ ...fx(TITLE_LOOK_EFFECT_ID), appearance }] as never };
		};
		const rim = (keyframes: unknown[]) => ({
			v: 1,
			palette: {},
			light: { source: 'look', angle: { value: 0, keyframes: [] }, altitude: { value: 0, keyframes: [] } },
			seed: 1,
			layers: [
				{
					id: 'apl_0000000000000001',
					type: 'rim',
					enabled: true,
					params: { width: { value: 5, keyframes } },
				},
			],
		});
		expect(nativeBlockers(look(rim([]), 'video'), caps, [], registry).join()).toContain(TITLE_LOOK_EFFECT_ID);
		expect(isStaticLayer(look(rim([])), registry)).toBe(true);
		const key = { id: 'kf_1', time: 0, value: 1, interpolation: 'linear' };
		expect(isStaticLayer(look(rim([key])), registry)).toBe(false);
		// A keyed global light moves a look that follows it.
		const lit = { ...look(rim([])), sequenceLight: { angle: { value: 0, keyframes: [key] } } };
		expect(isStaticLayer(lit as never, registry)).toBe(false);
	});

	it('the bake crop grows by a look reach instead of baking the full frame or clipping its glow (TL-033)', () => {
		const c = clip('shape', []);
		const appearance = {
			v: 1,
			palette: {},
			light: { source: 'look', angle: { value: 0, keyframes: [] }, altitude: { value: 0, keyframes: [] } },
			seed: 1,
			layers: [
				{
					id: 'apl_0000000000000001',
					type: 'glow',
					enabled: true,
					params: { radius: { value: 30, keyframes: [] } },
				},
			],
		};
		const withLook = {
			...c,
			effects: [{ ...fx(TITLE_LOOK_EFFECT_ID), appearance }],
			intrinsicBox: { width: 400, height: 200 },
		};
		const bleed = contentBleed(withLook as never, registry);
		// 30 % of the shorter side of the box, 60 px, and the guard.
		expect(bleed).toBeGreaterThanOrEqual(60);
		expect(bleed).toBeLessThan(80);
	});

	it('time-dependent shader effects make a DOM layer non-static (rendered per frame, not a still)', () => {
		expect(isStaticLayer(clip('shape', ['test.still']), registry)).toBe(true);
		expect(isStaticLayer(clip('shape', ['test.noise']), registry)).toBe(false);
	});
});
