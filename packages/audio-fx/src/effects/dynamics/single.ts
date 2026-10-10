// Single-band Compressor, Expander / Gate and Tube-modeled Compressor (ported from filmcraft
// `effects/dynamics.rs` Compressor / Gate and `multiband.rs` TubeCompressor). Detection is stereo-linked (the loudest
// channel drives one common gain, so the image does not shift); gain computers work in dB.
import { EffectBase } from '../../core/effect.ts';
import { dbToGain } from '../../core/math.ts';
import { Smoothed } from '../../core/smooth.ts';
import { coef } from '../../core/util.ts';
import { compressorCurve, expanderCurve, linToDb, smoothDb } from './curves.ts';

export class Compressor extends EffectBase {
	private threshold = 0;
	private ratio = 1;
	private knee = 0;
	private rms = false;
	private att = 0;
	private rel = 0;
	private readonly rmsCoef: number;
	private readonly makeup: Smoothed;
	private ms = 0;
	private env = 0;

	constructor(sr: number, ch: number) {
		super('jasper.audio.single-band-compressor', sr, ch);
		this.rmsCoef = coef(10, sr);
		this.makeup = Smoothed.withMs(1, sr, 20);
		this.applyParams(true);
	}

	protected applyParams(snap: boolean): void {
		this.threshold = this.pv.v('threshold');
		this.ratio = this.pv.v('ratio');
		this.knee = this.pv.v('knee');
		this.att = coef(this.pv.v('attack'), this.sampleRate);
		this.rel = coef(this.pv.v('release'), this.sampleRate);
		this.rms = this.pv.idx('detector') === 1;
		this.makeup.set(dbToGain(this.pv.v('output')));
		if (snap) this.makeup.snap();
	}

	transferDb(band: number, inputDb: number): number | null {
		if (band !== 0) return null;
		return compressorCurve(inputDb, this.threshold, this.ratio, this.knee) + this.pv.v('output');
	}

	meters(): number[] {
		return [this.env];
	}

	reset(): void {
		this.makeup.snap();
		this.ms = 0;
		this.env = 0;
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = ch.length;
		for (let i = start; i < end; i++) {
			let peak = 0;
			let sq = 0;
			for (let c = 0; c < nch; c++) {
				const x = ch[c]![i]!;
				const a = x < 0 ? -x : x;
				if (a > peak) peak = a;
				if (x * x > sq) sq = x * x;
			}
			let level: number;
			if (this.rms) {
				this.ms = this.rmsCoef * this.ms + (1 - this.rmsCoef) * sq;
				if (this.ms < 1e-30) this.ms = 0;
				level = 10 * Math.log10(Math.max(this.ms, 1e-20));
			} else level = linToDb(peak);
			const target = compressorCurve(level, this.threshold, this.ratio, this.knee) - level;
			const c = target < this.env ? this.att : this.rel;
			this.env = c * this.env + (1 - c) * target;
			if (Math.abs(this.env) < 1e-9) this.env = 0;
			const g = dbToGain(this.env) * this.makeup.tick();
			for (let k = 0; k < nch; k++) ch[k]![i] = ch[k]![i]! * g;
		}
	}
}

export class ExpanderGate extends EffectBase {
	private threshold = 0;
	private ratio = 1;
	private range = 0;
	private att = 0;
	private rel = 0;
	private hold = 0;
	private holdLeft = 0;
	private env = 0;

	constructor(sr: number, ch: number) {
		super('jasper.audio.expander-gate', sr, ch);
		this.applyParams();
	}

	protected applyParams(): void {
		this.threshold = this.pv.v('threshold');
		this.ratio = this.pv.v('ratio');
		this.range = this.pv.v('range');
		this.att = coef(this.pv.v('attack'), this.sampleRate);
		this.rel = coef(this.pv.v('release'), this.sampleRate);
		this.hold = Math.floor(this.pv.v('hold') * 0.001 * this.sampleRate);
	}

	transferDb(band: number, inputDb: number): number | null {
		return band === 0 ? expanderCurve(inputDb, this.threshold, this.ratio, this.range) : null;
	}

	meters(): number[] {
		return [this.env];
	}

	reset(): void {
		this.env = 0;
		this.holdLeft = 0;
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = ch.length;
		for (let i = start; i < end; i++) {
			let peak = 0;
			for (let c = 0; c < nch; c++) {
				const a = Math.abs(ch[c]![i]!);
				if (a > peak) peak = a;
			}
			const level = linToDb(peak);
			const target = expanderCurve(level, this.threshold, this.ratio, this.range) - level;
			if (target >= this.env) {
				this.env = this.att * this.env + (1 - this.att) * target;
				if (target >= 0) this.holdLeft = this.hold;
			} else if (this.holdLeft > 0) this.holdLeft--;
			else this.env = this.rel * this.env + (1 - this.rel) * target;
			if (Math.abs(this.env) < 1e-9) this.env = 0;
			const g = dbToGain(this.env);
			for (let k = 0; k < nch; k++) ch[k]![i] = ch[k]![i]! * g;
		}
	}
}

const TUBE_K = 0.5;
const TUBE_KNEE = 10;

/**
 * Compressor with an RMS detector, wide soft knee, program-dependent release and a gentle symmetric tube-style
 * saturation stage (`tanh(kx)/k`, k = ½: −0.2 dB at −6 dBFS).
 */
export class TubeCompressor extends EffectBase {
	private ms = 0;
	private env = 0;
	private slow = 0;
	private att = 0;
	private rel = 0;
	private readonly rmsC: number;
	private readonly slowC: number;
	private readonly out: Smoothed;

	constructor(sr: number, ch: number) {
		super('jasper.audio.tube-compressor', sr, ch);
		this.rmsC = coef(5, sr);
		this.slowC = coef(1500, sr);
		this.out = Smoothed.withMs(1, sr, 20);
		this.applyParams(true);
	}

	protected applyParams(snap: boolean): void {
		this.att = coef(this.pv.v('attack'), this.sampleRate);
		this.rel = coef(this.pv.v('release'), this.sampleRate);
		this.out.set(dbToGain(this.pv.v('output')));
		if (snap) this.out.snap();
	}

	transferDb(band: number, inputDb: number): number | null {
		if (band !== 0) return null;
		return (
			compressorCurve(inputDb, this.pv.v('threshold'), this.pv.v('ratio'), TUBE_KNEE) + this.pv.v('output')
		);
	}

	meters(): number[] {
		return [this.env];
	}

	reset(): void {
		this.ms = 0;
		this.env = 0;
		this.slow = 0;
		this.out.snap();
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = ch.length;
		const t = this.pv.v('threshold');
		const r = this.pv.v('ratio');
		for (let i = start; i < end; i++) {
			let sq = 0;
			for (let c = 0; c < nch; c++) {
				const x = ch[c]![i]!;
				if (x * x > sq) sq = x * x;
			}
			this.ms = this.rmsC * this.ms + (1 - this.rmsC) * sq;
			if (this.ms < 1e-30) this.ms = 0;
			const l = 10 * Math.log10(Math.max(this.ms, 1e-20));
			const target = compressorCurve(l, t, r, TUBE_KNEE) - l;
			// Program-dependent release: long, sustained reduction releases more slowly.
			this.slow = this.slowC * this.slow + (1 - this.slowC) * this.env;
			if (Math.abs(this.slow) < 1e-7) this.slow = 0;
			const rel = this.rel + Math.min(Math.max(this.slow / -20, 0), 1) * (1 - this.rel) * 0.5;
			this.env = smoothDb(this.env, target, this.att, Math.min(rel, 0.999999));
			const g = dbToGain(this.env);
			const o = this.out.tick();
			for (let k = 0; k < nch; k++) {
				const y = ch[k]![i]! * g;
				ch[k]![i] = (Math.tanh(TUBE_K * y) / TUBE_K) * o;
			}
		}
	}
}
