// Shared test helpers (ported from FilmCraft `crates/audio-dsp/src/lib.rs` testutil and the oracle test).

/** Tiny deterministic PRNG (xorshift32 on two words → 53-bit doubles). */
export class Rng {
	private s0: number;
	private s1: number;
	constructor(seed: number) {
		this.s0 = (seed * 0x9e3779b9) >>> 0 || 1;
		this.s1 = (seed ^ 0x85ebca6b) >>> 0 || 2;
		for (let i = 0; i < 8; i++) this.nextU32();
	}
	nextU32(): number {
		let x = this.s0;
		const y = this.s1;
		this.s0 = y;
		x ^= x << 23;
		x ^= x >>> 17;
		x ^= y ^ (y >>> 26);
		this.s1 = x >>> 0;
		return (this.s0 + this.s1) >>> 0;
	}
	/** Uniform in [-1, 1). */
	uniform(): number {
		const hi = this.nextU32() >>> 5;
		const lo = this.nextU32() >>> 6;
		return ((hi * 67108864 + lo) / 9007199254740992) * 2 - 1;
	}
}

export function sine(freq: number, amp: number, sr: number, n: number, phase = 0): Float32Array {
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr + phase);
	return out;
}

export function rms(x: Float32Array): number {
	if (x.length === 0) return 0;
	let s = 0;
	for (let i = 0; i < x.length; i++) s += x[i] * x[i];
	return Math.sqrt(s / x.length);
}

export function db(x: number): number {
	return 20 * Math.log10(x);
}

export function dbfs(level: number): number {
	return 10 ** (level / 20);
}

/** Amplitude of the `freq` component of `x` (single-bin DFT correlation). */
export function toneAmplitude(x: Float32Array, freq: number, sr: number): number {
	let re = 0;
	let im = 0;
	for (let i = 0; i < x.length; i++) {
		const w = (2 * Math.PI * freq * i) / sr;
		re += x[i] * Math.cos(w);
		im += x[i] * Math.sin(w);
	}
	return (2 * Math.sqrt(re * re + im * im)) / x.length;
}

/** Concatenate arrays. */
export function concat(parts: Float32Array[]): Float32Array {
	const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

/** Programme made of (seconds, dBFS) sine segments with continuous phase. */
export function segments(freq: number, sr: number, segs: [number, number][]): Float32Array {
	const total = segs.reduce((s, [secs]) => s + Math.round(secs * sr), 0);
	const out = new Float32Array(total);
	let idx = 0;
	for (const [secs, level] of segs) {
		const n = Math.round(secs * sr);
		const a = dbfs(level);
		for (let i = 0; i < n; i++) {
			out[idx] = a * Math.sin((2 * Math.PI * freq * idx) / sr);
			idx++;
		}
	}
	return out;
}

/** Pink noise (Paul Kellet's refined filter on seeded white noise). */
export function pink(sr: number, secs: number, amp: number, seed: number): Float32Array {
	const r = new Rng(seed);
	const n = Math.floor(secs * sr);
	const out = new Float32Array(n);
	let b0 = 0;
	let b1 = 0;
	let b2 = 0;
	let b3 = 0;
	let b4 = 0;
	let b5 = 0;
	let b6 = 0;
	for (let i = 0; i < n; i++) {
		const w = r.uniform();
		b0 = 0.99886 * b0 + w * 0.0555179;
		b1 = 0.99332 * b1 + w * 0.0750759;
		b2 = 0.969 * b2 + w * 0.153852;
		b3 = 0.8665 * b3 + w * 0.3104856;
		b4 = 0.55 * b4 + w * 0.5329522;
		b5 = -0.7616 * b5 - w * 0.016898;
		const y = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
		b6 = w * 0.115926;
		out[i] = y * 0.11 * amp;
	}
	return out;
}

/** Seeded white noise, uniform in ±amp. */
export function white(sr: number, secs: number, amp: number, seed: number): Float32Array {
	const r = new Rng(seed);
	const out = new Float32Array(Math.floor(secs * sr));
	for (let i = 0; i < out.length; i++) out[i] = amp * r.uniform();
	return out;
}

/**
 * Speech-like: syllable bursts (80–300 ms) of a pitched, formant-ish signal with pauses (50–600 ms) and
 * phrase-level level changes, so gating and the M/S windows are exercised.
 */
export function speech(sr: number, secs: number, seed: number): Float32Array {
	const r = new Rng(seed);
	const n = Math.floor(secs * sr);
	const out = new Float32Array(n);
	let pos = 0;
	let phraseGain = 1;
	while (pos < n) {
		if (r.uniform() > 0.7) phraseGain = dbfs((-12 * (r.uniform() + 1)) / 2);
		const syl = Math.floor((0.08 + (0.22 * (r.uniform() + 1)) / 2) * sr);
		const f0 = 110 + (60 * (r.uniform() + 1)) / 2;
		const f1 = 500 + 400 * r.uniform();
		const f2 = 1500 + 700 * r.uniform();
		const harmonics: number[] = [];
		const weights: number[] = [];
		for (let h = 1; h <= 20; h++) {
			const f = f0 * h;
			if (f > sr / 2.2) break;
			const formant = Math.exp(-(((f - f1) / 200) ** 2)) + 0.5 * Math.exp(-(((f - f2) / 300) ** 2)) + 0.05;
			harmonics.push((2 * Math.PI * f) / sr);
			weights.push(formant / h);
		}
		for (let i = 0; i < Math.min(syl, n - pos); i++) {
			const env = Math.sin((Math.PI * i) / syl) ** 2;
			let v = 0;
			for (let k = 0; k < harmonics.length; k++) v += weights[k] * Math.sin(harmonics[k] * i);
			out[pos + i] = 0.3 * phraseGain * env * v + 0.003 * r.uniform();
		}
		pos += syl;
		pos += Math.floor((0.05 + (0.55 * (r.uniform() + 1)) / 2) * sr);
	}
	return out;
}

/** Copy of `x` with a raised-cosine fade-in and fade-out of `ms` milliseconds at the programme edges. */
export function fadeEdges(x: Float32Array, sr: number, ms = 10): Float32Array {
	const y = x.slice();
	const n = Math.min(Math.round((sr * ms) / 1000), Math.floor(y.length / 2));
	for (let i = 0; i < n; i++) {
		const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
		y[i] *= g;
		y[y.length - 1 - i] *= g;
	}
	return y;
}
