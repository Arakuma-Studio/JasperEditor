// Exact frame-grid arithmetic on flicks for caption files (any rational rate, BigInt intermediates).
// Ported from FilmCraft `filmcraft-time` (FrameRate::frame_at / tick_of / snap / snap_nearest and the SMPTE
// field helpers); see licenses/ported/captions.md.
import { FLICKS_PER_SECOND, type Rational } from '../../time.ts';

const FPS = BigInt(FLICKS_PER_SECOND);

export const RATE_23_976: Rational = { num: 24000, den: 1001 };
export const RATE_24: Rational = { num: 24, den: 1 };
export const RATE_25: Rational = { num: 25, den: 1 };
export const RATE_29_97: Rational = { num: 30000, den: 1001 };
export const RATE_30: Rational = { num: 30, den: 1 };
export const RATE_50: Rational = { num: 50, den: 1 };
export const RATE_59_94: Rational = { num: 60000, den: 1001 };
export const RATE_60: Rational = { num: 60, den: 1 };

function sane(r: Rational): { num: bigint; den: bigint } {
	const num = Number.isFinite(r.num) && r.num > 0 ? Math.round(r.num) : 25;
	const den = Number.isFinite(r.den) && r.den > 0 ? Math.round(r.den) : 1;
	return { num: BigInt(num), den: BigInt(den) };
}

/** Euclidean (floor) division for bigint. */
function divFloor(a: bigint, b: bigint): bigint {
	const q = a / b;
	return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/** The frame containing flicks `t` (floor). */
export function frameAt(t: number, r: Rational): number {
	const { num, den } = sane(r);
	return Number(divFloor(BigInt(Math.round(t)) * num, FPS * den));
}

/** First flick of frame `f` (floor of the exact boundary). */
export function tickOf(f: number, r: Rational): number {
	const { num, den } = sane(r);
	return Number(divFloor(BigInt(Math.round(f)) * FPS * den, num));
}

/** Snap down to a frame boundary. */
export function snapDown(t: number, r: Rational): number {
	return tickOf(frameAt(t, r), r);
}

/** Snap to the nearest frame boundary (ties go down, as FilmCraft). */
export function snapNearest(t: number, r: Rational): number {
	const a = snapDown(t, r);
	const b = tickOf(frameAt(t, r) + 1, r);
	return t - a <= b - t ? a : b;
}

/** Duration of one frame (flicks of frame 1 − frame 0). */
export function frameDuration(r: Rational): number {
	return tickOf(1, r);
}

/** Frames per timecode second (30 for 29.97, 24 for 23.976). */
export function timecodeBase(r: Rational): number {
	const { num, den } = sane(r);
	return Math.max(1, Math.round(Number(num) / Number(den)));
}

/** Whether drop-frame timecode exists at this rate (29.97, 59.94, 119.88). */
export function supportsDrop(r: Rational): boolean {
	const { num, den } = sane(r);
	return den === 1001n && num % 30000n === 0n;
}

function dfParams(r: Rational): { drop: number; base: number } {
	const base = timecodeBase(r);
	return { drop: Math.floor(base / 15), base };
}

/** Frame count → SMPTE fields `[h, m, s, f]` (non-negative frames). */
export function framesToFields(
	frame: number,
	r: Rational,
	dropFrame: boolean,
): [number, number, number, number] {
	let n = Math.max(0, Math.trunc(frame));
	const { drop, base } = dfParams(r);
	if (dropFrame && supportsDrop(r)) {
		const perMin = base * 60 - drop;
		const per10 = perMin * 10 + drop;
		const d = Math.floor(n / per10);
		const m = n % per10;
		n += drop * 9 * d;
		if (m > drop) n += drop * Math.floor((m - drop) / perMin);
	}
	const f = n % base;
	const s = Math.floor(n / base) % 60;
	const mi = Math.floor(n / (base * 60)) % 60;
	const h = Math.floor(n / (base * 3600));
	return [h, mi, s, f];
}

/** SMPTE fields → frame count. */
export function fieldsToFrameCount(
	h: number,
	m: number,
	s: number,
	f: number,
	r: Rational,
	dropFrame: boolean,
): number {
	const { drop, base } = dfParams(r);
	let n = (h * 3600 + m * 60 + s) * base + f;
	if (dropFrame && supportsDrop(r)) {
		const totalMin = h * 60 + m;
		n -= drop * (totalMin - Math.floor(totalMin / 10));
	}
	return n;
}

export function rateEquals(a: Rational, b: Rational): boolean {
	return a.num * b.den === b.num * a.den;
}
