import { createEffectRegistry, defaultEffectRegistry, defineShaderEffect, fxParam } from '@jasper/project';
import { describe, expect, it } from 'vitest';
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
	it('the GPU filter keeps only shader effects; search matches the bin name', () => {
		const gpuOnly = effectTree(registry, { query: '', realtime: false, native: false, gpu: true });
		expect(gpuOnly.flatMap((m) => m.categories.flatMap((c) => c.effects.map((e) => e.id)))).toEqual([
			glow.id,
		]);
		const found = effectTree(registry, { query: 'sapphire glows', realtime: false, native: false });
		expect(found.flatMap((m) => m.categories.flatMap((c) => c.effects.map((e) => e.id)))).toEqual([glow.id]);
	});
});
