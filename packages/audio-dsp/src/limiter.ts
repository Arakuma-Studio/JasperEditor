/**
 * Look-ahead true-peak brick-wall limiter (linked across channels).
 *
 * Detection runs on the same polyphase interpolator as {@link TruePeakDetector} (oversampled to
 * ≥ 176.4 kHz) plus the sample peaks, so the measured output true peak is what is controlled. For every
 * detected point the required gain `ceiling / peak` must hold on **every input sample the interpolator
 * reads to build that point** (its {@link TAPS_PER_PHASE}-tap support) plus a guard of 8 samples on both
 * sides; a sliding minimum over `lookahead + support + 2·guard` samples followed by a one-pole release and a moving average
 * exactly `lookahead` long yields a gain that
 *
 * - has fully reached the required value before the first sample of a peak's support leaves the delay
 *   line (smooth linear attack over the look-ahead, no overshoot),
 * - is flat across the whole support of the dominant peak, so the interpolated output there is exactly
 *   `gain · interpolated input ≤ ceiling`,
 * - releases exponentially (`releaseMs` time constant) and then through the same moving average.
 *
 * The only residual error is the gain slope across the support of non-dominant points; it stays below
 * 0.011 dB at the shortest 1 ms look-ahead (0.008 dB at 1.5 ms, 0.004 dB at 5 ms) under an adversarial
 * hill-climbing search, well inside the ceiling + 0.05 dB guarantee that the tests check on full-scale
 * squares, fs/4 inter-sample peaks, clipped noise, transients and random signals. A final sample clamp at
 * the ceiling catches float rounding. `process` never allocates.
 */
import { Interpolator, PolyphaseBank, TAPS_PER_PHASE, truePeakFactor } from './oversample.ts';

export type TruePeakLimiterOptions = {
	/** Ceiling in dBTP (e.g. −1). */
	ceilingDb: number;
	/** Look-ahead (attack) time in ms, clamped to 1 … 20 (default 5; 1.5 … 5 recommended). */
	lookaheadMs?: number;
	/** Release time constant in ms (default 100). */
	releaseMs?: number;
};

/** Samples read by the interpolator for one detected point. */
const SUPPORT = TAPS_PER_PHASE;
/** Position of the detected points behind the newest input sample. */
const DET_DELAY = TAPS_PER_PHASE / 2;
/** Extra samples on both sides of a support over which the gain is held flat. */
const GUARD = 8;
const RESUM_INTERVAL = 1 << 16;

/** Look-ahead true-peak limiter; output is delayed by {@link TruePeakLimiter.latency} samples. */
export class TruePeakLimiter {
	readonly sampleRate: number;
	readonly channels: number;
	/** Processing delay in samples. */
	readonly latency: number;
	/** Ceiling (linear). */
	readonly ceiling: number;
	private readonly bank: PolyphaseBank;
	private readonly interp: Interpolator[];
	private readonly delay: Float32Array[];
	private readonly dlen: number;
	private wpos = 0;
	private t = 0;
	/** Sliding-minimum deque (ring) of (sample index, required gain). */
	private readonly qIdx: Float64Array;
	private readonly qVal: Float64Array;
	private qHead = 0;
	private qTail = 0;
	private readonly window: number;
	private readonly relCoef: number;
	private relState = 1;
	private readonly box: Float64Array;
	private boxPos = 0;
	private boxSum: number;
	private sinceResum = 0;
	private lastGain = 1;

	constructor(sampleRate: number, channels: number, opts: TruePeakLimiterOptions) {
		this.sampleRate = sampleRate;
		this.channels = Math.max(1, Math.floor(channels));
		this.bank = new PolyphaseBank(truePeakFactor(sampleRate));
		const lookMs = Math.min(20, Math.max(1, opts.lookaheadMs ?? 5));
		const a = Math.max(1, Math.round((lookMs * sampleRate) / 1000));
		this.ceiling = 10 ** (opts.ceilingDb / 20);
		this.window = a + SUPPORT - 1 + 2 * GUARD;
		this.latency = a + SUPPORT - 2 + GUARD;
		this.dlen = this.latency + 1;
		this.delay = Array.from({ length: this.channels }, () => new Float32Array(this.dlen));
		this.interp = Array.from({ length: this.channels }, () => new Interpolator());
		this.qIdx = new Float64Array(this.window + 1);
		this.qVal = new Float64Array(this.window + 1);
		const relSamples = Math.max(1, ((opts.releaseMs ?? 100) * sampleRate) / 1000);
		this.relCoef = 1 - Math.exp(-1 / relSamples);
		this.box = new Float64Array(a).fill(1);
		this.boxSum = a;
	}

	/** Current gain reduction in dB (≤ 0). */
	gainReductionDb(): number {
		return 20 * Math.log10(this.lastGain);
	}

	reset(): void {
		for (const d of this.delay) d.fill(0);
		for (const ip of this.interp) ip.reset();
		this.wpos = 0;
		this.t = 0;
		this.qHead = 0;
		this.qTail = 0;
		this.relState = 1;
		this.box.fill(1);
		this.boxPos = 0;
		this.boxSum = this.box.length;
		this.sinceResum = 0;
		this.lastGain = 1;
	}

	/** One sample frame: `src` (null = silence) at `i` in, output written back to `src` when non-null. */
	private step(planar: Float32Array[] | null, nch: number, i: number): void {
		const dlen = this.dlen;
		const wpos = this.wpos;
		const pk = (wpos + dlen - DET_DELAY) % dlen;
		let det = 0;
		for (let c = 0; c < this.channels; c++) {
			const x = planar !== null && c < nch ? planar[c][i] : 0;
			const d = this.delay[c];
			d[wpos] = x;
			const tp = this.interp[c].pushPeak(this.bank, x, this.ceiling);
			const s = d[pk];
			const a = s < 0 ? -s : s;
			if (tp > det) det = tp;
			if (a > det) det = a;
		}
		const r = det > this.ceiling ? this.ceiling / det : 1;
		// sliding minimum of the required gain over the last `window` samples
		const cap = this.qIdx.length;
		while (this.qTail > this.qHead && this.qVal[(this.qTail - 1) % cap] >= r) this.qTail--;
		this.qIdx[this.qTail % cap] = this.t;
		this.qVal[this.qTail % cap] = r;
		this.qTail++;
		while (this.qIdx[this.qHead % cap] + this.window <= this.t) this.qHead++;
		const m = this.qVal[this.qHead % cap];
		// release (never above the held minimum)
		this.relState = m < this.relState ? m : this.relState + (m - this.relState) * this.relCoef;
		// moving average over the look-ahead
		const box = this.box;
		this.boxSum += this.relState - box[this.boxPos];
		box[this.boxPos] = this.relState;
		this.boxPos = this.boxPos + 1 === box.length ? 0 : this.boxPos + 1;
		if (++this.sinceResum >= RESUM_INTERVAL) {
			this.sinceResum = 0;
			let s = 0;
			for (let k = 0; k < box.length; k++) s += box[k];
			this.boxSum = s;
		}
		let g = this.boxSum / box.length;
		if (g > 1) g = 1;
		this.lastGain = g;
		const out = (wpos + 1) % dlen;
		if (planar !== null) {
			const ceil = this.ceiling;
			for (let c = 0; c < nch; c++) {
				let y = this.delay[c][out] * g;
				if (y > ceil) y = ceil;
				else if (y < -ceil) y = -ceil;
				planar[c][i] = y;
			}
		}
		this.wpos = (wpos + 1) % dlen;
		this.t++;
	}

	/**
	 * Limit `planar[c][offset … offset + length)` in place. The output is the input delayed by
	 * {@link latency} samples. Extra channels are ignored; missing channels count as silence.
	 */
	process(planar: Float32Array[], offset = 0, length?: number): void {
		const nch = Math.min(planar.length, this.channels);
		let n = length ?? Number.POSITIVE_INFINITY;
		for (let c = 0; c < nch; c++) n = Math.min(n, planar[c].length - offset);
		if (!Number.isFinite(n)) n = 0;
		for (let i = offset; i < offset + n; i++) this.step(planar, nch, i);
	}

	/**
	 * Emit the remaining {@link latency} samples (the tail still in the delay line) into `out[c][0 … latency)`
	 * by feeding silence. Call {@link reset} before reusing the limiter for another stream.
	 */
	flush(out: Float32Array[]): void {
		const nch = Math.min(out.length, this.channels);
		let room = nch > 0 ? Number.POSITIVE_INFINITY : 0;
		for (let c = 0; c < nch; c++) room = Math.min(room, out[c].length);
		for (let i = 0; i < this.latency; i++) {
			// feed silence; write the emitted sample to out[c][i] when it fits
			if (i < room) {
				for (let c = 0; c < nch; c++) out[c][i] = 0;
				this.step(out, nch, i);
			} else this.step(null, 0, i);
		}
	}
}

/**
 * Limit a whole planar buffer and return a time-aligned result (latency removed, same length as the
 * input). The input is not modified.
 */
export function limitBuffer(
	planar: Float32Array[],
	sampleRate: number,
	opts: TruePeakLimiterOptions,
): Float32Array[] {
	const nch = planar.length;
	if (nch === 0) return [];
	const len = Math.min(...planar.map((c) => c.length));
	const lim = new TruePeakLimiter(sampleRate, nch, opts);
	const work = planar.map((c) => {
		const w = new Float32Array(len + lim.latency);
		w.set(c.subarray(0, len));
		return w;
	});
	lim.process(work);
	return work.map((w) => w.slice(lim.latency, lim.latency + len));
}
