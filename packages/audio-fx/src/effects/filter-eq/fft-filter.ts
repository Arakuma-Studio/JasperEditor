// FFT Filter (port of filmcraft `effects/filters.rs` FftFilter): a zero-phase frequency-domain gain curve (8 points
// interpolated in log frequency) applied with a √Hann STFT at 75 % overlap. Latency = FFT size; curve changes glide
// over a few frames.
import { EffectBase } from '../../core/effect.ts';
import { dbToGain } from '../../core/math.ts';
import { fftSize, Spectral, StftChannel } from '../../core/stft.ts';

/** Number of curve points. */
export const FFT_POINTS = 8;
const POINT_NAMES = Array.from({ length: FFT_POINTS }, (_, i) => [`p${i + 1}Freq`, `p${i + 1}Gain`] as const);

/**
 * Gain (dB) of the curve at `freq` for points sorted by frequency (`fs[i]`, `gs[i]`, `n` of them): constant beyond
 * the end points, interpolated in log-frequency between them (linearly or with a smoothstep).
 */
function curveSorted(fs: Float64Array, gs: Float64Array, n: number, freq: number, smooth: boolean): number {
	if (n === 0) return 0;
	if (freq <= fs[0]!) return gs[0]!;
	for (let i = 0; i + 1 < n; i++) {
		const f0 = fs[i]!;
		const f1 = fs[i + 1]!;
		if (freq <= f1) {
			const span = Math.log2(f1 / f0);
			let t = span > 0 ? Math.log2(freq / f0) / span : 1;
			if (smooth) t = t * t * (3 - 2 * t);
			return gs[i]! + (gs[i + 1]! - gs[i]!) * t;
		}
	}
	return gs[n - 1]!;
}

export class FftFilter extends EffectBase {
	private readonly n: number;
	private readonly hop: number;
	private readonly spectral: Spectral;
	private readonly stft: StftChannel[] = [];
	/** One frame callback per channel (allocated once). */
	private readonly frames: ((input: Float64Array, out: Float64Array) => void)[] = [];
	/** Target and current per-bin linear gains. */
	private readonly targetGains: Float64Array;
	private readonly gains: Float64Array;
	private readonly order: number[] = Array.from({ length: FFT_POINTS }, (_, i) => i);
	private readonly fs = new Float64Array(FFT_POINTS);
	private readonly gs = new Float64Array(FFT_POINTS);

	constructor(sampleRate: number, channels: number) {
		super('jasper.audio.fft-filter', sampleRate, channels);
		const n = fftSize(sampleRate);
		this.n = n;
		this.hop = n / 4;
		this.spectral = new Spectral(n, true);
		const bins = n / 2 + 1;
		this.targetGains = new Float64Array(bins).fill(1);
		this.gains = new Float64Array(bins).fill(1);
		for (let c = 0; c < Math.max(1, channels); c++) {
			this.stft.push(new StftChannel(n));
			// Every channel frames at the same samples; the gains glide once per frame (on channel 0).
			const first = c === 0;
			this.frames.push((input, out) => this.frame(first, input, out));
		}
		this.applyParams(true);
	}

	/** Sorts the curve points into `fs`/`gs`. */
	private loadPoints(): void {
		const pv = this.pv;
		this.order.sort((a, b) => pv.v(POINT_NAMES[a]![0]) - pv.v(POINT_NAMES[b]![0]) || a - b);
		for (let i = 0; i < FFT_POINTS; i++) {
			const [f, g] = POINT_NAMES[this.order[i]!]!;
			this.fs[i] = pv.v(f);
			this.gs[i] = pv.v(g);
		}
	}

	protected applyParams(snap: boolean): void {
		this.loadPoints();
		const smooth = this.pv.idx('interp') === 1;
		const bins = this.n / 2 + 1;
		for (let k = 0; k < bins; k++) {
			const f = Math.max((k * this.sampleRate) / this.n, 1);
			this.targetGains[k] = dbToGain(curveSorted(this.fs, this.gs, FFT_POINTS, f, smooth));
		}
		if (snap) this.gains.set(this.targetGains);
	}

	latency(): number {
		return this.n;
	}

	responseDb(freq: number): number {
		return curveSorted(this.fs, this.gs, FFT_POINTS, freq, this.pv.idx('interp') === 1);
	}

	reset(): void {
		for (const s of this.stft) s.reset();
		this.gains.set(this.targetGains);
	}

	private frame(first: boolean, input: Float64Array, out: Float64Array): void {
		const bins = this.n / 2 + 1;
		const gains = this.gains;
		if (first) {
			const target = this.targetGains;
			for (let k = 0; k < bins; k++) gains[k] = gains[k]! + (target[k]! - gains[k]!) * 0.5;
		}
		const sp = this.spectral;
		sp.analyse(input);
		for (let k = 0; k < bins; k++) {
			sp.re[k] = sp.re[k]! * gains[k]!;
			sp.im[k] = sp.im[k]! * gains[k]!;
		}
		sp.synthesiseAdd(out, 1 / (this.n * 2));
	}

	process(channels: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(channels.length, this.stft.length);
		const hop = this.hop;
		for (let i = start; i < end; i++)
			for (let ch = 0; ch < nch; ch++) {
				const buf = channels[ch]!;
				buf[i] = this.stft[ch]!.tick(buf[i]!, hop, this.frames[ch]!);
			}
	}
}
