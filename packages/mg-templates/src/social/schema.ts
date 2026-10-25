// `social-comment` params (design 2026-10-25 §7.3): one strict zod schema shared by the template, the Properties
// panel (through its JSON Schema), the MCP tools and the randomizer. Every field carries a `.describe()` written for
// AI agents. Per-variant defaults (tokcomment's, ref/index.md) come from `socialDefaults(variant)`; the schema's own
// `.default()`s are the `tiktok-reply` ones so `parse({})` stays valid.
import { TEMPLATE_MEDIA_KIND, TEMPLATE_MEDIA_KINDS_KEY, TEMPLATE_PARAM_KIND_KEY } from '@jasper/project';
import { z } from 'zod';
import { stripMarks } from './marks.ts';
import {
	parseReviewDate,
	SOCIAL_DATE_MAX_YEAR,
	SOCIAL_DATE_MIN_YEAR,
	SOCIAL_RATING_MAX,
	SOCIAL_RATING_MIN,
} from './review.ts';
import {
	SOCIAL_EMOJI_STYLES,
	SOCIAL_ENTRANCES,
	SOCIAL_THEMES,
	SOCIAL_TIME_UNITS,
	SOCIAL_VARIANTS,
	type SocialParamName,
	type SocialVariant,
	variantsWithParam,
} from './variants.ts';

/** Largest stored count (likes, replies, reposts, views). */
export const SOCIAL_COUNT_MAX = 1e12;
/** Largest time value ("10000 years ago" is already absurd). */
export const SOCIAL_TIME_VALUE_MAX = 10_000;
export const SOCIAL_NAME_MAX = 64;
export const SOCIAL_HANDLE_MAX = 64;
/** Visible comment length (marks stripped), in UTF-16 code units. */
export const SOCIAL_TEXT_MAX = 2000;
/** Stored markup length: the visible cap plus room for mark delimiters and escapes. */
export const SOCIAL_TEXT_MARKUP_MAX = 4000;
export const SOCIAL_MEDIA_ID_MAX = 256;
/** Review title length (App Store titles are one short line; the card cuts a longer one with an ellipsis). */
export const SOCIAL_TITLE_MAX = 120;

/** tokcomment's default comment text, used by every variant. */
export const SOCIAL_DEFAULT_TEXT = 'Write any comment and see what happens 😊';
/** The default body of the store review cards. */
export const SOCIAL_DEFAULT_REVIEW_TEXT = 'Write any review and see what happens 😊';

/** Control characters and line/paragraph separators: names and handles are single-line. */
const SINGLE_LINE = /^[^\p{Cc}\u2028\u2029]*$/u;
/** Handle characters: letters (any script, with their combining marks), digits, `.`, `_` and `-`. */
const HANDLE = /^[\p{L}\p{M}\p{N}._-]+$/u;

const uses = (param: SocialParamName) => `Used by: ${variantsWithParam(param).join(', ')}.`;
const count = (what: string, param: SocialParamName, example: string) =>
	z
		.number()
		.int()
		.min(0)
		.max(SOCIAL_COUNT_MAX)
		.describe(
			`${what}. A raw non-negative integer (0…1e12); the card formats it the way the platform does (${example}). ${uses(param)}`,
		);

/**
 * Avatar reference to a project media item: the object of the shared template media param (`mediaParam()`, contract
 * C1), stored as `{ mediaId }`. The `avatar` field carries `mediaParam()`'s media metadata on the whole union.
 */
export const socialAvatarMediaSchema = z.strictObject({
	mediaId: z
		.string()
		.min(1)
		.max(SOCIAL_MEDIA_ID_MAX)
		.describe('Id of an image media item in the project (from list_media); drawn cropped to a circle.'),
});
/** A seeded generated avatar (gradient + initials or silhouette, see `generatedAvatar`); needs no media. */
export const socialAvatarGeneratedSchema = z.strictObject({
	generated: z
		.number()
		.int()
		.min(0)
		.max(0xffff_ffff)
		.describe(
			'Seed (0…4294967295) of a generated avatar: a colour gradient with the initials or a silhouette.',
		),
});
export const socialAvatarSchema = z.union([socialAvatarMediaSchema, socialAvatarGeneratedSchema, z.null()]);
export type SocialAvatar = z.output<typeof socialAvatarSchema>;

/** Field schemas without defaults (shared by the full schema and the partial input schema). */
const FIELDS = {
	variant: z
		.enum(SOCIAL_VARIANTS)
		.describe(
			"Which platform card to draw: 'tiktok-reply' (TikTok \"Reply to name's comment\" bubble shown on a video reply), " +
				"'tiktok-comment' (TikTok comment row), 'instagram-post' (Instagram post comment), 'instagram-reel-reply' " +
				'(Instagram "Replying to username" Reels card), \'youtube-comment\' (YouTube video comment), ' +
				"'youtube-shorts-reply' (YouTube \"Comment from @handle\" Shorts card), 'x-post' (X post), 'play-store-review' (Google Play " +
				'review: avatar, name, stars, date), \'app-store-review\' (App Store review in its web / Mac style: stars, "name, date", ' +
				"bold title, body with \"more\") or 'app-store-review-ios' (App Store review in the iPhone app's Ratings & Reviews list: " +
				'title and age, stars and name). Switching variant keeps ' +
				'every other value; fields a variant does not draw are kept and ignored.',
		),
	theme: z
		.enum(SOCIAL_THEMES)
		.describe("Colour theme of the card: 'light' or 'dark' (the platform's own dark mode). All variants."),
	emojiStyle: z
		.enum(SOCIAL_EMOJI_STYLES)
		.describe(
			"Emoji image set: 'auto' (the platform's own: Apple for TikTok, Instagram and X, Noto for YouTube; 'twemoji' gives the older X / Windows look), " +
				"'apple', 'twemoji' or 'noto'. Emoji are drawn as images so preview and export match. 'auto' is Noto on Google Play reviews and Apple on App Store reviews. All variants.",
		),
	displayName: z
		.string()
		.min(1)
		.max(SOCIAL_NAME_MAX)
		.regex(SINGLE_LINE, 'must be a single line without control characters')
		.describe(
			`Name shown on the card, single line, up to ${SOCIAL_NAME_MAX} characters, emoji allowed (e.g. "Luna Park"). TikTok shows the nickname here; X shows it in bold before the @handle; store reviews show the reviewer's name (Google account name on Play, the App Store nickname). ${uses('displayName')}`,
		),
	handle: z
		.string()
		.min(1)
		.max(SOCIAL_HANDLE_MAX)
		.regex(HANDLE, 'letters, digits, ".", "_" and "-" only, without the leading @')
		.describe(
			`Account handle WITHOUT the leading @: letters, digits, ".", "_" and "-", up to ${SOCIAL_HANDLE_MAX} characters (e.g. "luna.makes", "jake_rides22"). Instagram shows it bare, YouTube and X as "@handle". ${uses('handle')}`,
		),
	// The template media param metadata of `mediaParam()` (contract C1) on the whole union: Properties offers the media
	// picker (the `social-avatar` control adds the generated choice), commands check that a `{ mediaId }` names an
	// image of the project, and every reference-integrity path counts it.
	avatar: socialAvatarSchema.meta({
		description:
			'Profile picture: {"mediaId": "<project image media id>"} for an imported image, {"generated": <seed>} for a ' +
			`generated gradient avatar, or null for the platform's default grey silhouette. ${uses('avatar')}`,
		[TEMPLATE_PARAM_KIND_KEY]: TEMPLATE_MEDIA_KIND,
		[TEMPLATE_MEDIA_KINDS_KEY]: ['image'],
	}),
	showProfile: z
		.boolean()
		.describe(
			`Show the avatar (false hides it and the text moves left, like tokcomment's "profile" toggle). ${uses('showProfile')}`,
		),
	verified: z.boolean().describe(`Show the platform's verified badge after the name. ${uses('verified')}`),
	timeValue: z
		.number()
		.int()
		.min(0)
		.max(SOCIAL_TIME_VALUE_MAX)
		.describe(
			`How long ago the comment was posted, in \`timeUnit\`s (0…${SOCIAL_TIME_VALUE_MAX}; 0 shows "now"/"Just now"). Shown as "3h" on TikTok/Instagram/X, "3 hours ago" on YouTube and as the iPhone App Store's review age ("3h ago", "1y ago"). ${uses('timeValue')}`,
		),
	timeUnit: z
		.enum(SOCIAL_TIME_UNITS)
		.describe(
			`Unit of \`timeValue\`: 'minute', 'hour', 'day', 'week', 'month' or 'year' (e.g. timeValue 10 + 'month' = "10mo" / "10 months ago"). ${uses('timeUnit')}`,
		),
	likes: count(
		'Like count',
		'likes',
		'TikTok/Instagram "1,393" then "12.3K"; YouTube "1.2K", "12K"; X "1.2K"',
	),
	replies: count(
		'Reply count. 0 hides the replies row',
		'replies',
		'TikTok "View 2 replies", Instagram "View 5 more replies", YouTube "2 replies", X count "45"',
	),
	reposts: count('Repost count shown next to the repost icon', 'reposts', '"12", "1.2K"'),
	views: count('View count shown next to the views icon', 'views', '"12K", "1.5M"'),
	showReposts: z.boolean().describe(`Show the repost count (the icon stays). ${uses('showReposts')}`),
	showViews: z.boolean().describe(`Show the view count (the icon stays). ${uses('showViews')}`),
	rating: z
		.number()
		.int()
		.min(SOCIAL_RATING_MIN)
		.max(SOCIAL_RATING_MAX)
		.describe(
			`Star rating of a store review: a whole number of stars, ${SOCIAL_RATING_MIN}–${SOCIAL_RATING_MAX} (Google Play draws green stars, the App Store orange ones). ${uses('rating')}`,
		),
	date: z.iso
		.date('must be an ISO date YYYY-MM-DD (a real calendar date)')
		.refine(
			(d) => parseReviewDate(d) !== null,
			`must be a real calendar date between ${SOCIAL_DATE_MIN_YEAR} and ${SOCIAL_DATE_MAX_YEAR}`,
		)
		.describe(
			`Date of a store review as an ISO date "YYYY-MM-DD" (a real calendar date, ${SOCIAL_DATE_MIN_YEAR}–${SOCIAL_DATE_MAX_YEAR}), printed the way the store does: Google Play "11/6/18" (M/D/YY), App Store web "09/24/2021" (MM/DD/YYYY). The iPhone App Store card shows a relative age instead (timeValue + timeUnit). ${uses('date')}`,
		),
	edited: z
		.boolean()
		.describe(
			`The review was edited: the iPhone App Store card prefixes its age with "edited" ("edited 1y ago"). ${uses('edited')}`,
		),
	title: z
		.string()
		.max(SOCIAL_TITLE_MAX)
		.regex(SINGLE_LINE, 'must be a single line without control characters')
		.describe(
			`Bold title of an App Store review, one line, up to ${SOCIAL_TITLE_MAX} characters, emoji allowed (e.g. "Great so far"); a title longer than the card ends with "…"; empty hides the title line. ${uses('title')}`,
		),
	text: z
		.string()
		.max(SOCIAL_TEXT_MARKUP_MAX)
		.refine((t) => stripMarks(t).length <= SOCIAL_TEXT_MAX, `at most ${SOCIAL_TEXT_MAX} visible characters`)
		.describe(
			`The comment (or the review body on store reviews), up to ${SOCIAL_TEXT_MAX} visible characters; line breaks and emoji allowed; @mentions and #hashtags are coloured like the platform (store reviews leave them plain). Word marks are inline markup: ==highlighted words== (yellow pill), ||blurred words||, ~~removed words~~ (invisible, gap kept); escape a literal =, |, ~ or \\ with a backslash (e.g. "a \\=\\= b"); unbalanced markers show literally; marks do not nest. Example: "This is ==so good== ||spoiler|| 🔥". All variants.`,
		),
	truncate: z
		.boolean()
		.describe(
			`Clamp a long review the way the store does: Google Play fades out the last of its lines, the App Store web card stops after 4 lines with a blue "more", the iPhone App Store card after its lines with "more". false shows the whole text. ${uses('truncate')}`,
		),
	entrance: z
		.enum(SOCIAL_ENTRANCES)
		.describe(
			"Entrance animation: 'classic-pop' (scale 0 → 130% → 100%, ≈270 ms), 'soft-spring' (scale 60% → 100% with a small bounce, ≈450 ms), 'grow-from-tail' (grows from the bubble tail or avatar corner with a tilt settle, ≈500 ms) or 'drop-bounce' (falls ≈60 px and bounces once, ≈550 ms). The exit is a short scale-down and fade. All variants.",
		),
	wordReveal: z
		.boolean()
		.describe(
			'After the entrance, reveal the comment word by word (≈90 ms per word, each popping in). All variants.',
		),
	likeTick: z
		.boolean()
		.describe(
			`After the entrance, count the likes up from 0 (≈900 ms) and thump the heart; on store reviews the stars fill one by one instead and pulse at the end. ${uses('likeTick')}`,
		),
} as const;

type Fields = typeof FIELDS;

export type SocialCommentParams = { [K in keyof Fields]: z.output<Fields[K]> };

const COMMON_DEFAULTS = {
	theme: 'light',
	emojiStyle: 'auto',
	avatar: null,
	showProfile: true,
	verified: false,
	reposts: 12,
	views: 12_000,
	showReposts: true,
	showViews: true,
	rating: 4,
	date: '2025-09-24',
	edited: false,
	title: 'Review title',
	text: SOCIAL_DEFAULT_TEXT,
	truncate: true,
	entrance: 'soft-spring',
	wordReveal: false,
	likeTick: false,
} as const satisfies Partial<SocialCommentParams>;

type PlatformDefaults = Pick<
	SocialCommentParams,
	'displayName' | 'handle' | 'timeValue' | 'timeUnit' | 'likes' | 'replies'
> &
	Partial<Pick<SocialCommentParams, 'reposts' | 'views' | 'text' | 'truncate'>>;

// tokcomment's defaults (ref/index.md; styles_*.json texts). Variants without stats keep their platform's stats so a
// variant switch within the platform shows tokcomment's numbers. The field a variant does not show gets a neutral
// counterpart ("Display Name" / "username").
const TIKTOK: PlatformDefaults = {
	displayName: 'username',
	handle: 'username',
	timeValue: 1,
	timeUnit: 'day',
	likes: 1393,
	replies: 2,
};
const INSTAGRAM: PlatformDefaults = {
	displayName: 'Display Name',
	handle: 'username',
	timeValue: 2,
	timeUnit: 'week',
	likes: 114,
	replies: 5,
};
const YOUTUBE: PlatformDefaults = {
	displayName: 'Display Name',
	handle: 'Username',
	timeValue: 10,
	timeUnit: 'month',
	likes: 72,
	replies: 2,
};
const X: PlatformDefaults = {
	displayName: 'Display Name',
	handle: 'username',
	timeValue: 2,
	timeUnit: 'hour',
	likes: 1200,
	replies: 45,
	reposts: 12,
	views: 12_000,
};
// Store reviews (design §11): neutral placeholders like tokcomment's ("Display Name", "Review title"), 4 stars as the
// requester's Play screenshot; the iPhone card's age is "1y ago" like the first card of its screenshot.
const REVIEW: PlatformDefaults = {
	displayName: 'Display Name',
	handle: 'username',
	timeValue: 1,
	timeUnit: 'year',
	// not drawn: tokcomment's TikTok numbers, so a switch to a comment card shows plausible counts
	likes: 1393,
	replies: 2,
	text: SOCIAL_DEFAULT_REVIEW_TEXT,
};
const VARIANT_DEFAULTS: Readonly<Record<SocialVariant, PlatformDefaults>> = {
	'tiktok-reply': TIKTOK,
	'tiktok-comment': TIKTOK,
	'instagram-post': INSTAGRAM,
	'instagram-reel-reply': INSTAGRAM,
	'youtube-comment': YOUTUBE,
	'youtube-shorts-reply': YOUTUBE,
	'x-post': X,
	'play-store-review': REVIEW,
	'app-store-review': REVIEW,
	// the iPhone app's Ratings & Reviews list (the requester's screenshot) shows whole reviews; `truncate` gives the
	// product page's clamped card
	'app-store-review-ios': { ...REVIEW, truncate: false },
};

/** tokcomment's defaults for `variant` (a fresh object every call). */
export function socialDefaults(variant: SocialVariant): SocialCommentParams {
	return { variant, ...COMMON_DEFAULTS, ...VARIANT_DEFAULTS[variant] };
}

const SCHEMA_DEFAULTS = socialDefaults('tiktok-reply');

/**
 * Strict params of `social-comment`. Unknown keys are rejected; omitted keys take the `tiktok-reply` defaults (use
 * `socialDefaults(variant)` or `fillSocialParams` for per-variant values).
 */
export const socialCommentParamsSchema = z.strictObject(
	Object.fromEntries(
		Object.entries(FIELDS).map(([k, s]) => [
			k,
			(s as z.ZodType).default(SCHEMA_DEFAULTS[k as keyof Fields] as never),
		]),
	) as { [K in keyof Fields]: z.ZodDefault<Fields[K]> },
);

/** The same fields, every one optional and without defaults: validates partial input (an agent's or a CSV row's). */
export const socialCommentPartialSchema = z.strictObject(
	Object.fromEntries(Object.entries(FIELDS).map(([k, s]) => [k, s.optional()])) as {
		[K in keyof Fields]: z.ZodOptional<Fields[K]>;
	},
);
export type SocialCommentInput = z.input<typeof socialCommentPartialSchema>;
