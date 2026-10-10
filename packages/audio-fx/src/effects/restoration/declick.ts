// Automatic Click Remover (ported from filmcraft `effects/declick.rs`): clicks are outliers of the linear-prediction
// residual, replaced by autoregressive interpolation (Vaseghi & Rayner). Per 512-sample block an order-p LPC model
// is fitted (autocorrelation + Levinson–Durbin over a Hann-windowed 1152-sample span); samples whose prediction
// error exceeds k·σ (σ from the median absolute residual) mark a click; nearby marks merge; each region is
// re-synthesised by forward prediction from the past and backward prediction from the future, cross-faded. Regions
// longer than the maximum click length are left alone (transients). Latency: one block plus the look-ahead.
import { EffectBase } from '../../core/effect.ts';

const BLOCK = 512;
const CONTEXT = 512;
const LOOKAHEAD = 128;
const SPAN = CONTEXT + BLOCK + LOOKAHEAD;
const MAX_ORDER = 32;
const MAX_REGION = 80;

class Chan {
	readonly buf = new Float32Array(SPAN);
	readonly out = new Float32Array(BLOCK);
	pos = 0;
	reset(): void {
		this.buf.fill(0);
		this.out.fill(0);
		this.pos = 0;
	}
}

/** LPC coefficients a[1..p] (x̂[n] = Σ a_k x[n−k]) by Levinson–Durbin; false for silent/degenerate input. */
export function lpc(x: Float64Array, p: number, a: Float64Array): boolean {
	const r = new Float64Array(MAX_ORDER + 1);
	for (let k = 0; k <= p; k++) {
		let s = 0;
		for (let i = k; i < x.length; i++) s += x[i]! * x[i - k]!;
		r[k] = s;
	}
	if (r[0]! <= 1e-12) return false;
	r[0] = r[0]! * (1 + 1e-6);
	let e = r[0]!;
	const tmp = new Float64Array(MAX_ORDER + 1);
	a.fill(0);
	for (let i = 1; i <= p; i++) {
		let acc = r[i]!;
		for (let j = 1; j < i; j++) acc -= a[j]! * r[i - j]!;
		const k = acc / e;
		tmp.set(a.subarray(0, i));
		a[i] = k;
		for (let j = 1; j < i; j++) a[j] = tmp[j]! - k * tmp[i - j]!;
		e *= 1 - k * k;
		if (e <= 1e-15) return false;
	}
	return true;
}

export class ClickRemover extends EffectBase {
	private readonly ch: Chan[];
	private readonly win = new Float64Array(SPAN);
	private readonly xw = new Float64Array(SPAN);
	private readonly resid = new Float64Array(SPAN);
	private readonly sorted = new Float64Array(SPAN);
	private readonly a = new Float64Array(MAX_ORDER + 1);
	private readonly fwd = new Float64Array(MAX_REGION);
	private readonly bwd = new Float64Array(MAX_REGION);
	/** Clicks repaired since the last reset (meter / tests). */
	repaired = 0;

	constructor(sr: number, ch: number) {
		super('jasper.audio.click-remover', sr, ch);
		this.ch = Array.from({ length: Math.max(1, ch) }, () => new Chan());
		for (let i = 0; i < SPAN; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / SPAN);
	}

	protected applyParams(): void {}

	private k(): number {
		return 4 + 0.2 * this.pv.v('threshold');
	}
	private order(): number {
		return Math.round(8 + (24 * (this.pv.v('complexity') - 1)) / 99);
	}
	private maxLen(): number {
		return Math.min(MAX_REGION, Math.round(16 + (48 * (this.pv.v('complexity') - 1)) / 99));
	}

	latency(): number {
		return BLOCK + LOOKAHEAD;
	}

	meters(): number[] {
		return [this.repaired];
	}

	reset(): void {
		for (const c of this.ch) c.reset();
		this.repaired = 0;
	}

	private analyse(c: Chan, p: number, k: number, maxLen: number): number {
		const buf = c.buf;
		for (let i = 0; i < SPAN; i++) this.xw[i] = buf[i]! * this.win[i]!;
		const a = this.a;
		if (!lpc(this.xw, p, a)) return 0;
		const resid = this.resid;
		for (let n = 0; n < SPAN; n++) {
			if (n < p) {
				resid[n] = 0;
				continue;
			}
			let pred = 0;
			for (let j = 1; j <= p; j++) pred += a[j]! * buf[n - j]!;
			resid[n] = buf[n]! - pred;
		}
		const valid = this.sorted.subarray(0, SPAN - p);
		for (let n = p; n < SPAN; n++) valid[n - p] = Math.abs(resid[n]!);
		valid.sort();
		const sigma = valid[valid.length >> 1]! / 0.6745;
		if (sigma <= 1e-9) return 0;
		const thr = k * sigma;
		let n = CONTEXT;
		let repaired = 0;
		while (n < CONTEXT + BLOCK) {
			if (Math.abs(resid[n]!) <= thr) {
				n++;
				continue;
			}
			const first = n;
			let last = n;
			for (let m = n + 1; m < SPAN - p && m <= last + 4; m++) if (Math.abs(resid[m]!) > thr) last = m;
			const start = Math.max(first - 2, p);
			const end = Math.min(last + 3, SPAN - p - 1);
			n = last + 1;
			if (end <= start || end - start > maxLen) continue;
			const len = end - start;
			const fwd = this.fwd;
			const bwd = this.bwd;
			for (let t = 0; t < len; t++) {
				const i = start + t;
				let pred = 0;
				for (let j = 1; j <= p; j++) pred += a[j]! * (i - j >= start ? fwd[i - j - start]! : buf[i - j]!);
				fwd[t] = Math.fround(pred);
			}
			for (let t = len - 1; t >= 0; t--) {
				const i = start + t;
				let pred = 0;
				for (let j = 1; j <= p; j++) pred += a[j]! * (i + j < end ? bwd[i + j - start]! : buf[i + j]!);
				bwd[t] = Math.fround(pred);
			}
			for (let t = 0; t < len; t++) {
				const w = (t + 1) / (len + 1);
				buf[start + t] = (1 - w) * fwd[t]! + w * bwd[t]!;
			}
			repaired++;
		}
		return repaired;
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.ch.length);
		const p = this.order();
		const k = this.k();
		const maxLen = this.maxLen();
		for (let ci = 0; ci < nch; ci++) {
			const c = this.ch[ci]!;
			const x = ch[ci]!;
			for (let i = start; i < end; i++) {
				const v = x[i]!;
				x[i] = c.out[c.pos]!;
				c.buf[SPAN - BLOCK + c.pos] = v;
				c.pos++;
				if (c.pos === BLOCK) {
					c.pos = 0;
					this.repaired += this.analyse(c, p, k, maxLen);
					c.out.set(c.buf.subarray(CONTEXT, CONTEXT + BLOCK));
					c.buf.copyWithin(0, BLOCK);
				}
			}
		}
	}
}
