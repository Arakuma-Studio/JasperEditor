// C3 (social comments): template UI hints in the param property specs, visibility, sections and template refs.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	type MgTemplateInfo,
	paramsPropertySpecs,
	parseMgTemplateRef,
	resolvePropertySpec,
	templateParamSections,
	templateParamVisible,
} from '../src/index.ts';

const schema = z.strictObject({
	variant: z.enum(['tiktok', 'x']).default('tiktok'),
	text: z.string().max(2000).describe('The comment').default('Hi'),
	views: z.number().int().min(0).default(0),
	size: z.number().min(1).max(100).default(10),
	free: z.string().max(20).default(''),
});

const tpl = (ui?: MgTemplateInfo['ui']): MgTemplateInfo => ({
	id: 'card',
	version: 1,
	name: 'Card',
	category: 'Social',
	paramsSchema: schema,
	defaults: schema.parse({}),
	introFrames: 0,
	outroFrames: 0,
	canvasDefault: 'sequence',
	renderer: 'anime',
	...(ui ? { ui } : {}),
});

const UI: NonNullable<MgTemplateInfo['ui']> = {
	groups: [
		{ id: 'look', label: 'Look', params: ['variant', 'size'] },
		{ id: 'text', label: 'Text', params: ['text', 'views'] },
	],
	params: {
		text: { label: 'Comment', description: 'What the viewer wrote', multiline: true, control: 'marks-text' },
		views: { label: 'Views', visibleWhen: { param: 'variant', in: ['x'] } },
		free: { multiline: true },
	},
};

describe('paramsPropertySpecs with ui hints', () => {
	it('labels enum options from ui.params.<name>.options (values keep their ids; unlabelled values show the id)', () => {
		const specs = paramsPropertySpecs(
			tpl({ params: { variant: { options: { tiktok: 'TikTok · Comment' } } } }),
		);
		expect(specs.find((s) => s.key === 'params.variant')).toMatchObject({
			kind: 'enum',
			options: ['tiktok', 'x'],
			optionLabels: ['TikTok · Comment', 'x'],
		});
		expect(paramsPropertySpecs(tpl()).find((s) => s.key === 'params.variant')!.optionLabels).toBeUndefined();
	});

	it('keeps the schema order and labels without hints', () => {
		const specs = paramsPropertySpecs(tpl());
		expect(specs.map((s) => s.key)).toEqual([
			'params.variant',
			'params.text',
			'params.views',
			'params.size',
			'params.free',
		]);
		expect(specs.find((s) => s.key === 'params.text')).toMatchObject({
			label: 'Text',
			description: 'The comment',
		});
		expect(specs.every((s) => s.section === undefined && s.visibleWhen === undefined)).toBe(true);
	});

	it('applies labels, descriptions, multi-line, custom controls, visibility and the group order', () => {
		const specs = paramsPropertySpecs(tpl(UI));
		// ungrouped params first (schema order), then each group in order
		expect(specs.map((s) => s.key)).toEqual([
			'params.free',
			'params.variant',
			'params.size',
			'params.text',
			'params.views',
		]);
		const text = specs.find((s) => s.key === 'params.text')!;
		expect(text).toMatchObject({
			label: 'Comment',
			description: 'What the viewer wrote',
			section: { id: 'text', label: 'Text' },
			ui: { control: 'text', multiline: true, customControl: 'marks-text' },
		});
		expect(specs.find((s) => s.key === 'params.free')).toMatchObject({ ui: { multiline: true } });
		expect(specs.find((s) => s.key === 'params.free')!.section).toBeUndefined();
		// keyframable params stay keyframable inside a group
		expect(specs.find((s) => s.key === 'params.size')).toMatchObject({
			animatable: 'continuous',
			section: { id: 'look' },
		});
		// resolvePropertySpec (History labels, writes) sees the same hints
		expect(resolvePropertySpec('params.text', tpl(UI))?.label).toBe('Comment');
	});

	it('splits the specs into sections in order', () => {
		const sections = templateParamSections(paramsPropertySpecs(tpl(UI)));
		expect(sections.map((s) => [s.section?.label ?? null, s.specs.map((x) => x.key)])).toEqual([
			[null, ['params.free']],
			['Look', ['params.variant', 'params.size']],
			['Text', ['params.text', 'params.views']],
		]);
		expect(templateParamSections(paramsPropertySpecs(tpl()))).toHaveLength(1);
		expect(templateParamSections([])).toEqual([]);
	});

	it('hides rows whose visibleWhen does not hold for the params', () => {
		const views = paramsPropertySpecs(tpl(UI)).find((s) => s.key === 'params.views')!;
		expect(templateParamVisible(views, { variant: 'x' })).toBe(true);
		expect(templateParamVisible(views, { variant: 'tiktok' })).toBe(false);
		expect(templateParamVisible(views, {})).toBe(false);
		expect(templateParamVisible(views, undefined)).toBe(false);
		expect(templateParamVisible({}, { variant: 'tiktok' })).toBe(true);
		// structured values compare by value
		expect(
			templateParamVisible({ visibleWhen: { param: 'c', in: [[1, 0, 0, 1]] } }, { c: [1, 0, 0, 1] }),
		).toBe(true);
	});
});

describe('parseMgTemplateRef', () => {
	it('parses ids, versions and presets', () => {
		expect(parseMgTemplateRef('social-comment')).toEqual({ id: 'social-comment' });
		expect(parseMgTemplateRef('social-comment@2')).toEqual({ id: 'social-comment', version: 2 });
		expect(parseMgTemplateRef('social-comment:x-post')).toEqual({ id: 'social-comment', preset: 'x-post' });
		expect(parseMgTemplateRef('social-comment@1:x-post')).toEqual({
			id: 'social-comment',
			version: 1,
			preset: 'x-post',
		});
		for (const bad of ['', '@1', ':x', 'a@0', 'a@-1', 'a@1.5', 'a:', 'a:X', 'a@1:b:c', 'a b', 'a@1@2'])
			expect(parseMgTemplateRef(bad), bad).toBeNull();
		expect(parseMgTemplateRef('x'.repeat(300))).toBeNull();
	});

	it('round-trips every well-formed ref and never throws on arbitrary input', () => {
		const id = fc.stringMatching(/^[a-z][a-z0-9.-]{0,20}$/);
		const preset = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/);
		fc.assert(
			fc.property(id, fc.option(fc.integer({ min: 1, max: 99999 })), fc.option(preset), (i, v, p) => {
				const ref = `${i}${v !== null ? `@${v}` : ''}${p !== null ? `:${p}` : ''}`;
				expect(parseMgTemplateRef(ref)).toEqual({
					id: i,
					...(v !== null ? { version: v } : {}),
					...(p !== null ? { preset: p } : {}),
				});
			}),
		);
		fc.assert(
			fc.property(fc.string(), (s) => {
				const r = parseMgTemplateRef(s);
				if (r) expect(r.id.length).toBeGreaterThan(0);
			}),
		);
	});
});
