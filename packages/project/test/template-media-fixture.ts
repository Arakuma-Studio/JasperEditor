// A test-only anime template with media params (`avatar`, a list `gallery`), shared by the template-media tests
// of @jasper/project, @jasper/session and @jasper/interchange. Not in the catalogue.
import { z } from 'zod';
import {
	createStaticMgRegistry,
	defaultRegistries,
	type MgTemplateInfo,
	TEMPLATE_MEDIA_KIND,
	TEMPLATE_MEDIA_KINDS_KEY,
	TEMPLATE_PARAM_KIND_KEY,
} from '../src/index.ts';

/** What `mediaParam()` of @jasper/mg-templates builds (this package may not import it). */
export const mediaParamLike = (kinds: string[] = ['image']) =>
	z
		.strictObject({ mediaId: z.string().min(1).max(256) })
		.nullable()
		.default(null)
		.meta({ [TEMPLATE_PARAM_KIND_KEY]: TEMPLATE_MEDIA_KIND, [TEMPLATE_MEDIA_KINDS_KEY]: kinds });

const cardSchema = z.strictObject({
	name: z.string().max(40).default('Ada'),
	avatar: mediaParamLike(),
	/** A nested reference (a list of pictures) proves the deep walk. */
	gallery: z
		.array(mediaParamLike(['image', 'video']))
		.max(4)
		.default([]),
});

export const avatarCard: MgTemplateInfo = {
	id: 'avatar-card',
	version: 1,
	name: 'Avatar card',
	category: 'Test',
	paramsSchema: cardSchema,
	defaults: cardSchema.parse({}) as Record<string, unknown>,
	introFrames: 10,
	outroFrames: 10,
	canvasDefault: 'sequence',
	renderer: 'anime',
};
export const avatarRegistries = () => defaultRegistries(createStaticMgRegistry([avatarCard]));
