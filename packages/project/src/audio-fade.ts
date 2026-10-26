// Audio fades of audio transitions (S01:TRN-004, S10:TUI-052). A light module (no imports) so the AudioWorklet
// chain of audio-fx can evaluate fades with the exact function the Player and the native export use.
// Gain curves (docs/wp-notes/audio-crossfades.md): Constant Gain = linear, Constant Power = quarter sine, Exponential
// Fade = dB-linear over 60 dB, Custom Fade = Premiere's fade shape (Linear / Cosine) bent by its fade value.

/** Premiere's fade shapes (`FadeShapeType` in a .prproj: 1 = Cosine; Linear assumed 0, see the work note). */
export const FADE_SHAPE_TYPES = ['linear', 'cosine'] as const;
export type FadeShapeType = (typeof FADE_SHAPE_TYPES)[number];
/** Fade value (curvature) range; positive values make a fade rise early (fade in) / fall late (fade out). */
export const FADE_VALUE_MIN = -100;
export const FADE_VALUE_MAX = 100;
/**
 * The fade value whose crossfade keeps the summed power constant (exponent 1/2): Premiere stores Constant Power as
 * Cosine @ 19, and Cosine @ 19 here is exactly the quarter sine of Constant Power.
 */
export const FADE_VALUE_EQUAL_POWER = 19;

/** A fade shape: the base curve and its fade value (FADE_VALUE_MIN…FADE_VALUE_MAX). */
export type FadeShape = { type: FadeShapeType; value: number };

export type RenderAudioFade = {
	type: 'in' | 'out';
	/** Sequence frame where the ramp begins. */
	start: number;
	frames: number;
	/**
	 * `linear` (Constant Gain), `equal-power` (Constant Power: quarter sine), `exponential` (Exponential Fade:
	 * dB-linear over 60 dB, (1000^x − 1) / 999, exactly 0 and 1 at the ends), `shape` (Custom Fade: `shape`).
	 */
	curve: 'linear' | 'equal-power' | 'exponential' | 'shape';
	/** The fade shape of a `shape` curve (absent: linear). */
	shape?: FadeShape;
	/**
	 * spec 14 TC-024: an edge micro-fade (`AudioClip.edgeFades`): `start` / `frames` are fractional (a 4 ms fade is
	 * ≈ 0.24 frames at 60 fps), so a nested sequence carries it as a fade of the flattened piece, not per frame.
	 */
	edge?: true;
};

/** Gain factor (0…1) of audio fades at a (fractional) sequence frame. */
export function audioFadeGain(fades: readonly RenderAudioFade[] | undefined, frame: number): number {
	if (!fades || fades.length === 0) return 1;
	let k = 1;
	for (const f of fades) {
		const p = f.frames > 0 ? Math.min(1, Math.max(0, (frame - f.start) / f.frames)) : 1;
		const x = f.type === 'in' ? p : 1 - p;
		k *= fadeCurve(f.curve, x, f.shape);
	}
	return Number.isFinite(k) ? k : 0;
}

/** Gain (0…1) of a fade curve at progress `x` (0 = silent end, 1 = full level). */
export function fadeCurve(curve: RenderAudioFade['curve'], x: number, shape?: FadeShape): number {
	const v = Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
	if (curve === 'equal-power') return Math.sin((v * Math.PI) / 2);
	if (curve === 'exponential') return (1000 ** v - 1) / 999;
	if (curve === 'shape') return fadeShapeGain(shape ?? { type: 'linear', value: 0 }, v);
	return v;
}

/** A fade value as stored → the value the curve uses (finite, rounded to 0.01, inside the range). */
export function clampFadeValue(value: unknown): number {
	const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
	return Math.round(Math.min(FADE_VALUE_MAX, Math.max(FADE_VALUE_MIN, n)) * 100) / 100;
}

/**
 * The exponent a fade value puts on the base curve: 2^(−value / 19). 0 → 1 (the base curve), 19 → 1/2 (equal power:
 * √base, so a symmetric crossfade's powers sum to 1), −19 → 2; the range ±100 spans exponents 1/38 … 38.
 */
function fadeShapeExponent(value: number): number {
	return 2 ** (-clampFadeValue(value) / FADE_VALUE_EQUAL_POWER);
}

/** The base curve of a shape at progress `x` (0…1): Linear `x`, Cosine the S-curve (1 − cos πx) / 2. */
export function fadeShapeBase(type: FadeShapeType, x: number): number {
	const v = Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
	return type === 'cosine' ? (1 - Math.cos(Math.PI * v)) / 2 : v;
}

/**
 * Gain (0…1) of a fade shape at progress `x` (0 = silent end, 1 = full level): base(x)^(2^(−value/19)). Monotone
 * non-decreasing, exactly 0 at x = 0 and 1 at x = 1 for every value. Linear @ 0 is Constant Gain's line; Cosine @ 19
 * is Constant Power's quarter sine (((1 − cos πx) / 2)^½ = sin(πx / 2)).
 */
export function fadeShapeGain(shape: FadeShape, x: number): number {
	const type: FadeShapeType = shape.type === 'cosine' ? 'cosine' : 'linear';
	const b = fadeShapeBase(type, x);
	if (b <= 0) return 0;
	if (b >= 1) return 1;
	return b ** fadeShapeExponent(shape.value);
}

/** Longest edge micro-fade (spec 14 TC-024): 30 ms. */
export const EDGE_FADE_MAX_MS = 30;

/**
 * Equal-power micro-fades at an audio clip's edges (spec 14 TC-024, `AudioClip.edgeFades`): `inMs` fades the clip in
 * from its first sample, `outMs` out to its last, both inside the clip (no handles needed). A cleanup join gets one on
 * each side. An edge that has an audio transition plays the transition's fade instead.
 */
export type AudioEdgeFades = { inMs?: number; outMs?: number };

const fadeMsOk = (v: unknown) =>
	v === undefined || (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= EDGE_FADE_MAX_MS);

/** INV-CLEANUP: what is wrong with a clip's `edgeFades`, or null (absent is fine). */
export function edgeFadesProblem(v: unknown): string | null {
	if (v === undefined) return null;
	if (!v || typeof v !== 'object' || Array.isArray(v)) return 'edge fades are not an object';
	const r = v as Record<string, unknown>;
	for (const k of Object.keys(r)) if (k !== 'inMs' && k !== 'outMs') return `unknown edge fade field ${k}`;
	if (!fadeMsOk(r.inMs) || !fadeMsOk(r.outMs)) return `edge fades must be 0 < ms <= ${EDGE_FADE_MAX_MS}`;
	if (r.inMs === undefined && r.outMs === undefined) return 'edge fades are empty';
	return null;
}

/** A clip's readable edge fades (unreadable parts read as absent). */
export function readEdgeFades(v: unknown): AudioEdgeFades {
	if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
	const r = v as Record<string, unknown>;
	const out: AudioEdgeFades = {};
	if (r.inMs !== undefined && fadeMsOk(r.inMs)) out.inMs = r.inMs as number;
	if (r.outMs !== undefined && fadeMsOk(r.outMs)) out.outMs = r.outMs as number;
	return out;
}
