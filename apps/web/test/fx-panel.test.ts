import {
	createEffectRegistry,
	defaultEffectRegistry,
	defineShaderEffect,
	fxParam,
	type ResolvedLayer,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { pointParams, pointToSequence, sequenceToPoint } from '../src/fx/PointOverlay.tsx';
import { effectTree } from '../src/panels/effects/drag.ts';

const glow = defineShaderEffect({
	id: 'jasper.s.glow-test',
	label: 'S_Glow',
	category: 'Stylize',
	bin: 'Sapphire Glows',
	description: 'test',
	params: [fxParam.point('center', 'Center'), fxParam.percent('amount', 'Amount', 50)],
	gpu: { passes: [{ frag: 'void main() { fragColor = texture(u_source, v_uv); }' }] },
});
// The built-in non-GPU effects plus one test shader effect, independent of the fx catalogue's growing families.
const registry = createEffectRegistry([...defaultEffectRegistry.list().filter((s) => !s.gpu), glow]);

describe('Effects panel tree', () => {
	it('shows an effect with a bin under Video Effects ▸ <bin>, categories otherwise', () => {
		const video = effectTree(registry, { query: '', realtime: false, native: false }).find(
			(m) => m.medium === 'Video Effects',
		)!;
		const bin = video.categories.find((c) => c.category === 'Sapphire Glows');
		expect(bin?.effects.map((e) => e.id)).toEqual(['jasper.s.glow-test']);
		expect(
			video.categories.find((c) => c.category === 'Stylize')?.effects.some((e) => e.id === glow.id) ?? false,
		).toBe(false);
		expect(video.categories.some((c) => c.category === 'Transform')).toBe(true);
	});

	it('the GPU filter keeps only shader effects; search matches the bin name', () => {
		const gpuOnly = effectTree(registry, { query: '', realtime: false, native: false, gpu: true });
		expect(gpuOnly.flatMap((m) => m.categories.flatMap((c) => c.effects.map((e) => e.id)))).toEqual([
			glow.id,
		]);
		const found = effectTree(registry, { query: 'sapphire glows', realtime: false, native: false });
		expect(found.flatMap((m) => m.categories.flatMap((c) => c.effects.map((e) => e.id)))).toEqual([glow.id]);
	});
});

describe('point handles', () => {
	it('finds point params and maps them through the layer map and back', () => {
		expect(pointParams(glow.params).map((p) => p.name)).toEqual(['center']);
		const layer = {
			props: {
				box: { width: 200, height: 100 },
				matrix: { a: 2, b: 0, c: 0, d: 2, e: 50, f: 10 },
				projective: null,
			},
		} as unknown as Pick<ResolvedLayer, 'props'>;
		expect(pointToSequence(layer, [0.5, 0.5])).toEqual([250, 110]);
		expect(sequenceToPoint(layer, [450, 210])).toEqual([1, 1]);
	});
});
