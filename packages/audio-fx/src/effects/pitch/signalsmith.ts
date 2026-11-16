// Signalsmith Stretch, ported to TypeScript for the Pitch Shifter's `signalsmith` engine (licenses/ported/
// signalsmith-stretch.md, signalsmith-linear.md; upstream `signalsmith-stretch.h` 1.3.2 and Signalsmith Linear's
// `DynamicSTFT`). Only the pitch-shift path with equal input and output lengths is ported, as a streaming in-place
// processor: every input sample produces one output sample, delayed by exactly `latency()` = the block length.
//
// Differences from upstream (each keeps the output deterministic and independent of how the host cuts its blocks):
// * Samples are processed one at a time; a spectrum is computed every `interval` samples counted from the reset, so
//   the analysis grid does not depend on the host's block sizes (upstream's grid already follows output samples).
// * The silence bypass counts quiet samples (Σ channels x² < 1e-15) one by one instead of per `process()` call.
// * The time-factor randomisation (only used for stretches > 2×, here only on the first, all-zero spectrum after a
//   reset) draws from a seeded PRNG reset with the state, instead of `std::random_device`.
// * `reset()` also clears the phase predictions (upstream keeps them), so a reset processor equals a fresh one.
// * Doubles throughout; no split computation; FFT sizes from `fastSizeAbove` like upstream (2^k · {1, 3, 5}).
import { Prng } from '../../core/util.ts';
import { fastSizeAbove, HalfBinRealFft } from './stretch-fft.ts';

const NOISE_FLOOR = 1e-15;
const MAX_CLEAN_STRETCH = 2;
const ALMOST_ZERO = 1e-30;
const SEED = 0x5157_7e7c;

/** Kaiser window (Signalsmith DSP `windows.h`, as copied into Signalsmith Linear's STFT). */
function bessel0(x: number): number {
	let result = 0;
	let term = 1;
	let m = 0;
	while (term > 1e-4) {
		result += term;
		++m;
		term *= (x * x) / (4 * m * m);
	}
	return result;
}

function kaiserSynthesisWindow(size: number, bandwidth: number): Float64Array {
	// heuristicOptimal bandwidth, then beta
	let bw = bandwidth + 8 / ((bandwidth + 3) * (bandwidth + 3)) + 0.25 * Math.max(3 - bandwidth, 0);
	bw = Math.max(bw, 2);
	const beta = Math.sqrt(bw * bw * 0.25 - 1) * Math.PI;
	const invB0 = 1 / bessel0(beta);
	const w = new Float64Array(size);
	const offsetI = size & 1 ? 1 : 0;
	for (let i = 0; i < size; i++) {
		const r = (2 * i + offsetI) / size - 1;
		w[i] = bessel0(beta * Math.sqrt(Math.max(0, 1 - r * r))) * invB0;
	}
	return w;
}

/** Signalsmith Linear `DynamicSTFT<Sample, false, STFT_SPECTRUM_MODIFIED>`, round-trip normalisation. */
class Stft {
	readonly block: number;
	readonly fftSize: number;
	readonly bands: number;
	readonly interval: number;
	readonly inputLength: number;
	readonly inBuf: Float64Array[];
	inPos = 0;
	readonly outBuf: Float64Array[];
	outPos = 0;
	readonly wp: Float64Array;
	readonly specRe: Float64Array[];
	readonly specIm: Float64Array[];
	private readonly time: Float64Array;
	private readonly window: Float64Array;
	readonly offset: number;
	private readonly fft: HalfBinRealFft;

	constructor(
		readonly channels: number,
		block: number,
		interval: number,
	) {
		this.block = block;
		this.interval = interval;
		this.fftSize = fastSizeAbove(Math.floor((block + 1) / 2)) * 2;
		this.fft = new HalfBinRealFft(this.fftSize);
		this.bands = this.fftSize / 2;
		this.inputLength = block + interval + 1;
		this.inBuf = Array.from({ length: channels }, () => new Float64Array(this.inputLength));
		this.outBuf = Array.from({ length: channels }, () => new Float64Array(block));
		this.wp = new Float64Array(block);
		this.specRe = Array.from({ length: channels }, () => new Float64Array(this.bands));
		this.specIm = Array.from({ length: channels }, () => new Float64Array(this.bands));
		this.time = new Float64Array(Math.max(this.fftSize, block));
		const w = kaiserSynthesisWindow(block, block / interval);
		// forcePerfectReconstruction
		for (let i = 0; i < interval; i++) {
			let sum2 = 0;
			for (let j = i; j < block; j += interval) sum2 += w[j]! * w[j]!;
			const f = 1 / Math.sqrt(sum2);
			for (let j = i; j < block; j += interval) w[j] = w[j]! * f;
		}
		this.window = w;
		let off = Math.floor(block / 2);
		for (let i = 0; i < block; i++) if (w[i]! > w[off]!) off = i;
		this.offset = off;
		this.reset(0.1);
	}

	binToFreq(b: number): number {
		return (b + 0.5) / this.fftSize;
	}

	freqToBin(f: number): number {
		return f * this.fftSize - 0.5;
	}

	reset(productWeight: number): void {
		this.inPos = this.block;
		this.outPos = 0;
		for (const b of this.inBuf) b.fill(0);
		for (const b of this.outBuf) b.fill(0);
		for (const b of this.specRe) b.fill(0);
		for (const b of this.specIm) b.fill(0);
		this.wp.fill(0);
		this.addWindowProduct();
		for (let i = this.block - this.interval - 1; i >= 0; --i)
			this.wp[i] = this.wp[i]! + this.wp[i + this.interval]!;
		for (let i = 0; i < this.block; i++) this.wp[i] = this.wp[i]! * productWeight + ALMOST_ZERO;
		this.moveOutput(this.interval);
	}

	private addWindowProduct(): void {
		const w = this.window;
		const n = this.block;
		const scaling = this.fftSize;
		let bi = this.outPos;
		for (let i = 0; i < n; i++) {
			this.wp[bi] = this.wp[bi]! + w[i]! * w[i]! * scaling;
			if (++bi === n) bi = 0;
		}
	}

	moveOutput(samples: number): void {
		const n = this.block;
		for (let i = 0; i < samples; i++) {
			for (let c = 0; c < this.channels; c++) this.outBuf[c]![this.outPos] = 0;
			this.wp[this.outPos] = ALMOST_ZERO;
			if (++this.outPos === n) this.outPos = 0;
		}
	}

	/** Windowed FFT of the input `samplesInPast` before the newest block into `specRe/Im[c]`. */
	analyse(c: number, samplesInPast: number): void {
		const L = this.inputLength;
		const n = this.block;
		const N = this.fftSize;
		const off = this.offset;
		const buf = this.inBuf[c]!;
		const w = this.window;
		const t = this.time;
		let bi = (L * 2 + this.inPos - n - samplesInPast) % L;
		for (let i = 0; i < n; i++) {
			// the half-bin shift makes the transform anti-periodic: samples before the centre wrap with a sign flip
			if (i < off) t[i + (N - off)] = -buf[bi]! * w[i]!;
			else t[i - off] = buf[bi]! * w[i]!;
			if (++bi === L) bi = 0;
		}
		for (let i = n - off; i < N - off; i++) t[i] = 0;
		this.fft.forward(t, this.specRe[c]!, this.specIm[c]!);
	}

	/** Inverse FFT of `specRe/Im[c]`, windowed and added to the output (call `addProduct` once per block first). */
	synthesise(c: number): void {
		if (c === 0) this.addWindowProduct();
		const n = this.block;
		const N = this.fftSize;
		const off = this.offset;
		const t = this.time;
		const w = this.window;
		const buf = this.outBuf[c]!;
		this.fft.inverse(this.specRe[c]!, this.specIm[c]!, t);
		let bi = this.outPos;
		for (let i = 0; i < n; i++) {
			if (i < off) buf[bi] = buf[bi]! - t[i + (N - off)]! * w[i]!;
			else buf[bi] = buf[bi]! + t[i - off]! * w[i]!;
			if (++bi === n) bi = 0;
		}
	}
}

export type SignalsmithPreset = 'default' | 'cheaper';

/** Block and interval of a preset (upstream `presetDefault` 120/30 ms, `presetCheaper` 100/40 ms). */
export function signalsmithBlock(
	preset: SignalsmithPreset,
	sampleRate: number,
): { block: number; interval: number } {
	return preset === 'cheaper'
		? { block: Math.trunc(sampleRate * 0.1), interval: Math.trunc(sampleRate * 0.04) }
		: { block: Math.trunc(sampleRate * 0.12), interval: Math.trunc(sampleRate * 0.03) };
}

export class SignalsmithStretch {
	private readonly stft: Stft;
	private readonly bands: number;
	private readonly channels: number;
	private readonly interval: number;
	// per channel × band
	private readonly inRe: Float64Array;
	private readonly inIm: Float64Array;
	private readonly prevRe: Float64Array;
	private readonly prevIm: Float64Array;
	private readonly outRe: Float64Array;
	private readonly outIm: Float64Array;
	private readonly inEnergy: Float64Array;
	private readonly predEnergy: Float64Array;
	private readonly predRe: Float64Array;
	private readonly predIm: Float64Array;
	// per band
	private readonly energy: Float64Array;
	private readonly smoothed: Float64Array;
	private readonly mapBin: Float64Array;
	private readonly mapGrad: Float64Array;
	private readonly formantMetric: Float64Array;
	private readonly peakIn: Float64Array;
	private readonly peakOut: Float64Array;
	private peakCount = 0;
	private readonly x: Float64Array;
	private rng = new Prng(SEED);

	private freqMultiplier = 1;
	private tonalityLimit = 1;
	private formantMultiplier = 1;
	private invFormantMultiplier = 1;
	private formantCompensation = false;
	private formantBaseFreq = 0;
	private freqEstimateWeighted = 0;
	private freqEstimateWeight = 0;

	private samplesSinceLast = Number.POSITIVE_INFINITY;
	/** Input sample count since the reset, and the position of the last spectrum. */
	private pos = 0;
	private prevBlockPos = -1;
	private quietCount = 0;
	private quietFirst = true;

	constructor(channels: number, block: number, interval: number) {
		this.channels = Math.max(1, channels);
		this.interval = interval;
		this.stft = new Stft(this.channels, block, interval);
		const bands = this.stft.bands;
		this.bands = bands;
		const cb = bands * this.channels;
		this.inRe = new Float64Array(cb);
		this.inIm = new Float64Array(cb);
		this.prevRe = new Float64Array(cb);
		this.prevIm = new Float64Array(cb);
		this.outRe = new Float64Array(cb);
		this.outIm = new Float64Array(cb);
		this.inEnergy = new Float64Array(cb);
		this.predEnergy = new Float64Array(cb);
		this.predRe = new Float64Array(cb);
		this.predIm = new Float64Array(cb);
		this.energy = new Float64Array(bands);
		this.smoothed = new Float64Array(bands);
		this.mapBin = new Float64Array(bands);
		this.mapGrad = new Float64Array(bands);
		this.formantMetric = new Float64Array(bands + 2);
		this.peakIn = new Float64Array(bands);
		this.peakOut = new Float64Array(bands);
		this.x = new Float64Array(this.channels);
	}

	/** Input-to-output delay in samples (analysis + synthesis latency = the block length). */
	latency(): number {
		return this.stft.block - this.stft.offset + this.stft.offset;
	}

	reset(): void {
		this.stft.reset(0.1);
		this.inRe.fill(0);
		this.inIm.fill(0);
		this.prevRe.fill(0);
		this.prevIm.fill(0);
		this.outRe.fill(0);
		this.outIm.fill(0);
		this.inEnergy.fill(0);
		this.predEnergy.fill(0);
		this.predRe.fill(0);
		this.predIm.fill(0);
		this.samplesSinceLast = Number.POSITIVE_INFINITY;
		this.pos = 0;
		this.prevBlockPos = -1;
		this.quietCount = 0;
		this.quietFirst = true;
		this.freqEstimateWeighted = 0;
		this.freqEstimateWeight = 0;
		this.rng = new Prng(SEED);
	}

	/** Frequency multiplier with a tonality limit (normalised frequency; 0 = none), from the next spectrum on. */
	setTransposeFactor(multiplier: number, tonalityLimit = 0): void {
		this.freqMultiplier = multiplier;
		this.tonalityLimit = tonalityLimit > 0 ? tonalityLimit / Math.sqrt(multiplier) : 1;
	}

	setFormantFactor(multiplier: number, compensatePitch: boolean): void {
		this.formantMultiplier = multiplier;
		this.invFormantMultiplier = 1 / multiplier;
		this.formantCompensation = compensatePitch;
	}

	/** Rough fundamental (normalised frequency) for the formant envelope; 0 = estimate it. */
	setFormantBase(freq: number): void {
		this.formantBaseFreq = freq;
	}

	/** Processes `[start, end)` of the first `channels` channels in place. */
	process(ch: readonly Float32Array[], start: number, end: number, flush: (v: number) => number): void {
		const nch = Math.min(ch.length, this.channels);
		const stft = this.stft;
		const x = this.x;
		const twoBlocks = 2 * stft.block;
		for (let i = start; i < end; i++) {
			let e = 0;
			for (let c = 0; c < this.channels; c++) {
				const v = c < nch ? ch[c]![i]! : 0;
				x[c] = v;
				e += v * v;
			}
			let quiet = false;
			if (e < NOISE_FLOOR) {
				if (this.quietCount >= twoBlocks) quiet = true;
				else this.quietCount++;
			} else {
				this.quietCount = 0;
				this.quietFirst = true;
			}
			if (quiet) {
				// Silence bypass: the output is the (sub-noise-floor) input; the history keeps filling.
				if (this.quietFirst) {
					this.quietFirst = false;
					this.samplesSinceLast = Number.POSITIVE_INFINITY;
					this.inRe.fill(0);
					this.inIm.fill(0);
					this.prevRe.fill(0);
					this.prevIm.fill(0);
					this.outRe.fill(0);
					this.outIm.fill(0);
					this.inEnergy.fill(0);
				}
			} else {
				if (this.samplesSinceLast >= this.interval) {
					const inputInterval = this.pos - this.prevBlockPos;
					this.prevBlockPos = this.pos;
					this.computeBlock(inputInterval);
					this.samplesSinceLast = 0;
				}
				this.samplesSinceLast++;
				const p = stft.outPos;
				const wp = stft.wp[p]!;
				for (let c = 0; c < nch; c++) ch[c]![i] = flush(stft.outBuf[c]![p]! / wp);
				stft.moveOutput(1);
			}
			const ip = stft.inPos;
			for (let c = 0; c < this.channels; c++) stft.inBuf[c]![ip] = x[c]!;
			stft.inPos = ip + 1 === stft.inputLength ? 0 : ip + 1;
			this.pos++;
		}
	}

	private computeBlock(inputInterval: number): void {
		const stft = this.stft;
		const bands = this.bands;
		const C = this.channels;
		const interval = this.interval;
		const mapped = this.freqMultiplier !== 1;
		const reanalysePrev = Math.abs(inputInterval - interval) > 1;
		const processFormants = this.formantMultiplier !== 1 || (this.formantCompensation && mapped);
		let timeFactor = interval / Math.max(1, inputInterval);

		if (reanalysePrev)
			for (let c = 0; c < C; c++) {
				stft.analyse(c, interval);
				this.prevRe.set(stft.specRe[c]!, c * bands);
				this.prevIm.set(stft.specIm[c]!, c * bands);
			}
		for (let c = 0; c < C; c++) {
			stft.analyse(c, 0);
			this.inRe.set(stft.specRe[c]!, c * bands);
			this.inIm.set(stft.specIm[c]!, c * bands);
		}

		const smoothingBins = stft.fftSize / interval;
		const longStep = Math.round(smoothingBins);
		timeFactor = Math.max(timeFactor, 1 / MAX_CLEAN_STRETCH);
		const randomTimeFactor = timeFactor > MAX_CLEAN_STRETCH;
		const randLo = MAX_CLEAN_STRETCH * 2 * (randomTimeFactor ? 1 : 0) - timeFactor;
		const randSpan = timeFactor - randLo;

		// rotate the previous output and input by one interval of each band's frequency
		{
			const a0 = stft.binToFreq(0) * interval * 2 * Math.PI;
			const da = (stft.binToFreq(1) - stft.binToFreq(0)) * interval * 2 * Math.PI;
			const sr = Math.sin(da);
			const cr = Math.cos(da);
			for (let c = 0; c < C; c++) {
				let rr = Math.cos(a0);
				let ri = Math.sin(a0);
				const o = c * bands;
				for (let b = 0; b < bands; b++) {
					const k = o + b;
					let re = this.outRe[k]!;
					let im = this.outIm[k]!;
					this.outRe[k] = re * rr - im * ri;
					this.outIm[k] = re * ri + im * rr;
					re = this.prevRe[k]!;
					im = this.prevIm[k]!;
					this.prevRe[k] = re * rr - im * ri;
					this.prevIm[k] = re * ri + im * rr;
					const nr = rr * cr - ri * sr;
					ri = rr * sr + ri * cr;
					rr = nr;
				}
			}
		}

		if (mapped) {
			this.smoothEnergy(smoothingBins);
			this.findPeaks();
			this.updateOutputMap();
		} else {
			for (let k = 0; k < C * bands; k++) this.inEnergy[k] = this.inRe[k]! ** 2 + this.inIm[k]! ** 2;
			for (let b = 0; b < bands; b++) {
				this.mapBin[b] = b;
				this.mapGrad[b] = 1;
			}
		}
		if (processFormants) this.updateFormants();

		// preliminary output prediction from the phase vocoder
		for (let c = 0; c < C; c++) {
			const o = c * bands;
			for (let b = 0; b < bands; b++) {
				const inBin = this.mapBin[b]!;
				const lo = Math.floor(inBin);
				const fr = inBin - lo;
				const k = o + b;
				const prevEnergy = this.predEnergy[k]!;
				const en = this.frac(this.inEnergy, o, lo, fr) * Math.max(0, this.mapGrad[b]!);
				this.predEnergy[k] = en;
				const ir = this.frac(this.inRe, o, lo, fr);
				const ii = this.frac(this.inIm, o, lo, fr);
				this.predRe[k] = ir;
				this.predIm[k] = ii;
				const pr = this.frac(this.prevRe, o, lo, fr);
				const pi = this.frac(this.prevIm, o, lo, fr);
				// twist = input · conj(prevInput); phase = output · twist
				const tr = ir * pr + ii * pi;
				const ti = ii * pr - ir * pi;
				const orr = this.outRe[k]!;
				const oi = this.outIm[k]!;
				const d = Math.max(prevEnergy, en) + NOISE_FLOOR;
				this.outRe[k] = (orr * tr - oi * ti) / d;
				this.outIm[k] = (orr * ti + oi * tr) / d;
			}
		}

		// re-predict from the phase differences between neighbouring frequencies
		for (let b = 0; b < bands; b++) {
			let maxC = 0;
			let maxE = this.predEnergy[b]!;
			for (let c = 1; c < C; c++) {
				const e = this.predEnergy[c * bands + b]!;
				if (e > maxE) {
					maxC = c;
					maxE = e;
				}
			}
			const o = maxC * bands;
			const k = o + b;
			const pir = this.predRe[k]!;
			const pii = this.predIm[k]!;
			let phR = 0;
			let phI = 0;
			const inBin = this.mapBin[b]!;
			if (b > 0) {
				const tf = randomTimeFactor ? randLo + randSpan * this.rand() : timeFactor;
				let at = inBin - tf;
				let lo = Math.floor(at);
				let dr = this.frac(this.inRe, o, lo, at - lo);
				let di = this.frac(this.inIm, o, lo, at - lo);
				// twist = pred.input · conj(down); phase += out[b−1] · twist
				let tr = pir * dr + pii * di;
				let ti = pii * dr - pir * di;
				let ur = this.outRe[k - 1]!;
				let ui = this.outIm[k - 1]!;
				phR += ur * tr - ui * ti;
				phI += ur * ti + ui * tr;
				if (b >= longStep) {
					at = inBin - longStep * tf;
					lo = Math.floor(at);
					dr = this.frac(this.inRe, o, lo, at - lo);
					di = this.frac(this.inIm, o, lo, at - lo);
					tr = pir * dr + pii * di;
					ti = pii * dr - pir * di;
					ur = this.outRe[k - longStep]!;
					ui = this.outIm[k - longStep]!;
					phR += ur * tr - ui * ti;
					phI += ur * ti + ui * tr;
				}
			}
			if (b < bands - 1) {
				const tf = randomTimeFactor ? randLo + randSpan * this.rand() : timeFactor;
				let at = this.mapBin[b + 1]! - tf;
				let lo = Math.floor(at);
				let dr = this.frac(this.inRe, o, lo, at - lo);
				let di = this.frac(this.inIm, o, lo, at - lo);
				let upr = this.predRe[k + 1]!;
				let upi = this.predIm[k + 1]!;
				let tr = upr * dr + upi * di;
				let ti = upi * dr - upr * di;
				// phase += out[b+1] · conj(twist)
				let ur = this.outRe[k + 1]!;
				let ui = this.outIm[k + 1]!;
				phR += ur * tr + ui * ti;
				phI += ui * tr - ur * ti;
				if (b < bands - longStep) {
					at = this.mapBin[b + longStep]! - longStep * tf;
					lo = Math.floor(at);
					dr = this.frac(this.inRe, o, lo, at - lo);
					di = this.frac(this.inIm, o, lo, at - lo);
					upr = this.predRe[k + longStep]!;
					upi = this.predIm[k + longStep]!;
					tr = upr * dr + upi * di;
					ti = upi * dr - upr * di;
					ur = this.outRe[k + longStep]!;
					ui = this.outIm[k + longStep]!;
					phR += ur * tr + ui * ti;
					phI += ui * tr - ur * ti;
				}
			}
			this.makeOutput(k, phR, phI);
			// the other channels are locked in phase to the loudest
			for (let c = 0; c < C; c++) {
				if (c === maxC) continue;
				const kc = c * bands + b;
				const cr = this.predRe[kc]!;
				const ci = this.predIm[kc]!;
				// channelTwist = chPred.input · conj(pred.input); phase = out[max] · channelTwist
				const tr = cr * pir + ci * pii;
				const ti = ci * pir - cr * pii;
				const or = this.outRe[k]!;
				const oi = this.outIm[k]!;
				this.makeOutput(kc, or * tr - oi * ti, or * ti + oi * tr);
			}
		}
		this.prevRe.set(this.inRe);
		this.prevIm.set(this.inIm);

		for (let c = 0; c < C; c++) {
			stft.specRe[c]!.set(this.outRe.subarray(c * bands, (c + 1) * bands));
			stft.specIm[c]!.set(this.outIm.subarray(c * bands, (c + 1) * bands));
			stft.synthesise(c);
		}
	}

	private rand(): number {
		return this.rng.nextU32() / 4294967296;
	}

	/** Linear interpolation of a per-band array (0 outside the bands). */
	private frac(a: Float64Array, o: number, lo: number, fr: number): number {
		const bands = this.bands;
		const l = lo >= 0 && lo < bands ? a[o + lo]! : 0;
		const h = lo + 1 >= 0 && lo + 1 < bands ? a[o + lo + 1]! : 0;
		return l + (h - l) * fr;
	}

	/** Prediction.makeOutput: the phase of `ph` with the predicted energy (falls back to the input's phase). */
	private makeOutput(k: number, phR: number, phI: number): void {
		let norm = phR * phR + phI * phI;
		if (norm <= NOISE_FLOOR) {
			phR = this.predRe[k]!;
			phI = this.predIm[k]!;
			norm = phR * phR + phI * phI + NOISE_FLOOR;
		}
		const g = Math.sqrt(this.predEnergy[k]! / norm);
		this.outRe[k] = phR * g;
		this.outIm[k] = phI * g;
	}

	private smoothEnergy(smoothingBins: number): void {
		const bands = this.bands;
		const slew = 1 / (1 + smoothingBins * 0.5);
		const energy = this.energy;
		const s = this.smoothed;
		energy.fill(0);
		for (let c = 0; c < this.channels; c++) {
			const o = c * bands;
			for (let b = 0; b < bands; b++) {
				const e = this.inRe[o + b]! ** 2 + this.inIm[o + b]! ** 2;
				this.inEnergy[o + b] = e;
				energy[b] = energy[b]! + e;
			}
		}
		s.set(energy);
		let e = 0;
		for (let pass = 0; pass < 2; pass++) {
			for (let b = bands - 1; b >= 0; --b) {
				e += (s[b]! - e) * slew;
				s[b] = e;
			}
			for (let b = 0; b < bands; ++b) {
				e += (s[b]! - e) * slew;
				s[b] = e;
			}
		}
	}

	private mapFreq(freq: number): number {
		if (freq > this.tonalityLimit) return freq + (this.freqMultiplier - 1) * this.tonalityLimit;
		return freq * this.freqMultiplier;
	}

	private findPeaks(): void {
		const bands = this.bands;
		const energy = this.energy;
		const s = this.smoothed;
		this.peakCount = 0;
		let start = 0;
		while (start < bands) {
			if (energy[start]! > s[start]!) {
				let end = start;
				let bandSum = 0;
				let energySum = 0;
				while (end < bands && energy[end]! > s[end]!) {
					bandSum += end * energy[end]!;
					energySum += energy[end]!;
					++end;
				}
				const avgBand = bandSum / energySum;
				const avgFreq = this.stft.binToFreq(avgBand);
				this.peakIn[this.peakCount] = avgBand;
				this.peakOut[this.peakCount] = this.stft.freqToBin(this.mapFreq(avgFreq));
				this.peakCount++;
				start = end;
			}
			++start;
		}
	}

	private updateOutputMap(): void {
		const bands = this.bands;
		const n = this.peakCount;
		const pin = this.peakIn;
		const pout = this.peakOut;
		if (n === 0) {
			for (let b = 0; b < bands; b++) {
				this.mapBin[b] = b;
				this.mapGrad[b] = 1;
			}
			return;
		}
		const bottomOffset = pin[0]! - pout[0]!;
		const e0 = Math.min(bands, Math.ceil(pout[0]!));
		for (let b = 0; b < e0; ++b) {
			this.mapBin[b] = b + bottomOffset;
			this.mapGrad[b] = 1;
		}
		for (let p = 1; p < n; ++p) {
			const prevIn = pin[p - 1]!;
			const prevOut = pout[p - 1]!;
			const nextIn = pin[p]!;
			const nextOut = pout[p]!;
			const rangeScale = 1 / (nextOut - prevOut);
			const outOffset = prevIn - prevOut;
			const outScale = nextIn - nextOut - prevIn + prevOut;
			const gradScale = outScale * rangeScale;
			const startBin = Math.max(0, Math.ceil(prevOut));
			const endBin = Math.min(bands, Math.ceil(nextOut));
			for (let b = startBin; b < endBin; ++b) {
				const r = (b - prevOut) * rangeScale;
				const h = r * r * (3 - 2 * r);
				this.mapBin[b] = b + outOffset + h * outScale;
				this.mapGrad[b] = 1 + 6 * r * (1 - r) * gradScale;
			}
		}
		const topOffset = pin[n - 1]! - pout[n - 1]!;
		for (let b = Math.max(0, Math.trunc(pout[n - 1]!)); b < bands; ++b) {
			this.mapBin[b] = b + topOffset;
			this.mapGrad[b] = 1;
		}
	}

	private invMapFormant(freq: number): number {
		if (freq * this.invFormantMultiplier > this.tonalityLimit)
			return freq + (1 - this.formantMultiplier) * this.tonalityLimit;
		return freq * this.invFormantMultiplier;
	}

	private estimateFrequency(): number {
		const fm = this.formantMetric;
		const bands = this.bands;
		let p0 = 0;
		let p1 = 0;
		let p2 = 0;
		for (let b = 1; b < bands - 1; ++b) {
			const e = fm[b]!;
			if (e < fm[b - 1]! || e <= fm[b + 1]!) continue;
			if (e > fm[p0]!) {
				if (e > fm[p1]!) {
					if (e > fm[p2]!) {
						p0 = p1;
						p1 = p2;
						p2 = b;
					} else {
						p0 = p1;
						p1 = b;
					}
				} else p0 = b;
			}
		}
		let est = p2;
		if (fm[p1]! > fm[p2]! * 0.1) {
			let diff = Math.abs(est - p1);
			if (diff > Math.floor(est / 8) && diff < Math.floor((est * 7) / 8)) est = est % diff;
			if (fm[p0]! > fm[p2]! * 0.01) {
				diff = Math.abs(est - p0);
				if (diff > Math.floor(est / 8) && diff < Math.floor((est * 7) / 8)) est = est % diff;
			}
		}
		const weight = fm[p2]!;
		this.freqEstimateWeighted += (est * weight - this.freqEstimateWeighted) * 0.25;
		this.freqEstimateWeight += (weight - this.freqEstimateWeight) * 0.25;
		return this.freqEstimateWeighted / (this.freqEstimateWeight + 1e-30);
	}

	private updateFormants(): void {
		const bands = this.bands;
		const fm = this.formantMetric;
		const stft = this.stft;
		fm.fill(0);
		for (let c = 0; c < this.channels; c++) {
			const o = c * bands;
			for (let b = 0; b < bands; b++) fm[b] = fm[b]! + this.inEnergy[o + b]!;
		}
		const freqEstimate =
			this.formantBaseFreq > 0 ? stft.freqToBin(this.formantBaseFreq) : this.estimateFrequency();
		// spectral envelope: peak-hold with exponential decay (max passes), then the matching min passes
		let decay = 1 - 1 / (freqEstimate * 0.5 + 1);
		let e = 0;
		for (let rep = 0; rep < 2; rep++) {
			for (let b = bands - 1; b >= 0; --b) {
				const t = e * decay;
				e = fm[b]! < t ? t : fm[b]!;
				fm[b] = e;
			}
			for (let b = 0; b < bands; ++b) {
				const t = e * decay;
				e = fm[b]! < t ? t : fm[b]!;
				fm[b] = e;
			}
		}
		decay = 1 / decay;
		for (let rep = 0; rep < 2; rep++) {
			for (let b = bands - 1; b >= 0; --b) {
				const t = e * decay;
				e = t < fm[b]! ? t : fm[b]!;
				fm[b] = e;
			}
			for (let b = 0; b < bands; ++b) {
				const t = e * decay;
				e = t < fm[b]! ? t : fm[b]!;
				fm[b] = e;
			}
		}
		for (let b = 0; b < bands; b++) {
			const inputF = stft.binToFreq(b);
			let outputF = this.formantCompensation ? this.mapFreq(inputF) : inputF;
			outputF = this.invMapFormant(outputF);
			const inputE = fm[b]!;
			let band = stft.freqToBin(outputF);
			let targetE = 0;
			if (band >= 0) {
				band = Math.min(band, bands);
				const fb = Math.floor(band);
				targetE = fm[fb]! + (fm[fb + 1]! - fm[fb]!) * (band - fb);
			}
			const ratio = targetE / (inputE + 1e-30);
			for (let c = 0; c < this.channels; c++)
				this.inEnergy[c * bands + b] = this.inEnergy[c * bands + b]! * ratio;
		}
	}
}
