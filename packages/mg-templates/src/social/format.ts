// Per-platform number, time and replies formatting for social-comment cards (design 2026-10-25 §7.4). Pure,
// deterministic and locale-independent: no `Intl` (its output differs between the preview browser and the render
// Chrome). Rules and their sources: docs/wp-notes/social-comments.md "Social comment core".
import {
	SOCIAL_TIME_UNITS,
	type SocialCountField,
	type SocialPlatform,
	type SocialTimeUnit,
	type SocialVariant,
	VARIANT_CAPABILITIES,
	VARIANT_PLATFORM,
} from './variants.ts';

const platformOf = (variant: SocialVariant): SocialPlatform => VARIANT_PLATFORM[variant] ?? 'tiktok';

/** A displayable count: non-finite or negative → 0, fractions dropped, capped at the largest safe integer. */
function toCount(n: unknown): number {
	if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0;
	return Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER);
}

/** "1,234,567" (integers ≥ 0). */
function grouped(n: number): string {
	const digits = String(n);
	let out = '';
	for (let i = 0; i < digits.length; i++) {
		if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
		out += digits[i];
	}
	return out;
}

const UNITS = [
	{ size: 1e9, suffix: 'B' },
	{ size: 1e6, suffix: 'M' },
	{ size: 1e3, suffix: 'K' },
] as const;

/**
 * Abbreviates `n` (≥ 1000) as K/M/B, truncated (never rounded up: 1,299 → "1.2K", 999,999 → "999.9K"), with one
 * decimal while the whole part is below `decimalsBelow` and ".0" dropped. Exact integer arithmetic.
 */
function abbreviated(n: number, decimalsBelow: number): string {
	const unit = UNITS.find((u) => n >= u.size) ?? UNITS[UNITS.length - 1];
	const tenth = unit.size / 10;
	const tenths = (n - (n % tenth)) / tenth;
	const whole = Math.floor(tenths / 10);
	const decimal = tenths % 10;
	const head = grouped(whole);
	return whole < decimalsBelow && decimal !== 0
		? `${head}.${decimal}${unit.suffix}`
		: `${head}${unit.suffix}`;
}

/**
 * A count as the platform shows it. `field` names which count it is (likes, replies, reposts, views); every
 * platform formats all of them alike today.
 * - TikTok, Instagram: exact and comma-grouped below 10,000 ("1,393"), then K/M/B with one decimal ("12.3K").
 * - YouTube: exact below 1,000, then one decimal only below 10 of a unit ("1.2K", "12K", "123K", "1.2M").
 * - X: exact below 1,000, then K/M/B with one decimal ("1.2K", "12.3K", "123.4K").
 * Abbreviations truncate and drop ".0". Never throws; invalid input formats as 0.
 */
export function formatCount(variant: SocialVariant, n: number, _field: SocialCountField = 'likes'): string {
	const c = toCount(n);
	switch (platformOf(variant)) {
		case 'tiktok':
		case 'instagram':
			return c < 10_000 ? grouped(c) : abbreviated(c, 1000);
		case 'youtube':
			return c < 1000 ? String(c) : abbreviated(c, 10);
		case 'x':
			return c < 1000 ? String(c) : abbreviated(c, 1000);
		// store reviews draw no counts (Play's "N people found this review helpful" is left out); grouped like Play
		case 'play-store':
		case 'app-store':
			return grouped(c);
	}
}

const COMPACT: Readonly<Record<SocialTimeUnit, string>> = {
	minute: 'm',
	hour: 'h',
	day: 'd',
	week: 'w',
	month: 'mo',
	year: 'y',
};

/** "Posted just now" per platform (value 0). */
const NOW: Readonly<Record<SocialPlatform, string>> = {
	tiktok: 'Just now',
	instagram: 'now',
	youtube: 'Just now',
	x: 'now',
	'play-store': 'now',
	// the iPhone App Store's TIME_AGO_JUST_NOW
	'app-store': 'Just now',
};

/**
 * How long ago a comment was posted, as the platform shows it: compact "3m", "3h", "3d", "3w", "3mo", "3y" on
 * TikTok, Instagram and X; "1 minute ago", "10 months ago" on YouTube; the iPhone App Store's "3h ago", "2d ago",
 * "3w ago", "4mo ago", "1y ago" ("Just now" under an hour) on App Store reviews. 0 shows "Just now" (TikTok, YouTube,
 * App Store) or "now" (Instagram, X). `value` is floored and clamped to 0…10000; an unknown unit reads as days. Never throws.
 */
export function formatTime(variant: SocialVariant, value: number, unit: SocialTimeUnit): string {
	const v = Math.min(10_000, toCount(value));
	const u: SocialTimeUnit = (SOCIAL_TIME_UNITS as readonly string[]).includes(unit) ? unit : 'day';
	const platform = platformOf(variant);
	if (v === 0) return NOW[platform];
	if (platform === 'youtube') return `${v} ${u}${v === 1 ? '' : 's'} ago`;
	// the iPhone App Store's review age (TIME_AGO_*_AGO of iOS 15–26: no minutes label, so under an hour is "Just now")
	if (platform === 'app-store') return u === 'minute' ? NOW[platform] : `${v}${COMPACT[u]} ago`;
	return `${v}${COMPACT[u]}`;
}

/**
 * The replies line under a comment, or '' when the card shows none (0 replies, or a variant without a replies row:
 * TikTok reply, Reels and Shorts reply cards, and X, whose reply count sits by its icon — use `formatCount`).
 * TikTok "View 2 replies" / "View 1 reply"; Instagram "View 5 more replies" / "View 1 more reply"; YouTube
 * "2 replies" / "1 reply". The number uses the platform's count format ("View 1.2K replies").
 */
export function formatRepliesLabel(variant: SocialVariant, n: number): string {
	const c = toCount(n);
	if (c === 0 || !VARIANT_CAPABILITIES[variant]?.replies) return '';
	const word = c === 1 ? 'reply' : 'replies';
	const num = formatCount(variant, c, 'replies');
	switch (platformOf(variant)) {
		case 'tiktok':
			return `View ${num} ${word}`;
		case 'instagram':
			return `View ${num} more ${word}`;
		case 'youtube':
			return `${num} ${word}`;
		case 'x':
		case 'play-store':
		case 'app-store':
			return '';
	}
}

/**
 * The age of an iPhone App Store review as its card prints it: `formatTime` ("2d ago", "1y ago", "Just now") with the
 * "edited " prefix of an edited review ("edited 1y ago"; under an hour "edited just now"). Strings of the App Store
 * frameworks of iOS 15–26 (TIME_AGO_*, TIME_AGO_EDITED_TIME, TIME_AGO_EDITED_JUST_NOW). Never throws.
 */
export function formatReviewAge(value: number, unit: SocialTimeUnit, edited: boolean): string {
	const age = formatTime('app-store-review-ios', value, unit);
	if (!edited) return age;
	return age === NOW['app-store'] ? 'edited just now' : `edited ${age}`;
}
