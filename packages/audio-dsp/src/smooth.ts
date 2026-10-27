/**
 * Per-sample parameter smoothing (linear ramps) to avoid zipper noise.
 *
 * Ported from FilmCraft `crates/audio-dsp/src/smooth.rs` (MIT OR Apache-2.0).
 */

/** A value that ramps linearly to its target over a fixed number of samples (float64 internally). */
export class Smoothed {
	private current: number;
	private targetValue: number;
	private step = 0;
	private remaining = 0;
	private readonly ramp: number;

	/** `rampSamples` = length of a full transition (0 = no smoothing). */
	constructor(value: number, rampSamples: number) {
		this.current = value;
		this.targetValue = value;
		this.ramp = Math.max(0, Math.floor(rampSamples));
	}

	/** Convenience: ramp length from a time in milliseconds. */
	static withMs(value: number, sampleRate: number, ms: number): Smoothed {
		return new Smoothed(value, Math.max(0, Math.round((sampleRate * ms) / 1000)));
	}

	/** Start ramping towards `target` (from the current value, so retargeting mid-ramp is continuous). */
	set(target: number): void {
		if (target === this.targetValue) return;
		this.targetValue = target;
		if (this.ramp === 0) {
			this.current = target;
			this.remaining = 0;
		} else {
			this.remaining = this.ramp;
			this.step = (target - this.current) / this.ramp;
		}
	}

	/** Jump straight to the target. */
	snap(): void {
		this.current = this.targetValue;
		this.remaining = 0;
	}

	/** Advance one sample and return the new value (lands exactly on the target). */
	tick(): number {
		if (this.remaining > 0) {
			this.remaining--;
			if (this.remaining === 0) this.current = this.targetValue;
			else this.current += this.step;
		}
		return this.current;
	}

	/** Current value without advancing. */
	value(): number {
		return this.current;
	}

	target(): number {
		return this.targetValue;
	}

	isSmoothing(): boolean {
		return this.remaining > 0;
	}
}
