import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMgRegistry, type MgTemplateDefinition, mgRegistry } from '../src/index.ts';

const params = z.strictObject({ title: z.string().min(1).default('Hello') });
const sample: MgTemplateDefinition<z.infer<typeof params>> = {
	id: 'test-card',
	version: 1,
	name: 'Test card',
	category: 'Titles',
	paramsSchema: params,
	defaults: { title: 'Hello' },
	introFrames: 10,
	outroFrames: 10,
	defaultDurationSeconds: 3,
	canvases: [{ width: 1920, height: 1080 }],
	renderSvg: () => '',
};

describe('@jasper/mg-templates registry', () => {
	it('ships the required fframes and anime template versions', () => {
		expect(mgRegistry.list().map(({ id, version }) => `${id}@${version}`)).toEqual(
			expect.arrayContaining([
				'callout@1',
				'counter@1',
				'lower-third-anim@1',
				'lower-third@1',
				'title-card@1',
				'title-reveal@1',
			]),
		);
	});

	it('exposes template lookup and a JSON schema for API clients', () => {
		const registry = createMgRegistry([sample]);
		expect(registry.get('test-card', 1)?.name).toBe('Test card');
		expect(registry.get('test-card', 2)).toBeUndefined();
		const entry = registry.catalogJson()[0]!;
		expect(entry.canvases).toEqual(['1920x1080']);
		expect(entry.paramsSchema).toMatchObject({
			type: 'object',
			additionalProperties: false,
			properties: { title: { type: 'string', minLength: 1 } },
		});
	});

	it('rejects duplicate template versions and invalid defaults', () => {
		expect(() => createMgRegistry([sample, sample])).toThrow(/Duplicate/);
		expect(() => createMgRegistry([{ ...sample, defaults: { title: '' } }])).toThrow(/Defaults/);
	});
});
