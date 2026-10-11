// SMPTE timecode formatting/parsing (S01:TIME-005, S02 Appendix A.1, S02:TL-205, S05:TY-005/006).
import { nominalFps, type Rational, supportsDropFrame } from './time.ts';

export type TimecodeOptions = {
	/** Use drop-frame numbering (`;` separators). Ignored for rates other than 29.97/59.94. */
	dropFrame?: boolean;
	/** Sequence start timecode offset in frames (S01:SEQ-001 `startTimecodeFrames`). */
	startFrames?: number;
};

function dropInfo(rate: Rational) {
	const nominal = nominalFps(rate);
	const D = nominal === 60 ? 4 : 2;
	return { nominal, D, per10: nominal * 600 - 9 * D, perMin: nominal * 60 - D };
}

function isDrop(rate: Rational, opts?: TimecodeOptions): boolean {
	return !!opts?.dropFrame && supportsDropFrame(rate);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Frame count → drop-frame "nominal" frame number (S02 A.1). */
export function dropFrameToNominal(frame: number, rate: Rational): number {
	const { D, per10, perMin } = dropInfo(rate);
	const d = Math.floor(frame / per10);
	const m = frame % per10;
	if (m > D) return frame + 9 * D * d + D * Math.floor((m - D) / perMin);
	return frame + 9 * D * d;
}

/** Formats a frame index as `HH:MM:SS:FF` or drop-frame `HH;MM;SS;FF`. Negative frames get `-`. */
export function formatTimecode(frame: number, rate: Rational, opts?: TimecodeOptions): string {
	const total = frame + (opts?.startFrames ?? 0);
	const neg = total < 0;
	let f = Math.abs(Math.trunc(total));
	const nominal = nominalFps(rate);
	const drop = isDrop(rate, opts);
	if (drop) f = dropFrameToNominal(f, rate);
	const ff = f % nominal;
	const totalSeconds = Math.floor(f / nominal);
	const ss = totalSeconds % 60;
	const mm = Math.floor(totalSeconds / 60) % 60;
	const hh = Math.floor(totalSeconds / 3600);
	const sep = drop ? ';' : ':';
	return `${neg ? '-' : ''}${pad(hh)}${sep}${pad(mm)}${sep}${pad(ss)}${sep}${pad(ff)}`;
}

/** Converts H/M/S/F fields to a frame index; invalid drop-frame labels snap forward (S02 A.1). */
export function fieldsToFrames(
	h: number,
	m: number,
	s: number,
	f: number,
	rate: Rational,
	opts?: TimecodeOptions,
): number {
	const nominal = nominalFps(rate);
	if (!isDrop(rate, opts)) return ((h * 60 + m) * 60 + s) * nominal + f;
	const { D } = dropInfo(rate);
	// Normalize carries so that the drop rule sees canonical fields.
	let totalNominal = ((h * 60 + m) * 60 + s) * nominal + f;
	let ff = totalNominal % nominal;
	let secs = Math.floor(totalNominal / nominal);
	const ss = secs % 60;
	const totalMinutes = Math.floor(secs / 60);
	if (ss === 0 && ff < D && totalMinutes % 10 !== 0) {
		ff = D; // labels ;00 and ;01 (;00–;03 at 59.94) do not exist in these minutes
		secs = totalMinutes * 60;
		totalNominal = secs * nominal + ff;
	}
	return totalNominal - D * (totalMinutes - Math.floor(totalMinutes / 10));
}

/**
 * Parses a full timecode (`HH:MM:SS:FF`, `;` or `:` separators, optional leading `-`). Returns null
 * for malformed input. The sequence start offset is subtracted when given.
 */
export function parseTimecode(input: string, rate: Rational, opts?: TimecodeOptions): number | null {
	const m = /^\s*(-)?(\d{1,3})[:;](\d{1,2})[:;](\d{1,2})[:;.](\d{1,3})\s*$/.exec(input);
	if (!m) return null;
	const frames = fieldsToFrames(Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), rate, {
		dropFrame: opts?.dropFrame ?? input.includes(';'),
	});
	const signed = m[1] ? -frames : frames;
	return signed - (opts?.startFrames ?? 0);
}

export type TimecodeEntryContext = TimecodeOptions & {
	/** Current value (playhead) for relative entries like `+15` or `-1:00`. */
	current: number;
};

/** Parses right-aligned digit groups (`115`, `1:00`, `1..`) into a frame count (no sign, no offset). */
function parseDigits(body: string, rate: Rational, opts: TimecodeOptions): number | null {
	if (body.length === 0) return null;
	// `.` stands for "00" (S02:TL-205: `1.` = 1 s, `1..` = 1 min).
	const expanded = body.replace(/\./g, '00');
	let groups: number[];
	if (/[:;]/.test(expanded)) {
		const parts = expanded.split(/[:;]/);
		if (parts.some((p) => !/^\d{1,3}$/.test(p)) || parts.length > 4) return null;
		groups = parts.map(Number);
	} else {
		if (!/^\d+$/.test(expanded) || expanded.length > 8) return null;
		groups = [];
		for (let end = expanded.length; end > 0; end -= 2) {
			groups.unshift(Number(expanded.slice(Math.max(0, end - 2), end)));
		}
	}
	while (groups.length < 4) groups.unshift(0);
	const [h, m, s, f] = groups as [number, number, number, number];
	return fieldsToFrames(h, m, s, f, rate, opts);
}

/**
 * Timecode entry field parser (S02:TL-205, S05:TY-006). Accepts:
 * - full or partial timecode, digits filling from the right: `115` = 1 s 15 f, `1510` = 15 s 10 f;
 * - `.` shorthand: `1.` = 1 s, `1..` = 1 min;
 * - `#120` = absolute frame count;
 * - relative offsets: `+15`, `-15` (frames), `+1:00`, `-1.` (timecode forms).
 * Returns the absolute frame (never negative), or null for invalid input.
 */
export function parseTimecodeEntry(input: string, rate: Rational, ctx: TimecodeEntryContext): number | null {
	const s = input.trim();
	if (s.length === 0) return null;
	const opts: TimecodeOptions = { dropFrame: ctx.dropFrame };
	if (s.startsWith('#')) {
		const n = s.slice(1).trim();
		if (!/^\d+$/.test(n)) return null;
		return Number(n);
	}
	if (s.startsWith('+') || s.startsWith('-')) {
		const body = s.slice(1).trim();
		// Offsets are durations: digits fill from the right like absolute entries, without drop-frame.
		const delta = parseDigits(body, rate, { dropFrame: false });
		if (delta === null) return null;
		const next = ctx.current + (s.startsWith('-') ? -delta : delta);
		return Math.max(0, next);
	}
	const frames = parseDigits(s, rate, opts);
	if (frames === null) return null;
	return Math.max(0, frames - (ctx.startFrames ?? 0));
}

/** Project Settings ▸ General ▸ Video Display Format (see `VIDEO_DISPLAY_FORMATS` in the schema). */
export type VideoDisplayFormat = 'timecode' | 'frames' | 'feet35' | 'feet16';
/** Frames per foot of film: 35 mm (4-perf) has 16, 16 mm has 40. */
export const FRAMES_PER_FOOT = { feet35: 16, feet16: 40 } as const;

export type DisplayOptions = TimecodeOptions & { display?: VideoDisplayFormat };

/**
 * A frame (or a duration) in the project's video display format, as Premiere shows it: timecode, a frame count, or
 * feet + frames of 35 mm / 16 mm film (`0012+05`). The start timecode offset applies to every format.
 */
export function formatTimeDisplay(frame: number, rate: Rational, opts: DisplayOptions = {}): string {
	const display = opts.display ?? 'timecode';
	if (display === 'timecode') return formatTimecode(frame, rate, opts);
	const total = Math.trunc(frame + (opts.startFrames ?? 0));
	const neg = total < 0;
	const f = Math.abs(total);
	if (display === 'frames') return `${neg ? '-' : ''}${f}`;
	const per = FRAMES_PER_FOOT[display];
	const feet = Math.floor(f / per);
	return `${neg ? '-' : ''}${String(feet).padStart(4, '0')}+${String(f % per).padStart(2, '0')}`;
}

/**
 * Parses a time typed in the display format. Frames: `120` (absolute), feet + frames: `12+05`; timecode entries
 * (`:` / `;` separated) and the relative / `#` forms of `parseTimecodeEntry` work in every format.
 */
export function parseTimeDisplayEntry(
	input: string,
	rate: Rational,
	ctx: TimecodeEntryContext & { display?: VideoDisplayFormat },
): number | null {
	const display = ctx.display ?? 'timecode';
	const s = input.trim();
	if (display === 'timecode' || /[:;]/.test(s) || s.startsWith('#')) return parseTimecodeEntry(s, rate, ctx);
	const start = ctx.startFrames ?? 0;
	if (display === 'frames') {
		if (/^[+-]\d+$/.test(s)) return Math.max(0, ctx.current + Number(s));
		if (!/^\d{1,9}$/.test(s)) return null;
		return Math.max(0, Number(s) - start);
	}
	const per = FRAMES_PER_FOOT[display];
	const m = /^([+-])?(\d{1,7})(?:\+(\d{1,3}))?$/.exec(s);
	if (!m) return null;
	const frames = Number(m[2]) * per + Number(m[3] ?? 0);
	if (m[1]) return Math.max(0, ctx.current + (m[1] === '-' ? -frames : frames));
	return Math.max(0, frames - start);
}

/** Project Settings ▸ General ▸ Audio Display Format. */
export type AudioDisplayFormat = 'samples' | 'milliseconds';

/** A sequence frame in audio time units: `HH:MM:SS:samples` or `HH:MM:SS:mmm` (Premiere's Show Audio Time Units). */
export function formatAudioTime(
	frame: number,
	rate: Rational,
	sampleRate: number,
	format: AudioDisplayFormat,
	startFrames = 0,
): string {
	const fps = rate.num / Math.max(1, rate.den);
	const seconds = Math.max(0, (frame + startFrames) / (fps > 0 ? fps : 30));
	const whole = Math.floor(seconds + 1e-9);
	const frac = seconds - whole;
	const hh = Math.floor(whole / 3600);
	const mm = Math.floor(whole / 60) % 60;
	const ss = whole % 60;
	const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
	const sub =
		format === 'samples'
			? String(Math.min(sr - 1, Math.round(frac * sr))).padStart(String(sr).length - 1, '0')
			: String(Math.min(999, Math.round(frac * 1000))).padStart(3, '0');
	return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${sub}`;
}
