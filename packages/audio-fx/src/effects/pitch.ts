// Pitch Shifter (ported from filmcraft `effects/pitch.rs`; catalogue: registry/audio/pitch.ts): phase vocoder with
// peak-region shifting and identity phase locking (Laroche & Dolson 1999). Every STFT frame (8× overlap) is
// analysed for spectral peaks; each peak's region of influence (down to the magnitude minima between peaks) is moved
// as a block so the peak lands on k·ratio, keeping the window's main-lobe shape; all bins of a region get the same
// phase rotation, accumulated per frame from the peak's instantaneous frequency, so the partial's frequency is scaled
// exactly by `ratio` while the within-lobe phase relations stay coherent. Duration is unchanged; at ratio 1 the
// output is the input delayed by the frame size.
import { EffectBase, type ProcessorFactory } from '../core/effect.ts';
import { flush32 } from '../core/math.ts';
import { fftSize, Spectral, StftChannel } from '../core/stft.ts';

const OVERLAP = 8;

/** Wraps a phase to (−π, π]. */
function wrap(p: number): number {
	return p - 2 * Math.PI * Math.floor((p + Math.PI) / (2 * Math.PI));
}

class PvState {
	readonly lastPhase: Float64Array;
	rot: Float64Array;
	newRot: Float64Array;
	constructor(bins: number) {
		this.lastPhase = new Float64Array(bins);
		this.rot = new Float64Array(bins);
		this.newRot = new Float64Array(bins);
	}
	reset(): void {
		this.lastPhase.fill(0);
		this.rot.fill(0);
		this.newRot.fill(0);
	}
}

export class PitchShifter extends EffectBase {
	private readonly n: number;
	private readonly hop: number;
	private readonly spectral: Spectral;
	private readonly stft: StftChannel[];
	private readonly state: PvState[];
	private readonly mag: Float64Array;
	private readonly phase: Float64Array;
	private readonly outRe: Float64Array;
	private readonly outIm: Float64Array;
	private readonly peaks: Int32Array;
	private targetRatio = 1;
	/** Ratio of the current frame (glides once per frame towards the target). */
	private ratio = 1;
	private frameDone = false;
	private readonly frames: ((input: Float64Array, out: Float64Array) => void)[];

	constructor(sr: number, ch: number) {
		super('jasper.audio.pitch-shifter', sr, ch);
		this.n = fftSize(sr);
		this.hop = this.n / OVERLAP;
		const bins = this.n / 2 + 1;
		const nch = Math.max(1, ch);
		this.spectral = new Spectral(this.n, false);
		this.stft = Array.from({ length: nch }, () => new StftChannel(this.n));
		this.state = Array.from({ length: nch }, () => new PvState(bins));
		this.mag = new Float64Array(bins);
		this.phase = new Float64Array(bins);
		this.outRe = new Float64Array(bins);
		this.outIm = new Float64Array(bins);
		this.peaks = new Int32Array(bins);
		// Hann² summed over 8× overlap = 3/8 · 8 = 3.
		const scale = 1 / (((this.n * 3) / 8) * OVERLAP);
		const expect = (2 * Math.PI * this.hop) / this.n;
		this.frames = this.state.map((st) => (input, out) => {
			this.spectral.analyse(input);
			this.shiftFrame(st, this.ratio, expect);
			this.spectral.synthesiseAdd(out, scale);
			this.frameDone = true;
		});
		this.applyParams(true);
	}

	/** Pitch ratio for the current settings. */
	targetPitchRatio(): number {
		return 2 ** ((this.pv.v('semitones') + this.pv.v('cents') / 100) / 12);
	}

	protected applyParams(snap: boolean): void {
		this.targetRatio = this.targetPitchRatio();
		if (snap) this.ratio = this.targetRatio;
	}

	latency(): number {
		return this.n;
	}

	reset(): void {
		for (const s of this.stft) s.reset();
		for (const s of this.state) s.reset();
		this.ratio = this.targetRatio;
	}

	private shiftFrame(st: PvState, ratio: number, expect: number): void {
		const spec = this.spectral;
		const bins = this.mag.length;
		const mag = this.mag;
		const phase = this.phase;
		const outRe = this.outRe;
		const outIm = this.outIm;
		let maxMag = 0;
		for (let k = 0; k < bins; k++) {
			const re = spec.re[k]!;
			const im = spec.im[k]!;
			mag[k] = Math.sqrt(re * re + im * im);
			phase[k] = Math.atan2(im, re);
			if (mag[k]! > maxMag) maxMag = mag[k]!;
			outRe[k] = 0;
			outIm[k] = 0;
			st.newRot[k] = 0;
		}
		// Peaks: local maxima over ±2 bins, above −100 dB of the frame maximum.
		let np = 0;
		const floor = maxMag * 1e-5;
		for (let k = 0; k < bins; k++) {
			const m = mag[k]!;
			if (m <= floor) continue;
			let ok = true;
			for (let j = Math.max(0, k - 2); j < k && ok; j++) if (!(mag[j]! < m)) ok = false;
			for (let j = k + 1; j <= Math.min(k + 2, bins - 1) && ok; j++) if (!(mag[j]! <= m)) ok = false;
			if (ok) this.peaks[np++] = k;
		}
		let start = 0;
		for (let i = 0; i < np; i++) {
			const p = this.peaks[i]!;
			let end = bins;
			if (i + 1 < np) {
				const q = this.peaks[i + 1]!;
				let mi = p + 1;
				for (let j = p + 1; j < q; j++) if (mag[j]! < mag[mi]!) mi = j;
				end = mi;
			}
			const d = wrap(phase[p]! - st.lastPhase[p]! - p * expect);
			const f = p + d / expect;
			const target = Math.round(p * ratio);
			const delta = target - p;
			const prevRot = target >= 0 && target < bins ? st.rot[target]! : 0;
			const rot = wrap(prevRot + (ratio - 1) * f * expect);
			const s = Math.sin(rot);
			const c = Math.cos(rot);
			for (let k = start; k < end; k++) {
				const t = k + delta;
				if (t < 0 || t >= bins) continue;
				// X[k]·e^{i·rot} (X = mag·e^{i·phase} is still in the analysis spectrum)
				const xr = spec.re[k]!;
				const xi = spec.im[k]!;
				outRe[t] = outRe[t]! + xr * c - xi * s;
				outIm[t] = outIm[t]! + xi * c + xr * s;
				st.newRot[t] = rot;
			}
			start = end;
		}
		for (let k = 0; k < bins; k++) {
			st.lastPhase[k] = phase[k]!;
			spec.re[k] = outRe[k]!;
			spec.im[k] = outIm[k]!;
		}
		const tmp = st.rot;
		st.rot = st.newRot;
		st.newRot = tmp;
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.stft.length);
		const hop = this.hop;
		// Sample-major so every channel hits its frame boundary on the same sample and the ratio glides identically.
		for (let i = start; i < end; i++) {
			this.frameDone = false;
			for (let c = 0; c < nch; c++) {
				const buf = ch[c]!;
				buf[i] = flush32(this.stft[c]!.tick(buf[i]!, hop, this.frames[c]!));
			}
			if (this.frameDone) {
				this.ratio += (this.targetRatio - this.ratio) * 0.5;
				if (Math.abs(this.ratio - this.targetRatio) < 1e-5) this.ratio = this.targetRatio;
			}
		}
	}
}

export const PITCH_PROCESSORS: Readonly<Record<string, ProcessorFactory>> = {
	'jasper.audio.pitch-shifter': (sr, ch) => new PitchShifter(sr, ch),
};
