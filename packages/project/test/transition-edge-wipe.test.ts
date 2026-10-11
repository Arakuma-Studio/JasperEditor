import { describe, expect, it } from 'vitest';
import { defineEdgeWipe } from '../src/registry/transitions/premiere/common.ts';
import { planGpuTransition } from '../src/registry/transitions/shader.ts';
import type { ParamValue } from '../src/schema/common.ts';

const body = 'd = px.x - p * u_compSize.x;';

describe('edge wipe shader generation', () => {
	it.each([true, false])('emits the distance body and border expression with border=%s', (border) => {
		const spec = defineEdgeWipe({
			id: 'jasper.test-edge-wipe',
			label: 'Test Edge Wipe',
			bin: 'Wipe',
			description: 'A horizontal wipe used to verify shader generation.',
			border,
			body,
		});
		const params = Object.fromEntries(spec.params.map<[string, ParamValue]>((p) => [p.name, p.default]));
		const side = { width: 64, height: 36, compToCanvas: [1, 0, 0, 0, 1, 0, 0, 0, 1], opacity: 1 };
		const staged = planGpuTransition(
			spec,
			{ id: 'trn', params, frame: 5, duration: 10, sides: 'both' },
			{ width: 64, height: 36, fps: 30 },
			{ out: side, in: side },
		);
		const source = staged.plan.passes.at(-1)!.source;
		expect(source).toContain(body);
		expect(source).toContain(`float bw = ${border ? 'max(u_borderWidth, 0.0)' : '0.0'};`);
		expect(source).not.toContain('$');
		if (border) expect(source).toContain('uniform float u_borderWidth;');
		else expect(source).not.toContain('u_borderWidth');
	});
});
