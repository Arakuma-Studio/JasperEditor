// Seeded randomness of the editing-automation passes (spec 15 EA-030/EA-032): every decision of a pass comes from a
// stream seeded by (pass seed, item key), so a pass is deterministic given its seed and the document, each item keeps
// its own seed (stored in the proposal item's `meta.seed`), and "Reroll" re-plans one item with the next seed without
// changing any other item. Pure.
import { hash32 } from '../sound/variant.ts';

/** Seeds are unsigned 32-bit integers. */
export const MAX_AUTOMATION_SEED = 0xffff_ffff;

/** The seed of one item: a hash of the pass seed, the pass and the item's stable key (cut frame, clip id). */
export function itemSeed(passSeed: number, pass: string, key: string | number): number {
	const s = Number.isFinite(passSeed) ? Math.trunc(passSeed) >>> 0 : 0;
	return hash32(`${s}|${pass}|${key}`);
}

/** The seed Reroll uses after `seed` (wraps at 2³²). */
export function nextSeed(seed: number): number {
	return ((Number.isFinite(seed) ? Math.trunc(seed) : 0) + 1) >>> 0;
}

/** A deterministic stream of floats in [0, 1) (mulberry32). */
export function seededRandom(seed: number): () => number {
	let a = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Index of a weighted choice (`weights` ≥ 0; non-finite or negative count as 0) with the draw `u` ∈ [0, 1); -1 when
 * every weight is 0.
 */
export function weightedIndex(weights: readonly number[], u: number): number {
	let total = 0;
	for (const w of weights) if (Number.isFinite(w) && w > 0) total += w;
	if (!(total > 0)) return -1;
	let x = Math.min(Math.max(Number.isFinite(u) ? u : 0, 0), 1 - Number.EPSILON) * total;
	let last = -1;
	for (let i = 0; i < weights.length; i++) {
		const w = weights[i]!;
		if (!(Number.isFinite(w) && w > 0)) continue;
		last = i;
		if (x < w) return i;
		x -= w;
	}
	return last;
}
