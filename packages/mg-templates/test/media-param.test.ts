// mediaParam() (C1, docs/wp-notes/social-comments.md "Template media params"): the zod schema of a template media
// param, its JSON-schema metadata in the catalogue, and the media control Properties derives from it.
import { paramsPropertySpecs, templateMediaKindsAt } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMgRegistry, type MgAnimeTemplateDefinition, mediaParam } from '../src/index.ts';

const schema = z.strictObject({
	name: z.string().default('Ada'),
	avatar: mediaParam(),
	clip: mediaParam({ kinds: ['image', 'video'] }),
});
const def: MgAnimeTemplateDefinition<z.output<typeof schema>> = {
	id: 'media-test',
	version: 1,
	name: 'Media test',
	category: 'Test',
	renderer: 'anime',
	renderVersion: 1,
	paramsSchema: schema,
	defaults: schema.parse({}),
	introFrames: 0,
	outroFrames: 0,
	defaultDurationSeconds: 3,
	canvases: [{ width: 1920, height: 1080 }],
};

describe('mediaParam()', () => {
	it('is {mediaId} | null, default null, strict', () => {
		const p = mediaParam();
		expect(p.parse(undefined)).toBeNull();
		expect(p.parse(null)).toBeNull();
		expect(p.parse({ mediaId: 'med_1' })).toEqual({ mediaId: 'med_1' });
		for (const bad of [{ mediaId: '' }, { mediaId: 3 }, { mediaId: 'm', extra: 1 }, 'med_1', []])
			expect(p.safeParse(bad).success).toBe(false);
	});

	it('carries x-jasper-kind / x-jasper-media-kinds in the catalogue JSON schema (default: images)', () => {
		const entry = createMgRegistry([def]).catalogJson()[0]!;
		const props = (entry.paramsSchema as { properties: Record<string, Record<string, unknown>> }).properties;
		expect(props.avatar).toMatchObject({
			'x-jasper-kind': 'media',
			'x-jasper-media-kinds': ['image'],
			default: null,
		});
		expect(props.clip).toMatchObject({ 'x-jasper-media-kinds': ['image', 'video'] });
		expect(templateMediaKindsAt(def, ['avatar'])).toEqual(['image']);
		expect(templateMediaKindsAt(def, ['name'])).toBeNull();
	});

	it('maps to the media picker in Properties (None = null)', () => {
		const info = createMgRegistry([def]).get('media-test', 1)!;
		const avatar = paramsPropertySpecs(info).find((s) => s.key === 'params.avatar')!;
		expect(avatar).toMatchObject({
			kind: 'media',
			ui: { control: 'media' },
			mediaKinds: ['image'],
			mediaNullable: true,
			animatable: 'no',
			defaultValue: null,
		});
	});
});
