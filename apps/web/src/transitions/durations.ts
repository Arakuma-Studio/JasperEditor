// Default-duration fields of Preferences ▸ Timeline (S10:TUI-032): parse, validate and format a duration in
// frames or seconds against a sequence frame rate. Pure.
//
// Storage is the project's: transition lengths are whole frames (`defaultTransitionFrames`,
// `defaultAudioTransitionFrames`); the still length `defaultStillDurationFrames` is in 1/30 s units and
// rescaled to the sequence rate when a still is placed (S01:KND-004). Seconds are converted at the rate of
// the active sequence (NTSC rates never give whole frames, so seconds are rounded to the nearest frame and the
// field says so).
import type { Rational } from '@jasper/project';

/** Longest default the fields accept (a typo guard: 3000 instead of 30). */
const MAX_DEFAULT_SECONDS = 60;
/** Unit of `defaultStillDurationFrames` (S01:KND-004). */
const STILL_BASE_FPS = 30;

export type DurationUnit = 'frames' | 'seconds';
export type ParsedDuration = { ok: true; value: number; note: string | null } | { ok: false; error: string };

const fps = (r: Rational) => r.num / r.den;

/** "29.97", "25", "23.976", "59.94". */
export function formatFps(r: Rational): string {
	const f = fps(r);
	return Number.isInteger(f) ? String(f) : String(Number(f.toFixed(3)));
}

/** Seconds with 2–3 decimals: 1 → "1.00", 1.001 → "1.001", 0.5 → "0.50". */
function formatSeconds(s: number): string {
	const three = s.toFixed(3);
	return three.endsWith('0') ? s.toFixed(2) : three;
}

function parseNumber(text: string): number | null {
	const t = text.trim().replace(',', '.');
	if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return null;
	const n = Number(t);
	return Number.isFinite(n) ? n : null;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * A transition length typed in `unit` → whole frames at `rate` (≥ 1 frame, ≤ MAX_DEFAULT_SECONDS). `note` says
 * when seconds had to be rounded to whole frames.
 */
export function parseTransitionDuration(text: string, unit: DurationUnit, rate: Rational): ParsedDuration {
	const n = parseNumber(text);
	const at = `at ${formatFps(rate)} fps`;
	const max = Math.round(MAX_DEFAULT_SECONDS * fps(rate));
	if (n === null)
		return { ok: false, error: unit === 'frames' ? 'Enter a number of frames' : 'Enter seconds' };
	if (unit === 'frames') {
		if (!Number.isInteger(n)) return { ok: false, error: 'Whole frames only' };
		if (n < 1) return { ok: false, error: 'At least 1 frame' };
		if (n > max) return { ok: false, error: `At most ${max} frames (${MAX_DEFAULT_SECONDS} s) ${at}` };
		return { ok: true, value: n, note: null };
	}
	const exact = n * fps(rate);
	const frames = Math.round(exact);
	if (frames < 1) return { ok: false, error: `Shorter than one frame ${at}` };
	if (frames > max) return { ok: false, error: `At most ${MAX_DEFAULT_SECONDS} s` };
	return {
		ok: true,
		value: frames,
		note: Math.abs(exact - frames) > 1e-6 ? `Rounded to ${plural(frames, 'frame')} ${at}` : null,
	};
}

/** Frames → the text of the field in `unit`. */
export function formatTransitionDuration(frames: number, unit: DurationUnit, rate: Rational): string {
	return unit === 'frames' ? String(frames) : formatSeconds((frames * rate.den) / rate.num);
}

/** The other unit, for the hint next to the field: "= 1.001 s at 29.97 fps" / "= 30 frames at 29.97 fps". */
export function transitionEquivalent(frames: number, unit: DurationUnit, rate: Rational): string {
	const at = `at ${formatFps(rate)} fps`;
	return unit === 'frames'
		? `= ${formatSeconds((frames * rate.den) / rate.num)} s ${at}`
		: `= ${plural(frames, 'frame')} ${at}`;
}

/** The still length placed in a sequence of `rate` (same rounding as clip.place, S01:KND-004). */
function stillFramesAt(stored: number, rate: Rational): number {
	return Math.max(1, Math.round((stored * rate.num) / (rate.den * STILL_BASE_FPS)));
}

/** A still length typed in `unit` → the stored value (1/30 s units, ≥ 1). */
export function parseStillDuration(text: string, unit: DurationUnit, rate: Rational): ParsedDuration {
	const n = parseNumber(text);
	const at = `at ${formatFps(rate)} fps`;
	if (n === null)
		return { ok: false, error: unit === 'frames' ? 'Enter a number of frames' : 'Enter seconds' };
	const maxStored = 3600 * STILL_BASE_FPS; // an hour
	if (unit === 'frames') {
		if (!Number.isInteger(n)) return { ok: false, error: 'Whole frames only' };
		if (n < 1) return { ok: false, error: 'At least 1 frame' };
		const stored = Math.max(1, Math.round((n * STILL_BASE_FPS * rate.den) / rate.num));
		if (stored > maxStored) return { ok: false, error: 'At most one hour' };
		const placed = stillFramesAt(stored, rate);
		return {
			ok: true,
			value: stored,
			note: placed !== n ? `Stills are kept in 1/30 s: placed as ${plural(placed, 'frame')} ${at}` : null,
		};
	}
	const stored = Math.round(n * STILL_BASE_FPS);
	if (stored < 1) return { ok: false, error: 'At least 1/30 s' };
	if (stored > maxStored) return { ok: false, error: 'At most one hour' };
	return {
		ok: true,
		value: stored,
		note:
			Math.abs(n * STILL_BASE_FPS - stored) > 1e-6
				? `Rounded to ${formatSeconds(stored / STILL_BASE_FPS)} s (stills are kept in 1/30 s)`
				: null,
	};
}

export function formatStillDuration(stored: number, unit: DurationUnit, rate: Rational): string {
	return unit === 'frames' ? String(stillFramesAt(stored, rate)) : formatSeconds(stored / STILL_BASE_FPS);
}

export function stillEquivalent(stored: number, unit: DurationUnit, rate: Rational): string {
	const at = `at ${formatFps(rate)} fps`;
	return unit === 'frames'
		? `= ${formatSeconds(stored / STILL_BASE_FPS)} s`
		: `= ${plural(stillFramesAt(stored, rate), 'frame')} ${at}`;
}
