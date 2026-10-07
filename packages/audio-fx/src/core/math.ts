// Small numeric helpers shared by every processor (ported from filmcraft `audio-dsp/src/lib.rs`).

/** Decibels → linear amplitude. */
export function dbToGain(db: number): number {
	return 10 ** (db / 20);
}

/** Linear amplitude → decibels (−Infinity for 0). */
export function gainToDb(g: number): number {
	return 20 * Math.log10(Math.abs(g));
}

/** Linear → dB with a −200 dB floor. */
export function linDb(x: number): number {
	return 20 * Math.log10(Math.max(x, 1e-10));
}

/** Flush tiny values of recursive state to zero (keeps tails exactly silent; no subnormals). */
export function flush(x: number): number {
	return x > -1e-30 && x < 1e-30 ? 0 : x;
}

/** Flush for f32 delay-line storage. */
export function flush32(x: number): number {
	return x > -1e-25 && x < 1e-25 ? 0 : x;
}

export function clamp(x: number, lo: number, hi: number): number {
	return x < lo ? lo : x > hi ? hi : x;
}

/** Euclidean remainder (always ≥ 0 for b > 0). */
export function remEuclid(a: number, b: number): number {
	const r = a % b;
	return r < 0 ? r + b : r;
}
