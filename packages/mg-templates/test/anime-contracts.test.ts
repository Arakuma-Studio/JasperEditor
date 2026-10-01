import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMgRegistry, lowerThird, type MgAnimeTemplateDefinition } from '../src/index.ts';

const params = z.strictObject({ title: z.string().default('Hello') });
const reveal: MgAnimeTemplateDefinition<z.infer<typeof params>> = {
	id: 'test-reveal',
	version: 2,
	name: 'Test Reveal',
	category: 'Titles',
	description: 'An animated title',
	renderer: 'anime',
	renderVersion: 1,
	paramsSchema: params,
	defaults: { title: 'Hello' },
	introFrames: 20,
	outroFrames: 15,
	defaultDurationSeconds: 4,
	canvases: [{ width: 1920, height: 1080 }],
};

describe('template registry metadata', () => {
	it('exposes anime routing and gallery metadata without marking fframes entries', () => {
		const registry = createMgRegistry([lowerThird, reveal]);
		expect(registry.get('test-reveal', 2)).toMatchObject({
			renderer: 'anime',
			description: 'An animated title',
			defaultDurationSeconds: 4,
		});
		expect(registry.get('lower-third', 1)).not.toHaveProperty('renderer');
		expect(registry.catalogJson().find((entry) => entry.id === 'test-reveal')).toMatchObject({
			renderer: 'anime',
			description: 'An animated title',
			defaultDurationSeconds: 4,
		});
		expect(registry.catalogJson().find((entry) => entry.id === 'lower-third')).not.toHaveProperty('renderer');
	});
});
