// A native effect mapping alone does not prove rendering: GPU shaders require a composition stage.
// Time-dependent shaders cannot use still bakes; seeded shaders require the clip id in the bake key.
import {
	createEffectRegistry,
	defaultEffectRegistry,
	defineShaderEffect,
	type RenderVisualClip,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { nativeBlockers } from '../src/export/planner.ts';
import { normalisedClip } from '../src/layer-bake/key.ts';
import { isStaticLayer } from '../src/layer-bake/layer.ts';

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
		expect(nativeBlockers(clip('video', ['test.noise']), caps, [], registry).join()).toMatch(
			/uses effect test\.noise, which the native path cannot render/,
		);
		expect(nativeBlockers(clip('video', []), caps, [], registry)).toEqual([]);
	});

	it('time-dependent shader effects make a DOM layer non-static (rendered per frame, not a still)', () => {
		expect(isStaticLayer(clip('shape', ['test.still']), registry)).toBe(true);
		expect(isStaticLayer(clip('shape', ['test.noise']), registry)).toBe(false);
	});

	it('bake keys keep the clip id of layers with shader effects (u_seed hashes it)', () => {
		expect(normalisedClip(clip('shape', []), registry).clipId).toBe('clip');
		expect(normalisedClip(clip('shape', ['test.still']), registry).clipId).toBe('clp_X');
	});
});
