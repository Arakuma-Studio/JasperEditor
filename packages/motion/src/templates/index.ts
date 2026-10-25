// @jasper/motion/templates — React implementations of the anime templates (S11 §5, ARCHITECTURE §20.2), keyed
// `id@version` like the `renderer: 'anime'` entries of @jasper/mg-templates.
import type { ComponentType } from 'react';
import { Callout } from './callout.tsx';
import { Counter } from './counter.tsx';
import { LowerThirdAnim } from './lower-third-anim.tsx';
import { SocialComment } from './social-comment/index.tsx';
import { TitleReveal } from './title-reveal.tsx';
import type { AnimeTemplateProps } from './types.ts';

export {
	EmojiImage,
	MissingAssetMarker,
	type MissingAssetReporter,
	MissingAssetReporterContext,
	type MissingTemplateAsset,
	missingAssetLabel,
	onTemplateAssetRetry,
	retryTemplateAssets,
	TemplateAssetScopeContext,
	useTemplateAssetEpoch,
} from './assets.tsx';
export { type EditableParamProps, editableParamProps } from './editable.ts';
export { TemplateImage, TemplateImagePlaceholder, type TemplateImageProps } from './image.tsx';
export type { AnimeTemplateProps } from './types.ts';

/** URL of an emoji of a pack in `AnimeTemplateProps.emojiUrls` (undefined when not available). */
export function emojiUrlOf(
	emojiUrls: Readonly<Record<string, string>>,
	pack: string,
	grapheme: string,
): string | undefined {
	return emojiUrls[`${pack}:${grapheme}`];
}

export const ANIME_TEMPLATE_IMPLS: Readonly<Record<string, ComponentType<AnimeTemplateProps>>> =
	Object.freeze({
		'title-reveal@1': TitleReveal,
		'lower-third-anim@1': LowerThirdAnim,
		'callout@1': Callout,
		'counter@1': Counter,
		'social-comment@1': SocialComment,
	});
