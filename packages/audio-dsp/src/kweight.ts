/**
 * ITU-R BS.1770-4 K-weighting, derived from the analog prototypes (centre frequency, Q, gain) through the
 * bilinear transform so any sample rate is supported; at 48 kHz the coefficients reproduce the table of the
 * recommendation.
 *
 * Ported from FilmCraft `crates/audio-dsp/src/loudness.rs` (MIT OR Apache-2.0).
 */
import { type BiquadCoeffs, bilinearHighPass, bilinearHighShelf, biquadMagnitude } from './biquad.ts';

/** Analog prototype of the K-weighting pre-filter (high shelf). */
export const K_PREFILTER_PROTOTYPE = Object.freeze({
	f0: 1681.974450955533,
	gainDb: 3.999843853973347,
	q: 0.7071752369554196,
	/** Exponent giving the band gain `Vb = Vh^0.4996667741545416`. */
	vbExponent: 0.4996667741545416,
});

/** Analog prototype of the K-weighting RLB high-pass. */
export const K_RLB_PROTOTYPE = Object.freeze({ f0: 38.13547087602444, q: 0.5003270373238773 });

/** Stage 1 of K-weighting: the high-shelf ("head") pre-filter for `sampleRate`. */
export function kPrefilter(sampleRate: number): BiquadCoeffs {
	const p = K_PREFILTER_PROTOTYPE;
	const vh = 10 ** (p.gainDb / 20);
	const vb = vh ** p.vbExponent;
	return bilinearHighShelf(sampleRate, p.f0, p.q, vh, vb);
}

/** Stage 2 of K-weighting: the RLB high-pass for `sampleRate` (numerator 1, −2, 1 as in BS.1770). */
export function kRlb(sampleRate: number): BiquadCoeffs {
	return bilinearHighPass(sampleRate, K_RLB_PROTOTYPE.f0, K_RLB_PROTOTYPE.q);
}

/** Power gain |H(f)|² of the complete K-weighting at `freq` (for tests and analytical tooling). */
export function kWeightingPower(freq: number, sampleRate: number): number {
	const a = biquadMagnitude(kPrefilter(sampleRate), freq, sampleRate);
	const b = biquadMagnitude(kRlb(sampleRate), freq, sampleRate);
	return (a * b) ** 2;
}
