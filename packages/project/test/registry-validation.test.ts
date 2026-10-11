import { describe, expect, it } from 'vitest';
import { defineShaderEffect } from '../src/registry/fx/define.ts';
import { validateGpuEffect } from '../src/registry/fx/shader.ts';
import { defineShaderTransition } from '../src/registry/transitions/define.ts';
import { validateGpuTransition } from '../src/registry/transitions/shader.ts';

const passes = [{ frag: 'void main() { fragColor = vec4(0.0); }' }];

describe.each(['effect', 'transition'] as const)('%s registry', (kind) => {
	describe.each(['passes', 'uniforms'] as const)('%s hook errors', (hook) => {
		it.each([
			['null', null, 'null'],
			['undefined', undefined, 'undefined'],
			['string', 'invalid hook', 'invalid hook'],
			['number', 42, '42'],
			['Error', new Error('invalid hook'), 'invalid hook'],
			['null-prototype object', Object.create(null), 'Unknown shader hook error'],
			[
				'object with throwing coercion',
				{
					toString() {
						throw new Error('cannot stringify');
					},
				},
				'Unknown shader hook error',
			],
		])('reports a thrown %s without throwing from the validator', (_label, error, message) => {
			const init = {
				id: 'test.invalid',
				label: 'Invalid',
				description: 'Invalid shader',
				params: [],
				gpu: {
					passes,
					[hook]: () => {
						throw error;
					},
				},
			};
			const problems =
				kind === 'effect'
					? validateGpuEffect(defineShaderEffect({ ...init, category: 'Stylize' }))
					: validateGpuTransition(defineShaderTransition({ ...init, bin: 'Dissolve' }));
			expect(
				problems.some((problem) =>
					problem.endsWith(`threw${hook === 'passes' ? '' : ' with default params'}: ${message}`),
				),
			).toBe(true);
		});
	});
});
