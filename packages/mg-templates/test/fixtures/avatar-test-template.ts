// A test-only anime template with a media param (`avatar`), used to prove the template media path end to end
// (params → render snapshot → AnimeTemplateProps.mediaUrls → TemplateImage) in the @jasper/compositions and engine
// tests. Not in the catalogue; its implementation is packages/motion/test/fixtures/avatar-test-impl.tsx.
import { z } from 'zod';
import { mediaParam } from '../../src/params.ts';
import type { MgAnimeTemplateDefinition } from '../../src/types.ts';

export const avatarTestParams = z.strictObject({
	name: z.string().max(40).default('Ada'),
	avatar: mediaParam(),
});

export const AVATAR_TEST_TEMPLATE: MgAnimeTemplateDefinition<z.output<typeof avatarTestParams>> = {
	id: 'avatar-test',
	version: 1,
	name: 'Avatar test',
	category: 'Test',
	renderer: 'anime',
	renderVersion: 1,
	paramsSchema: avatarTestParams,
	defaults: avatarTestParams.parse({}),
	introFrames: 0,
	outroFrames: 0,
	defaultDurationSeconds: 2,
	canvases: [{ width: 1920, height: 1080 }],
};
