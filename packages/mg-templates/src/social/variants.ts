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
	'play-store-review',
	'app-store-review',
	'app-store-review-ios',
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
	'play-store-review': 'Google Play review',
	'app-store-review': 'App Store review',
	'app-store-review-ios': 'App Store review (iPhone app)',
};

export const SOCIAL_PLATFORMS = ['tiktok', 'instagram', 'youtube', 'x', 'play-store', 'app-store'] as const;
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
	'play-store-review': 'play-store',
	'app-store-review': 'app-store',
	'app-store-review-ios': 'app-store',
};

/** The store review cards (Play Store, App Store web and iPhone app): rating, date and title instead of counts. */
export const SOCIAL_REVIEW_VARIANTS = [
	'play-store-review',
	'app-store-review',
	'app-store-review-ios',
] as const;
export type SocialReviewVariant = (typeof SOCIAL_REVIEW_VARIANTS)[number];

/** Whether `variant` is a store review card. */
export function isReviewVariant(variant: unknown): variant is SocialReviewVariant {
	return typeof variant === 'string' && (SOCIAL_REVIEW_VARIANTS as readonly string[]).includes(variant);
}

export const SOCIAL_THEMES = ['light', 'dark'] as const;
export type SocialTheme = (typeof SOCIAL_THEMES)[number];

/** Emoji image packs plus `auto` (the platform's own set). Same ids as the remote-asset emoji packs. */
export const SOCIAL_EMOJI_STYLES = ['auto', 'apple', 'twemoji', 'noto'] as const;
export type SocialEmojiStyle = (typeof SOCIAL_EMOJI_STYLES)[number];
export type SocialEmojiPack = Exclude<SocialEmojiStyle, 'auto'>;

/**
 * The pack `auto` stands for: Apple for TikTok, Instagram and X (x.com renders OS emoji, so an iPhone screenshot shows
 * Apple's; see docs/wp-notes/social-comments.md "Platform assets & sources"), Noto for YouTube; Noto for Play Store
 * reviews (Android) and Apple for App Store reviews.
 */
export const PLATFORM_EMOJI_PACK: Readonly<Record<SocialPlatform, SocialEmojiPack>> = {
	tiktok: 'apple',
	instagram: 'apple',
	youtube: 'noto',
	x: 'apple',
	// Play reviews are read on Android (Noto Color Emoji); App Store reviews on iPhone, iPad and Mac (Apple)
	'play-store': 'noto',
	'app-store': 'apple',
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
	'rating',
	'date',
	'edited',
	'title',
	'text',
	'truncate',
	'entrance',
	'wordReveal',
	'likeTick',
] as const;
export type SocialParamName = (typeof SOCIAL_PARAM_NAMES)[number];

type Flags = {
	displayName: boolean;
	handle: boolean;
	verified: boolean;
	/** The avatar (and its show toggle). */
	avatar: boolean;
	/** The relative age (`timeValue` + `timeUnit`). */
	time: boolean;
	/** Likes and replies. */
	counts: boolean;
	xOnly: boolean;
	/** Store reviews: star rating and the line clamp of the body. */
	review: boolean;
	/** A calendar date (`date`). */
	date: boolean;
	/** A bold review title (App Store). */
	title: boolean;
	/** The "edited" prefix of the iPhone App Store date. */
	edited: boolean;
};

const COMMENT = { avatar: true, review: false, date: false, title: false, edited: false } as const;

// Per tokcomment (ref/index.md "Controls"): the TikTok reply bubble has no time or counts; the Reels and Shorts
// reply cards have neither stats nor a verified badge; replies-with-reposts-and-views exist only on X.
// Name shown: TikTok cards show the nickname (displayName); Instagram and YouTube show the account handle
// (Instagram bare, YouTube as "@handle"); X shows both.
// Store reviews (design §11): the reviewer's free-form name (displayName: Google account name, App Store nickname),
// a 1–5 star rating and the body with the store's line clamp; Play has an avatar and a date; the App Store web card a
// title and a date; the iPhone app card a title and a relative age ("2d ago", "edited 1y ago"). No counts, no badge.
const FLAGS: Readonly<Record<SocialVariant, Flags>> = {
	'tiktok-reply': {
		...COMMENT,
		displayName: true,
		handle: false,
		verified: true,
		time: false,
		counts: false,
		xOnly: false,
	},
	'tiktok-comment': {
		...COMMENT,
		displayName: true,
		handle: false,
		verified: true,
		time: true,
		counts: true,
		xOnly: false,
	},
	'instagram-post': {
		...COMMENT,
		displayName: false,
		handle: true,
		verified: true,
		time: true,
		counts: true,
		xOnly: false,
	},
	'instagram-reel-reply': {
		...COMMENT,
		displayName: false,
		handle: true,
		verified: false,
		time: false,
		counts: false,
		xOnly: false,
	},
	'youtube-comment': {
		...COMMENT,
		displayName: false,
		handle: true,
		verified: true,
		time: true,
		counts: true,
		xOnly: false,
	},
	'youtube-shorts-reply': {
		...COMMENT,
		displayName: false,
		handle: true,
		verified: false,
		time: false,
		counts: false,
		xOnly: false,
	},
	'x-post': {
		...COMMENT,
		displayName: true,
		handle: true,
		verified: true,
		time: true,
		counts: true,
		xOnly: true,
	},
	'play-store-review': {
		displayName: true,
		handle: false,
		verified: false,
		avatar: true,
		time: false,
		counts: false,
		xOnly: false,
		review: true,
		date: true,
		title: false,
		edited: false,
	},
	'app-store-review': {
		displayName: true,
		handle: false,
		verified: false,
		avatar: false,
		time: false,
		counts: false,
		xOnly: false,
		review: true,
		date: true,
		title: true,
		edited: false,
	},
	'app-store-review-ios': {
		displayName: true,
		handle: false,
		verified: false,
		avatar: false,
		time: true,
		counts: false,
		xOnly: false,
		review: true,
		date: false,
		title: true,
		edited: true,
	},
};

function capabilities(f: Flags): Readonly<Record<SocialParamName, boolean>> {
	return {
		variant: true,
		theme: true,
		emojiStyle: true,
		displayName: f.displayName,
		handle: f.handle,
		avatar: f.avatar,
		showProfile: f.avatar,
		verified: f.verified,
		timeValue: f.time,
		timeUnit: f.time,
		likes: f.counts,
		replies: f.counts,
		reposts: f.xOnly,
		views: f.xOnly,
		showReposts: f.xOnly,
		showViews: f.xOnly,
		rating: f.review,
		date: f.date,
		edited: f.edited,
		title: f.title,
		text: true,
		truncate: f.review,
		entrance: true,
		wordReveal: true,
		// the like count ticks up on cards with likes; on store reviews the same extra fills the stars one by one
		likeTick: f.counts || f.review,
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
