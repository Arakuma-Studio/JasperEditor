// Second-order IIR sections: RBJ "Audio EQ Cookbook" designs (R. Bristow-Johnson), transposed direct form II.

import type { BiquadCoeffs as Coeffs, FilterType } from '@jasper/audio-dsp';
import { flush } from './math.ts';

// Banks share coefficients per band; each channel keeps only its filter state.
export {
	BIQUAD_IDENTITY as IDENTITY,
	type BiquadCoeffs as Coeffs,
	biquadMagnitude as magnitude,
	biquadMagnitudeDb as magnitudeDb,
	designBiquad,
	type FilterType,
} from '@jasper/audio-dsp';

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
