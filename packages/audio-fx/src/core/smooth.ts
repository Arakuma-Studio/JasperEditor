// Per-sample parameter smoothing (linear ramps) to avoid zipper noise (port of filmcraft `smooth.rs`).

/** A value that ramps linearly to its target over a fixed number of samples. */
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
		this.ramp = Math.max(0, Math.round(rampSamples));
	}

	/** Ramp length from a time in milliseconds. */
	static withMs(value: number, sampleRate: number, ms: number): Smoothed {
		return new Smoothed(value, Math.max(0, Math.round((sampleRate * ms) / 1000)));
	}

	/** Start ramping towards `target`. */
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

	/** Set and jump. */
	setImmediate(v: number): void {
		this.targetValue = v;
		this.snap();
	}

	/** Advance one sample and return the new value. */
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
