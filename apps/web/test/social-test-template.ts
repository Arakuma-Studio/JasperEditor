// A test-only social-comment template: the real params schema (`socialCommentParamsSchema`) with the ui hints the
// `social-comment@1` template names its controls in (design §7.3/§7.9: groups, per-variant visibility, custom
// controls). Its id differs from the real template's so both can sit in one registry.
import {
	type MgAnimeTemplateDefinition,
	SOCIAL_PARAM_NAMES,
	SOCIAL_VARIANTS,
	type SocialCommentParams,
	type SocialParamName,
	socialCommentParamsSchema,
	variantsWithParam,
} from '@jasper/mg-templates';

const CONTROLS: Partial<Record<SocialParamName, string>> = {
	text: 'social-comment-text',
	likes: 'social-count',
	replies: 'social-count',
	reposts: 'social-count',
	views: 'social-count',
	timeValue: 'social-time',
	avatar: 'social-avatar',
};

const params: Record<
	string,
	{ control?: string; visibleWhen?: { param: string; in: string[] }; multiline?: boolean }
> = {};
for (const name of SOCIAL_PARAM_NAMES) {
	const variants = variantsWithParam(name);
	const hint: (typeof params)[string] = {};
	if (CONTROLS[name]) hint.control = CONTROLS[name];
	if (variants.length < SOCIAL_VARIANTS.length) hint.visibleWhen = { param: 'variant', in: variants };
	if (name === 'text') hint.multiline = true;
	if (Object.keys(hint).length) params[name] = hint;
}

export const SOCIAL_TEST_TEMPLATE_ID = 'social-comment-test';

export const socialTestTemplate: MgAnimeTemplateDefinition<SocialCommentParams> = {
	id: SOCIAL_TEST_TEMPLATE_ID,
	version: 1,
	name: 'Social Comment (test)',
	category: 'Social',
	renderer: 'anime',
	renderVersion: 1,
	paramsSchema: socialCommentParamsSchema,
	defaults: socialCommentParamsSchema.parse({}),
	introFrames: 10,
	outroFrames: 10,
	defaultDurationSeconds: 4,
	canvases: [{ width: 1080, height: 1920 }],
	ui: {
		groups: [
			{ id: 'look', label: 'Look', params: ['variant', 'theme', 'emojiStyle'] },
			{
				id: 'author',
				label: 'Author',
				params: ['displayName', 'handle', 'avatar', 'showProfile', 'verified'],
			},
			{
				id: 'stats',
				label: 'Stats',
				params: ['timeValue', 'timeUnit', 'likes', 'replies', 'reposts', 'views', 'showReposts', 'showViews'],
			},
			{ id: 'text', label: 'Text', params: ['text'] },
			{ id: 'animation', label: 'Animation', params: ['entrance', 'wordReveal', 'likeTick'] },
		],
		params,
	},
};
