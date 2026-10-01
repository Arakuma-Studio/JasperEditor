import {
	applyTransaction,
	createEmptyProject,
	createSeededIdSource,
	defaultRegistries,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMgRegistry, MG_CATALOG, type MgTemplateDefinition, mgRegistry } from '../src/index.ts';

const params = z.object({ title: z.string().min(1), accent: z.array(z.number()).length(4) });
const sample: MgTemplateDefinition<z.infer<typeof params>> = {
	id: 'test-card',
	version: 1,
	name: 'Test card',
	category: 'Titles',
	paramsSchema: params,
	defaults: { title: 'Hello', accent: [1, 0, 0, 1] },
	introFrames: 10,
	outroFrames: 10,
	defaultDurationSeconds: 3,
	canvases: [{ width: 1920, height: 1080 }],
	renderSvg: () => '',
};

describe('@jasper/mg-templates', () => {
	it('ships lower-third@1 and title-card@1', () => {
		expect(MG_CATALOG.map((d) => `${d.id}@${d.version}`)).toEqual(['lower-third@1', 'title-card@1']);
		expect(mgRegistry.list().map((t) => t.name)).toEqual(['Lower Third', 'Title Card']);
		expect(mgRegistry.get('lower-third', 1)?.introFrames).toBe(30);
	});
	it('implements the project MgTemplateRegistry and validates params through it', () => {
		const reg = createMgRegistry([sample]);
		expect(reg.get('test-card', 1)?.name).toBe('Test card');
		expect(reg.get('test-card', 2)).toBeUndefined();
		expect(reg.catalogJson()[0]!.paramsSchema.type).toBe('object');
		expect(reg.catalogJson()[0]!.canvases).toEqual(['1920x1080']);
		const ids = createSeededIdSource(4);
		const doc = createEmptyProject({ ids, name: 'mg' });
		const ctx = { ids, now: () => 't', revision: 0, registries: defaultRegistries(reg) };
		const ok = applyTransaction(
			doc,
			{
				label: 'MG',
				origin: 'user',
				commands: [
					{
						type: 'clip.addMotionGraphic',
						at: 0,
						duration: 90,
						track: 'V2',
						template: { id: 'test-card', version: 1 },
						params: { title: 'Ana' },
					},
				],
			},
			ctx,
		);
		expect(ok.result.ok).toBe(true);
		const bad = applyTransaction(
			doc,
			{
				label: 'MG',
				origin: 'user',
				commands: [
					{
						type: 'clip.addMotionGraphic',
						at: 0,
						duration: 90,
						track: 'V2',
						template: { id: 'test-card', version: 1 },
						params: { title: '' },
					},
				],
			},
			ctx,
		);
		expect(bad.result.ok).toBe(false);
	});
	it('rejects duplicate ids and defaults that fail the schema', () => {
		expect(() => createMgRegistry([sample, sample])).toThrow();
		expect(() => createMgRegistry([{ ...sample, defaults: { title: '', accent: [] } }])).toThrow();
	});
});
