// Small numeric helpers shared by every processor (ported from filmcraft `audio-dsp/src/lib.rs`).

export { dbToLin as dbToGain, flushDenormal as flush } from '@jasper/audio-dsp';

/** Linear → dB with a −200 dB floor. */
export function linDb(x: number): number {
	return 20 * Math.log10(Math.max(x, 1e-10));
}

/** Flush for f32 delay-line storage. */
export function flush32(x: number): number {
	return x > -1e-25 && x < 1e-25 ? 0 : x;
}

export function clamp(x: number, lo: number, hi: number): number {
	return x < lo ? lo : x > hi ? hi : x;
}
