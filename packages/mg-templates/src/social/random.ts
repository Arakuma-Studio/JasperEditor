// Seeded randomizer for social comments (design 2026-10-25 §7.9 Randomize, §7.10): made-up identities, generated
// avatars, believable stats and `fillSocialParams` for agents and bulk import. Deterministic: the same seed always
// gives the same values (no Math.random, no clock). The word lists are original and made up; any match with a real
// account is coincidental. Distributions: docs/wp-notes/social-comments.md "Social comment core".
import type { z } from 'zod';
import {
	type CalendarDate,
	dateOfDayNumber,
	dayNumber,
	isoDate,
	parseReviewDate,
	SOCIAL_RATING_MAX,
	SOCIAL_RATING_MIN,
} from './review.ts';
import {
	SOCIAL_COUNT_MAX,
	type SocialAvatar,
	type SocialCommentParams,
	socialCommentParamsSchema,
	socialCommentPartialSchema,
	socialDefaults,
} from './schema.ts';
import {
	SOCIAL_PARAM_NAMES,
	type SocialParamName,
	type SocialPlatform,
	type SocialTimeUnit,
	type SocialVariant,
	VARIANT_CAPABILITIES,
	VARIANT_PLATFORM,
} from './variants.ts';

// ---------------------------------------------------------------------------------------------------------------
// PRNG

/** Folds any number (fractions, negatives, huge values; non-finite → 0) into a 32-bit seed. */
function seed32(seed: number): number {
	const s = typeof seed === 'number' && Number.isFinite(seed) ? seed : 0;
	const int = Math.floor(s);
	const lo = int >>> 0;
	const hi = Math.floor(int / 0x1_0000_0000) >>> 0;
	const frac = Math.floor((s - int) * 0x1_0000_0000) >>> 0;
	return mix(mix(lo ^ 0x9e37_79b9) ^ hi ^ mix(frac + 0x85eb_ca6b));
}

/** murmur3 finalizer. */
function mix(h: number): number {
	h = Math.imul(h ^ (h >>> 16), 0x85eb_ca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2_ae35);
	return (h ^ (h >>> 16)) >>> 0;
}

type Rng = {
	/** Uniform in [0, 1). */
	next(): number;
	/** Uniform integer in [min, max] (inclusive). */
	int(min: number, max: number): number;
	pick<T>(items: readonly T[]): T;
	/** True with probability `p`. */
	chance(p: number): boolean;
	/** A key of `weights`, chosen in proportion to its weight. */
	weighted<K extends string>(weights: Readonly<Record<K, number>>): K;
};

/** mulberry32 over the seed and a stream salt (independent streams for identity, avatar and stats). */
function rng(seed: number, salt: number): Rng {
	let state = mix(seed32(seed) ^ mix(salt));
	const next = () => {
		state = (state + 0x6d2b_79f5) | 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
	};
	const r: Rng = {
		next,
		int: (min, max) => min + Math.floor(next() * (max - min + 1)),
		pick: (items) => items[Math.floor(next() * items.length)]!,
		chance: (p) => next() < p,
		weighted: (weights) => {
			const entries = Object.entries(weights) as [keyof typeof weights, number][];
			const total = entries.reduce((sum, [, w]) => sum + w, 0);
			let x = next() * total;
			for (const [k, w] of entries) {
				x -= w;
				if (x < 0) return k;
			}
			return entries[entries.length - 1]![0];
		},
	};
	return r;
}

const SALT_IDENTITY = 0x1d3a;
const SALT_AVATAR = 0xa7a7;
const SALT_STATS = 0x57a7;
const SALT_FILL = 0xf111;
const SALT_REVIEW = 0x5eb1;

// ---------------------------------------------------------------------------------------------------------------
// Identity

// Given names from many languages and of every gender, Latin script (handles are derived from them).
const FIRST_NAMES = [
	'Luna',
	'Jake',
	'Maya',
	'Leo',
	'Aisha',
	'Mateo',
	'Sofia',
	'Kenji',
	'Amara',
	'Noah',
	'Priya',
	'Diego',
	'Chloe',
	'Omar',
	'Hana',
	'Elijah',
	'Zoe',
	'Rafael',
	'Ines',
	'Kofi',
	'Mei',
	'Lucas',
	'Nadia',
	'Theo',
	'Yara',
	'Arjun',
	'Freya',
	'Malik',
	'Camila',
	'Sven',
	'Leila',
	'Tomas',
	'Aiko',
	'Jonah',
	'Zara',
	'Emeka',
	'Olivia',
	'Ravi',
	'Lena',
	'Mason',
	'Ayla',
	'Kai',
	'Nora',
	'Santiago',
	'Imani',
	'Finn',
	'Sana',
	'Hugo',
	'Aria',
	'Tariq',
	'Elena',
	'Jun',
	'Mila',
	'Dante',
	'Keira',
	'Ibrahim',
	'Rosa',
	'Felix',
	'Nia',
	'Hiro',
	'Clara',
	'Andre',
	'Yasmin',
	'Oscar',
	'Lucia',
	'Bilal',
	'Ruby',
	'Ezra',
	'Anya',
	'Kwame',
	'Jade',
	'Pablo',
	'Emma',
	'Soren',
	'Lina',
	'Marcus',
	'Ivy',
	'Daniel',
	'Selin',
	'Tyler',
	'Naomi',
	'Vikram',
	'Ella',
	'Bruno',
	'Fatima',
	'Liam',
	'Valentina',
	'Wen',
	'Grace',
	'Rohan',
	'Sasha',
	'Miguel',
	'Esther',
	'Jamal',
	'Lea',
	'Nico',
	'Alma',
	'Kian',
	'June',
	'Rami',
] as const;

const LAST_NAMES = [
	'Park',
	'Rivera',
	'Okafor',
	'Tanaka',
	'Haddad',
	'Novak',
	'Mendes',
	'Larsen',
	'Kaur',
	'Moreau',
	'Bianchi',
	'Nguyen',
	'Adeyemi',
	'Kowalski',
	'Silva',
	'Ito',
	'Brooks',
	'Fischer',
	'Castillo',
	'Mensah',
	'Rossi',
	'Kim',
	'Dubois',
	'Herrera',
	'Osei',
	'Petrov',
	'Sato',
	'Jensen',
	'Costa',
	'Ali',
	'Murphy',
	'Lopez',
	'Hoang',
	'Varga',
	'Ward',
	'Nakamura',
	'Duarte',
	'Sharma',
	'Bauer',
	'Reyes',
	'Abara',
	'Lindqvist',
	'Moretti',
	'Chen',
	'Diallo',
	'Hughes',
	'Marin',
	'Yilmaz',
	'Torres',
	'Quinn',
	'Romero',
	'Akhtar',
	'Berg',
	'Flores',
	'Wright',
	'Ortega',
	'Mori',
	'Santos',
	'Nowak',
	'Bell',
	'Vega',
	'Iyer',
	'Fontaine',
	'Okoro',
	'Hale',
	'Cruz',
	'Lund',
	'Navarro',
] as const;

// Handle words: what the account "does" and what it is about.
const VERBS = [
	'makes',
	'rides',
	'cooks',
	'draws',
	'codes',
	'runs',
	'bakes',
	'sings',
	'reads',
	'lifts',
	'films',
	'paints',
	'plays',
	'builds',
	'travels',
	'skates',
	'dances',
	'writes',
	'shoots',
	'grows',
	'knits',
	'climbs',
	'surfs',
	'hikes',
] as const;
const NOUNS = [
	'art',
	'eats',
	'vibes',
	'studio',
	'daily',
	'fit',
	'films',
	'plants',
	'beats',
	'books',
	'cafe',
	'clips',
	'diary',
	'kitchen',
	'lab',
	'life',
	'moves',
	'notes',
	'photo',
	'reels',
	'tales',
	'tech',
	'trips',
	'world',
	'gaming',
	'sketch',
] as const;
const NAME_EMOJI = ['✨', '🌸', '🔥', '🌙', '🎧', '🌿', '☕', '🎨', '⚡', '🌊'] as const;

/** Max handle length: X's 15-character limit, so every generated handle suits every variant. */
const HANDLE_LIMIT = 15;

export type SocialIdentity = {
	displayName: string;
	handle: string;
	/** The generated avatar that goes with this identity. */
	avatar: { generated: number };
};

/** Lower-case ASCII letters and digits of a name ("Zoë" → "zoe", "Søren" → "soren"). */
function slug(s: string): string {
	return s
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.replace(/ø/giu, 'o')
		.replace(/æ/giu, 'ae')
		.replace(/ß/gu, 'ss')
		.replace(/[łŁ]/gu, 'l')
		.toLowerCase()
		.replace(/[^a-z0-9]/gu, '');
}

/** A handle in one of several common styles from name parts (each part already a non-empty slug). */
function makeHandle(r: Rng, first: string, last: string): string {
	const two = () => String(r.int(1, 99));
	const year = () => String(r.int(0, 9)) + String(r.int(0, 9));
	const styles = [
		() => `${first}.${r.pick(VERBS)}`, // luna.makes
		() => `${first}_${r.pick(VERBS)}${two()}`, // jake_rides22
		() => `${first}${last}`, // lunapark
		() => `${first}.${last}`, // luna.park
		() => `${first}_${last}${year()}`, // luna_park07
		() => `its${first}${r.pick(['x', 'xo', '_', ''])}`, // itsluna
		() => `${r.pick(NOUNS)}.by.${first}`, // art.by.luna
		() => `${first}${last[0]}${two()}`, // lunap42
		() => `the.${first}.${r.pick(NOUNS)}`, // the.luna.eats
		() => `${first}${r.pick(NOUNS)}`, // lunavibes
	];
	const handle = r.pick(styles)();
	if (handle.length <= HANDLE_LIMIT && !/[._]$/u.test(handle)) return handle;
	const short = `${first.slice(0, HANDLE_LIMIT - 2)}${two()}`;
	return short.slice(0, HANDLE_LIMIT);
}

function makeDisplayName(r: Rng, first: string, last: string): string {
	const style = r.weighted({ full: 55, first: 14, initial: 10, lower: 8, emoji: 8, firstEmoji: 5 });
	switch (style) {
		case 'full':
			return `${first} ${last}`;
		case 'first':
			return first;
		case 'initial':
			return `${first} ${last[0]}.`;
		case 'lower':
			return `${first} ${last}`.toLowerCase();
		case 'emoji':
			return `${first} ${last} ${r.pick(NAME_EMOJI)}`;
		case 'firstEmoji':
			return `${first} ${r.pick(NAME_EMOJI)}`;
	}
}

/**
 * A made-up identity: display name and handle built from the same name parts (so "Luna Park" pairs with
 * "luna.makes" or "lunapark"), plus a generated avatar seed. Handles fit every platform (≤ 15 characters of
 * lower-case letters, digits, "." and "_").
 */
export function randomIdentity(seed: number): SocialIdentity {
	const r = rng(seed, SALT_IDENTITY);
	const first = r.pick(FIRST_NAMES);
	const last = r.pick(LAST_NAMES);
	return {
		displayName: makeDisplayName(r, first, last),
		handle: makeHandle(r, slug(first), slug(last)),
		avatar: { generated: seed32(seed) },
	};
}

/** Name words usable for a handle: the Latin-letter slugs of `displayName`'s words. */
function nameParts(displayName: string): string[] {
	return displayName
		.split(/\s+/u)
		.map(slug)
		.filter((w) => /[a-z]/u.test(w));
}

/** A handle that goes with an existing display name (falls back to a random identity's handle). */
function handleForName(displayName: string, seed: number): string {
	const parts = nameParts(displayName);
	const r = rng(seed, SALT_IDENTITY ^ 0x5151);
	if (parts.length === 0) return randomIdentity(seed).handle;
	const first = parts[0]!.slice(0, 10);
	const last = (parts[1] ?? r.pick(NOUNS)).slice(0, 10);
	return makeHandle(r, first, last);
}

/** Handle words that are not part of a name ("art.by.luna", "itsluna", "the.luna.eats"). */
const HANDLE_FILLERS = new Set<string>([
	...VERBS,
	...NOUNS,
	'its',
	'the',
	'by',
	'with',
	'and',
	'of',
	'real',
	'official',
	'x',
	'xo',
]);

/** A display name that goes with an existing handle: its letter runs, capitalised ("luna.makes" → "Luna"). */
function nameForHandle(handle: string, seed: number): string {
	const words = handle
		.split(/[._\-\d]+/u)
		.filter((w) => /\p{L}/u.test(w) && !HANDLE_FILLERS.has(w.toLowerCase()));
	if (words.length === 0) return randomIdentity(seed).displayName;
	return words
		.slice(0, 2)
		.map((w) => w[0]!.toUpperCase() + w.slice(1))
		.join(' ')
		.slice(0, 64);
}

// ---------------------------------------------------------------------------------------------------------------
// Generated avatar

export type GeneratedAvatar = {
	/** `initials`: up to two letters on the gradient; `silhouette`: a generic head-and-shoulders figure. */
	style: 'initials' | 'silhouette';
	/** Linear gradient: `from` → `to` along `angleDeg` (CSS convention: 0 = to top, 90 = to right). */
	background: { from: string; to: string; angleDeg: number };
	/** Colour of the initials or the silhouette (white or a dark ink, whichever reads on the gradient). */
	foreground: string;
	/** Upper-case initials ('' for `silhouette`). */
	initials: string;
};

// Gradient pairs (sRGB hex), chosen to read well at avatar size in light and dark themes.
const GRADIENTS = [
	['#FF7A59', '#FFB15C'],
	['#7F5AF0', '#2CB1BC'],
	['#00B4D8', '#0077B6'],
	['#F72585', '#7209B7'],
	['#43AA8B', '#90BE6D'],
	['#F9C74F', '#F8961E'],
	['#4361EE', '#4CC9F0'],
	['#E63946', '#F4A261'],
	['#2A9D8F', '#264653'],
	['#B5179E', '#F15BB5'],
	['#06D6A0', '#118AB2'],
	['#FFD166', '#EF476F'],
	['#8338EC', '#3A86FF'],
	['#FB5607', '#FF006E'],
	['#A3C4BC', '#5E8B7E'],
	['#CDB4DB', '#A2D2FF'],
] as const;

const INK_LIGHT = '#FFFFFF';
const INK_DARK = '#1F2430';

/** WCAG relative luminance of "#RRGGBB". */
function luminance(hex: string): number {
	const ch = (i: number) => {
		const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
}

/** Up to two initials: the first letter of the first two words that start with a letter. */
function initialsOf(name: string): string {
	const out: string[] = [];
	for (const word of name.split(/\s+/u)) {
		const first = [...word][0];
		if (first && /\p{L}/u.test(first)) out.push(first.toUpperCase());
		if (out.length === 2) break;
	}
	return out.join('');
}

/**
 * The look of a `{ generated: seed }` avatar, for the template to draw: a two-colour gradient with the initials of
 * `name` (or of `randomIdentity(seed)` when no name is given) or a silhouette. Pure: same inputs, same avatar.
 */
export function generatedAvatar(seed: number, name?: string): GeneratedAvatar {
	const r = rng(seed, SALT_AVATAR);
	const [from, to] = r.pick(GRADIENTS);
	const angleDeg = r.pick([45, 90, 135, 180, 225]);
	const mean = (luminance(from) + luminance(to)) / 2;
	// Contrast against white (L=1) vs the dark ink: pick whichever is larger for the gradient's mean.
	const dark = luminance(INK_DARK);
	const foreground = 1.05 / (mean + 0.05) >= (mean + 0.05) / (dark + 0.05) ? INK_LIGHT : INK_DARK;
	const initials = initialsOf(
		typeof name === 'string' && name.trim() ? name : randomIdentity(seed).displayName,
	);
	const style = initials && r.chance(0.7) ? 'initials' : 'silhouette';
	return {
		style,
		background: { from, to, angleDeg },
		foreground,
		initials: style === 'initials' ? initials : '',
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Stats

export type SocialStats = Pick<
	SocialCommentParams,
	'timeValue' | 'timeUnit' | 'likes' | 'replies' | 'reposts' | 'views' | 'rating' | 'date'
>;

/** How old comments tend to look per platform (relative weights) — an estimate, see the work note. */
const TIME_WEIGHTS: Readonly<Record<SocialPlatform, Readonly<Record<SocialTimeUnit, number>>>> = {
	tiktok: { minute: 10, hour: 25, day: 30, week: 25, month: 7, year: 3 },
	instagram: { minute: 10, hour: 25, day: 30, week: 35, month: 0, year: 0 },
	youtube: { minute: 5, hour: 15, day: 20, week: 20, month: 25, year: 15 },
	x: { minute: 20, hour: 50, day: 20, week: 5, month: 3, year: 2 },
	// store reviews take their age from the drawn review date (`reviewAge`); these weights are not used for them
	'play-store': { minute: 0, hour: 5, day: 25, week: 25, month: 30, year: 15 },
	'app-store': { minute: 0, hour: 5, day: 25, week: 25, month: 30, year: 15 },
};
/** Value range per unit (Instagram counts weeks past a month: "56w"). */
const TIME_RANGE: Readonly<Record<SocialTimeUnit, readonly [number, number]>> = {
	minute: [1, 59],
	hour: [1, 23],
	day: [1, 6],
	week: [1, 4],
	month: [1, 11],
	year: [1, 8],
};

/**
 * Believable stats with tokcomment's distribution: likes 40 % in 1–500, 30 % in 500–10k, 20 % in 10k–100k, 10 % in
 * 100k–5M (uniform within the band); replies 1–5 % of likes; reposts 10–30 % and views 10–50× likes (used by X;
 * filled for every variant so a switch to X stays plausible); a plausible posting age for the platform. Store
 * reviews also get a star rating (J-shaped like real stores, `randomRating`) and a review date within two years
 * before `SOCIAL_REVIEW_DATE_ANCHOR` (`randomReviewDate`); their age (`timeValue` / `timeUnit`, the iPhone card's
 * "2d ago") is the date's age. Every variant gets a rating and a date (a switch to a review card stays plausible).
 */
export function randomStats(variant: SocialVariant, seed: number): SocialStats {
	return statsFor(variant, seed);
}

// ---------------------------------------------------------------------------------------------------------------
// Store reviews

/**
 * The fixed "today" review dates are drawn back from (no wall clock: the same seed gives the same date on every
 * machine and day). The date this feature was built.
 */
export const SOCIAL_REVIEW_DATE_ANCHOR = '2026-10-25';
/** Reviews are drawn at most this many days before the anchor (about two years). */
export const SOCIAL_REVIEW_MAX_AGE_DAYS = 730;

/**
 * Star shares of drawn ratings, 1★…5★ [E]: the J-shaped distribution of online and app-store ratings (many 5★, some
 * 1★, few in between; Hu, Pavlou & Zhang, "Overcoming the J-shaped distribution of product reviews", CACM 52(10),
 * 2009), with the high average of popular apps (≈ 4.1 here).
 */
export const SOCIAL_RATING_WEIGHTS: Readonly<Record<'1' | '2' | '3' | '4' | '5', number>> = {
	'1': 13,
	'2': 5,
	'3': 8,
	'4': 18,
	'5': 56,
};

/** A believable star rating 1–5 for `seed` (`SOCIAL_RATING_WEIGHTS`). */
export function randomRating(seed: number): number {
	return Number(rng(seed, SALT_REVIEW).weighted(SOCIAL_RATING_WEIGHTS));
}

const ANCHOR_DAY = dayNumber(parseReviewDate(SOCIAL_REVIEW_DATE_ANCHOR) as CalendarDate);

/**
 * Days before the anchor of a drawn review: recent reviews are likelier (stores list the newest first and a video
 * usually shows recent ones), so the age is `730 · u²` days for a uniform `u` (half of them within the last six months).
 */
function reviewDaysAgo(r: Rng): number {
	const u = r.next();
	return Math.min(SOCIAL_REVIEW_MAX_AGE_DAYS, Math.floor(SOCIAL_REVIEW_MAX_AGE_DAYS * u * u));
}

/** A review date (ISO `YYYY-MM-DD`) within two years before `SOCIAL_REVIEW_DATE_ANCHOR`, for `seed`. */
export function randomReviewDate(seed: number): string {
	const r = rng(seed, SALT_REVIEW);
	r.next(); // the rating's draw: the same seed gives the rating and the date of one review
	return isoDate(dateOfDayNumber(ANCHOR_DAY - reviewDaysAgo(r)));
}

/**
 * The relative age of a review written `daysAgo` days before the anchor, as `timeValue` + `timeUnit` (the iPhone
 * App Store card's "3h ago", "2d ago", "3w ago", "5mo ago", "1y ago"): hours on the day itself (`hour` drawn by the
 * caller), then days below a week, weeks below a month (30 days), months below a year (365 days), then whole years.
 */
export function reviewAge(daysAgo: number, hours = 1): Pick<SocialCommentParams, 'timeValue' | 'timeUnit'> {
	const d = Math.max(0, Math.floor(Number.isFinite(daysAgo) ? daysAgo : 0));
	if (d === 0) return { timeValue: Math.min(23, Math.max(1, Math.floor(hours))), timeUnit: 'hour' };
	if (d < 7) return { timeValue: d, timeUnit: 'day' };
	if (d < 30) return { timeValue: Math.floor(d / 7), timeUnit: 'week' };
	if (d < 365) return { timeValue: Math.floor(d / 30), timeUnit: 'month' };
	return { timeValue: Math.floor(d / 365), timeUnit: 'year' };
}

/** Days a relative age spans (the inverse of `reviewAge`, at the start of its unit). */
function ageDays(value: number, unit: SocialTimeUnit): number {
	const v = Math.max(0, Math.floor(value));
	switch (unit) {
		case 'minute':
		case 'hour':
			return 0;
		case 'day':
			return v;
		case 'week':
			return v * 7;
		case 'month':
			return v * 30;
		case 'year':
			return v * 365;
	}
}

/** Days between a review date and the anchor (0 for a date on or after it, or an invalid one). */
function daysBeforeAnchor(iso: string): number {
	const d = parseReviewDate(iso);
	return d ? Math.max(0, ANCHOR_DAY - dayNumber(d)) : 0;
}

/** The ISO date `days` before the anchor (never before the schema's earliest year). */
function dateDaysBeforeAnchor(days: number): string {
	const d = dateOfDayNumber(ANCHOR_DAY - Math.max(0, Math.floor(days)));
	return d.year < 1970 ? '1970-01-01' : isoDate(d);
}

// Made-up review titles by rating (short, generic, as on the stores); any match with a real review is coincidental.
const REVIEW_TITLES: Readonly<Record<number, readonly string[]>> = {
	5: [
		'Love it!',
		'Best app I’ve tried',
		'Five stars',
		'Game changer',
		'Exactly what I needed',
		'So easy to use',
		'Highly recommend',
		'Worth every penny',
		'Use it every day',
		'Just works',
		'Amazing update',
		'Perfect 👌',
	],
	4: [
		'Really good',
		'Great so far',
		'Almost perfect',
		'Solid app',
		'Very useful',
		'Good, a few bugs',
		'Does the job',
		'Nice update',
		'Pretty great',
	],
	3: ['It’s okay', 'Decent, but…', 'Needs work', 'Mixed feelings', 'Good idea, buggy app', 'Fine for now'],
	2: ['Disappointed', 'Not what I expected', 'Too many ads', 'Getting worse', 'Keeps logging me out'],
	1: [
		'Keeps crashing',
		'Don’t bother',
		'Worst update yet',
		'Broken after the update',
		'Unusable',
		'Waste of money',
	],
};

/** A plausible review title for a rating (1–5) and seed. */
export function randomReviewTitle(rating: number, seed: number): string {
	const stars = Math.min(SOCIAL_RATING_MAX, Math.max(SOCIAL_RATING_MIN, Math.round(Number(rating) || 5)));
	return rng(seed, SALT_REVIEW ^ 0x7171).pick(REVIEW_TITLES[stars]!);
}

/** `randomStats`, optionally around given likes (replies, reposts and views then scale with them). */
function statsFor(variant: SocialVariant, seed: number, givenLikes?: number): SocialStats {
	const r = rng(seed, SALT_STATS);
	const band = r.weighted({ a: 40, b: 30, c: 20, d: 10 });
	const [lo, hi] = LIKE_BANDS[band];
	const drawn = r.int(lo, hi);
	const likes = givenLikes ?? drawn;
	const share = (min: number, max: number) =>
		Math.min(SOCIAL_COUNT_MAX, Math.round(likes * (min + r.next() * (max - min))));
	const replies = share(0.01, 0.05);
	const reposts = share(0.1, 0.3);
	const views = share(10, 50);
	const platform = VARIANT_PLATFORM[variant] ?? 'tiktok';
	const timeUnit = r.weighted(TIME_WEIGHTS[platform]);
	const [tmin, tmax] = platform === 'instagram' && timeUnit === 'week' ? [1, 60] : TIME_RANGE[timeUnit];
	const timeValue = r.int(tmin, tmax);
	// the review stream (separate, so the comment stats above stay what they were before store reviews existed)
	const rv = rng(seed, SALT_REVIEW);
	const rating = Number(rv.weighted(SOCIAL_RATING_WEIGHTS));
	const daysAgo = reviewDaysAgo(rv);
	const date = isoDate(dateOfDayNumber(ANCHOR_DAY - daysAgo));
	// a review card's age is its date's age (the iPhone card shows it)
	const age = VARIANT_CAPABILITIES[variant]?.rating
		? reviewAge(daysAgo, rv.int(1, 23))
		: { timeValue, timeUnit };
	return { ...age, likes, replies, reposts, views, rating, date };
}

const LIKE_BANDS = {
	a: [1, 500],
	b: [500, 10_000],
	c: [10_000, 100_000],
	d: [100_000, 5_000_000],
} as const satisfies Record<string, readonly [number, number]>;

// ---------------------------------------------------------------------------------------------------------------
// Fill

export type SocialFillResult =
	| {
			ok: true;
			/** Fully resolved params (they parse with `socialCommentParamsSchema`). */
			params: SocialCommentParams;
			/** The params that were omitted and filled, in `SOCIAL_PARAM_NAMES` order. */
			filled: SocialParamName[];
	  }
	| { ok: false; error: string; issues: z.core.$ZodIssue[] };

/**
 * Validates partial params (an agent call, a CSV row) and fills ONLY the omitted fields: identity (display name,
 * handle, generated avatar) and stats from the seed, everything else from `socialDefaults(variant)` (variant itself
 * defaults to `tiktok-reply`). A given display name gets a matching handle and vice versa. Store reviews also get a
 * rating, a date (agreeing with a given age, and the age with a given date) and, on the App Store cards, a title
 * that suits the rating. Provided values are kept as they are. Invalid input returns `{ ok: false }` with zod
 * issues; never throws.
 */
export function fillSocialParams(partial: unknown, seed: number): SocialFillResult {
	const parsed = socialCommentPartialSchema.safeParse(partial ?? {});
	if (!parsed.success) {
		const error = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
		return { ok: false, error, issues: parsed.error.issues };
	}
	// An explicit `undefined` counts as omitted.
	const given = Object.fromEntries(
		Object.entries(parsed.data).filter(([, v]) => v !== undefined),
	) as Partial<SocialCommentParams>;
	const variant: SocialVariant = given.variant ?? 'tiktok-reply';
	const base = socialDefaults(variant);
	const s = rng(seed, SALT_FILL).int(0, 0xffff_ffff);
	const identity = randomIdentity(s);
	const stats: { -readonly [K in keyof SocialStats]: SocialStats[K] } = { ...statsFor(variant, s, given.likes) };
	// store reviews: a given date gives the age and a given age the date, so the two agree; the title suits the rating
	if (VARIANT_CAPABILITIES[variant]?.rating) {
		const timeGiven = given.timeValue !== undefined || given.timeUnit !== undefined;
		if (given.date !== undefined && !timeGiven)
			Object.assign(stats, reviewAge(daysBeforeAnchor(given.date), stats.timeValue));
		if (given.date === undefined && timeGiven)
			stats.date = dateDaysBeforeAnchor(
				ageDays(given.timeValue ?? stats.timeValue, given.timeUnit ?? stats.timeUnit),
			);
	}
	const rating = given.rating ?? stats.rating;
	// filled for every variant (like reposts and views) so a switch to an App Store card stays plausible
	const title = randomReviewTitle(rating, s);
	const displayName =
		given.displayName ?? (given.handle !== undefined ? nameForHandle(given.handle, s) : identity.displayName);
	const handle =
		given.handle ?? (given.displayName !== undefined ? handleForName(given.displayName, s) : identity.handle);
	const avatar: SocialAvatar = given.avatar !== undefined ? given.avatar : identity.avatar;
	const candidate: SocialCommentParams = {
		...base,
		...stats,
		title,
		displayName,
		handle,
		avatar,
		...given,
		variant,
	};
	const full = socialCommentParamsSchema.safeParse(candidate);
	if (!full.success) {
		const error = full.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
		return { ok: false, error, issues: full.error.issues };
	}
	const filled = SOCIAL_PARAM_NAMES.filter((k) => given[k] === undefined);
	return { ok: true, params: full.data as SocialCommentParams, filled };
}
