// The cards of social-comment@1 per variant (contract.ts). A variant without its card yet draws a visible
// "not available" card (never a blank or a wrong platform), see unavailable.tsx.
import type { SocialVariant } from '@jasper/mg-templates';
import type { SocialVariantImpl } from './contract.ts';
import { TIKTOK_COMMENT, TIKTOK_REPLY } from './tiktok.tsx';
import { unavailableVariant } from './unavailable.tsx';

export const SOCIAL_VARIANT_IMPLS: Readonly<Record<SocialVariant, SocialVariantImpl>> = {
	'tiktok-reply': TIKTOK_REPLY,
	'tiktok-comment': TIKTOK_COMMENT,
	'instagram-post': unavailableVariant('instagram-post'),
	'instagram-reel-reply': unavailableVariant('instagram-reel-reply'),
	'youtube-comment': unavailableVariant('youtube-comment'),
	'youtube-shorts-reply': unavailableVariant('youtube-shorts-reply'),
	'x-post': unavailableVariant('x-post'),
};

/** Whether a variant has its real card (false: the "not available" card is drawn). */
export function socialVariantAvailable(variant: SocialVariant): boolean {
	return !SOCIAL_VARIANT_IMPLS[variant]?.unavailable;
}
