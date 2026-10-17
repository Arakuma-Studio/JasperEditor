// Peak-aligned placement (spec 12 §2.3): where a sound clip starts so that its peak (or onset, or end) lands on a cue
// frame. Sequence time is whole frames; the sub-frame rest is taken out of the clip's In point when the sound's head
// is quiet enough to lose it, which makes the alignment exact to the flick (finer than a sample at every rate).
// Otherwise the sound is at most one frame late: audio slightly after the picture is far less noticeable than audio
// before it (ITU-R BT.1359-1: sound ≈ 45 ms early or ≈ 125 ms late is the threshold of detectability). Pure.
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../time.ts';
import type { SoundAlign } from './taxonomy.ts';

export interface PeakAlignInput {
	/** Sequence frame the aligned point must land on. */
	cueFrame: number;
	/** Seconds from the file start to the peak (descriptor `peakSec`). */
	peakSec: number;
	/** Seconds from the file start to the onset (descriptor `onsetSec`), for `start` alignment; default 0. */
	onsetSec?: number;
	/** Length of the sound file, seconds. */
	durationSec: number;
	/** Where the sound ends in the file, for `end` alignment (before trailing silence; default `durationSec`). */
	endSec?: number;
	/** Quiet head (descriptor `headQuietSec`): at most this much may be trimmed off the start; default 0. */
	headQuietSec?: number;
	/** Playback rate of the clip (its speed; varispeed). Default 1. */
	rate?: number;
	/** Sequence frame rate. */
	fps: Rational;
	/** `peak` (hits, lands), `start` (UI blips: the onset), `end` (risers, reverses: the last sample). */
	align: SoundAlign;
	/** Trim the sub-frame rest from the In point when the head is quiet (default true; false = frame-accurate). */
	subFrame?: boolean;
	/**
	 * When the clip would start before frame 0: false (default) refuses with E_INVALID_PARAM; true starts it at 0
	 * and trims the head instead (the aligned point stays exact; `trimmedHeadSec` says how much was cut).
	 */
	clampStart?: boolean;
}

export type PeakAlignResult =
	| {
			ok: true;
			/** Sequence frame of the clip's first frame. */
			start: number;
			/** The clip's In point (content flicks, ≥ 0). */
			sourceInFlicks: number;
			/** How late the aligned point plays relative to the cue frame, in sequence flicks (0 ≤ error < 1 frame). */
			errorFlicks: number;
			/** The aligned point in the source (content flicks from the file start): `AudioClip.sfx.placement.peakFlicks`. */
			alignFlicks: number;
			/** Frames covering the rest of the sound from `sourceInFlicks` (≥ 1). */
			durationFrames: number;
			/** Seconds of the head cut by `clampStart` beyond the quiet head (0 otherwise). */
			trimmedHeadSec: number;
	  }
	| { ok: false; code: 'E_INVALID_PARAM'; message: string };

/** Longest sound placement accepts (a day): bounds the arithmetic for hostile input. */
export const MAX_PLACEMENT_SECONDS = 86_400;
/** Accepted playback rates (Premiere's Speed/Duration range is 1 %…10 000 %). */
export const MIN_PLACEMENT_RATE = 0.01;
export const MAX_PLACEMENT_RATE = 100;

const refuse = (message: string): PeakAlignResult => ({ ok: false, code: 'E_INVALID_PARAM', message });
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isRational = (r: unknown): r is Rational =>
	!!r &&
	typeof r === 'object' &&
	Number.isSafeInteger((r as Rational).num) &&
	Number.isSafeInteger((r as Rational).den) &&
	(r as Rational).num > 0 &&
	(r as Rational).den > 0 &&
	(r as Rational).num / (r as Rational).den <= 1000;

/**
 * Start frame and In point that put the aligned point of a sound on `cueFrame` (spec 12 §2.3):
 * `P` = aligned offset ÷ rate, `k = floor(P·fps)`, `start = cue − k`, rest `r = P − k/fps`; when the quiet head is at
 * least `r` (in source time) the In point is `r` and the error 0, else the In point is 0 and the sound plays `r` late.
 * Never throws: invalid input (non-finite, out of range, a point past the end) is a typed refusal.
 */
export function peakAlignedStart(input: PeakAlignInput): PeakAlignResult {
	if (!input || typeof input !== 'object') return refuse('placement input must be an object');
	const { cueFrame, align } = input;
	if (!Number.isSafeInteger(cueFrame) || cueFrame < 0) return refuse('cueFrame must be a frame number ≥ 0');
	if (!isRational(input.fps)) return refuse('fps must be a positive rational (num/den) up to 1000 fps');
	const rate = input.rate ?? 1;
	if (!fin(rate) || rate < MIN_PLACEMENT_RATE || rate > MAX_PLACEMENT_RATE)
		return refuse(`rate must be between ${MIN_PLACEMENT_RATE} and ${MAX_PLACEMENT_RATE}`);
	const dur = input.durationSec;
	if (!fin(dur) || dur <= 0 || dur > MAX_PLACEMENT_SECONDS)
		return refuse(`durationSec must be > 0 and ≤ ${MAX_PLACEMENT_SECONDS}`);
	const point = (name: string, v: unknown, fallback: number): number | string => {
		if (v === undefined) return fallback;
		if (!fin(v) || v < 0) return `${name} must be a number ≥ 0`;
		if (v > dur + 1e-3) return `${name} (${v} s) is past the end of the sound (${dur} s)`;
		return Math.min(v, dur);
	};
	const peak = point('peakSec', input.peakSec, Number.NaN);
	if (typeof peak === 'string') return refuse(peak);
	if (Number.isNaN(peak)) return refuse('peakSec must be a number ≥ 0');
	const onset = point('onsetSec', input.onsetSec, 0);
	if (typeof onset === 'string') return refuse(onset);
	const end = point('endSec', input.endSec, dur);
	if (typeof end === 'string') return refuse(end);
	const quiet = input.headQuietSec === undefined ? 0 : input.headQuietSec;
	if (!fin(quiet) || quiet < 0) return refuse('headQuietSec must be a number ≥ 0');
	let offsetSec: number;
	if (align === 'peak') offsetSec = peak;
	else if (align === 'start') offsetSec = onset;
	else if (align === 'end') offsetSec = end;
	else return refuse('align must be peak, start or end');

	const F = flicksPerFrame(input.fps);
	const alignSrc = offsetSec * FLICKS_PER_SECOND; // source flicks from the file start
	const P = alignSrc / rate; // sequence flicks from the clip start
	let k = Math.floor(P / F);
	let r = P - k * F;
	if (r < 0) {
		k -= 1;
		r = P - k * F;
	} else if (r >= F) {
		k += 1;
		r = P - k * F;
	}
	r = Math.min(Math.max(r, 0), F);
	const totalSrc = dur * FLICKS_PER_SECOND;
	const framesFrom = (sourceIn: number) => Math.max(1, Math.ceil((totalSrc - sourceIn) / rate / F - 1e-9));
	const alignFlicks = Math.round(alignSrc);
	let start = cueFrame - k;

	if (start < 0) {
		if (!input.clampStart)
			return refuse(
				`the sound's ${align} is ${(P / FLICKS_PER_SECOND).toFixed(3)} s into it: aligned at frame ${cueFrame} it would start at frame ${start}, before the sequence`,
			);
		// Start at frame 0; the source time playing there puts the aligned point exactly on the cue.
		start = 0;
		const exact = alignSrc - cueFrame * F * rate;
		const sourceIn = Math.max(0, Math.round(exact));
		const errorFlicks = Math.max(0, Math.round((exact - sourceIn) / rate));
		const trimmed = Math.max(0, sourceIn / FLICKS_PER_SECOND - quiet);
		return {
			ok: true,
			start,
			sourceInFlicks: sourceIn,
			errorFlicks,
			alignFlicks,
			durationFrames: framesFrom(sourceIn),
			trimmedHeadSec: Math.round(trimmed * 1e6) / 1e6,
		};
	}

	const restSrc = r * rate; // the rest in source flicks
	if (input.subFrame !== false && quiet * FLICKS_PER_SECOND >= restSrc) {
		const sourceIn = Math.round(restSrc);
		const err = Math.round((restSrc - sourceIn) / rate);
		return {
			ok: true,
			start,
			sourceInFlicks: sourceIn,
			errorFlicks: err > 0 ? err : 0,
			alignFlicks,
			durationFrames: framesFrom(sourceIn),
			trimmedHeadSec: 0,
		};
	}
	let errorFlicks = Math.round(r);
	if (errorFlicks >= F) errorFlicks = Math.max(0, Math.ceil(F) - 1);
	return {
		ok: true,
		start,
		sourceInFlicks: 0,
		errorFlicks,
		alignFlicks,
		durationFrames: framesFrom(0),
		trimmedHeadSec: 0,
	};
}
