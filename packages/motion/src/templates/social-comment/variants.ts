// The cards of social-comment@1 per variant (contract.ts). A variant without its card draws a visible "not available"
// card (never a blank or a wrong platform), see unavailable.tsx; every variant has its card now.
import type { SocialVariant } from '@jasper/mg-templates';
import type { SocialVariantImpl } from './contract.ts';
import { INSTAGRAM_POST, INSTAGRAM_REEL_REPLY } from './instagram.tsx';
import { TIKTOK_COMMENT, TIKTOK_REPLY } from './tiktok.tsx';
import { X_POST } from './x.tsx';
import { YOUTUBE_COMMENT, YOUTUBE_SHORTS_REPLY } from './youtube.tsx';

export const SOCIAL_VARIANT_IMPLS: Readonly<Record<SocialVariant, SocialVariantImpl>> = {
	'tiktok-reply': TIKTOK_REPLY,
	'tiktok-comment': TIKTOK_COMMENT,
	'instagram-post': INSTAGRAM_POST,
	'instagram-reel-reply': INSTAGRAM_REEL_REPLY,
	'youtube-comment': YOUTUBE_COMMENT,
	'youtube-shorts-reply': YOUTUBE_SHORTS_REPLY,
	'x-post': X_POST,
};

/** Whether a variant has its real card (false: the "not available" card is drawn). */
export function socialVariantAvailable(variant: SocialVariant): boolean {
	return !SOCIAL_VARIANT_IMPLS[variant]?.unavailable;
}
