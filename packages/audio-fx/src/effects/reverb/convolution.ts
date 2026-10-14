// Convolution Reverb (ported from filmcraft `effects/reverbs.rs`): uniformly partitioned overlap-save convolution
// (256-sample partitions, frequency-domain delay line, one inverse FFT for both outputs by packing Y_L + j·Y_R) with
// impulse responses we GENERATE: sparse early reflections plus exponentially decaying noise whose bandwidth narrows
// over time (high frequencies decay faster, at constant broadband energy decay), faded in over the onset, each channel
// normalised to unit energy.
// Deterministic for a given impulse and sample rate; no recorded or third-party IRs. The partition spectra are
// rebuilt only when the impulse, room size or damping change (those are not keyframable).
import { EffectBase } from '../../core/effect.ts';
import { Fft } from '../../core/fft.ts';
import { dbToGain, flush32 } from '../../core/math.ts';
import { Smoothed } from '../../core/smooth.ts';
import { DelayLine, OnePole, Prng } from '../../core/util.ts';

/** Partition (block) size: the effect's latency. */
export const PART = 256;

type IrSpec = { rt60: number; erMs: number; erCount: number; hfDecay: number; onsetMs: number; seed: number };

/** Characters of the generated impulses (order of CONVOLUTION_IMPULSES). */
export const IR_SPECS: readonly IrSpec[] = [
	{ rt60: 0.45, erMs: 25, erCount: 10, hfDecay: 6, onsetMs: 8, seed: 11 },
	{ rt60: 0.8, erMs: 45, erCount: 14, hfDecay: 4, onsetMs: 15, seed: 12 },
	{ rt60: 1.9, erMs: 80, erCount: 18, hfDecay: 2.2, onsetMs: 30, seed: 13 },
	{ rt60: 3.2, erMs: 120, erCount: 22, hfDecay: 1.4, onsetMs: 45, seed: 14 },
	{ rt60: 1.6, erMs: 0, erCount: 0, hfDecay: 1, onsetMs: 1, seed: 15 },
	{ rt60: 0.3, erMs: 15, erCount: 8, hfDecay: 8, onsetMs: 4, seed: 16 },
	{ rt60: 0.2, erMs: 8, erCount: 6, hfDecay: 12, onsetMs: 2, seed: 17 },
];

export function irLength(spec: IrSpec, sr: number): number {
	return Math.floor((spec.rt60 * 1.1 + spec.erMs * 0.001) * sr) + 1;
}

/** Writes the stereo impulse `index` into `out` (two equal-length buffers). */
export function generateIr(index: number, sr: number, out: [Float32Array, Float32Array]): void {
	const spec = IR_SPECS[Math.min(Math.max(index, 0), IR_SPECS.length - 1)]!;
	out.forEach((buf, c) => {
		const len = buf.length;
		const rng = new Prng(spec.seed * 2 + c);
		const lp = new OnePole();
		const onset = Math.max(spec.onsetMs * 0.001 * sr, 1);
		for (let i = 0; i < len; i++) {
			const t = i / sr;
			const env = Math.exp((-6.907755 * t) / spec.rt60);
			const fade = Math.min(i / onset, 1);
			const fc = Math.max(16000 * Math.exp(-t * spec.hfDecay), 800);
			const a = OnePole.alpha(fc, sr);
			// The darkening low-pass passes a/(2 − a) of white noise's power: compensate it so the broadband energy
			// follows `env` and the impulse's measured RT60 is the spec's (FilmCraft's came out 15–25 % short).
			buf[i] = (lp.lp(a, rng.uniform()) * env * fade) / Math.sqrt(a / (2 - a));
		}
		for (let k = 0; k < spec.erCount; k++) {
			const t = 0.002 + (rng.uniform() * 0.5 + 0.5) * spec.erMs * 0.001;
			const i = Math.min(Math.floor(t * sr), len - 1);
			const amp = 0.6 * Math.exp((-3 * t) / (spec.erMs * 0.001 + 1e-3)) * (rng.uniform() < 0 ? -1 : 1);
			buf[i] = buf[i]! + amp;
		}
		let e = 0;
		for (let i = 0; i < len; i++) e += buf[i]! * buf[i]!;
		const g = e > 0 ? 1 / Math.sqrt(e) : 0;
		for (let i = 0; i < len; i++) buf[i] = buf[i]! * g;
	});
}

export class ConvolutionReverb extends EffectBase {
	private readonly fft = new Fft(2 * PART);
	private readonly base: [Float32Array, Float32Array];
	private baseLen = 0;
	/** Partition spectra (PART+1 bins, re/im interleaved) per output channel. */
	private readonly h: [Float64Array, Float64Array];
	private parts = 0;
	private readonly fdl: Float64Array;
	private head = 0;
	private readonly maxParts: number;
	private readonly hist = new Float64Array(2 * PART);
	private readonly inbuf = new Float64Array(PART);
	private readonly out: [Float64Array, Float64Array] = [new Float64Array(PART), new Float64Array(PART)];
	private pos = 0;
	private readonly re = new Float64Array(2 * PART);
	private readonly im = new Float64Array(2 * PART);
	private readonly yl = new Float64Array(2 * (PART + 1));
	private readonly yr = new Float64Array(2 * (PART + 1));
	private readonly pre: DelayLine;
	private readonly dryDelay: DelayLine[];
	private key = '';
	private keyImpulse = -1;
	private readonly mix: Smoothed;
	private readonly gain: Smoothed;
	private readonly width: Smoothed;
	private readonly predelay: Smoothed;

	constructor(sr: number, ch: number) {
		super('jasper.audio.convolution-reverb', sr, ch);
		const maxLen = Math.max(...IR_SPECS.map((s) => irLength(s, sr)));
		this.maxParts = Math.ceil(maxLen / PART);
		const bins2 = 2 * (PART + 1);
		this.base = [new Float32Array(maxLen), new Float32Array(maxLen)];
		this.h = [new Float64Array(this.maxParts * bins2), new Float64Array(this.maxParts * bins2)];
		this.fdl = new Float64Array(this.maxParts * bins2);
		this.pre = new DelayLine(Math.floor(0.5 * sr) + 2);
		this.dryDelay = Array.from({ length: Math.max(1, ch) }, () => new DelayLine(PART + 2));
		this.mix = Smoothed.withMs(0, sr, 20);
		this.gain = Smoothed.withMs(1, sr, 20);
		this.width = Smoothed.withMs(1, sr, 20);
		this.predelay = Smoothed.withMs(0, sr, 50);
		this.applyParams(true);
	}

	/** Rebuilds the partition spectra (only when the impulse, size or damping changed). */
	private rebuild(): void {
		const imp = this.pv.idx('impulse');
		const size = this.pv.v('roomSize');
		const dLf = this.pv.v('dampingLf');
		const dHf = this.pv.v('dampingHf');
		const key = `${imp}|${size}|${dLf}|${dHf}`;
		if (key === this.key) return;
		const sr = this.sampleRate;
		if (imp !== this.keyImpulse) {
			const len = Math.min(irLength(IR_SPECS[Math.min(imp, IR_SPECS.length - 1)]!, sr), this.base[0].length);
			generateIr(imp, sr, [this.base[0].subarray(0, len), this.base[1].subarray(0, len)]);
			this.baseLen = len;
			this.keyImpulse = imp;
		}
		this.key = key;
		// Room size shortens the impulse by resampling it (linear interpolation).
		const scale = Math.min(Math.max(size / 100, 0.1), 1);
		const len = Math.max(Math.floor(this.baseLen * scale), 1);
		this.parts = Math.min(Math.ceil(len / PART), this.maxParts);
		const alf = OnePole.alpha(dLf, sr);
		const ahf = OnePole.alpha(dHf, sr);
		const bins2 = 2 * (PART + 1);
		// Keep the impulse's energy: linear interpolation at fractional ratios loses a ratio-dependent part of it (and
		// drops or keeps single-sample reflections), so a plain 1/√scale made the level jump with Room Size.
		let eBase = 0;
		let eScaled = 0;
		const used = Math.min(len, this.parts * PART);
		const baseUsed = Math.min(this.baseLen, Math.ceil(used / scale));
		for (let c = 0; c < 2; c++) {
			const b = this.base[c as 0 | 1];
			for (let i = 0; i < baseUsed; i++) eBase += b[i]! * b[i]!;
			for (let i = 0; i < used; i++) {
				const src = i / scale;
				const i0 = Math.floor(src);
				const fr = src - i0;
				const v0 = i0 < this.baseLen ? b[i0]! : 0;
				const v1 = i0 + 1 < this.baseLen ? b[i0 + 1]! : 0;
				const v = v0 + (v1 - v0) * fr;
				eScaled += v * v;
			}
		}
		const norm = eScaled > 0 ? Math.sqrt(eBase / eScaled) : 1 / Math.sqrt(scale);
		for (let c = 0; c < 2; c++) {
			const hp = new OnePole();
			const lp = new OnePole();
			const b = this.base[c as 0 | 1];
			const h = this.h[c as 0 | 1];
			for (let p = 0; p < this.parts; p++) {
				this.re.fill(0);
				this.im.fill(0);
				for (let k = 0; k < PART; k++) {
					const i = p * PART + k;
					if (i >= len) break;
					const src = i / scale;
					const i0 = Math.floor(src);
					const fr = src - i0;
					const v0 = i0 < this.baseLen ? b[i0]! : 0;
					const v1 = i0 + 1 < this.baseLen ? b[i0 + 1]! : 0;
					let v = (v0 + (v1 - v0) * fr) * norm;
					if (dLf > 10.5) v = hp.hp(alf, v);
					if (dHf < 19999) v = lp.lp(ahf, v);
					this.re[k] = Math.fround(v);
				}
				this.fft.forward(this.re, this.im);
				const o = p * bins2;
				for (let k = 0; k <= PART; k++) {
					h[o + 2 * k] = this.re[k]!;
					h[o + 2 * k + 1] = this.im[k]!;
				}
			}
		}
	}

	protected applyParams(snap: boolean): void {
		this.rebuild();
		this.mix.set(this.pv.v('mix') / 100);
		this.gain.set(dbToGain(this.pv.v('gain')));
		this.width.set(this.pv.v('width') / 100);
		this.predelay.set(this.pv.v('preDelay') * 0.001 * this.sampleRate);
		if (snap) for (const s of [this.mix, this.gain, this.width, this.predelay]) s.snap();
	}

	latency(): number {
		return PART;
	}

	/** The current processed impulse response of output channel `c` (tests: RT60, determinism). */
	impulse(c: 0 | 1): Float32Array {
		const scale = Math.min(Math.max(this.pv.v('roomSize') / 100, 0.1), 1);
		const len = Math.max(Math.floor(this.baseLen * scale), 1);
		return this.base[c].slice(0, Math.min(len, this.baseLen));
	}

	private block(): void {
		const bins2 = 2 * (PART + 1);
		this.hist.copyWithin(0, PART);
		this.hist.set(this.inbuf, PART);
		this.re.set(this.hist);
		this.im.fill(0);
		this.fft.forward(this.re, this.im);
		this.head = (this.head + this.maxParts - 1) % this.maxParts;
		const slot = this.head * bins2;
		for (let k = 0; k <= PART; k++) {
			this.fdl[slot + 2 * k] = this.re[k]!;
			this.fdl[slot + 2 * k + 1] = this.im[k]!;
		}
		const yl = this.yl;
		const yr = this.yr;
		yl.fill(0);
		yr.fill(0);
		const hl = this.h[0];
		const hr = this.h[1];
		for (let p = 0; p < this.parts; p++) {
			const xi = ((this.head + p) % this.maxParts) * bins2;
			const hi = p * bins2;
			for (let k = 0; k <= PART; k++) {
				const xr = this.fdl[xi + 2 * k]!;
				const xm = this.fdl[xi + 2 * k + 1]!;
				const lr = hl[hi + 2 * k]!;
				const li = hl[hi + 2 * k + 1]!;
				const rr = hr[hi + 2 * k]!;
				const ri = hr[hi + 2 * k + 1]!;
				yl[2 * k] = yl[2 * k]! + xr * lr - xm * li;
				yl[2 * k + 1] = yl[2 * k + 1]! + xr * li + xm * lr;
				yr[2 * k] = yr[2 * k]! + xr * rr - xm * ri;
				yr[2 * k + 1] = yr[2 * k + 1]! + xr * ri + xm * rr;
			}
		}
		const n = 2 * PART;
		for (let k = 0; k < n; k++) {
			let lr: number;
			let li: number;
			let rr: number;
			let ri: number;
			if (k <= PART) {
				lr = yl[2 * k]!;
				li = yl[2 * k + 1]!;
				rr = yr[2 * k]!;
				ri = yr[2 * k + 1]!;
			} else {
				const m = n - k;
				lr = yl[2 * m]!;
				li = -yl[2 * m + 1]!;
				rr = yr[2 * m]!;
				ri = -yr[2 * m + 1]!;
			}
			this.re[k] = lr - ri;
			this.im[k] = li + rr;
		}
		this.fft.inverse(this.re, this.im);
		const s = 1 / n;
		for (let k = 0; k < PART; k++) {
			this.out[0][k] = flush32(this.re[PART + k]! * s);
			this.out[1][k] = flush32(this.im[PART + k]! * s);
		}
	}

	reset(): void {
		this.fdl.fill(0);
		this.hist.fill(0);
		this.inbuf.fill(0);
		this.out[0].fill(0);
		this.out[1].fill(0);
		this.head = 0;
		this.pos = 0;
		this.pre.reset();
		for (const d of this.dryDelay) d.reset();
		for (const s of [this.mix, this.gain, this.width, this.predelay]) s.snap();
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.dryDelay.length);
		if (nch === 0) return;
		for (let i = start; i < end; i++) {
			const mix = this.mix.tick();
			const gain = this.gain.tick();
			const width = this.width.tick();
			const pd = this.predelay.tick();
			let mono = 0;
			for (let c = 0; c < nch; c++) mono += ch[c]![i]!;
			mono /= nch;
			this.pre.push(mono);
			this.inbuf[this.pos] = this.pre.read(pd);
			let wl = this.out[0][this.pos]!;
			let wr = this.out[1][this.pos]!;
			this.pos++;
			if (this.pos === PART) {
				this.pos = 0;
				this.block();
			}
			const m = 0.5 * (wl + wr);
			wl = m + width * (wl - m);
			wr = m + width * (wr - m);
			for (let c = 0; c < nch; c++) {
				const dl = this.dryDelay[c]!;
				dl.push(ch[c]![i]!);
				const dry = dl.tap(PART);
				const wet = nch === 1 ? m : c === 0 ? wl : wr;
				ch[c]![i] = dry + mix * (wet * gain - dry);
			}
		}
	}
}
