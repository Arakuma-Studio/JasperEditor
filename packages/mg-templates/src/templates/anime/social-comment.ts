// social-comment@1 (social-comment design 2026-10-25 §7.1–7.6): a comment card that looks like a platform
// screenshot (TikTok, Instagram, YouTube, X — one template, `variant` param) and pops onto the screen. Metadata and the
// pure timing the React implementation (packages/motion/src/templates/social-comment/) and the sound-design motion
// model (`motion.ts`) share: one schedule of tweens per clip, so the cue tests compare the model with the real anime.js
// timeline frame by frame.
//
// Timing (design §7.6, S11:ATP-004): the declared intro is the entrance window (the longest entrance, drop & bounce,
// 550 ms → 17 frames at 30 fps); every entrance is a fixed set of tweens inside it, scaled with it when
// `animeTemplateTiming` compresses it. The extras — words appearing one by one (≈ 90 ms per word) and the like count
// ticking up (≈ 900 ms, then the heart thumps and fills) — start when the entrance ends and must finish before the exit
// starts: on a short clip they compress proportionally into the time left. The exit (≈ 200 ms, scale to 82 % and fade,
// eased in) is the declared outro, anchored at the content end. Outside these windows the card is at rest and shows
// its hold state (S11:ANM-009): every word shown, the final count, the heart filled when it ticked.

import { REMOTE_IMAGE_IDS, type RemoteImageId } from '../../assets.ts';
import { CANVASES } from '../../core.ts';
import { emojiGraphemes } from '../../emoji.ts';
import {
	type CommentSpan,
	fillSocialParams,
	formatCount,
	resolveEmojiStyle,
	SOCIAL_ADD_ANOTHER,
	SOCIAL_IMPORT_HINTS,
	SOCIAL_PARAM_NAMES,
	SOCIAL_VARIANTS,
	type SocialCommentParams,
	type SocialEntrance,
	type SocialParamName,
	type SocialPlatform,
	type SocialVariant,
	socialClipName,
	socialCommentParamsSchema,
	socialDefaults,
	stripMarks,
	tokenizeComment,
	VARIANT_CAPABILITIES,
	VARIANT_PLATFORM,
	variantsWithParam,
} from '../../social/index.ts';
import { segmentText } from '../../text-units.ts';
import type {
	MgAnimeTemplateDefinition,
	MgTemplateFillResult,
	MgTemplateParamUi,
	MgTemplatePreset,
	TemplateRequiredAssets,
} from '../../types.ts';
import { ANIME_REFERENCE_FPS } from './common.ts';
import type { AnimeTween, TemplateTiming } from './motion.ts';

// ------------------------------------------------------------------------------------------------------ timing

/** Declared intro: the entrance window, 17 frames at 30 fps (566.7 ms ≥ the longest entrance, 550 ms). */
export const SOCIAL_COMMENT_INTRO_FRAMES = 17;
/** Declared outro: the exit, 6 frames at 30 fps (200 ms). */
export const SOCIAL_COMMENT_OUTRO_FRAMES = 6;
/** The intro window in ms at its declared length: the entrance tweens below are written in these ms. */
const INTRO_REF_MS = (SOCIAL_COMMENT_INTRO_FRAMES * 1000) / ANIME_REFERENCE_FPS;

/** Entrance lengths (design §7.6). */
export const SOCIAL_ENTRANCE_MS: Readonly<Record<SocialEntrance, number>> = {
	'classic-pop': 270,
	'soft-spring': 450,
	'grow-from-tail': 500,
	'drop-bounce': 550,
};
/** Drop & bounce: the fall, in design px of the stage. */
export const SOCIAL_DROP_PX = 60;
/** Grow from tail: the tilt the card settles from, in degrees. */
export const SOCIAL_GROW_TILT_DEG = -8;
/** Exit: the card shrinks to this scale while it fades out. */
export const SOCIAL_EXIT_SCALE = 0.82;
/** Word reveal: one word every 90 ms, each popping from 50 % to 100 % in 220 ms… */
export const SOCIAL_WORD_STAGGER_MS = 90;
export const SOCIAL_WORD_POP_MS = 220;
/** …and a long comment spreads its words over at most 2.4 s (the stagger shrinks). */
export const SOCIAL_REVEAL_MAX_SPAN_MS = 2400;
/** Like tick: the count rises 0 → final in 900 ms (ease-out), then the heart thumps and fills in 300 ms. */
export const SOCIAL_TICK_MS = 900;
export const SOCIAL_THUMP_MS = 300;
export const SOCIAL_THUMP_SCALE = 1.3;

/** Animated values of the card (target 0): scale, opacity, drop (design px), tilt (degrees). */
export type SocialCardProp = 's' | 'o' | 'y' | 'r';
/** Animated values of a word unit: scale, opacity; of the heart: thump scale, fill (0 outline … 1 filled). */
export type SocialUnitProp = 's' | 'o';
export type SocialHeartProp = 's' | 'f';

/** One animated value of the schedule: target 0 = card, 1…units = word units, 1 + units = heart. */
export type SocialScheduleTrack = { target: number; prop: string; initial: number; tweens: AnimeTween[] };

export type SocialCommentSchedule = {
	tracks: SocialScheduleTrack[];
	/** Word units revealed one by one (0 without word reveal). */
	units: number;
	/** Target index of the heart (when the likes tick), else null. */
	heartTarget: number | null;
	/** The like count tick: progress 0 → 1 from `start` over `dur` (content ms), eased; null without a tick. */
	tick: { start: number; dur: number; ease: string } | null;
	/** Content ms when the entrance ends and when the exit starts. */
	entranceEnd: number;
	exitStart: number;
};

/** What the schedule depends on (the build key of the implementation). */
export type SocialScheduleInput = TemplateTiming & {
	entrance: SocialEntrance;
	/** Word units of the comment when word reveal is on, else 0. */
	units: number;
	/** The like count ticks (the variant shows likes and `likeTick` is on). */
	tick: boolean;
};

type NominalTween = {
	prop: SocialCardProp;
	start: number;
	dur: number;
	from: number;
	to: number;
	ease: string;
};

/** The entrances as tweens in ms of the declared intro window (scaled with it when it is compressed). */
const ENTRANCES: Readonly<Record<SocialEntrance, readonly NominalTween[]>> = {
	// scale 0 → 130 % → 100 %: out to the overshoot, then in-out back (zero speed at the turn)
	'classic-pop': [
		{ prop: 's', start: 0, dur: 150, from: 0, to: 1.3, ease: 'outQuad' },
		{ prop: 's', start: 150, dur: 120, from: 1.3, to: 1, ease: 'inOutQuad' },
		{ prop: 'o', start: 0, dur: 60, from: 0, to: 1, ease: 'linear' },
	],
	// scale 60 % → 100 % with one soft bounce: out to a 3.5 % overshoot, then in-out back to rest (zero speed at the
	// turn and at the end: an underdamped spring's slow tail would keep the card moving below the cue threshold)
	'soft-spring': [
		{ prop: 's', start: 0, dur: 260, from: 0.6, to: 1.035, ease: 'outCubic' },
		{ prop: 's', start: 260, dur: 190, from: 1.035, to: 1, ease: 'inOutQuad' },
		{ prop: 'o', start: 0, dur: 150, from: 0, to: 1, ease: 'out' },
	],
	// grows out of the tail corner (outBack) while the −8° tilt settles on the spring
	'grow-from-tail': [
		{ prop: 's', start: 0, dur: 420, from: 0, to: 1, ease: 'outBack' },
		{ prop: 'r', start: 0, dur: 500, from: SOCIAL_GROW_TILT_DEG, to: 0, ease: 'jasper.spring' },
		{ prop: 'o', start: 0, dur: 100, from: 0, to: 1, ease: 'out' },
	],
	// falls 60 px under gravity and bounces once
	'drop-bounce': [
		{ prop: 'y', start: 0, dur: 550, from: -SOCIAL_DROP_PX, to: 0, ease: 'jasper.dropBounce' },
		{ prop: 'o', start: 0, dur: 165, from: 0, to: 1, ease: 'out' },
	],
};

/** Shortest tween (anime.js 4.5.0 mishandles zero-duration tweens; `ANIME_MIN_TWEEN_MS` of motion.ts). */
const MIN_TWEEN_MS = 1;
const fin = (v: number) => (Number.isFinite(v) ? v : 0);

/**
 * The tweens of one social-comment clip. Card (target 0): the entrance tweens in the intro window, the exit
 * (scale 1 → 0.82 and opacity 1 → 0, eased in) over the outro window. Word units (targets 1…units): scale 0.5 → 1
 * (`outBack`) and opacity 0 → 1 (`out`, half as long), one every 90 ms from the end of the entrance. Heart (target
 * 1 + units): thump 1 → 1.3 → 1 and fill 0 → 1 when the 900 ms count tick ends. The extras keep their nominal
 * lengths unless they would run into the exit; then they compress proportionally into the time left (S11:ATP-004:
 * the time comes from `animeTemplateTiming`). No property is ever driven by two overlapping tweens (S11:ANM-008).
 */
export function socialCommentSchedule(input: SocialScheduleInput): SocialCommentSchedule {
	const introMs = Math.max(0, fin(input.introMs));
	const totalMs = Math.max(0, fin(input.totalMs));
	const outroMs = Math.max(0, fin(input.outroMs));
	const k = introMs / INTRO_REF_MS;
	const byProp = new Map<SocialCardProp, AnimeTween[]>();
	const push = (prop: SocialCardProp, tw: AnimeTween) => {
		const list = byProp.get(prop) ?? [];
		list.push(tw);
		byProp.set(prop, list);
	};
	let entranceEnd = 0;
	for (const tw of ENTRANCES[input.entrance] ?? ENTRANCES['soft-spring']) {
		// a compressed window keeps the tweens of one value in sequence (their 1 ms minimum must not overlap)
		const prev = byProp.get(tw.prop)?.at(-1);
		const start = Math.max(tw.start * k, prev ? prev.start + prev.dur : 0);
		const dur = Math.max(MIN_TWEEN_MS, tw.dur * k);
		push(tw.prop, { start, dur, from: tw.from, to: tw.to, ease: tw.ease });
		entranceEnd = Math.max(entranceEnd, start + dur);
	}
	// the exit: the outro window, never before the entrance has ended
	const exitStart = Math.max(totalMs - outroMs, entranceEnd);
	const exitDur = Math.max(MIN_TWEEN_MS, totalMs - exitStart);
	push('s', { start: exitStart, dur: exitDur, from: 1, to: SOCIAL_EXIT_SCALE, ease: 'in' });
	push('o', { start: exitStart, dur: exitDur, from: 1, to: 0, ease: 'in' });
	const tracks: SocialScheduleTrack[] = [];
	for (const prop of ['s', 'o', 'y', 'r'] as const) {
		const tweens = byProp.get(prop);
		if (tweens) tracks.push({ target: 0, prop, initial: tweens[0]!.from, tweens });
	}

	// extras, from the end of the entrance; compressed when they would reach the exit
	const units = Math.max(0, Math.floor(fin(input.units)));
	const stagger = units > 1 ? Math.min(SOCIAL_WORD_STAGGER_MS, SOCIAL_REVEAL_MAX_SPAN_MS / (units - 1)) : 0;
	const revealSpan = units > 0 ? (units - 1) * stagger + SOCIAL_WORD_POP_MS : 0;
	const tickSpan = input.tick ? SOCIAL_TICK_MS + SOCIAL_THUMP_MS : 0;
	const needed = Math.max(revealSpan, tickSpan);
	const available = Math.max(0, exitStart - entranceEnd);
	const c = needed > available ? available / needed : 1;
	const len = (ms: number) => Math.max(MIN_TWEEN_MS, ms * c);
	/** Start of an extra `ms` after the entrance, moved earlier when its 1 ms minimum would reach the exit. */
	const at = (ms: number, span: number) =>
		Math.max(entranceEnd, Math.min(entranceEnd + ms * c, exitStart - span));
	for (let i = 0; i < units; i++) {
		const dur = len(SOCIAL_WORD_POP_MS);
		const start = at(i * stagger, dur);
		tracks.push(
			{
				target: 1 + i,
				prop: 's',
				initial: 0.5,
				tweens: [{ start, dur, from: 0.5, to: 1, ease: 'outBack' }],
			},
			{
				target: 1 + i,
				prop: 'o',
				initial: 0,
				tweens: [{ start, dur: len(SOCIAL_WORD_POP_MS / 2), from: 0, to: 1, ease: 'out' }],
			},
		);
	}
	let tick: SocialCommentSchedule['tick'] = null;
	let heartTarget: number | null = null;
	if (input.tick) {
		const up = len(SOCIAL_THUMP_MS * 0.4);
		const down = len(SOCIAL_THUMP_MS * 0.6);
		const thump = at(SOCIAL_TICK_MS, up + down);
		// the count runs from the entrance end up to the thump
		tick = { start: entranceEnd, dur: Math.max(MIN_TWEEN_MS, thump - entranceEnd), ease: 'outCubic' };
		heartTarget = 1 + units;
		tracks.push(
			{
				target: heartTarget,
				prop: 's',
				initial: 1,
				tweens: [
					{ start: thump, dur: up, from: 1, to: SOCIAL_THUMP_SCALE, ease: 'out' },
					{ start: thump + up, dur: down, from: SOCIAL_THUMP_SCALE, to: 1, ease: 'inOut' },
				],
			},
			{
				target: heartTarget,
				prop: 'f',
				initial: 0,
				tweens: [{ start: thump, dur: up, from: 0, to: 1, ease: 'out' }],
			},
		);
	}
	return { tracks, units, heartTarget, tick, entranceEnd, exitStart };
}

/** The count shown at tick progress `p` (0…1): exactly 0 and `likes` at the ends, rounded in between. */
export function socialTickCount(likes: number, p: number): number {
	const n = Number.isFinite(likes) && likes > 0 ? Math.floor(likes) : 0;
	if (!(p > 0)) return 0;
	if (p >= 1) return n;
	return Math.min(n, Math.max(0, Math.round(n * p)));
}

/** Stars of a store review card (whole stars filled up to the rating, the rest drawn empty). */
export const SOCIAL_STAR_COUNT = 5;

/**
 * Star fill of a store review card at tick progress `p` (0…1; 1 at rest and without the extra): one value per star
 * (0 empty … 1 filled). The stars up to `rating` fill one after the other as the progress runs (star i fills while
 * `p · rating` goes from i to i + 1), so the "likes tick up" extra fills them one by one on review cards; the stars
 * after the rating stay empty.
 */
export function socialStarFill(rating: number, p: number): number[] {
	const stars = Number.isFinite(rating) ? Math.min(SOCIAL_STAR_COUNT, Math.max(0, Math.round(rating))) : 0;
	const q = p >= 1 ? 1 : p > 0 ? p : 0;
	const filled = q * stars;
	return Array.from({ length: SOCIAL_STAR_COUNT }, (_, i) =>
		i >= stars ? 0 : Math.min(1, Math.max(0, filled - i)),
	);
}

/**
 * What the tick shows at progress `p` as text (the motion model's `textAt`, compared with the card frame by frame):
 * the like count as the variant prints it, or on store reviews how many stars are filled ("2.63/4 stars").
 */
export function socialTickText(
	params: Pick<SocialCommentParams, 'variant' | 'likes' | 'rating'>,
	p: number,
): string {
	if (VARIANT_CAPABILITIES[params.variant]?.rating) {
		const filled = socialStarFill(params.rating, p).reduce((a, b) => a + b, 0);
		return `${(Math.round(filled * 100) / 100).toFixed(2)}/${Math.round(params.rating)} stars`;
	}
	return formatCount(params.variant, socialTickCount(params.likes, p), 'likes');
}

/**
 * Whether a clip's likes tick: the variant draws likes (or, on store reviews, stars that fill one by one) and
 * `likeTick` is on.
 */
export function socialLikesTick(p: Pick<SocialCommentParams, 'variant' | 'likeTick'>): boolean {
	return p.likeTick === true && VARIANT_CAPABILITIES[p.variant]?.likeTick === true;
}

// --------------------------------------------------------------------------------------------- text units

/**
 * One piece of the visible comment text: a whitespace run (`unit` −1, never animated) or a word unit numbered from 0.
 * `start` is the UTF-16 offset in the visible text; `highlight` marks a unit that is entirely one highlighted run
 * (drawn as one pill).
 */
export type SocialTextSegment = { text: string; start: number; unit: number; highlight: boolean };

/**
 * The comment split for drawing and word reveal: the styled spans (`tokenizeComment`: marks, mentions, hashtags) and
 * the word segments (`segmentText`, Intl.Segmenter). Words joined by a highlight run (`==any comment==`) are ONE unit:
 * the pill appears as a whole, like tokcomment merges adjacent highlighted words into one pill. Pure, shared by the
 * renderer and the motion model so both count the same units.
 */
export function socialCommentSegments(
	text: string,
	variant: SocialVariant,
): { spans: CommentSpan[]; segments: SocialTextSegment[]; units: number } {
	const spans = tokenizeComment(text, variant);
	const marks: string[] = [];
	let visible = '';
	for (const sp of spans) {
		visible += sp.text;
		for (let i = 0; i < sp.text.length; i++) marks.push(sp.mark);
	}
	const highlighted = (from: number, to: number) => {
		for (let i = from; i < to; i++) if (marks[i] !== 'highlight') return false;
		return to > from;
	};
	const segments: SocialTextSegment[] = [];
	let offset = 0;
	let units = 0;
	let pendingSpace: SocialTextSegment | null = null;
	for (const seg of segmentText(visible, 'word')) {
		const start = offset;
		offset += seg.text.length;
		if (seg.space) {
			pendingSpace = { text: seg.text, start, unit: -1, highlight: false };
			continue;
		}
		const last = segments[segments.length - 1];
		// join this word to the previous unit when the whitespace between them is inside the same highlight run
		if (
			pendingSpace &&
			last &&
			last.unit >= 0 &&
			last.highlight &&
			highlighted(pendingSpace.start, offset) &&
			highlighted(start, offset)
		) {
			last.text += pendingSpace.text + seg.text;
			pendingSpace = null;
			continue;
		}
		if (pendingSpace) segments.push(pendingSpace);
		pendingSpace = null;
		segments.push({ text: seg.text, start, unit: units++, highlight: highlighted(start, offset) });
	}
	if (pendingSpace) segments.push(pendingSpace);
	return { spans, segments, units };
}

// ------------------------------------------------------------------------------------------------ layout

/** Width of every card in reference px (tokcomment's CSS px: its cards are at most 420 px wide). */
export const SOCIAL_CARD_REF_WIDTH = 420;
/** The card never takes more than this share of the design height (long comments shrink the whole card). */
export const SOCIAL_CARD_MAX_HEIGHT = 0.88;

/**
 * Design px per reference px of the card on a design canvas (the card is drawn at tokcomment's CSS px and zoomed as a
 * unit, so it stays proportional to the reference): 1.8 on 9:16 (a 420 px card is 756 px, 70 % of the width, like a
 * real reply sticker), 1.7 on 1:1 (66 %), 1.6 on 16:9 (35 % of the width, 25 % of the height for a two-line reply).
 */
export function socialCardScale(design: { width: number; height: number }): number {
	if (design.height > design.width) return 1.8;
	if (design.height === design.width) return 1.7;
	return 1.6;
}

/** Font faces each variant draws with (family and weights), requested from the bundled / remote font catalogue. */
export const SOCIAL_VARIANT_FONTS: Readonly<
	Record<SocialVariant, { family: string; weights: readonly number[] } | null>
> = {
	// TikTok Sans (OFL, bundled): header 600 and comment 700 on the reply sticker; name, text, time and counts 500,
	// "Reply" and the replies line 600 on the comment row (tokcomment's weights)
	'tiktok-reply': { family: 'TikTok Sans', weights: [600, 700] },
	'tiktok-comment': { family: 'TikTok Sans', weights: [500, 600] },
	// SF Pro Text (remote manifest; the iPhone app's system font, Text cut below 20 pt): username, "Reply" and the
	// replies line 600, comment, time and like count 400 on the post comment; comment and "Replying to" 400 on the Reels
	// card (Instagram's weights, WP5 measurements)
	'instagram-post': { family: 'SF Pro Text', weights: [400, 600] },
	'instagram-reel-reply': { family: 'SF Pro Text', weights: [400] },
	// Roboto (Apache-2.0, bundled; YouTube's comment font): handle, "N replies" 500, time, comment and counts 400 on the
	// comment; header 400 and comment 500 on the Shorts card
	'youtube-comment': { family: 'Roboto', weights: [400, 500] },
	'youtube-shorts-reply': { family: 'Roboto', weights: [400, 500] },
	// Chirp (X's UI font, remote manifest `chirp-*`): name 700; handle, time, post text and counts 400 (x.com 2026)
	'x-post': { family: 'Chirp', weights: [400, 700] },
	// store reviews (design §11): Play web's review font (Roboto, bundled: name 500, date and body 400); the App Store
	// cards in SF Pro Text (remote manifest; Apple's Text cut below 20 pt): title 600, body, name and date 400
	'play-store-review': { family: 'Roboto', weights: [400, 500] },
	'app-store-review': { family: 'SF Pro Text', weights: [400, 600] },
	'app-store-review-ios': { family: 'SF Pro Text', weights: [400, 600] },
};

// ------------------------------------------------------------------------------------------------ assets

/**
 * The platform default avatars that are raster images of the remote-asset manifest (X, YouTube), by platform. A card
 * draws `AnimeTemplateProps.imageUrls[id]`; TikTok's default is a glyph and Instagram has none (glyphs.ts).
 */
export const SOCIAL_DEFAULT_AVATAR_IMAGES: Readonly<Partial<Record<SocialPlatform, RemoteImageId>>> = {
	x: REMOTE_IMAGE_IDS.xDefaultAvatar,
	youtube: REMOTE_IMAGE_IDS.youtubeDefaultAvatar,
};

/**
 * What a clip draws (social-comment design §7.8, `requiredAssets`): the variant's font faces
 * (`SOCIAL_VARIANT_FONTS`), the emoji of the comment and of the names the variant shows, in the clip's emoji pack,
 * and the platform's default-avatar image when the avatar is shown and is the default. A variant whose card is not
 * built yet declares nothing. Pure; never throws.
 */
export function socialCommentRequiredAssets(params: SocialCommentParams): TemplateRequiredAssets {
	const p = socialCommentParamsSchema.safeParse(params).data ?? DEFAULTS;
	// a card style not built yet draws only its "not available" stand-in: nothing to load
	if (!SOCIAL_COMMENT_READY_VARIANTS.includes(p.variant)) return { fonts: [] };
	const font = SOCIAL_VARIANT_FONTS[p.variant];
	const caps = VARIANT_CAPABILITIES[p.variant];
	const out: TemplateRequiredAssets = {
		fonts: font
			? font.weights.map((weight) => ({ family: font.family, weight, style: 'normal' as const }))
			: [],
	};
	const shown = [
		stripMarks(p.text),
		caps.displayName ? p.displayName : '',
		caps.handle ? p.handle : '',
		caps.title ? p.title : '',
	];
	const graphemes = emojiGraphemes(shown.join('\n'));
	if (graphemes.length) out.emoji = { pack: resolveEmojiStyle(p.variant, p.emojiStyle), graphemes };
	const image = SOCIAL_DEFAULT_AVATAR_IMAGES[VARIANT_PLATFORM[p.variant]];
	if (image && p.showProfile && p.avatar === null) out.images = [image];
	return out;
}

// -------------------------------------------------------------------------------------------- definition

/**
 * The template's fill hook (design §7.10, `clip.addMotionGraphic {fill}`): `fillSocialParams` — the params the caller
 * and the preset left out get believable values for `seed` (identity, stats, the variant's look); given ones are kept.
 * Returns the given params plus the filled ones and the filled names; never throws.
 */
export function fillSocialCommentParams(
	partial: Record<string, unknown>,
	seed: number,
): MgTemplateFillResult {
	try {
		const r = fillSocialParams(partial, seed);
		return r.ok
			? { ok: true, params: { ...r.params }, filled: [...r.filled] }
			: { ok: false, error: r.error, issues: r.issues };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

const DEFAULTS = socialCommentParamsSchema.parse({});

/** The variants with a card of their own (the others draw a "not available yet" card and get no preset). */
export const SOCIAL_COMMENT_READY_VARIANTS: readonly SocialVariant[] = [
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
];

/**
 * The variant of social-comment params whose card this build does not draw yet (the clip shows a "not available" card
 * in preview; exports refuse it like a template that is not installed), else null.
 */
export function socialCommentUnavailableVariant(params: unknown): SocialVariant | null {
	const v = (params as { variant?: unknown } | null)?.variant;
	const variant = (SOCIAL_VARIANTS as readonly unknown[]).includes(v) ? (v as SocialVariant) : 'tiktok-reply';
	return SOCIAL_COMMENT_READY_VARIANTS.includes(variant) ? null : variant;
}

/** Gallery card names of the variant presets ("<platform> · <card>"). */
const PRESET_NAMES: Readonly<Record<SocialVariant, { name: string; description: string }>> = {
	'tiktok-reply': {
		name: 'TikTok · Comment reply',
		description: 'The "Reply to name\'s comment" bubble TikTok shows on a video reply.',
	},
	'tiktok-comment': { name: 'TikTok · Comment', description: 'A TikTok comment with likes and replies.' },
	'instagram-post': {
		name: 'Instagram · Post comment',
		description: 'An Instagram post comment with its like heart and replies.',
	},
	'instagram-reel-reply': {
		name: 'Instagram · Reel reply',
		description: 'The "Replying to username" card Instagram shows on a Reel made in reply to a comment.',
	},
	'youtube-comment': {
		name: 'YouTube · Comment',
		description: 'A YouTube video comment with likes, the reply button and "N replies".',
	},
	'youtube-shorts-reply': {
		name: 'YouTube · Shorts reply',
		description: 'The "Comment from @handle" card YouTube shows on a Shorts reply.',
	},
	'x-post': {
		name: 'X · Post',
		description: 'An X post with replies, reposts, likes and views.',
	},
	'play-store-review': {
		name: 'Play Store · Review',
		description: 'A Google Play review: avatar, name, green stars, date and the text fading out when long.',
	},
	'app-store-review': {
		name: 'App Store · Review',
		description:
			'An App Store review card in its web / Mac style: orange stars, name and date, title, text and "more".',
	},
	'app-store-review-ios': {
		name: 'App Store · Review (iPhone app)',
		description:
			"An App Store review from the iPhone app's Ratings & Reviews list: title and age, stars and name, text.",
	},
};

/** One preset per variant with a card: tokcomment's defaults of that variant (what differs from the schema's). */
export function socialCommentPresets(variants: readonly SocialVariant[]): MgTemplatePreset[] {
	return variants.map((variant) => {
		const d = socialDefaults(variant);
		const params: Record<string, unknown> = {};
		for (const k of SOCIAL_PARAM_NAMES)
			if (JSON.stringify(d[k]) !== JSON.stringify(DEFAULTS[k])) params[k] = d[k];
		params.variant = variant;
		return { id: variant, ...PRESET_NAMES[variant], params };
	});
}

/** Menu labels of the enum params in Properties (the stored values stay the ids agents use). */
const VARIANT_OPTION_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
	SOCIAL_VARIANTS.map((v) => [v, PRESET_NAMES[v].name]),
);
const THEME_OPTION_LABELS = { light: 'Light', dark: 'Dark' } as const;
const EMOJI_OPTION_LABELS = { auto: 'Platform', apple: 'Apple', twemoji: 'Twemoji', noto: 'Noto' } as const;
const IOS_AGE_OPTION_LABELS = { weekday: 'Weekday (Sun)', relative: 'Relative (2d ago)' } as const;
const ENTRANCE_OPTION_LABELS = {
	'classic-pop': 'Classic pop',
	'soft-spring': 'Soft spring',
	'grow-from-tail': 'Grow from tail',
	'drop-bounce': 'Drop & bounce',
} as const;

/** Params a variant may not draw are shown only for the variants that draw them (`variantsWithParam`). */
const byVariant = (param: SocialParamName): Pick<MgTemplateParamUi, 'visibleWhen'> => {
	const variants = variantsWithParam(param);
	return variants.length < SOCIAL_VARIANTS.length ? { visibleWhen: { param: 'variant', in: variants } } : {};
};

export const socialComment: MgAnimeTemplateDefinition<SocialCommentParams> = {
	id: 'social-comment',
	version: 1,
	name: 'Social comment',
	category: 'Social comments',
	description:
		'A TikTok, Instagram, YouTube or X comment card, or a Google Play / App Store review, that looks like a screenshot and pops onto the screen; optional word-by-word reveal and like count tick (stars filling on reviews).',
	renderer: 'anime',
	renderVersion: 1,
	posterAt: 2.5,
	paramsSchema: socialCommentParamsSchema,
	defaults: DEFAULTS,
	introFrames: SOCIAL_COMMENT_INTRO_FRAMES,
	outroFrames: SOCIAL_COMMENT_OUTRO_FRAMES,
	defaultDurationSeconds: 5,
	canvases: [...CANVASES],
	presets: socialCommentPresets(SOCIAL_COMMENT_READY_VARIANTS),
	fill: fillSocialCommentParams,
	clipName: socialClipName,
	requiredAssets: socialCommentRequiredAssets,
	// grouped like tokcomment's control panel (design §7.9); custom controls are registered by the web app (until then
	// Properties falls back to the standard editors)
	ui: {
		// the gallery draws the card on the 9:16 canvas it is designed for, covering the 16:9 thumbnail (App QA N7)
		preview: { canvas: { width: 1080, height: 1920 } },
		groups: [
			{ id: 'look', label: 'Look', params: ['variant', 'theme', 'emojiStyle'] },
			{
				id: 'author',
				label: 'Author',
				params: ['displayName', 'handle', 'avatar', 'showProfile', 'verified'],
			},
			{
				id: 'stats',
				label: 'Stats',
				params: [
					'rating',
					'date',
					'timeValue',
					'timeUnit',
					'edited',
					'iosAgeStyle',
					'likes',
					'replies',
					'reposts',
					'views',
					'showReposts',
					'showViews',
				],
			},
			{ id: 'text', label: 'Text', params: ['title', 'text', 'truncate'] },
			{ id: 'animation', label: 'Animation', params: ['entrance', 'wordReveal', 'likeTick'] },
		],
		params: {
			variant: { label: 'Style', options: VARIANT_OPTION_LABELS },
			theme: { options: THEME_OPTION_LABELS },
			emojiStyle: { label: 'Emoji', options: EMOJI_OPTION_LABELS },
			displayName: { label: 'Display Name', ...byVariant('displayName') },
			handle: { label: 'Handle', ...byVariant('handle') },
			avatar: { label: 'Avatar', control: 'social-avatar', ...byVariant('avatar') },
			showProfile: { label: 'Show Avatar', ...byVariant('showProfile') },
			verified: { label: 'Verified', ...byVariant('verified') },
			// value and unit are one row of the `social-time` control (it edits timeUnit too and hides its row)
			timeValue: { label: 'Posted', control: 'social-time', ...byVariant('timeValue') },
			timeUnit: { label: 'Unit', ...byVariant('timeUnit') },
			likes: { label: 'Likes', control: 'social-count', ...byVariant('likes') },
			replies: { label: 'Replies', control: 'social-count', ...byVariant('replies') },
			reposts: { label: 'Reposts', control: 'social-count', ...byVariant('reposts') },
			views: { label: 'Views', control: 'social-count', ...byVariant('views') },
			showReposts: { label: 'Show Reposts', ...byVariant('showReposts') },
			showViews: { label: 'Show Views', ...byVariant('showViews') },
			// store reviews: a star picker and a date picker with the store's printed form (web app controls)
			rating: { label: 'Rating', control: 'social-rating', ...byVariant('rating') },
			date: { label: 'Date', control: 'social-date', ...byVariant('date') },
			edited: { label: 'Edited', ...byVariant('edited') },
			iosAgeStyle: { label: 'Recent Dates', options: IOS_AGE_OPTION_LABELS, ...byVariant('iosAgeStyle') },
			title: { label: 'Title', ...byVariant('title') },
			text: { label: 'Comment', multiline: true, control: 'social-comment-text' },
			truncate: { label: 'Truncate Long Text', ...byVariant('truncate') },
			entrance: { label: 'Entrance', options: ENTRANCE_OPTION_LABELS },
			wordReveal: { label: 'Words One by One' },
			// one extra, two looks: the like count ticks up on comments, the stars fill one by one on store reviews
			likeTick: {
				label: 'Likes Tick Up / Stars Fill',
				description:
					'After the entrance the like count ticks up and the heart thumps; on store reviews the stars fill one by one and pulse.',
				...byVariant('likeTick'),
			},
		},
		// "Add another" re-randomizes identity and stats (keeps look, text and animation); bulk-import column aliases
		// (docs/wp-notes/social-comments.md "Add another & bulk import")
		addAnother: SOCIAL_ADD_ANOTHER,
		import: SOCIAL_IMPORT_HINTS,
	},
};
