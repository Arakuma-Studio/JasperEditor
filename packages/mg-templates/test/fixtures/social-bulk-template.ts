// A test-only stand-in for `social-comment@1` (WP6a's template) with exactly the hints that template carries for
// "Add another" and bulk import (`ui.addAnother: SOCIAL_ADD_ANOTHER`, `ui.import: SOCIAL_IMPORT_HINTS`), the social
// params schema, per-variant presets and the `fillSocialParams` fill hook. Not in the catalogue; shared by the
// mg-templates, web and MCP tests of docs/wp-notes/social-comments.md "Add another & bulk import".
import {
	fillSocialParams,
	SOCIAL_ADD_ANOTHER,
	SOCIAL_IMPORT_HINTS,
	SOCIAL_VARIANTS,
	type SocialCommentParams,
	socialCommentParamsSchema,
	socialDefaults,
	VARIANT_LABELS,
} from '../../src/social/index.ts';
import type { MgAnimeTemplateDefinition } from '../../src/types.ts';

const DEFAULTS = socialDefaults('tiktok-reply');

export const SOCIAL_BULK_TEST_TEMPLATE: MgAnimeTemplateDefinition<SocialCommentParams> = {
	id: 'social-bulk-test',
	version: 1,
	name: 'Social comment (test)',
	category: 'Social comments',
	renderer: 'anime',
	renderVersion: 1,
	paramsSchema: socialCommentParamsSchema as never,
	defaults: DEFAULTS,
	introFrames: 8,
	outroFrames: 6,
	defaultDurationSeconds: 5,
	canvases: [{ width: 1080, height: 1920 }],
	presets: SOCIAL_VARIANTS.map((variant) => ({
		id: variant,
		name: VARIANT_LABELS[variant],
		params: { ...socialDefaults(variant), variant },
	})),
	fill(partial, seed) {
		const r = fillSocialParams(partial, seed);
		return r.ok
			? { ok: true, params: { ...r.params }, filled: [...r.filled] }
			: { ok: false, error: r.error, issues: r.issues };
	},
	ui: {
		params: {
			text: { label: 'Comment', multiline: true },
			displayName: { label: 'Display Name' },
			variant: { label: 'Style' },
		},
		addAnother: SOCIAL_ADD_ANOTHER,
		import: SOCIAL_IMPORT_HINTS,
	},
};
