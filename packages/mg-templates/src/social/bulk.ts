// "Add another" and bulk-import hints of the social-comment template (design §7.9; docs/wp-notes/social-comments.md
// "Add another & bulk import"). The template definition spreads them into its `ui`:
//   ui: { …, addAnother: SOCIAL_ADD_ANOTHER, import: SOCIAL_IMPORT_HINTS }
import type { MgTemplateImportUi } from '@jasper/project';
import {
	SOCIAL_PARAM_NAMES,
	SOCIAL_VARIANTS,
	type SocialParamName,
	VARIANT_CAPABILITIES,
} from './variants.ts';

/**
 * What "Add another" re-randomizes (through `fillSocialParams`): a different person (name, handle, avatar) and new
 * stats (age, likes, replies, reposts, views; a store review's rating and date). Kept from the source card: the look
 * (variant, theme, emoji style), the profile and verified toggles, the X count toggles, the animation (entrance, word
 * reveal, like tick), the review's edited flag and line clamp, and the content (text and review title) — the user
 * edits the text of the new card, which keeps its marks' style.
 */
export const SOCIAL_REROLL_PARAMS: readonly SocialParamName[] = [
	'displayName',
	'handle',
	'avatar',
	'timeValue',
	'timeUnit',
	'likes',
	'replies',
	'reposts',
	'views',
	'rating',
	'date',
];

/** Kept by "Add another" (every param that is not re-randomized). */
export const SOCIAL_KEEP_PARAMS: readonly SocialParamName[] = SOCIAL_PARAM_NAMES.filter(
	(p) => !SOCIAL_REROLL_PARAMS.includes(p),
);

/** `ui.addAnother` of `social-comment`. */
export const SOCIAL_ADD_ANOTHER = { reroll: SOCIAL_REROLL_PARAMS } as const;

/** The name a variant shows first: TikTok and X the display name, Instagram and YouTube the handle. */
const shownName = Object.fromEntries(
	SOCIAL_VARIANTS.map((v) => [v, VARIANT_CAPABILITIES[v].displayName ? 'displayName' : 'handle']),
) as Record<string, string>;
/** What a "Username" means per variant: the handle where the card draws one, else (TikTok) the nickname. */
const userName = Object.fromEntries(
	SOCIAL_VARIANTS.map((v) => [v, VARIANT_CAPABILITIES[v].handle ? 'handle' : 'displayName']),
) as Record<string, string>;

const REMOTE_IMAGES =
	'Pictures from web addresses are not imported: import the picture into the project, then choose it in Properties ▸ Author ▸ Avatar (or give an avatar column with {"mediaId": "…"}).';

/**
 * `ui.import` of `social-comment`: tokcomment's `User` / `Username` / `Comment` / `Verified`, store-review exports'
 * `Stars` / `Review title` / `Review date` / `Review`, and other common spreadsheet headers. Param names and Properties labels (`Display Name`, `Comment`, `Style`, …) match without
 * aliases; `Verified` is the param itself (yes / true / 1 / ✓ read as true).
 */
export const SOCIAL_IMPORT_HINTS: MgTemplateImportUi = {
	aliases: {
		User: { byParam: 'variant', map: shownName, otherwise: 'displayName' },
		Username: { byParam: 'variant', map: userName, otherwise: 'handle' },
		'User name': { byParam: 'variant', map: userName, otherwise: 'handle' },
		Name: 'displayName',
		Nickname: 'displayName',
		Author: 'displayName',
		Account: 'handle',
		Message: 'text',
		Body: 'text',
		Content: 'text',
		'Comment text': 'text',
		'Like count': 'likes',
		Hearts: 'likes',
		'Reply count': 'replies',
		Retweets: 'reposts',
		'View count': 'views',
		Type: 'variant',
		Ago: 'timeValue',
		'Time unit': 'timeUnit',
		'Blue check': 'verified',
		Badge: 'verified',
		// store reviews (`Rating`, `Title`, `Date` and `Edited` are the param names themselves)
		Stars: 'rating',
		'Star rating': 'rating',
		Score: 'rating',
		'Review title': 'title',
		Headline: 'title',
		'Review date': 'date',
		'Date posted': 'date',
		'Posted on': 'date',
		Review: 'text',
		'Review text': 'text',
		'Was edited': 'edited',
	},
	ignored: {
		'Image URL': REMOTE_IMAGES,
		'Avatar URL': REMOTE_IMAGES,
		'Profile picture': REMOTE_IMAGES,
		'Profile picture URL': REMOTE_IMAGES,
		'Profile image': REMOTE_IMAGES,
		'Photo URL': REMOTE_IMAGES,
		Image: REMOTE_IMAGES,
		Photo: REMOTE_IMAGES,
		Picture: REMOTE_IMAGES,
	},
	trimPrefix: { handle: '@' },
};
