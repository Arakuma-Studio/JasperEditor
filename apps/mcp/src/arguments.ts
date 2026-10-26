import { TimeInputSchema } from '@jasper/project';
import { z } from 'zod';

export const ProjectIdArg = z
	.string()
	.min(1)
	.describe('Project id ("prj_…") from list_projects or create_project');

export const SequenceIdArg = z
	.string()
	.optional()
	.describe('Sequence id ("seq_…"); default: the project\'s first sequence');

/**
 * Friendly times (social-comments design §7.10), on top of the command forms (frames, {frames}, {seconds},
 * timecode). The grammar is unambiguous by shape — the unit suffix or the number of `:`-separated fields:
 *   - `<n>s` / `<n>ms`: seconds / milliseconds, `n` a decimal without exponent ("3s", "1.5s", "250ms");
 *   - one `:` = `M:SS` (minutes 1–4 digits, seconds 00–59: "00:03", "2:30");
 *   - two `:` = `H:MM:SS` (hours 1–3 digits, minutes and seconds 00–59: "1:02:03");
 *   - three separators stay timecode `HH:MM:SS:FF` (the last one may be `;` or `.`), parsed by the command layer.
 * Clock forms take no fraction ("1:02:03.5" would read as timecode H:MM:SS.FF): use "3.5s". An optional leading
 * `-` is allowed like timecode's. Anything else is not a friendly time.
 */
const FRIENDLY_TIME =
	/^(-?)(?:(\d{1,9}(?:\.\d{1,9})?)(ms|s)|(\d{1,4}):([0-5]\d)|(\d{1,3}):([0-5]\d):([0-5]\d))$/;

/** Seconds of a friendly time string (see FRIENDLY_TIME), or null when it is not one. Never throws. */
export function parseFriendlyTime(input: string): number | null {
	if (typeof input !== 'string' || input.length > 32) return null;
	const m = FRIENDLY_TIME.exec(input);
	if (!m) return null;
	let seconds: number;
	if (m[2] !== undefined) seconds = m[3] === 'ms' ? Number(m[2]) / 1000 : Number(m[2]);
	else if (m[4] !== undefined) seconds = Number(m[4]) * 60 + Number(m[5]);
	else seconds = Number(m[6]) * 3600 + Number(m[7]) * 60 + Number(m[8]);
	if (!Number.isFinite(seconds)) return null;
	if (seconds === 0) return 0;
	return m[1] === '-' ? -seconds : seconds;
}

/** A friendly time string → `{seconds}` (the command form); every other value unchanged. */
export function normalizeTimeArg<T>(input: T): T | { seconds: number } {
	if (typeof input !== 'string') return input;
	const seconds = parseFriendlyTime(input);
	return seconds === null ? input : { seconds };
}

const FriendlyTimeSchema = z
	.string()
	.regex(FRIENDLY_TIME, 'a time like "3s", "1.5s", "250ms", "00:03" (M:SS) or "1:02:03" (H:MM:SS)')
	.transform((s) => ({ seconds: parseFriendlyTime(s) ?? 0 }));

export const TIME_FORMATS =
	'Sequence time as frames (integer), {"frames": n}, {"seconds": x}, seconds "3s" / "1.5s", milliseconds "250ms", a clock "M:SS" ("00:03") or "H:MM:SS" ("1:02:03"), or timecode "HH:MM:SS:FF" (";" before FF for drop-frame; four fields are always timecode, clocks take no fraction)';

/** Hint for a time argument that did not parse. */
export const TIME_HINT =
	'Times are frames, {"seconds": x}, "3s", "1.5s", "250ms", "00:03" (M:SS), "1:02:03" (H:MM:SS) or timecode "HH:MM:SS:FF".';

/**
 * A sequence time argument: the command forms of `TimeInputSchema` plus the friendly strings, which parse to
 * `{seconds}` so tools hand the command layer only its own forms.
 */
export const TimeArgSchema = z.union([TimeInputSchema, FriendlyTimeSchema]);

export const timeArg = (what: string) => TimeArgSchema.describe(`${what}. ${TIME_FORMATS}`);
