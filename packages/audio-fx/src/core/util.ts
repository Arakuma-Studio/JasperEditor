// Building blocks shared by the effect implementations: delay lines with fractional reads, LFOs, one-pole filters,
// envelope followers, a deterministic PRNG (port of filmcraft `effects/util.rs`).
import { flush, flush32 } from './math.ts';

/** One-pole smoothing coefficient for a time constant in ms (0 → instant). */
export function coef(ms: number, sr: number): number {
	return ms <= 0 ? 0 : Math.exp(-1 / (ms * 0.001 * sr));
}

/** Circular delay line (f32 storage) with linear-interpolated fractional reads. */
export class DelayLine {
	private buf: Float32Array;
	private w = 0;

	/** A line that can delay by up to `max` samples. */
	constructor(max: number) {
		this.buf = new Float32Array(Math.max(0, Math.ceil(max)) + 3);
	}

	reset(): void {
		this.buf.fill(0);
		this.w = 0;
	}

	/** Sample written `d` samples ago (`d` ≥ 0; 0 = the sample written by the last `push`). */
	read(d: number): number {
		const len = this.buf.length;
		const dd = d < 0 ? 0 : d > len - 3 ? len - 3 : d;
		const di = Math.floor(dd);
		const frac = dd - di;
		const i0 = (this.w + len - 1 - di) % len;
		const i1 = (i0 + len - 1) % len;
		const a = this.buf[i0]!;
		return a + (this.buf[i1]! - a) * frac;
	}

	/** Integer read (`d` samples ago, 0 = newest). */
	tap(d: number): number {
		const len = this.buf.length;
		const dd = Math.min(d, len - 1);
		return this.buf[(this.w + len - 1 - dd) % len]!;
	}

	push(x: number): void {
		this.buf[this.w] = flush32(x);
		this.w++;
		if (this.w === this.buf.length) this.w = 0;
	}
}

/** Phase accumulator LFO (phase in cycles, 0..1). */
export class Lfo {
	private ph = 0;

	reset(): void {
		this.ph = 0;
	}

	/** Current phase plus `offset` (cycles), wrapped to 0..1. */
	phase(offset = 0): number {
		const p = (this.ph + offset) % 1;
		return p < 0 ? p + 1 : p;
	}

	advance(hz: number, sr: number): void {
		this.ph += hz / sr;
		if (this.ph >= 1) this.ph -= Math.floor(this.ph);
	}
}

/** Sine of a phase in cycles, mapped to 0..1. */
export function uniSine(phase: number): number {
	return 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
}

/** Triangle of a phase in cycles, 0..1. */
export function uniTri(phase: number): number {
	return phase < 0.5 ? 2 * phase : 2 - 2 * phase;
}

/** One-pole low-pass (`y += a (x − y)`). */
export class OnePole {
	y = 0;

	/** Coefficient for a −3 dB cutoff at `hz` (matched-z). */
	static alpha(hz: number, sr: number): number {
		const f = Math.min(Math.max(hz, 1), sr * 0.49);
		return 1 - Math.exp((-2 * Math.PI * f) / sr);
	}

	lp(a: number, x: number): number {
		this.y = flush(this.y + a * (x - this.y));
		return this.y;
	}

	/** High-pass as the complement of the low-pass. */
	hp(a: number, x: number): number {
		return x - this.lp(a, x);
	}

	reset(): void {
		this.y = 0;
	}
}

/** DC blocker (`y = x − x₁ + R·y₁`, ≈ 20 Hz). */
export class DcBlock {
	private x1 = 0;
	private y1 = 0;

	static r(sr: number): number {
		return 1 - (2 * Math.PI * 20) / sr;
	}

	tick(r: number, x: number): number {
		const y = x - this.x1 + r * this.y1;
		this.x1 = x;
		this.y1 = flush(y);
		return y;
	}

	reset(): void {
		this.x1 = 0;
		this.y1 = 0;
	}
}

/** First-order all-pass section `H(z) = (a + z⁻¹) / (1 + a z⁻¹)`. */
export class AllPass1 {
	private x1 = 0;
	private y1 = 0;

	/** Coefficient placing the 90° phase point at `hz`. */
	static coef(hz: number, sr: number): number {
		const f = Math.min(Math.max(hz, 1), sr * 0.49);
		const t = Math.tan((Math.PI * f) / sr);
		return (t - 1) / (t + 1);
	}

	tick(a: number, x: number): number {
		const y = a * x + this.x1 - a * this.y1;
		this.x1 = x;
		this.y1 = flush(y);
		return y;
	}

	reset(): void {
		this.x1 = 0;
		this.y1 = 0;
	}
}

/** Peak envelope follower with separate attack / release coefficients (linear domain). */
export class Envelope {
	env = 0;

	tick(att: number, rel: number, x: number): number {
		const c = x > this.env ? att : rel;
		this.env = c * this.env + (1 - c) * x;
		if (this.env < 1e-20) this.env = 0;
		return this.env;
	}

	reset(): void {
		this.env = 0;
	}
}

/**
 * Small deterministic PRNG (xoshiro128**, 32-bit integer ops only, so every JS engine gives the same sequence).
 * Used for generated impulse responses and tests.
 */
export class Prng {
	private s0: number;
	private s1: number;
	private s2: number;
	private s3: number;

	constructor(seed: number) {
		// splitmix32 seeding
		let x = seed >>> 0 || 0x9e3779b9;
		const next = () => {
			x = (x + 0x9e3779b9) >>> 0;
			let z = x;
			z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
			z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
			return (z ^ (z >>> 16)) >>> 0;
		};
		this.s0 = next();
		this.s1 = next();
		this.s2 = next();
		this.s3 = next() | 1;
	}

	/** Next unsigned 32-bit integer. */
	nextU32(): number {
		const r = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
		const t = (this.s1 << 9) >>> 0;
		this.s2 = (this.s2 ^ this.s0) >>> 0;
		this.s3 = (this.s3 ^ this.s1) >>> 0;
		this.s1 = (this.s1 ^ this.s2) >>> 0;
		this.s0 = (this.s0 ^ this.s3) >>> 0;
		this.s2 = (this.s2 ^ t) >>> 0;
		this.s3 = rotl(this.s3, 11);
		return r;
	}

	/** Uniform in [0, 1). */
	unit(): number {
		return this.nextU32() / 4294967296;
	}

	/** Uniform in [-1, 1). */
	uniform(): number {
		return this.unit() * 2 - 1;
	}
}

function rotl(x: number, k: number): number {
	return ((x << k) | (x >>> (32 - k))) >>> 0;
}
