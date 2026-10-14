/**
 * ITU-R BS.1770-4 / EBU R128 loudness metering.
 *
 * - K-weighting from the analog prototypes via the bilinear transform (any sample rate, see `kweight.ts`).
 * - Momentary (400 ms) and short-term (3 s) windows evaluated every 100 ms (the 400 ms gating blocks
 *   therefore overlap by 75 %).
 * - Integrated loudness: two-stage gate (−70 LUFS absolute, −10 LU relative). Gating blocks go into a fixed
 *   0.01 LU histogram that also stores exact energy sums, so the meter runs for arbitrarily long programmes
 *   without allocating and the result is exact up to the placement of blocks within 0.01 LU of the
 *   relative threshold.
 * - Loudness range (EBU Tech 3342): short-term values every 100 ms, −70 LUFS absolute and −20 LU relative
 *   gate, LRA = 95th − 10th percentile (histogram based, nearest rank ⌊p·n + ½⌋ as ffmpeg).
 * - Sample peak and true peak (polyphase oversampling to ≥ 176.4 kHz, see `oversample.ts`).
 *
 * Ported from FilmCraft `crates/audio-dsp/src/loudness.rs` (MIT OR Apache-2.0).
 */
import { Biquad } from './biquad.ts';
import { kPrefilter, kRlb } from './kweight.ts';
import { Interpolator, PolyphaseBank, truePeakFactor } from './oversample.ts';

const HIST_MIN = -70;
const HIST_MAX = 20;
const HIST_STEP = 0.01;
const HIST_BINS = Math.round((HIST_MAX - HIST_MIN) / HIST_STEP);
/** Short-term window in 100 ms sub-blocks. */
const ST_SUBBLOCKS = 30;
/** Momentary window in 100 ms sub-blocks. */
const M_SUBBLOCKS = 4;

/** Loudness (LUFS) of a channel-weighted mean-square energy; −Infinity for 0. */
export function energyToLufs(e: number): number {
	return e <= 0 ? Number.NEGATIVE_INFINITY : -0.691 + 10 * Math.log10(e);
}

/** Inverse of {@link energyToLufs}. */
export function lufsToEnergy(l: number): number {
	return 10 ** ((l + 0.691) / 10);
}

/**
 * Default BS.1770 channel weights for a channel count: L R C LFE Ls Rs (Lb Rb) order for 5.1 / 7.1, LFE
 * excluded (0), surrounds 1.41 (≈ +1.5 dB); 5 channels = L R C Ls Rs; anything else 1 each.
 */
export function defaultChannelWeights(channels: number): number[] {
	switch (channels) {
		case 5:
			return [1, 1, 1, 1.41, 1.41];
		case 6:
			return [1, 1, 1, 0, 1.41, 1.41];
		case 8:
			return [1, 1, 1, 0, 1.41, 1.41, 1.41, 1.41];
		default:
			return new Array<number>(Math.max(0, channels)).fill(1);
	}
}

/** Histogram of block loudness values with exact energy sums per bin. */
class Histogram {
	readonly count = new Float64Array(HIST_BINS);
	readonly energy = new Float64Array(HIST_BINS);

	clear(): void {
		this.count.fill(0);
		this.energy.fill(0);
	}

	static binOf(l: number): number {
		return Math.min(HIST_BINS - 1, Math.max(0, Math.floor((l - HIST_MIN) / HIST_STEP)));
	}

	static binCentre(i: number): number {
		return HIST_MIN + (i + 0.5) * HIST_STEP;
	}

	/** Add a block if it passes the absolute gate. */
	add(energy: number): void {
		const l = energyToLufs(energy);
		if (l >= HIST_MIN) {
			const b = Histogram.binOf(l);
			this.count[b] += 1;
			this.energy[b] += energy;
		}
	}

	/** Power mean (energy) of the bins from `from` upward; NaN when empty. */
	meanEnergyFrom(from: number): number {
		let e = 0;
		let n = 0;
		for (let i = from; i < HIST_BINS; i++) {
			e += this.energy[i];
			n += this.count[i];
		}
		return n > 0 ? e / n : Number.NaN;
	}

	/** Relative-gate start bin for a gate `rel` LU (negative) below the absolute-gated mean; −1 when empty. */
	relativeGateBin(rel: number): number {
		const e = this.meanEnergyFrom(0);
		if (Number.isNaN(e)) return -1;
		const thr = energyToLufs(e) + rel;
		return thr < HIST_MIN ? 0 : Histogram.binOf(thr);
	}
}

export type LoudnessMeterOptions = {
	/** Per-channel weights (missing entries are 1, extra ignored). Default {@link defaultChannelWeights}. */
	weights?: number[];
};

/** Streaming BS.1770-4 / EBU R128 loudness meter for planar float audio. `process` never allocates. */
export class LoudnessMeter {
	readonly sampleRate: number;
	readonly channels: number;
	private readonly weights: Float64Array;
	private readonly pre: Biquad[];
	private readonly rlb: Biquad[];
	/** Per-channel sum of squares in the current 100 ms sub-block. */
	private readonly acc: Float64Array;
	private readonly subLen: number;
	private subPos = 0;
	/** Weighted energy sums of the last 30 sub-blocks. */
	private readonly ring = new Float64Array(ST_SUBBLOCKS);
	private ringPos = 0;
	private subblocksSeen = 0;
	private mom = Number.NEGATIVE_INFINITY;
	private st = Number.NEGATIVE_INFINITY;
	private maxMom = Number.NEGATIVE_INFINITY;
	private maxSt = Number.NEGATIVE_INFINITY;
	private readonly integratedHist = new Histogram();
	private readonly lraHist = new Histogram();
	private readonly sPeak: Float64Array;
	private readonly tPeak: Float64Array;
	private readonly bank: PolyphaseBank;
	private readonly interp: Interpolator[];

	constructor(sampleRate: number, channels: number, opts: LoudnessMeterOptions = {}) {
		this.sampleRate = sampleRate;
		this.channels = Math.max(1, Math.floor(channels));
		const n = this.channels;
		this.weights = new Float64Array(n);
		const w = opts.weights ?? defaultChannelWeights(n);
		for (let i = 0; i < n; i++) this.weights[i] = w[i] ?? 1;
		const pre = kPrefilter(sampleRate);
		const rlb = kRlb(sampleRate);
		this.pre = Array.from({ length: n }, () => new Biquad(pre));
		this.rlb = Array.from({ length: n }, () => new Biquad(rlb));
		this.acc = new Float64Array(n);
		this.subLen = Math.max(1, Math.round(sampleRate * 0.1));
		this.sPeak = new Float64Array(n);
		this.tPeak = new Float64Array(n);
		this.bank = new PolyphaseBank(truePeakFactor(sampleRate));
		this.interp = Array.from({ length: n }, () => new Interpolator());
	}

	/** Override the per-channel weights (missing entries are 1, extra ignored). */
	setChannelWeights(weights: number[]): void {
		for (let i = 0; i < this.channels; i++) this.weights[i] = weights[i] ?? 1;
	}

	reset(): void {
		this.integratedHist.clear();
		this.lraHist.clear();
		for (const f of this.pre) f.reset();
		for (const f of this.rlb) f.reset();
		for (const ip of this.interp) ip.reset();
		this.acc.fill(0);
		this.sPeak.fill(0);
		this.tPeak.fill(0);
		this.subPos = 0;
		this.ring.fill(0);
		this.ringPos = 0;
		this.subblocksSeen = 0;
		this.mom = Number.NEGATIVE_INFINITY;
		this.st = Number.NEGATIVE_INFINITY;
		this.maxMom = Number.NEGATIVE_INFINITY;
		this.maxSt = Number.NEGATIVE_INFINITY;
	}

	/** Feed `count` samples of channel `ch` starting at `data[start]` (`data` null = silence). */
	private feed(ch: number, data: Float32Array | null, start: number, count: number): void {
		const pre = this.pre[ch];
		const rlb = this.rlb[ch];
		const ip = this.interp[ch];
		const bank = this.bank;
		let acc = this.acc[ch];
		let sp = this.sPeak[ch];
		let tp = this.tPeak[ch];
		for (let i = 0; i < count; i++) {
			const x = data === null ? 0 : data[start + i];
			const y = rlb.processSample(pre.processSample(x));
			acc += y * y;
			const a = x < 0 ? -x : x;
			if (a > sp) sp = a;
			const t = ip.pushPeak(bank, x, tp);
			const m = t > a ? t : a;
			if (m > tp) tp = m;
		}
		this.acc[ch] = acc;
		this.sPeak[ch] = sp;
		this.tPeak[ch] = tp;
	}

	/**
	 * Feed planar audio `planar[c][offset … offset + length)` (one array per channel; extra channels are
	 * ignored, missing channels count as silence). The result does not depend on how the stream is cut.
	 */
	process(planar: Float32Array[], offset = 0, length?: number): void {
		const nch = Math.min(planar.length, this.channels);
		let avail = Number.POSITIVE_INFINITY;
		for (let c = 0; c < nch; c++) avail = Math.min(avail, planar[c].length - offset);
		if (!Number.isFinite(avail)) avail = length ?? 0;
		const n = Math.max(0, Math.min(avail, length ?? avail));
		let pos = 0;
		while (pos < n) {
			const take = Math.min(n - pos, this.subLen - this.subPos);
			for (let c = 0; c < this.channels; c++) this.feed(c, c < nch ? planar[c] : null, offset + pos, take);
			pos += take;
			this.subPos += take;
			if (this.subPos === this.subLen) this.finishSubblock();
		}
	}

	private windowEnergy(k: number): number {
		let s = 0;
		for (let i = 0; i < k; i++) s += this.ring[(this.ringPos + ST_SUBBLOCKS - 1 - i) % ST_SUBBLOCKS];
		return s / (k * this.subLen);
	}

	private finishSubblock(): void {
		let e = 0;
		for (let c = 0; c < this.channels; c++) {
			e += this.weights[c] * this.acc[c];
			this.acc[c] = 0;
		}
		this.ring[this.ringPos] = e;
		this.ringPos = (this.ringPos + 1) % ST_SUBBLOCKS;
		this.subPos = 0;
		this.subblocksSeen++;
		const em = this.windowEnergy(M_SUBBLOCKS);
		const es = this.windowEnergy(ST_SUBBLOCKS);
		this.mom = energyToLufs(em);
		this.st = energyToLufs(es);
		if (this.subblocksSeen >= M_SUBBLOCKS) {
			this.integratedHist.add(em);
			if (this.mom > this.maxMom) this.maxMom = this.mom;
		}
		if (this.subblocksSeen >= ST_SUBBLOCKS) {
			this.lraHist.add(es);
			if (this.st > this.maxSt) this.maxSt = this.st;
		}
	}

	/**
	 * End of stream: measures the true peak of the points between the last input samples (silence follows; the
	 * interpolator lags by {@link PolyphaseBank.delay} samples). Call once after the last `process` for a
	 * whole-programme summary; live meters don't. Loudness values are unaffected.
	 */
	flush(): void {
		for (let c = 0; c < this.channels; c++) {
			const t = this.interp[c].flushPeak(this.bank, this.tPeak[c]);
			if (t > this.tPeak[c]) this.tPeak[c] = t;
		}
	}

	/** Momentary loudness (last 400 ms), LUFS, updated every 100 ms; −Infinity before data / for silence. */
	momentary(): number {
		return this.mom;
	}

	/** Short-term loudness (last 3 s), LUFS, updated every 100 ms; −Infinity before data / for silence. */
	shortTerm(): number {
		return this.st;
	}

	/** Maximum momentary loudness so far (once 400 ms have been seen). */
	maxMomentary(): number {
		return this.maxMom;
	}

	/** Maximum short-term loudness so far (once 3 s have been seen). */
	maxShortTerm(): number {
		return this.maxSt;
	}

	/** Gated integrated loudness (BS.1770-4), LUFS; −Infinity if nothing passed the gates. */
	integrated(): number {
		const h = this.integratedHist;
		const b = h.relativeGateBin(-10);
		if (b < 0) return Number.NEGATIVE_INFINITY;
		const e = h.meanEnergyFrom(b);
		return Number.isNaN(e) ? Number.NEGATIVE_INFINITY : energyToLufs(e);
	}

	/** Relative gate threshold used for the integrated loudness (LUFS); −Infinity when nothing is gated in. */
	relativeThreshold(): number {
		const e = this.integratedHist.meanEnergyFrom(0);
		return Number.isNaN(e) ? Number.NEGATIVE_INFINITY : energyToLufs(e) - 10;
	}

	/** Loudness range (EBU Tech 3342), LU; 0 when there is too little signal. */
	loudnessRange(): number {
		const h = this.lraHist;
		const start = h.relativeGateBin(-20);
		if (start < 0) return 0;
		let n = 0;
		for (let i = start; i < HIST_BINS; i++) n += h.count[i];
		if (n === 0) return 0;
		// nearest rank, 1-based rank ⌊p·n + ½⌋ (as ffmpeg's ebur128; FilmCraft / libebur128 use the 0-based rank
		// ⌊p·(n − 1) + ½⌋ — the two differ by at most one rank)
		const percentile = (p: number): number => {
			const rank = Math.min(n, Math.max(1, Math.floor(p * n + 0.5)));
			let c = 0;
			for (let i = start; i < HIST_BINS; i++) {
				c += h.count[i];
				if (c >= rank) return Histogram.binCentre(i);
			}
			return Histogram.binCentre(HIST_BINS - 1);
		};
		return Math.max(0, percentile(0.95) - percentile(0.1));
	}

	/** Maximum absolute sample value over all channels (linear). */
	samplePeak(): number {
		let m = 0;
		for (let c = 0; c < this.channels; c++) if (this.sPeak[c] > m) m = this.sPeak[c];
		return m;
	}

	/** Maximum true peak over all channels (linear). */
	truePeak(): number {
		let m = 0;
		for (let c = 0; c < this.channels; c++) if (this.tPeak[c] > m) m = this.tPeak[c];
		return m;
	}

	/** Per-channel sample peak (linear). */
	samplePeakChannel(ch: number): number {
		return this.sPeak[ch] ?? 0;
	}

	/** Per-channel true peak (linear). */
	truePeakChannel(ch: number): number {
		return this.tPeak[ch] ?? 0;
	}

	/** Sample peak in dBFS (−Infinity for silence). */
	samplePeakDb(): number {
		return 20 * Math.log10(this.samplePeak());
	}

	/** True peak in dBTP (−Infinity for silence). */
	truePeakDb(): number {
		return 20 * Math.log10(this.truePeak());
	}

	/** Snapshot of all programme measurements. */
	summary(): LoudnessSummary {
		return {
			integrated: this.integrated(),
			lra: this.loudnessRange(),
			truePeakDb: this.truePeakDb(),
			samplePeakDb: this.samplePeakDb(),
			maxMomentary: this.maxMom,
			maxShortTerm: this.maxSt,
		};
	}
}

/** Programme loudness measurements (EBU R128 set). LUFS / LU / dBTP / dBFS. */
export type LoudnessSummary = {
	integrated: number;
	lra: number;
	truePeakDb: number;
	samplePeakDb: number;
	maxMomentary: number;
	maxShortTerm: number;
};

/** Measure a whole planar programme in one call. */
export function measureLoudness(
	planar: Float32Array[],
	sampleRate: number,
	weights?: number[],
): LoudnessSummary {
	const m = new LoudnessMeter(sampleRate, Math.max(1, planar.length), weights ? { weights } : {});
	m.process(planar);
	m.flush();
	return m.summary();
}

export type NormalizeGain = {
	/** Gain (dB) that moves the programme to the target loudness (0 for silent / unmeasurable input). */
	gainDb: number;
	/** Largest gain (dB) that keeps the true peak at or below the ceiling (+Infinity without a ceiling). */
	maxGainDb: number;
	/** `min(gainDb, maxGainDb)`: the loudness target sacrificed to respect the ceiling (no limiter). */
	limitedGainDb: number;
};

/**
 * Loudness normalisation gain. `truePeakCeilingDb` (dBTP) is optional; without it, or with an unmeasurable
 * true peak, `maxGainDb` is +Infinity and `limitedGainDb === gainDb`.
 */
export function normalizeGainDb(
	measured: { integratedLufs: number; truePeakDbtp: number },
	targetLufs: number,
	truePeakCeilingDb?: number,
): NormalizeGain {
	const gainDb =
		Number.isFinite(measured.integratedLufs) && Number.isFinite(targetLufs)
			? targetLufs - measured.integratedLufs
			: 0;
	const maxGainDb =
		truePeakCeilingDb !== undefined &&
		Number.isFinite(truePeakCeilingDb) &&
		Number.isFinite(measured.truePeakDbtp)
			? truePeakCeilingDb - measured.truePeakDbtp
			: Number.POSITIVE_INFINITY;
	return { gainDb, maxGainDb, limitedGainDb: Math.min(gainDb, maxGainDb) };
}
