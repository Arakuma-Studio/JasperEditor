// Rotation and variation (spec 12 §2.3): which of the ranked candidates fills a cue, and a small seeded random
// variation of its speed and gain so repeated sounds do not sound mechanical. Round-robin over the top-N candidates
// (the least recently used one wins, ties by rank), never the same file twice in a row when another candidate exists;
// ±2 % varispeed and ±1 dB gain from a hash of (sequence, cue, seed, layer). When the best candidate is a take of a
// recording (spec 12 P6-E9), the recording's takes among the candidates are the pool ("vary the take, not the
// pitch"): repeated cues cycle through its takes, never the same take twice in a row. Deterministic: the same inputs
// always give the same pick. Pure.
import { parseTakeId, SOUND_TAKES_MAX } from './provenance.ts';

/** Candidates the rotation cycles through (the best N of the ranking). */
export const ROTATION_TOP_N = 4;
/** Largest varispeed deviation (±2 %). */
export const VARIATION_RATE = 0.02;
/** Largest gain deviation (±1 dB). */
export const VARIATION_GAIN_DB = 1;

export type VariantContext = {
	seed: number;
	cueId: string;
	/** Part of the hash (two sequences with the same cue ids vary differently). */
	sequenceId?: string;
	/** Layer of the cue (layers of one cue vary independently). Default 0. */
	layer?: number;
	/** Sounds used nearby, most recent (or nearest) first. */
	recentSoundIds?: readonly string[];
	/** Size of the rotation pool (default `ROTATION_TOP_N`, 1…16). */
	topN?: number;
};

export type VariantPick = {
	soundId: string;
	/** Index of the pick in `candidates`. */
	index: number;
	/** Clip speed: 1 ± 2 % (0.0001 steps). */
	rate: number;
	/** Gain offset: ±1 dB (0.01 dB steps). */
	gainDb: number;
	/** True only when the one usable candidate is the sound used last (nothing else to rotate to). */
	repeated: boolean;
};

/** FNV-1a 32-bit hash of a string (UTF-16 code units). */
export function hash32(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/** mulberry32: a small seeded generator of [0, 1) numbers. */
function generator(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The seeded speed and gain variation of one cue layer: rate in [0.98, 1.02], gain in [−1, +1] dB. */
export function variationOf(ctx: Pick<VariantContext, 'seed' | 'cueId' | 'sequenceId' | 'layer'>): {
	rate: number;
	gainDb: number;
} {
	const seed = Number.isFinite(ctx.seed) ? Math.floor(ctx.seed) >>> 0 : 0;
	const layer = Number.isFinite(ctx.layer) ? Math.floor(ctx.layer ?? 0) : 0;
	const next = generator(hash32(`${ctx.sequenceId ?? ''}|${String(ctx.cueId)}|${seed}|${layer}`));
	const u = next();
	const v = next();
	const rate = Math.round((1 + VARIATION_RATE * (2 * u - 1)) * 10_000) / 10_000;
	const gainDb = Math.round(VARIATION_GAIN_DB * (2 * v - 1) * 100) / 100;
	return { rate, gainDb: Object.is(gainDb, -0) ? 0 : gainDb };
}

/**
 * The variation pool when the best candidate is a take: every take of its recording among the candidates (rank order,
 * at most `SOUND_TAKES_MAX`), or null when the best is no take or its recording has only that one take here.
 */
function takePool<T extends { id: string }>(ranked: readonly T[]): T[] | null {
	const parent = parseTakeId(ranked[0]!.id)?.parentId;
	if (!parent) return null;
	const siblings = ranked.filter((c) => parseTakeId(c.id)?.parentId === parent).slice(0, SOUND_TAKES_MAX);
	return siblings.length > 1 ? siblings : null;
}

/**
 * Picks the sound for a cue from ranked `candidates` (best first): among the top N, the one used least recently
 * (never used beats used; ties go to the better rank), skipping the sound used last whenever another exists; when the
 * best candidate is a take, among its recording's takes instead (`takePool`). Null when there is no candidate. Never
 * throws.
 */
export function pickVariant(candidates: readonly string[], ctx: VariantContext): VariantPick | null {
	if (!Array.isArray(candidates)) return null;
	const seen = new Set<string>();
	const ranked: { id: string; index: number }[] = [];
	candidates.forEach((id, index) => {
		if (typeof id === 'string' && id && !seen.has(id)) {
			seen.add(id);
			ranked.push({ id, index });
		}
	});
	if (ranked.length === 0) return null;
	const n = Math.max(1, Math.min(16, Math.floor(Number.isFinite(ctx.topN) ? ctx.topN! : ROTATION_TOP_N)));
	const pool = takePool(ranked) ?? ranked.slice(0, n);
	const recent = Array.isArray(ctx.recentSoundIds)
		? ctx.recentSoundIds.filter((x) => typeof x === 'string')
		: [];
	const last = recent[0];
	// How long ago each pool sound was used: its first position in `recent` (not used = never = best).
	const age = (id: string) => {
		const i = recent.indexOf(id);
		return i < 0 ? Number.POSITIVE_INFINITY : i;
	};
	let best: { id: string; index: number } | null = null;
	for (const c of pool) {
		if (c.id === last && pool.length > 1) continue;
		if (!best || age(c.id) > age(best.id)) best = c;
	}
	const pick = best ?? pool[0]!;
	const v = variationOf(ctx);
	return { soundId: pick.id, index: pick.index, rate: v.rate, gainDb: v.gainDb, repeated: pick.id === last };
}
