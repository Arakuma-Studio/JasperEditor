// Exact time arithmetic for the interchange formats (see the conventions in `model.ts`). Everything converts
// through integer flicks; products that could leave the safe-integer range go through BigInt.
import { formatTimecode, parseTimecode } from '@jasper/project';
import { FLICKS, type Rate } from './model.ts';

const BF = BigInt(FLICKS);
export const RATE_23_976: Rate = { num: 24000, den: 1001 };
export const RATE_24: Rate = { num: 24, den: 1 };
export const RATE_25: Rate = { num: 25, den: 1 };
export const RATE_29_97: Rate = { num: 30000, den: 1001 };
export const RATE_30: Rate = { num: 30, den: 1 };
export const RATE_50: Rate = { num: 50, den: 1 };
export const RATE_59_94: Rate = { num: 60000, den: 1001 };
export const RATE_60: Rate = { num: 60, den: 1 };
/** The broadcast rates every format must handle exactly. */
export const COMMON_RATES: readonly Rate[] = [
	RATE_23_976,
	RATE_24,
	RATE_25,
	RATE_29_97,
	RATE_30,
	RATE_50,
	RATE_59_94,
	RATE_60,
	{ num: 48000, den: 1001 },
	{ num: 120, den: 1 },
	{ num: 120000, den: 1001 },
	{ num: 100, den: 1 },
	{ num: 15, den: 1 },
	{ num: 12, den: 1 },
];

export function gcd(a: number, b: number): number {
	a = Math.abs(a);
	b = Math.abs(b);
	while (b) [a, b] = [b, a % b];
	return a;
}

function bgcd(a: bigint, b: bigint): bigint {
	if (a < 0n) a = -a;
	if (b < 0n) b = -b;
	while (b) [a, b] = [b, a % b];
	return a;
}

export function reduceRate(r: Rate): Rate {
	const g = gcd(r.num, r.den) || 1;
	return { num: r.num / g, den: r.den / g };
}

export function rateEquals(a: Rate, b: Rate): boolean {
	return a.num * b.den === b.num * a.den;
}

export function fps(r: Rate): number {
	return r.num / r.den;
}

/** Nominal integer rate used by timecode (24 for 23.976, 30 for 29.97, 60 for 59.94). */
export function timecodeBase(r: Rate): number {
	return Math.max(1, Math.round(r.num / r.den));
}

/** NTSC (×1000/1001) rate. */
export function isNtsc(r: Rate): boolean {
	const x = reduceRate(r);
	return x.den === 1001;
}

export function supportsDropFrame(r: Rate): boolean {
	return rateEquals(r, RATE_29_97) || rateEquals(r, RATE_59_94);
}

/** FCP7-style `(timebase, ntsc)` for a rate. */
export function timebaseOf(r: Rate): { timebase: number; ntsc: boolean } {
	return { timebase: timecodeBase(r), ntsc: isNtsc(r) };
}

/** Rate from FCP7-style `(timebase, ntsc)`. */
export function rateFromTimebase(timebase: number, ntsc: boolean): Rate {
	const tb = Math.max(1, Math.round(timebase) || 1);
	return ntsc ? reduceRate({ num: tb * 1000, den: 1001 }) : { num: tb, den: 1 };
}

/** Snap a floating rate (OTIO, ALE `FPS`) to an exact rate. Invalid input → 24. */
export function rateFromFloat(r: number): Rate {
	if (!Number.isFinite(r) || r <= 0) return RATE_24;
	for (const c of COMMON_RATES) if (Math.abs(fps(c) - r) < 1e-3) return { ...c };
	const n = Math.round(r * 1001);
	if (Math.abs(n / 1001 - r) < 1e-9 && n % 1000 === 0) return reduceRate({ num: n, den: 1001 });
	if (Math.abs(r - Math.round(r)) < 1e-9) return { num: Math.round(r), den: 1 };
	return reduceRate({ num: Math.round(r * 1_000_000), den: 1_000_000 });
}

// ---------------------------------------------------------------- frames ↔ flicks

/** Flicks per frame (integral for every broadcast rate; fractional for odd rates). */
export function flicksPerFrame(r: Rate): number {
	return (FLICKS * r.den) / r.num;
}

/** Exact flicks of `frames` frames at `r` (rounded to the nearest flick when the rate is off the grid). */
export function framesToFlicks(frames: number, r: Rate): number {
	const f = flicksPerFrame(r);
	if (Number.isInteger(f) && Number.isSafeInteger(frames * f)) return frames * f;
	return bigDivRound(BigInt(Math.round(frames)) * BF * BigInt(r.den), BigInt(r.num));
}

/** Frame index for a flick time at `r`. `round` = nearest (ties up), `floor`, `ceil`. */
export function flicksToFrames(t: number, r: Rate, mode: 'round' | 'floor' | 'ceil' = 'round'): number {
	const n = BigInt(Math.round(t)) * BigInt(r.num);
	const d = BF * BigInt(r.den);
	if (mode === 'floor') return Number(floorDiv(n, d));
	if (mode === 'ceil') return Number(-floorDiv(-n, d));
	return bigDivRound(n, d);
}

/** Whether `t` lies exactly on a frame boundary of `r`. */
export function onFrame(t: number, r: Rate): boolean {
	return framesToFlicks(flicksToFrames(t, r, 'floor'), r) === t;
}

// ---------------------------------------------------------------- seconds

/** Rational seconds `n/d` → flicks (exact when on the grid, else rounded; `exact` says which). */
export function rationalSecondsToFlicks(n: bigint, d: bigint): { flicks: number; exact: boolean } {
	if (d === 0n) return { flicks: 0, exact: false };
	const num = n * BF;
	const exact = num % d === 0n;
	return { flicks: bigDivRound(num, d), exact };
}

/** Flicks → reduced rational seconds `[n, d]` (FCPXML `n/ds`). */
export function flicksToRationalSeconds(t: number): [bigint, bigint] {
	const n = BigInt(Math.round(t));
	const g = bgcd(n, BF) || 1n;
	return [n / g, BF / g];
}

// ---------------------------------------------------------------- Premiere ticks

/** Premiere ticks (decimal string or number, any size) → flicks; `exact` false when not a multiple of 360. */
export function ticksToFlicks(ticks: string | number | bigint): { flicks: number; exact: boolean } | null {
	let b: bigint;
	try {
		b =
			typeof ticks === 'bigint'
				? ticks
				: BigInt(typeof ticks === 'number' ? Math.round(ticks) : ticks.trim());
	} catch {
		return null;
	}
	const exact = b % 360n === 0n;
	return { flicks: bigDivRound(b, 360n), exact };
}

/** Flicks → Premiere ticks as a decimal string (exact). */
export function flicksToTicks(t: number): string {
	return (BigInt(Math.round(t)) * 360n).toString();
}

// ---------------------------------------------------------------- timecode

/** `HH:MM:SS:FF` (or `HH;MM;SS;FF` drop-frame) of a frame index at `r`. */
export function formatTc(frames: number, r: Rate, dropFrame: boolean): string {
	return formatTimecode(frames, r, { dropFrame: dropFrame && supportsDropFrame(r) });
}

/**
 * Frame index of a timecode at `r`; `dropFrame` defaults to the separator (`;` = drop). Accepts `HH:MM:SS:FF`,
 * `HH:MM:SS;FF`, `HH;MM;SS;FF` and `HH:MM:SS.FF`. Null when malformed.
 */
export function parseTc(s: string, r: Rate, dropFrame?: boolean): number | null {
	const drop = (dropFrame ?? /;/.test(s)) && supportsDropFrame(r);
	return parseTimecode(s, r, { dropFrame: drop });
}

// ---------------------------------------------------------------- BigInt helpers

function floorDiv(n: bigint, d: bigint): bigint {
	if (d < 0n) {
		n = -n;
		d = -d;
	}
	const q = n / d;
	return n % d !== 0n && n < 0n ? q - 1n : q;
}

/** n / d rounded to the nearest integer (ties away from zero), as a Number. */
export function bigDivRound(n: bigint, d: bigint): number {
	if (d < 0n) {
		n = -n;
		d = -d;
	}
	const neg = n < 0n;
	const a = neg ? -n : n;
	const q = (a * 2n + d) / (2n * d);
	return Number(neg ? -q : q);
}
