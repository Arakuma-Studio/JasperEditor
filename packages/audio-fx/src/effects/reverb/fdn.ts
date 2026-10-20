// Studio Reverb: 8×8 feedback-delay-network reverb with a Householder feedback matrix, per-line RT60 gains, one-pole
// HF damping in each loop, pre-delay, size and dry/wet mix (ported from filmcraft `effects/time.rs` Reverb; Jot &
// Chaigne 1991 FDN design).
import { EffectBase } from '../../core/effect.ts';
import { flush32 } from '../../core/math.ts';
import { Smoothed } from '../../core/smooth.ts';

/** Fractional read from a circular buffer: `delay` samples behind write position `w`. */
function readFrac(buf: Float32Array, w: number, delay: number): number {
	const len = buf.length;
	const d = delay < 1 ? 1 : delay > len - 2 ? len - 2 : delay;
	const di = Math.floor(d);
	const frac = d - di;
	const i0 = (w + len - di) % len;
	const i1 = (i0 + len - 1) % len;
	return buf[i0]! + (buf[i1]! - buf[i0]!) * frac;
}

const FDN = 8;
/** Base loop delays (ms) at size 50 %; mutually prime-ish so modes don't pile up. */
const BASE_MS = [29.7, 37.1, 41.1, 43.7, 53.9, 59.3, 67.1, 73.3];
const MAX_SIZE_SCALE = 2;
/** Output tap signs (left, right) for decorrelated stereo. */
const SIGN_L = [1, -1, 1, -1, 1, 1, -1, -1];
const SIGN_R = [1, 1, -1, -1, 1, -1, 1, -1];

const sizeScale = (pct: number) => 0.35 + ((MAX_SIZE_SCALE - 0.35) * pct) / 100;

/** The FDN core; `mixParam` lets the Surround Reverb drive it at 100 % wet. */
export class FdnReverb {
	private readonly lines: Float32Array[];
	private w = 0;
	private readonly len: Smoothed[];
	private readonly lp = new Float64Array(FDN);
	private readonly gains = new Float64Array(FDN);
	private readonly v = new Float64Array(FDN);
	readonly damp: Smoothed;
	readonly rt60: Smoothed;
	readonly mix: Smoothed;
	private readonly pre: Float32Array;
	private preW = 0;
	readonly preLen: Smoothed;
	private counter = 0;

	constructor(
		readonly sampleRate: number,
		private readonly channels = 2,
	) {
		const maxLine = Math.floor(BASE_MS[FDN - 1]! * MAX_SIZE_SCALE * 0.001 * sampleRate) + 4;
		this.lines = Array.from({ length: FDN }, () => new Float32Array(maxLine));
		const sm = (v: number) => Smoothed.withMs(v, sampleRate, 50);
		this.len = Array.from({ length: FDN }, () => sm(1));
		this.damp = sm(0);
		this.rt60 = sm(1);
		this.mix = sm(0);
		this.pre = new Float32Array(Math.floor(0.2 * sampleRate) + 4);
		this.preLen = Smoothed.withMs(1, sampleRate, 100);
	}

	set(
		p: { preDelay: number; decay: number; damping: number; size: number; mix: number },
		snap: boolean,
	): void {
		const scale = sizeScale(p.size);
		this.len.forEach((l, k) => {
			l.set(BASE_MS[k]! * scale * 0.001 * this.sampleRate);
		});
		this.preLen.set(Math.max(p.preDelay * 0.001 * this.sampleRate, 1));
		this.damp.set((p.damping / 100) * 0.85);
		this.rt60.set(p.decay);
		this.mix.set(p.mix / 100);
		if (snap) {
			for (const s of [...this.len, this.preLen, this.damp, this.rt60, this.mix]) s.snap();
			this.updateGains();
		}
	}

	private updateGains(): void {
		const rt = Math.max(this.rt60.value(), 0.01);
		for (let k = 0; k < FDN; k++)
			this.gains[k] = 10 ** ((-3 * this.len[k]!.value()) / (rt * this.sampleRate));
	}

	clear(): void {
		for (const l of this.lines) l.fill(0);
		this.pre.fill(0);
		this.lp.fill(0);
		this.w = 0;
		this.preW = 0;
		this.counter = 0;
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.channels);
		if (nch === 0) return;
		const lineLen = this.lines[0]!.length;
		const preLen = this.pre.length;
		const hh = 2 / FDN;
		const v = this.v;
		for (let i = start; i < end; i++) {
			if (this.counter === 0) this.updateGains();
			this.counter = (this.counter + 1) % 32;
			for (const l of this.len) l.tick();
			this.rt60.tick();
			const damp = this.damp.tick();
			const mix = this.mix.tick();
			const pd = this.preLen.tick();
			let mono = 0;
			for (let c = 0; c < nch; c++) mono += ch[c]![i]!;
			mono /= nch;
			this.pre[this.preW] = mono;
			const input = readFrac(this.pre, this.preW, pd);
			this.preW = (this.preW + 1) % preLen;
			let sum = 0;
			for (let k = 0; k < FDN; k++) {
				const d = readFrac(this.lines[k]!, this.w, this.len[k]!.value());
				this.lp[k] = flush32(d + (this.lp[k]! - d) * damp);
				v[k] = this.lp[k]! * this.gains[k]!;
				sum += v[k]!;
			}
			let wl = 0;
			let wr = 0;
			for (let k = 0; k < FDN; k++) {
				this.lines[k]![this.w] = flush32(v[k]! - hh * sum + input * 0.5);
				wl += SIGN_L[k]! * v[k]!;
				wr += SIGN_R[k]! * v[k]!;
			}
			this.w = (this.w + 1) % lineLen;
			wl *= 0.35;
			wr *= 0.35;
			for (let c = 0; c < nch; c++) {
				const x = ch[c]![i]!;
				const wet = nch === 1 ? 0.5 * (wl + wr) : c % 2 === 0 ? wl : wr;
				ch[c]![i] = x + mix * (wet - x);
			}
		}
	}
}

export class StudioReverb extends EffectBase {
	private readonly fdn: FdnReverb;

	constructor(sr: number, ch: number) {
		super('jasper.audio.studio-reverb', sr, ch);
		this.fdn = new FdnReverb(sr, ch);
		this.applyParams(true);
	}

	protected applyParams(snap: boolean): void {
		this.fdn.set(
			{
				preDelay: this.pv.v('preDelay'),
				decay: this.pv.v('decay'),
				damping: this.pv.v('damping'),
				size: this.pv.v('roomSize'),
				mix: this.pv.v('mix'),
			},
			snap,
		);
	}

	reset(): void {
		this.fdn.clear();
		this.applyParams(true);
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		this.fdn.process(ch, start, end);
	}
}
