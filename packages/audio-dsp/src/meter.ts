/**
 * Per-channel level metering for UI meters (peak, running-window RMS, clip flags) and display helpers
 * (dB conversions, fader law, meter ballistics with peak hold).
 */

/** Linear amplitude → dB, `floor` for silence (and never below `floor`). */
export function linToDb(x: number, floor = Number.NEGATIVE_INFINITY): number {
	const a = Math.abs(x);
	if (!(a > 0)) return floor;
	const db = 20 * Math.log10(a);
	return db < floor ? floor : db;
}

/** dB → linear amplitude (exact: `10^(db/20)`, −Infinity → 0). */
export function dbToLin(db: number): number {
	return 10 ** (db / 20);
}

/** Fader position in dB → gain; at or below −96 dB the fader is fully closed (gain 0). */
export function faderDbToGain(db: number): number {
	return db <= -96 ? 0 : 10 ** (db / 20);
}

export type LevelMeterOptions = {
	/** RMS window length in milliseconds (default 300). */
	rmsWindowMs?: number;
};

/** Result of {@link LevelMeter.take} (the same arrays are reused by every call). */
export type LevelReading = {
	/** Peak |x| per channel since the last take (linear). */
	peak: Float32Array;
	/** Highest running-window RMS per channel since the last take (linear). */
	rms: Float32Array;
	/** 1 when any sample since the last take reached full scale (|x| ≥ 1.0, 0 dBFS). */
	clipped: Uint8Array;
};

/** Number of samples between exact re-summations of the RMS window (cancels float drift). */
const RESUM_INTERVAL = 1 << 16;

/**
 * Per-channel peak / RMS / clip meter. The RMS is a running mean of squares over a fixed window (history
 * before the first sample counts as silence). `process` and `take` never allocate.
 */
export class LevelMeter {
	readonly sampleRate: number;
	readonly channels: number;
	readonly windowSamples: number;
	private readonly sq: Float64Array[];
	private readonly sums: Float64Array;
	private readonly maxSums: Float64Array;
	private readonly peaks: Float32Array;
	private readonly clips: Uint8Array;
	private pos = 0;
	private sinceResum = 0;
	private readonly reading: LevelReading;

	constructor(sampleRate: number, channels: number, opts: LevelMeterOptions = {}) {
		this.sampleRate = sampleRate;
		this.channels = Math.max(1, Math.floor(channels));
		this.windowSamples = Math.max(1, Math.round(((opts.rmsWindowMs ?? 300) * sampleRate) / 1000));
		this.sq = Array.from({ length: this.channels }, () => new Float64Array(this.windowSamples));
		this.sums = new Float64Array(this.channels);
		this.maxSums = new Float64Array(this.channels);
		this.peaks = new Float32Array(this.channels);
		this.clips = new Uint8Array(this.channels);
		this.reading = {
			peak: new Float32Array(this.channels),
			rms: new Float32Array(this.channels),
			clipped: new Uint8Array(this.channels),
		};
	}

	/** Feed planar audio `planar[c][offset … offset + length)`; missing channels count as silence. */
	process(planar: Float32Array[], offset = 0, length?: number): void {
		const nch = Math.min(planar.length, this.channels);
		let n = length ?? Number.POSITIVE_INFINITY;
		for (let c = 0; c < nch; c++) n = Math.min(n, planar[c].length - offset);
		if (!Number.isFinite(n)) n = 0;
		const W = this.windowSamples;
		let done = 0;
		while (done < n) {
			// process up to the ring wrap / next re-sum point so the inner loops stay branch-light
			const take = Math.min(n - done, W - this.pos, RESUM_INTERVAL - this.sinceResum);
			for (let c = 0; c < this.channels; c++) {
				const ring = this.sq[c];
				let sum = this.sums[c];
				let maxSum = this.maxSums[c];
				let peak = this.peaks[c];
				let clip = this.clips[c];
				if (c < nch) {
					const data = planar[c];
					for (let i = 0; i < take; i++) {
						const x = data[offset + done + i];
						const a = x < 0 ? -x : x;
						if (a > peak) peak = a;
						if (a >= 1) clip = 1;
						const s = x * x;
						const p = this.pos + i;
						sum += s - ring[p];
						ring[p] = s;
						if (sum > maxSum) maxSum = sum;
					}
				} else {
					for (let i = 0; i < take; i++) {
						const p = this.pos + i;
						sum -= ring[p];
						ring[p] = 0;
					}
				}
				this.sums[c] = sum;
				this.maxSums[c] = maxSum;
				this.peaks[c] = peak;
				this.clips[c] = clip;
			}
			done += take;
			this.pos += take;
			if (this.pos === W) this.pos = 0;
			this.sinceResum += take;
			if (this.sinceResum >= RESUM_INTERVAL) {
				this.sinceResum = 0;
				for (let c = 0; c < this.channels; c++) {
					let s = 0;
					const ring = this.sq[c];
					for (let i = 0; i < W; i++) s += ring[i];
					this.sums[c] = s;
				}
			}
		}
	}

	/**
	 * Peak and RMS (linear) per channel since the last take, and the clip flags; then starts a new
	 * measurement period (the RMS window itself keeps running). Returns the same object every call.
	 */
	take(): LevelReading {
		const r = this.reading;
		const W = this.windowSamples;
		for (let c = 0; c < this.channels; c++) {
			r.peak[c] = this.peaks[c];
			r.rms[c] = Math.sqrt(Math.max(0, this.maxSums[c]) / W);
			r.clipped[c] = this.clips[c];
			this.peaks[c] = 0;
			this.clips[c] = 0;
			this.maxSums[c] = Math.max(0, this.sums[c]);
		}
		return r;
	}

	reset(): void {
		for (const ring of this.sq) ring.fill(0);
		this.sums.fill(0);
		this.maxSums.fill(0);
		this.peaks.fill(0);
		this.clips.fill(0);
		this.pos = 0;
		this.sinceResum = 0;
	}
}

export type MeterBallisticsOptions = {
	/** Fall rate of the displayed level in dB per second (default 20). */
	releaseDbPerSec?: number;
	/** Peak-hold time in milliseconds (default 1500). */
	holdMs?: number;
};

/**
 * Display ballistics for one meter bar: instant attack, linear-in-dB release, and a peak-hold marker that
 * stays for `holdMs` and then falls with the displayed level until a new peak reaches it. Feed it the
 * level of each UI frame.
 */
export class MeterBallistics {
	private readonly release: number;
	private readonly holdMs: number;
	private display = Number.NEGATIVE_INFINITY;
	private hold = Number.NEGATIVE_INFINITY;
	private holdSince = 0;
	private lastMs = Number.NaN;
	private readonly out = { displayDb: Number.NEGATIVE_INFINITY, holdDb: Number.NEGATIVE_INFINITY };

	constructor(opts: MeterBallisticsOptions = {}) {
		this.release = Math.max(0, opts.releaseDbPerSec ?? 20);
		this.holdMs = Math.max(0, opts.holdMs ?? 1500);
	}

	/** Advance to `nowMs` with the new level; returns the bar and hold-marker levels (reused object). */
	update(levelDb: number, nowMs: number): { displayDb: number; holdDb: number } {
		const dt = Number.isNaN(this.lastMs) ? 0 : Math.max(0, nowMs - this.lastMs);
		this.lastMs = nowMs;
		const lvl = Number.isNaN(levelDb) ? Number.NEGATIVE_INFINITY : levelDb;
		if (lvl >= this.display) this.display = lvl;
		else {
			const fallen = this.display - (this.release * dt) / 1000;
			this.display = fallen > lvl ? fallen : lvl;
		}
		if (lvl >= this.hold) {
			this.hold = lvl;
			this.holdSince = nowMs;
		} else if (nowMs - this.holdSince >= this.holdMs) {
			// hold expired: the marker rides down with the bar until a new peak re-arms it
			this.hold = this.display;
		}
		this.out.displayDb = this.display;
		this.out.holdDb = this.hold;
		return this.out;
	}

	/** Forget the history. */
	reset(): void {
		this.display = Number.NEGATIVE_INFINITY;
		this.hold = Number.NEGATIVE_INFINITY;
		this.holdSince = 0;
		this.lastMs = Number.NaN;
	}
}
