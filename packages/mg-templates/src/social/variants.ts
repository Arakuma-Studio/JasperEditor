// Social-comment variants (design 2026-10-25 §2, §7.2–7.3): the seven platform looks of `social-comment`, their
// labels, the platform each belongs to, and which params each one draws (per tokcomment's control panel, the
// layout blueprint). Pure data shared by the template, the Properties UI hints, the randomizer and the MCP tools.

/** Variant ids, in gallery order. */
export const SOCIAL_VARIANTS = [
	'tiktok-reply',
	'tiktok-comment',
	'instagram-post',
	'instagram-reel-reply',
	'youtube-comment',
	'youtube-shorts-reply',
	'x-post',
] as const;
export type SocialVariant = (typeof SOCIAL_VARIANTS)[number];

/** English display names (the UI translates them through i18n; MCP and the gallery use them as is). */
export const VARIANT_LABELS: Readonly<Record<SocialVariant, string>> = {
	'tiktok-reply': 'TikTok reply',
	'tiktok-comment': 'TikTok comment',
	'instagram-post': 'Instagram post comment',
	'instagram-reel-reply': 'Instagram Reels reply',
	'youtube-comment': 'YouTube comment',
	'youtube-shorts-reply': 'YouTube Shorts reply',
	'x-post': 'X post',
};

export const SOCIAL_PLATFORMS = ['tiktok', 'instagram', 'youtube', 'x'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

/** The platform whose number, time and mention rules a variant follows. */
export const VARIANT_PLATFORM: Readonly<Record<SocialVariant, SocialPlatform>> = {
	'tiktok-reply': 'tiktok',
	'tiktok-comment': 'tiktok',
	'instagram-post': 'instagram',
	'instagram-reel-reply': 'instagram',
	'youtube-comment': 'youtube',
	'youtube-shorts-reply': 'youtube',
	'x-post': 'x',
};

export const SOCIAL_THEMES = ['light', 'dark'] as const;
export type SocialTheme = (typeof SOCIAL_THEMES)[number];

/** Emoji image packs plus `auto` (the platform's own set). Same ids as the remote-asset emoji packs. */
export const SOCIAL_EMOJI_STYLES = ['auto', 'apple', 'twemoji', 'noto'] as const;
export type SocialEmojiStyle = (typeof SOCIAL_EMOJI_STYLES)[number];
export type SocialEmojiPack = Exclude<SocialEmojiStyle, 'auto'>;

/**
 * The pack `auto` stands for: Apple for TikTok, Instagram and X (x.com renders OS emoji, so an iPhone screenshot shows
 * Apple's; see docs/wp-notes/social-comments.md "Platform assets & sources"), Noto for YouTube.
 */
export const PLATFORM_EMOJI_PACK: Readonly<Record<SocialPlatform, SocialEmojiPack>> = {
	tiktok: 'apple',
	instagram: 'apple',
	youtube: 'noto',
	x: 'apple',
};

/** The emoji pack a card draws with: `style` itself, or the platform's pack for `auto`. */
export function resolveEmojiStyle(variant: SocialVariant, style: SocialEmojiStyle): SocialEmojiPack {
	return style === 'auto' ? PLATFORM_EMOJI_PACK[VARIANT_PLATFORM[variant]] : style;
}

export const SOCIAL_ENTRANCES = ['classic-pop', 'soft-spring', 'grow-from-tail', 'drop-bounce'] as const;
export type SocialEntrance = (typeof SOCIAL_ENTRANCES)[number];

export const SOCIAL_TIME_UNITS = ['minute', 'hour', 'day', 'week', 'month', 'year'] as const;
export type SocialTimeUnit = (typeof SOCIAL_TIME_UNITS)[number];

/** The count fields a card can show. */
export const SOCIAL_COUNT_FIELDS = ['likes', 'replies', 'reposts', 'views'] as const;
export type SocialCountField = (typeof SOCIAL_COUNT_FIELDS)[number];

/** Every `social-comment` param, in panel order (the schema's keys; a test keeps them equal). */
export const SOCIAL_PARAM_NAMES = [
	'variant',
	'theme',
	'emojiStyle',
	'displayName',
	'handle',
	'avatar',
	'showProfile',
	'verified',
	'timeValue',
	'timeUnit',
	'likes',
	'replies',
	'reposts',
	'views',
	'showReposts',
	'showViews',
	'text',
	'entrance',
	'wordReveal',
	'likeTick',
] as const;
export type SocialParamName = (typeof SOCIAL_PARAM_NAMES)[number];

type Flags = {
	displayName: boolean;
	handle: boolean;
	verified: boolean;
	stats: boolean;
	xOnly: boolean;
};

// Per tokcomment (ref/index.md "Controls"): the TikTok reply bubble has no time or counts; the Reels and Shorts
// reply cards have neither stats nor a verified badge; replies-with-reposts-and-views exist only on X.
// Name shown: TikTok cards show the nickname (displayName); Instagram and YouTube show the account handle
// (Instagram bare, YouTube as "@handle"); X shows both.
const FLAGS: Readonly<Record<SocialVariant, Flags>> = {
	'tiktok-reply': { displayName: true, handle: false, verified: true, stats: false, xOnly: false },
	'tiktok-comment': { displayName: true, handle: false, verified: true, stats: true, xOnly: false },
	'instagram-post': { displayName: false, handle: true, verified: true, stats: true, xOnly: false },
	'instagram-reel-reply': { displayName: false, handle: true, verified: false, stats: false, xOnly: false },
	'youtube-comment': { displayName: false, handle: true, verified: true, stats: true, xOnly: false },
	'youtube-shorts-reply': { displayName: false, handle: true, verified: false, stats: false, xOnly: false },
	'x-post': { displayName: true, handle: true, verified: true, stats: true, xOnly: true },
};

function capabilities(f: Flags): Readonly<Record<SocialParamName, boolean>> {
	return {
		variant: true,
		theme: true,
		emojiStyle: true,
		displayName: f.displayName,
		handle: f.handle,
		avatar: true,
		showProfile: true,
		verified: f.verified,
		timeValue: f.stats,
		timeUnit: f.stats,
		likes: f.stats,
		replies: f.stats,
		reposts: f.xOnly,
		views: f.xOnly,
		showReposts: f.xOnly,
		showViews: f.xOnly,
		text: true,
		entrance: true,
		wordReveal: true,
		likeTick: f.stats,
	};
}

/**
 * Which params each variant draws (`true`) or ignores (`false`). Ignored params keep their value, so switching
 * variant and back loses nothing; the Properties panel hides them.
 */
export const VARIANT_CAPABILITIES: Readonly<
	Record<SocialVariant, Readonly<Record<SocialParamName, boolean>>>
> = Object.fromEntries(SOCIAL_VARIANTS.map((v) => [v, capabilities(FLAGS[v])])) as Record<
	SocialVariant,
	Readonly<Record<SocialParamName, boolean>>
>;

/** The variants that draw `param`, in `SOCIAL_VARIANTS` order (for `visibleWhen: { param: 'variant', in }`). */
export function variantsWithParam(param: SocialParamName): SocialVariant[] {
	return SOCIAL_VARIANTS.filter((v) => VARIANT_CAPABILITIES[v][param]);
}

/** Type guard for untrusted variant strings. */
export function isSocialVariant(value: unknown): value is SocialVariant {
	return typeof value === 'string' && (SOCIAL_VARIANTS as readonly string[]).includes(value);
}

/**
 * The name a variant shows for the author first: TikTok and X the display name, Instagram and YouTube the handle
 * (`VARIANT_CAPABILITIES`). Unknown variants read as the schema default (`tiktok-reply`).
 */
export function shownNameParam(variant: unknown): 'displayName' | 'handle' {
	const v = isSocialVariant(variant) ? variant : 'tiktok-reply';
	return VARIANT_CAPABILITIES[v].displayName ? 'displayName' : 'handle';
}

/**
 * The name a generated avatar's initials come from (`generatedAvatar(seed, name)`): the one the card shows
 * (`shownNameParam`), so the Properties preview and every card draw the same initials. `''` when it is not a string.
 */
export function avatarNameFor(variant: unknown, params: Readonly<Record<string, unknown>>): string {
	const value = params[shownNameParam(variant)];
	return typeof value === 'string' ? value : '';
}
