import { TEMPLATE_MEDIA_KIND, TEMPLATE_MEDIA_KINDS_KEY, TEMPLATE_PARAM_KIND_KEY } from '@jasper/project';
import { z } from 'zod';
import type { Rgba } from './core.ts';

const channel = z.number().min(0).max(1);

/** Straight sRGB RGBA in 0..1; arrays preserve the native template JSON schema. */
export const rgbaParam = (defaults: Rgba) =>
	z
		.array(channel)
		.length(4)
		.default([...defaults]);

/** Media kinds a template media param may take (pictures drawn by `TemplateImage` are `image`). */
export type MediaParamKind = 'image' | 'video';

/** Value of a template media param: a project medium, or `null` (none). */
export type MediaParamValue = { mediaId: string } | null;

/**
 * A media param of an anime template (avatars, docs/wp-notes/social-comments.md "Template media params"):
 * `{mediaId} | null`, default `null`. The JSON schema carries `x-jasper-kind: "media"` and `x-jasper-media-kinds`,
 * so Properties shows the media picker (with None and drag from the Project panel), commands check that the medium
 * exists and is of one of `kinds` (default `['image']`), every reference-integrity path counts it, and the render
 * snapshot resolves it into `AnimeTemplateProps.mediaUrls[mediaId]`.
 */
export const mediaParam = (opts: { kinds?: MediaParamKind[] } = {}) =>
	z
		.strictObject({ mediaId: z.string().min(1).max(256) })
		.nullable()
		.default(null)
		.meta({
			[TEMPLATE_PARAM_KIND_KEY]: TEMPLATE_MEDIA_KIND,
			[TEMPLATE_MEDIA_KINDS_KEY]: [...new Set(opts.kinds?.length ? opts.kinds : ['image'])],
		});
