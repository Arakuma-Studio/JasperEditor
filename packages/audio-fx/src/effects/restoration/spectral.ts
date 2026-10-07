// DeNoise and DeReverb: STFT spectral processors (ported from filmcraft `effects/restoration.rs` DeNoise and
// `essential.rs` DeReverb). Each channel has its own streaming STFT (√Hann analysis/synthesis, 75 % overlap,
// latency = FFT size); the per-channel frame callbacks are created once.
import { EffectBase } from '../../core/effect.ts';
import { dbToGain, flush32 } from '../../core/math.ts';
import { Smoothed } from '../../core/smooth.ts';
import { fftSize, Spectral, StftChannel } from '../../core/stft.ts';

/** Minimum-statistics sub-windows. */
const MS_SUBWINDOWS = 8;
/** Length of the minimum-statistics search window (s). */
const MS_WINDOW_S = 1.5;
/** Bias compensation of the minimum of smoothed periodograms (≈ +4 dB). */
const MS_BIAS = 2.5;
const PSD_SMOOTH = 0.8;

class NoiseState {
	readonly psd: Float64Array;
	readonly curMin: Float64Array;
	readonly ring: Float64Array;
	ringPos = 0;
	framesInSub = 0;
	readonly gains: Float64Array;
	started = false;
	/** Learned noise print (mean PSD over the learning frames) and its frame count. */
	readonly print: Float64Array;
	printFrames = 0;
	constructor(readonly bins: number) {
		this.psd = new Float64Array(bins);
		this.curMin = new Float64Array(bins).fill(Number.POSITIVE_INFINITY);
		this.ring = new Float64Array(bins * MS_SUBWINDOWS).fill(Number.POSITIVE_INFINITY);
		this.gains = new Float64Array(bins).fill(1);
		this.print = new Float64Array(bins);
	}
	reset(): void {
		this.psd.fill(0);
		this.curMin.fill(Number.POSITIVE_INFINITY);
		this.ring.fill(Number.POSITIVE_INFINITY);
		this.gains.fill(1);
		this.ringPos = 0;
		this.framesInSub = 0;
		this.started = false;
		this.print.fill(0);
		this.printFrames = 0;
	}
}

/**
 * DeNoise: spectral gating. The noise floor of every bin is tracked with minimum statistics (`adaptive`), or taken
 * from a noise print: while Noise Model is `learn` the processor averages the spectrum (and passes audio unchanged);
 * `print` then gates against that print (keyframe the model to Learn over a noise-only stretch, then to Use Noise
 * Print). Bins that do not rise above `floor × threshold` are attenuated by `reduction`, with per-bin attack/release
 * and 3-tap frequency smoothing against musical noise. Without a learned print, `print` falls back to adaptive.
 */
export class DeNoise extends EffectBase {
	private readonly n: number;
	private readonly hop: number;
	private readonly subFrames: number;
	private readonly spectral: Spectral;
	private readonly stft: StftChannel[];
	private readonly noise: NoiseState[];
	private readonly frames: ((input: Float64Array, out: Float64Array) => void)[];
	private readonly sg: Float64Array;
	private floor = 1;
	private thr = 1;
	private release = 0.5;
	private model = 0;
	private readonly gain: Smoothed;

	constructor(sr: number, ch: number) {
		super('jasper.audio.denoise', sr, ch);
		this.n = fftSize(sr);
		this.hop = this.n / 4;
		const bins = this.n / 2 + 1;
		this.subFrames = Math.max(1, Math.round((MS_WINDOW_S * sr) / this.hop / MS_SUBWINDOWS));
		this.spectral = new Spectral(this.n, true);
		const nch = Math.max(1, ch);
		this.stft = Array.from({ length: nch }, () => new StftChannel(this.n));
		this.noise = Array.from({ length: nch }, () => new NoiseState(bins));
		this.sg = new Float64Array(bins);
		this.frames = this.noise.map((st) => (input, out) => this.frame(st, input, out));
		this.gain = Smoothed.withMs(1, sr, 20);
		this.applyParams(true);
	}

	protected applyParams(snap: boolean): void {
		this.floor = dbToGain(-this.pv.v('reduction'));
		this.thr = 10 ** (this.pv.v('threshold') / 10);
		// 0 % → fast (0.6 per frame), 100 % → slow (0.03 per frame).
		this.release = 0.6 - (0.57 * this.pv.v('smoothing')) / 100;
		this.model = this.pv.idx('noiseModel');
		this.gain.set(dbToGain(this.pv.v('gain')));
		if (snap) this.gain.snap();
	}

	latency(): number {
		return this.n;
	}

	reset(): void {
		for (const s of this.stft) s.reset();
		for (const s of this.noise) s.reset();
		this.gain.snap();
	}

	private frame(st: NoiseState, input: Float64Array, out: Float64Array): void {
		const spec = this.spectral;
		spec.analyse(input);
		const bins = this.n / 2 + 1;
		const re = spec.re;
		const im = spec.im;
		for (let k = 0; k < bins; k++) {
			const p = re[k]! * re[k]! + im[k]! * im[k]!;
			st.psd[k] = st.started ? PSD_SMOOTH * st.psd[k]! + (1 - PSD_SMOOTH) * p : p;
			if (st.psd[k]! < st.curMin[k]!) st.curMin[k] = st.psd[k]!;
		}
		st.started = true;
		st.framesInSub++;
		const rotate = st.framesInSub === this.subFrames;
		const learning = this.model === 1;
		const usePrint = this.model === 2 && st.printFrames > 0;
		if (learning) {
			// Running mean of the raw periodogram (one frame = one observation).
			st.printFrames++;
			const w = 1 / st.printFrames;
			for (let k = 0; k < bins; k++) {
				const p = re[k]! * re[k]! + im[k]! * im[k]!;
				st.print[k] = st.print[k]! + (p - st.print[k]!) * w;
			}
		}
		for (let k = 0; k < bins; k++) {
			let m = st.curMin[k]!;
			for (let u = 0; u < MS_SUBWINDOWS; u++) {
				const r = st.ring[u * bins + k]!;
				if (r < m) m = r;
			}
			const noise = usePrint ? st.print[k]! : m * MS_BIAS;
			const target = learning ? 1 : st.psd[k]! > noise * this.thr ? 1 : this.floor;
			const g = st.gains[k]!;
			const c = target > g ? 0.7 : this.release;
			st.gains[k] = g + (target - g) * c;
			if (rotate) {
				st.ring[st.ringPos * bins + k] = st.curMin[k]!;
				st.curMin[k] = Number.POSITIVE_INFINITY;
			}
		}
		if (rotate) {
			st.ringPos = (st.ringPos + 1) % MS_SUBWINDOWS;
			st.framesInSub = 0;
		}
		const sg = this.sg;
		for (let k = 0; k < bins; k++) {
			const a = st.gains[k > 0 ? k - 1 : 0]!;
			const b = st.gains[k]!;
			const c = st.gains[k + 1 < bins ? k + 1 : bins - 1]!;
			sg[k] = 0.25 * a + 0.5 * b + 0.25 * c;
		}
		for (let k = 0; k < bins; k++) {
			re[k] = re[k]! * sg[k]!;
			im[k] = im[k]! * sg[k]!;
		}
		spec.synthesiseAdd(out, 1 / (this.n * 2));
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.stft.length);
		const hop = this.hop;
		for (let c = 0; c < nch; c++) {
			const buf = ch[c]!;
			const st = this.stft[c]!;
			const f = this.frames[c]!;
			for (let i = start; i < end; i++) buf[i] = flush32(st.tick(buf[i]!, hop, f));
		}
		// Output gain (shared smoother: one tick per sample).
		for (let i = start; i < end; i++) {
			const g = this.gain.tick();
			if (g !== 1) for (let c = 0; c < nch; c++) ch[c]![i] = ch[c]![i]! * g;
		}
	}
}

/** Late-reverberation delay T_d (s): reflections later than this count as reverb. */
const DEREVERB_TD = 0.05;
/** Time constant (s) of the PSD smoothing. */
const DEREVERB_PSD_TAU = 0.02;

class ReverbState {
	readonly psd: Float64Array;
	readonly hist: Float64Array;
	pos = 0;
	readonly gains: Float64Array;
	frames = 0;
	constructor(bins: number, delay: number) {
		this.psd = new Float64Array(bins);
		this.hist = new Float64Array(bins * delay);
		this.gains = new Float64Array(bins).fill(1);
	}
	reset(): void {
		this.psd.fill(0);
		this.hist.fill(0);
		this.gains.fill(1);
		this.pos = 0;
		this.frames = 0;
	}
}

/**
 * DeReverb: suppresses the late reverberant tail predicted by the statistical model (Polack; Lebart et al. 2001,
 * Habets 2007): λ_r(t) = e^{−2Δ·T_d}·λ_x(t − T_d), Δ = 3·ln10 / RT60, removed by spectral subtraction with
 * over-subtraction 1 + amount and a gain floor (0 % = identity apart from the STFT delay, 100 % ≈ −18 dB floor).
 */
export class DeReverb extends EffectBase {
	private readonly n: number;
	private readonly hop: number;
	private readonly delay: number;
	private readonly spectral: Spectral;
	private readonly stft: StftChannel[];
	private readonly state: ReverbState[];
	private readonly frames: ((input: Float64Array, out: Float64Array) => void)[];
	private readonly sg: Float64Array;
	private decay = 1;
	private beta = 1;
	private floor = 1;
	private readonly alpha: number;

	constructor(sr: number, ch: number) {
		super('jasper.audio.dereverb', sr, ch);
		this.n = fftSize(sr);
		this.hop = this.n / 4;
		const bins = this.n / 2 + 1;
		this.delay = Math.max(1, Math.round((DEREVERB_TD * sr) / this.hop));
		this.spectral = new Spectral(this.n, true);
		const nch = Math.max(1, ch);
		this.stft = Array.from({ length: nch }, () => new StftChannel(this.n));
		this.state = Array.from({ length: nch }, () => new ReverbState(bins, this.delay));
		this.sg = new Float64Array(bins);
		this.alpha = Math.exp(-this.hop / (sr * DEREVERB_PSD_TAU));
		this.frames = this.state.map((st) => (input, out) => this.frame(st, input, out));
		this.applyParams();
	}

	protected applyParams(): void {
		const amount = this.pv.v('amount') / 100;
		const rt60 = this.pv.v('rt60');
		const delta = (3 * Math.LN10) / rt60;
		const td = (this.delay * this.hop) / this.sampleRate;
		this.decay = Math.exp(-2 * delta * td);
		this.beta = 1 + amount;
		this.floor = dbToGain(-18 * amount);
	}

	latency(): number {
		return this.n;
	}

	reset(): void {
		for (const s of this.stft) s.reset();
		for (const s of this.state) s.reset();
	}

	private frame(st: ReverbState, input: Float64Array, out: Float64Array): void {
		const spec = this.spectral;
		spec.analyse(input);
		const bins = this.n / 2 + 1;
		const re = spec.re;
		const im = spec.im;
		const warm = st.frames >= this.delay;
		const base = st.pos * bins;
		const a = this.alpha;
		for (let k = 0; k < bins; k++) {
			const p = re[k]! * re[k]! + im[k]! * im[k]!;
			const psd = a * st.psd[k]! + (1 - a) * p;
			st.psd[k] = psd < 1e-30 ? 0 : psd;
			const late = warm ? this.decay * st.hist[base + k]! : 0;
			st.hist[base + k] = st.psd[k]!;
			const target = st.psd[k]! > 0 ? Math.max(1 - (this.beta * late) / st.psd[k]!, this.floor) : 1;
			const g = st.gains[k]!;
			const c = target > g ? 0.8 : 0.5;
			st.gains[k] = g + (target - g) * c;
		}
		st.pos = (st.pos + 1) % this.delay;
		st.frames++;
		const sg = this.sg;
		for (let k = 0; k < bins; k++) {
			const l = st.gains[k > 0 ? k - 1 : 0]!;
			const r = st.gains[k + 1 < bins ? k + 1 : bins - 1]!;
			sg[k] = 0.25 * l + 0.5 * st.gains[k]! + 0.25 * r;
		}
		for (let k = 0; k < bins; k++) {
			re[k] = re[k]! * sg[k]!;
			im[k] = im[k]! * sg[k]!;
		}
		spec.synthesiseAdd(out, 1 / (this.n * 2));
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.stft.length);
		for (let c = 0; c < nch; c++) {
			const buf = ch[c]!;
			const st = this.stft[c]!;
			const f = this.frames[c]!;
			for (let i = start; i < end; i++) buf[i] = flush32(st.tick(buf[i]!, this.hop, f));
		}
	}
}
