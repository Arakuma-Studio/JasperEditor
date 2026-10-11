import { describe, expect, it } from 'vitest';
import { defineShaderEffect } from '../src/registry/fx/define.ts';
import { validateGpuEffect } from '../src/registry/fx/shader.ts';
import { defineShaderTransition } from '../src/registry/transitions/define.ts';
import { validateGpuTransition } from '../src/registry/transitions/shader.ts';

const passes = [{ frag: 'void main() { fragColor = vec4(0.0); }' }];

describe.each(['passes', 'uniforms'] as const)('registry %s hook errors', (hook) => {
	it.each([null, undefined, 'invalid hook', 42, new Error('invalid hook')])(
		'reports a thrown %s without throwing from the validator',
		(error) => {
			const gpu = {
				passes,
				[hook]: () => {
					throw error;
				},
			};
			const effect = defineShaderEffect({
				id: 'test.invalid-effect',
				label: 'Invalid effect',
				category: 'Stylize',
				params: [],
				gpu,
			});
			const transition = defineShaderTransition({
				id: 'test.invalid-transition',
				label: 'Invalid transition',
				bin: 'Dissolve',
				description: 'Invalid transition',
				params: [],
				gpu,
			});
			const message = error instanceof Error ? error.message : String(error);
			expect(
				validateGpuEffect(effect).some((problem) =>
					problem.endsWith(`threw${hook === 'passes' ? '' : ' with default params'}: ${message}`),
				),
			).toBe(true);
			expect(
				validateGpuTransition(transition).some((problem) =>
					problem.endsWith(`threw${hook === 'passes' ? '' : ' with default params'}: ${message}`),
				),
			).toBe(true);
		},
	);
});
