import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	createMgRegistry,
	type MgTemplateDefinition,
	mgRegistry,
	templatePresetParams,
} from '../src/index.ts';

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
		expect(() => createMgRegistry([sample, sample])).toThrow();
		expect(() => createMgRegistry([{ ...sample, defaults: { title: '' } }])).toThrow();
	});
});

const variantParams = z.strictObject({
	variant: z.enum(['a', 'b', 'c']).default('a'),
	title: z.string().max(200).default('Hello'),
	views: z.number().int().min(0).default(0),
});
const withExtras: MgTemplateDefinition<z.infer<typeof variantParams>> = {
	...(sample as unknown as MgTemplateDefinition<z.infer<typeof variantParams>>),
	id: 'variant-card',
	paramsSchema: variantParams,
	defaults: variantParams.parse({}),
	presets: [
		{ id: 'a', name: 'Variant A', params: {} },
		{ id: 'b-dark', name: 'Variant B', description: 'The B look', params: { variant: 'b', views: 12 } },
	],
	ui: {
		groups: [
			{ id: 'look', label: 'Look', params: ['variant'] },
			{ id: 'text', label: 'Text', params: ['title', 'views'] },
		],
		params: {
			title: { label: 'Comment', description: 'The comment text', multiline: true, control: 'marks-text' },
			views: { visibleWhen: { param: 'variant', in: ['b'] } },
		},
	},
};

describe('presets and UI hints (C3)', () => {
	it('exposes presets and ui in the template info and the catalogue JSON', () => {
		const registry = createMgRegistry([withExtras]);
		expect(registry.get('variant-card', 1)?.presets?.map((p) => p.id)).toEqual(['a', 'b-dark']);
		expect(registry.get('variant-card', 1)?.ui?.groups?.[0]?.label).toBe('Look');
		const entry = registry.catalogJson()[0]!;
		expect(entry.presets).toEqual([
			{ id: 'a', name: 'Variant A', params: {} },
			{ id: 'b-dark', name: 'Variant B', description: 'The B look', params: { variant: 'b', views: 12 } },
		]);
		expect(entry.ui?.params?.views).toEqual({ visibleWhen: { param: 'variant', in: ['b'] } });
		// Templates without presets / hints keep their catalogue shape (schemas/catalog.json mirrors the Rust one).
		const plain = createMgRegistry([sample]).catalogJson()[0]!;
		expect('presets' in plain || 'ui' in plain).toBe(false);
	});

	it('applies a preset over the defaults', () => {
		expect(templatePresetParams(withExtras, 'b-dark')).toEqual({ variant: 'b', title: 'Hello', views: 12 });
		expect(templatePresetParams(withExtras, 'nope')).toBeUndefined();
	});

	it.each([
		[
			'an invalid preset value',
			{ presets: [{ id: 'x', name: 'X', params: { variant: 'z' } }] },
			/does not match/,
		],
		['an unknown preset param', { presets: [{ id: 'x', name: 'X', params: { nope: 1 } }] }, /unknown param/],
		[
			'a duplicate preset id',
			{
				presets: [
					{ id: 'x', name: 'X', params: {} },
					{ id: 'x', name: 'Y', params: {} },
				],
			},
			/Duplicate preset/,
		],
		['a malformed preset id', { presets: [{ id: 'X:1', name: 'X', params: {} }] }, /must match/],
		['a preset without a name', { presets: [{ id: 'x', name: ' ', params: {} }] }, /needs a name/],
		[
			'preset params that are no object',
			{ presets: [{ id: 'x', name: 'X', params: [] }] },
			/must be an object/,
		],
		[
			'a group naming an unknown param',
			{ ui: { groups: [{ id: 'g', label: 'G', params: ['nope'] }] } },
			/unknown param/,
		],
		[
			'a param in two groups',
			{
				ui: {
					groups: [
						{ id: 'g', label: 'G', params: ['title'] },
						{ id: 'h', label: 'H', params: ['title'] },
					],
				},
			},
			/more than one ui group/,
		],
		['a group without a label', { ui: { groups: [{ id: 'g', label: '', params: [] }] } }, /needs a label/],
		['hints of an unknown param', { ui: { params: { nope: { label: 'N' } } } }, /unknown param/],
		[
			'visibleWhen on an unknown param',
			{ ui: { params: { views: { visibleWhen: { param: 'nope', in: ['a'] } } } } },
			/another param/,
		],
		[
			'visibleWhen on itself',
			{ ui: { params: { views: { visibleWhen: { param: 'views', in: [1] } } } } },
			/another param/,
		],
		[
			'visibleWhen with an impossible value',
			{ ui: { params: { views: { visibleWhen: { param: 'variant', in: ['z'] } } } } },
			/not a valid value/,
		],
		[
			'visibleWhen without values',
			{ ui: { params: { views: { visibleWhen: { param: 'variant', in: [] } } } } },
			/must be \{param/,
		],
		['an empty control name', { ui: { params: { title: { control: '' } } } }, /non-empty string/],
	])('rejects %s', (_name, patch, message) => {
		const def = {
			...withExtras,
			presets: undefined,
			ui: undefined,
			...patch,
		} as unknown as MgTemplateDefinition;
		expect(() => createMgRegistry([def])).toThrow(message);
	});

	it('the shipped catalogue passes the preset and ui checks', () => {
		expect(() => createMgRegistry(mgRegistry.definitions())).not.toThrow();
	});
});
