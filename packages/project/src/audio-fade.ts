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
