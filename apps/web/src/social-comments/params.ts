// Reading social-comment params defensively (a control must never crash on a bad value) and the patches written by
// the Randomize actions (design §7.9: concrete values, one undoable command, the shared randomizer of
// `@jasper/mg-templates`). Pure apart from `randomSeed`.
import {
	fillSocialParams,
	isSocialVariant,
	randomIdentity,
	randomStats,
	SOCIAL_COUNT_FIELDS,
	SOCIAL_COUNT_MAX,
	SOCIAL_TIME_UNITS,
	SOCIAL_TIME_VALUE_MAX,
	type SocialCountField,
	type SocialTimeUnit,
	type SocialVariant,
	VARIANT_CAPABILITIES,
} from '@jasper/mg-templates';

export type Params = Readonly<Record<string, unknown>>;

/** The clip's variant; unknown values read as the schema default (`tiktok-reply`). */
export function variantOf(params: Params | null | undefined): SocialVariant {
	const v = params?.variant;
	return isSocialVariant(v) ? v : 'tiktok-reply';
}

/** A stored count, or null when the value is not one (missing, wrong type, out of range). */
export function countOf(v: unknown): number | null {
	return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= SOCIAL_COUNT_MAX ? v : null;
}

export function timeValueOf(v: unknown): number | null {
	return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= SOCIAL_TIME_VALUE_MAX ? v : null;
}

export function timeUnitOf(v: unknown): SocialTimeUnit | null {
	return typeof v === 'string' && (SOCIAL_TIME_UNITS as readonly string[]).includes(v)
		? (v as SocialTimeUnit)
		: null;
}

export const isCountField = (name: string): name is SocialCountField =>
	(SOCIAL_COUNT_FIELDS as readonly string[]).includes(name);

/** Whether the clip's variant draws `param` (unknown params: true). */
export function applies(params: Params, param: string): boolean {
	const caps = VARIANT_CAPABILITIES[variantOf(params)] as Readonly<Record<string, boolean>>;
	return caps[param] ?? true;
}

/** A fresh 32-bit seed (the written values are concrete, so the document stays deterministic). */
export function randomSeed(): number {
	try {
		const a = new Uint32Array(1);
		globalThis.crypto.getRandomValues(a);
		return a[0]!;
	} catch {
		return Math.floor(Math.random() * 0x1_0000_0000);
	}
}

/** mulberry32 for the few draws not covered by the shared randomizer. */
function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b_79f5) | 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
	};
}

const STAT_PARAMS = ['timeValue', 'timeUnit', 'likes', 'replies', 'reposts', 'views'] as const;

/** Randomize stats: every stat the clip's variant draws (time and counts, consistent with each other). */
export function statsPatch(params: Params, seed: number): Record<string, unknown> {
	const stats = randomStats(variantOf(params), seed) as Record<(typeof STAT_PARAMS)[number], unknown>;
	const out: Record<string, unknown> = {};
	for (const k of STAT_PARAMS) if (applies(params, k)) out[k] = stats[k];
	return out;
}

/** Randomize one time: a plausible age for the platform (value and unit together); null when the variant has none. */
export function timePatch(params: Params, seed: number): Record<string, unknown> | null {
	if (!applies(params, 'timeValue')) return null;
	const s = randomStats(variantOf(params), seed);
	return { timeValue: s.timeValue, timeUnit: s.timeUnit };
}

/**
 * Randomize one count, consistent with the others: replies, reposts and views follow the current likes (1–5 %,
 * 10–30 %, 10–50×, as `randomStats`); likes are drawn so the current replies stay 1–5 % of them (tokcomment's
 * distribution when there are no replies to match). Null when the clip's variant does not draw the field.
 */
export function countPatch(
	field: SocialCountField,
	params: Params,
	seed: number,
): Record<string, unknown> | null {
	if (!applies(params, field)) return null;
	const variant = variantOf(params);
	const likes = countOf(params.likes);
	if (field === 'likes') {
		const replies = countOf(params.replies);
		if (replies && applies(params, 'replies')) {
			const share = 0.01 + rng(seed)() * 0.04;
			return { likes: Math.min(SOCIAL_COUNT_MAX, Math.max(replies, Math.round(replies / share))) };
		}
		return { likes: randomStats(variant, seed).likes };
	}
	if (likes !== null) {
		const filled = fillSocialParams({ variant, likes }, seed);
		if (filled.ok) return { [field]: filled.params[field] };
	}
	return { [field]: randomStats(variant, seed)[field] };
}

/** Randomize identity: a made-up name, matching handle and a generated avatar (always all three). */
export function identityPatch(seed: number): Record<string, unknown> {
	const id = randomIdentity(seed);
	return { displayName: id.displayName, handle: id.handle, avatar: id.avatar };
}
