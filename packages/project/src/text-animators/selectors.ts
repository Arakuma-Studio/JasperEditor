// Text selector maths (workstream text-animators): how much each character / word / line is affected by an
// animator. Pure functions shared by the renderer, the commands and the tests.
//
// Ported from EffectCraft `crates/text/src/selectors.rs` (MIT OR Apache-2.0, Copyright (c) 2026 ArtCraft Team and
// the EffectCraft contributors; see licenses/ported/text-animators.md). The u64 hashing (SplitMix64) uses BigInt so
// seeds, permutations and noise match the Rust implementation bit for bit.
//
// Selection values are fractions (1 = fully selected; negative values invert the animated property's effect, as
// with a negative Amount). Behaviour follows After Effects' documented Range / Wiggly selectors:
// - Range: Start / End / Offset over `n` units, Shape (Square with Smoothness, Ramp Up / Down, Triangle, Round,
//   Smooth), Ease High / Low, Amount, Randomize Order.
// - Wiggly: smooth seeded noise in time (Wiggles/Second, Temporal Phase) and across units (Correlation, Spatial
//   Phase), mapped to Min…Max Amount, per dimension unless Lock Dimensions.
// - Modes combine each selector with the selectors above it.
import type {
	TextRangeShape,
	TextSelectorBasedOn,
	TextSelectorMode,
} from '../schema/text-animators.ts';

const MASK64 = (1n << 64n) - 1n;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Selection before the first selector: nothing for Add / Max / Difference, everything for Subtract / Intersect / Min. */
export function modeInitial(mode: TextSelectorMode): number {
	return mode === 'subtract' || mode === 'intersect' || mode === 'min' ? 1 : 0;
}

/** Combines the selection so far (`acc`) with a selector's value `v`, clamped to −1…1. */
export function modeCombine(mode: TextSelectorMode, acc: number, v: number): number {
	let r: number;
	switch (mode) {
		case 'subtract':
			r = acc - v;
			break;
		case 'intersect':
			r = acc * v;
			break;
		case 'min':
			r = Math.min(acc, v);
			break;
		case 'max':
			r = Math.max(acc, v);
			break;
		case 'difference':
			r = Math.abs(acc - v);
			break;
		default:
			r = acc + v;
	}
	return clamp(r, -1, 1);
}

/** Evaluated Range Selector parameters (fractions of the unit count, not percent). */
export type RangeParams = {
	start: number;
	end: number;
	offset: number;
	/** −1…1. */
	amount: number;
	shape: TextRangeShape;
	/** 0…1 (Square only): width of the soft edge in units. */
	smoothness: number;
	/** −1…1. */
	easeHigh: number;
	easeLow: number;
};

export const DEFAULT_RANGE: Readonly<RangeParams> = Object.freeze({
	start: 0,
	end: 1,
	offset: 0,
	amount: 1,
	shape: 'square',
	smoothness: 1,
	easeHigh: 0,
	easeLow: 0,
});

/** Shape profile over the range (`f` = 0 at Start, 1 at End). */
export function shapeValue(shape: TextRangeShape, f: number): number {
	switch (shape) {
		case 'square':
			return f >= 0 && f <= 1 ? 1 : 0;
		// Ramps hold their end values outside the range (cascades animate Offset across it).
		case 'rampUp':
			return clamp(f, 0, 1);
		case 'rampDown':
			return 1 - clamp(f, 0, 1);
	}
	if (!(f >= 0 && f <= 1)) return 0;
	switch (shape) {
		case 'triangle':
			return 1 - Math.abs(2 * f - 1);
		case 'round':
			return Math.sqrt(Math.max(0, 1 - (2 * f - 1) ** 2));
		default: {
			const t = 1 - Math.abs(2 * f - 1);
			return t * t * (3 - 2 * t);
		}
	}
}

/**
 * Ease High / Low remap of a selection value `v` (0…1): positive values slow the change near the fully selected
 * (high) or unselected (low) end, negative values make it more abrupt. A cubic Bezier `y(t)` with control values
 * `(1 − low)/3` and `1 − (1 − high)/3`; monotonic for −1…1.
 */
export function selectorEase(v: number, high: number, low: number): number {
	if (high === 0 && low === 0) return v;
	const t = clamp(v, 0, 1);
	const p1 = (1 - clamp(low, -1, 1)) / 3;
	const p2 = 1 - (1 - clamp(high, -1, 1)) / 3;
	const u = 1 - t;
	return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

/** Selection of unit `i` of `n` (0-based, after any random reordering) by a range selector. */
export function rangeValue(r: RangeParams, i: number, n: number): number {
	const count = Math.max(1, n);
	let s = r.start;
	let e = r.end;
	if (s > e) [s, e] = [e, s];
	s += r.offset;
	e += r.offset;
	const unit = 1 / count;
	const c = (i + 0.5) * unit;
	let v: number;
	if (r.shape === 'square') {
		const w = clamp(r.smoothness, 0, 1) * unit;
		const edge = (d: number) => (w > 1e-12 ? clamp(d / w + 0.5, 0, 1) : d >= 0 ? 1 : 0);
		v = e - s <= 1e-12 ? 0 : Math.min(edge(c - s), edge(e - c));
	} else if (e - s <= 1e-12) {
		// Degenerate range: ramps step at the point, others select nothing.
		v = r.shape === 'rampUp' ? (c >= s ? 1 : 0) : r.shape === 'rampDown' ? (c < s ? 1 : 0) : 0;
	} else {
		v = selectorEase(shapeValue(r.shape, (c - s) / (e - s)), r.easeHigh, r.easeLow);
	}
	return v * r.amount;
}

// ---------------------------------------------------------------- deterministic hashing (u64)

/** SplitMix64 step (deterministic hashing for seeds and noise lattices). */
export function splitmix(x: bigint): bigint {
	const a = (x + 0x9e3779b97f4a7c15n) & MASK64;
	let z = a;
	z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
	z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
	return z ^ (z >> 31n);
}

function hash3(a: bigint, b: bigint, c: bigint): bigint {
	const ab = splitmix(splitmix(a) ^ ((b * 0x632be59bd9b4e019n) & MASK64));
	return splitmix(ab ^ ((c * 0x8cb92ba72f3d8dd7n) & MASK64));
}

/** `x as i64 as u64` of a finite float (truncation toward zero, two's complement wrap). */
export function f64ToU64(x: number): bigint {
	if (!Number.isFinite(x)) return 0n;
	return BigInt.asUintN(64, BigInt(Math.trunc(x)));
}

/** Randomize Order: a seeded permutation `p` with `p[i]` = the position unit `i` takes. */
export function randomOrder(n: number, seed: bigint): number[] {
	const p = Array.from({ length: n }, (_, i) => i);
	let s = splitmix((seed ^ 0x5eedn) & MASK64);
	for (let i = n - 1; i >= 1; i--) {
		s = splitmix(s);
		const j = Number(s % BigInt(i + 1));
		[p[i], p[j]] = [p[j]!, p[i]!];
	}
	return p;
}

const TWO53 = 2 ** 53;

/** Smooth 1D value noise in −1…1 (quintic interpolation of seeded lattice values). */
export function noise1(x: number, seed: bigint, channel: bigint): number {
	const i = Math.floor(x);
	const f = x - i;
	const lat = (k: number) => {
		const h = hash3(seed, channel, f64ToU64(k));
		return (Number(h >> 11n) / TWO53) * 2 - 1;
	};
	const a = lat(i);
	const b = lat(i + 1);
	const t = f * f * f * (f * (f * 6 - 15) + 10);
	return a + (b - a) * t;
}

/** Evaluated Wiggly Selector parameters. */
export type WigglyParams = {
	/** −1…1. */
	max: number;
	min: number;
	wigglesPerSecond: number;
	/** 0…1: 1 = every unit moves together. */
	correlation: number;
	/** Degrees (one cycle = 360). */
	temporalPhase: number;
	spatialPhase: number;
	lockDimensions: boolean;
	seed: bigint;
};

/** Wiggly selection of unit `i` at layer time `t` seconds for dimension `dim` (0…2). */
export function wigglyValue(w: WigglyParams, t: number, i: number, dim: number): number {
	const ch = BigInt(w.lockDimensions ? 0 : dim);
	const tau = t * w.wigglesPerSecond + w.temporalPhase / 360;
	const shared = noise1(tau, w.seed, ch * 2n);
	// Each unit's own channel; Spatial Phase slides the pattern along the units.
	const along = i * 0.61 + w.spatialPhase / 360;
	const own =
		0.5 * noise1(tau + along, w.seed ^ 0xa5a5n, ch * 2n + 1n) +
		0.5 * noise1(tau * 1.37 + along * 1.7, w.seed ^ ((BigInt(i + 1) * 0x9e37n) & MASK64), ch);
	const c = clamp(w.correlation, 0, 1);
	const v = clamp(c * shared + (1 - c) * clamp(own, -1, 1), -1, 1);
	return w.min + (v + 1) * 0.5 * (w.max - w.min);
}

/** Layer seed (EffectCraft `layer_seed`): the Random Seed value mixed with the layer's identity. */
export function layerSeed(layerId: bigint, randomSeed: number): bigint {
	return f64ToU64(randomSeed) ^ ((layerId * 0x9e3779b9n) & MASK64);
}

/** A stable 32-bit identity of a clip id (FNV-1a), the "layer id" of `layerSeed`. */
export function clipLayerId(clipId: string): bigint {
	let h = 0x811c9dc5;
	for (let i = 0; i < clipId.length; i++) {
		h ^= clipId.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return BigInt(h >>> 0);
}

/** Indices of a selector's Based On (the unit a character belongs to and the unit count). */
export type TextUnitIndices = {
	charIndex: number;
	charIndexNoSpace: number;
	wordIndex: number;
	lineIndex: number;
};
export type TextUnitCounts = { chars: number; charsNoSpace: number; words: number; lines: number };

export function unitOf(
	basedOn: TextSelectorBasedOn,
	g: TextUnitIndices,
	counts: TextUnitCounts,
): [index: number, count: number] {
	switch (basedOn) {
		case 'charactersExcludingSpaces':
			return [Math.min(g.charIndexNoSpace, Math.max(0, counts.charsNoSpace - 1)), counts.charsNoSpace];
		case 'words':
			return [g.wordIndex, counts.words];
		case 'lines':
			return [g.lineIndex, counts.lines];
		default:
			return [g.charIndex, counts.chars];
	}
}

export function unitCount(basedOn: TextSelectorBasedOn, counts: TextUnitCounts): number {
	return unitOf(basedOn, { charIndex: 0, charIndexNoSpace: 0, wordIndex: 0, lineIndex: 0 }, counts)[1];
}
