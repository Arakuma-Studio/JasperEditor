// list_motion_templates describes template media params (`mediaParam()`, avatars) as media of their kinds, and the
// guide tells agents what they take (docs/wp-notes/social-comments.md "Template media params").
import { describe, expect, it } from 'vitest';
import { TEMPLATES_GUIDE, templateSummary } from '../src/tools/templates.ts';

describe('template media params for agents', () => {
	it('summarises a media param as "media <kinds>", default null, not keyframable', () => {
		const s = templateSummary({
			id: 'avatar-test',
			version: 1,
			name: 'Avatar test',
			category: 'Test',
			renderer: 'anime',
			canvases: ['1920x1080'],
			defaults: { name: 'Ada', avatar: null },
			paramsSchema: {
				type: 'object',
				properties: {
					name: { type: 'string', default: 'Ada' },
					avatar: {
						default: null,
						'x-jasper-kind': 'media',
						'x-jasper-media-kinds': ['image'],
						anyOf: [
							{ type: 'object', properties: { mediaId: { type: 'string' } }, required: ['mediaId'] },
							{ type: 'null' },
						],
					},
				},
			},
		});
		expect(s.params.find((p) => p.name === 'avatar')).toEqual({
			name: 'avatar',
			type: 'media image',
			default: null,
			keyframable: false,
		});
		expect(TEMPLATES_GUIDE).toContain('{mediaId}');
	});
});
