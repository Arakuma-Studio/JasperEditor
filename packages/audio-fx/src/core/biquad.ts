// Second-order IIR sections: RBJ "Audio EQ Cookbook" designs (R. Bristow-Johnson), transposed direct form II.

import {
	BIQUAD_IDENTITY,
	type BiquadCoeffs,
	biquadMagnitude,
	biquadMagnitudeDb,
	type FilterType as DspFilterType,
	designBiquad as dspDesignBiquad,
} from '@jasper/audio-dsp';
import { flush } from './math.ts';

// The RBJ designs and magnitude responses are @jasper/audio-dsp's (one implementation, ported from the same
// FilmCraft code); this module keeps a coefficient-free state section so banks share one `Coeffs` per band.
export type FilterType = DspFilterType;
export type Coeffs = BiquadCoeffs;
export const IDENTITY: Readonly<Coeffs> = BIQUAD_IDENTITY;

/** Order of the parametric EQs' band `type` choice. */
export const FILTER_TYPES: readonly FilterType[] = [
	'peaking',
	'lowShelf',
	'highShelf',
	'lowPass',
	'highPass',
	'notch',
	'bandPass',
];

/** RBJ cookbook design (`freq` clamped to 1 Hz … 0.49·fs, `q` ≥ 1e-3, `gainDb` for peaking/shelves/cut). */
export function designBiquad(
	kind: FilterType,
	sampleRate: number,
	freq: number,
	q: number,
	gainDb: number,
): Coeffs {
	return dspDesignBiquad(kind, sampleRate, freq, q, gainDb);
}

/** |H(e^{jω})| at `freq` Hz. */
export function magnitude(c: Coeffs, freq: number, sampleRate: number): number {
	return biquadMagnitude(c, freq, sampleRate);
}

/** Magnitude in dB. */
export function magnitudeDb(c: Coeffs, freq: number, sampleRate: number): number {
	return biquadMagnitudeDb(c, freq, sampleRate);
}

/** One biquad section's state (TDF-II, f64). */
export class Biquad {
	s1 = 0;
	s2 = 0;

	tick(c: Coeffs, x: number): number {
		const y = c.b0 * x + this.s1;
		this.s1 = flush(c.b1 * x - c.a1 * y + this.s2);
		this.s2 = flush(c.b2 * x - c.a2 * y);
		return y;
	}

	reset(): void {
		this.s1 = 0;
		this.s2 = 0;
	}

	/** Filter `buf[start..end)` in place. */
	process(c: Coeffs, buf: Float32Array, start = 0, end = buf.length): void {
		for (let i = start; i < end; i++) buf[i] = this.tick(c, buf[i]!);
	}
}
