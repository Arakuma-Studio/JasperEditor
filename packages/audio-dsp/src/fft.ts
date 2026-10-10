// Minimal in-place iterative radix-2 complex FFT over Float64Array pairs (power-of-two sizes).
// Ported from FilmCraft `crates/audio-dsp/src/fft.rs` (MIT OR Apache-2.0, licenses/ported/multicam.md), in
// double precision: the audio-sync correlations run on up to 4 M points, where single-precision twiddles lose
// the sub-sample peak.

const plans = new Map<number, { cos: Float64Array; sin: Float64Array; rev: Uint32Array }>();

function plan(n: number): { cos: Float64Array; sin: Float64Array; rev: Uint32Array } {
	let p = plans.get(n);
	if (p) return p;
	if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two ≥ 2 (got ${n})`);
	const bits = Math.round(Math.log2(n));
	const cos = new Float64Array(n / 2);
	const sin = new Float64Array(n / 2);
	for (let k = 0; k < n / 2; k++) {
		const a = (-2 * Math.PI * k) / n;
		cos[k] = Math.cos(a);
		sin[k] = Math.sin(a);
	}
	const rev = new Uint32Array(n);
	for (let i = 0; i < n; i++) {
		let r = 0;
		let x = i;
		for (let b = 0; b < bits; b++) {
			r = (r << 1) | (x & 1);
			x >>>= 1;
		}
		rev[i] = r >>> 0;
	}
	p = { cos, sin, rev };
	// Keep a handful of plans (sync calls use two or three sizes); large ones are not worth caching forever.
	if (n <= 1 << 18) plans.set(n, p);
	return p;
}

/** Forward (e^{-iωt}) or inverse (e^{+iωt}) transform, unscaled (divide by `n` yourself after inverse). */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
	const n = re.length;
	if (im.length !== n) throw new Error('fft: re and im lengths differ');
	const { cos, sin, rev } = plan(n);
	for (let i = 0; i < n; i++) {
		const j = rev[i]!;
		if (j > i) {
			const tr = re[i]!;
			re[i] = re[j]!;
			re[j] = tr;
			const ti = im[i]!;
			im[i] = im[j]!;
			im[j] = ti;
		}
	}
	const sign = inverse ? -1 : 1;
	for (let len = 2; len <= n; len <<= 1) {
		const half = len >> 1;
		const stride = n / len;
		for (let start = 0; start < n; start += len) {
			for (let k = 0; k < half; k++) {
				const wr = cos[k * stride]!;
				const wi = sign * sin[k * stride]!;
				const a = start + k;
				const b = a + half;
				const br = re[b]!;
				const bi = im[b]!;
				const xr = br * wr - bi * wi;
				const xi = br * wi + bi * wr;
				re[b] = re[a]! - xr;
				im[b] = im[a]! - xi;
				re[a] = re[a]! + xr;
				im[a] = im[a]! + xi;
			}
		}
	}
}

export function nextPow2(n: number): number {
	let p = 2;
	while (p < n) p *= 2;
	return p;
}
