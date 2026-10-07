// Static gain computers of the dynamics effects (ported from filmcraft `effects/dynamics.rs`, `multiband.rs`).

/**
 * Compressor static curve with a quadratic soft knee (Giannoulis, Massberg & Reiss, "Digital Dynamic Range
 * Compressor Design — A Tutorial and Analysis", JAES 2012, eq. 4): output level (dB) for input level `x` (dB).
 */
export function compressorCurve(x: number, threshold: number, ratio: number, knee: number): number {
	const d = x - threshold;
	if (knee > 0 && 2 * Math.abs(d) <= knee) return x + ((1 / ratio - 1) * (d + knee / 2) ** 2) / (2 * knee);
	if (d > 0) return threshold + d / ratio;
	return x;
}

/** Downward-expander static curve (output dB); attenuation limited to `range` dB. */
export function expanderCurve(x: number, threshold: number, ratio: number, range: number): number {
	return x >= threshold ? x : x + Math.max((x - threshold) * (ratio - 1), -range);
}

/** Cubic soft clipper with ceiling `t` (linear): identity below t/2, smooth to exactly ±t. */
export function softClip(x: number, t: number): number {
	const k = 0.5 * t;
	const a = Math.abs(x);
	if (a <= k) return x;
	const u = Math.min((a - k) / (2 * (t - k)), 1);
	const y = k + (t - k) * (2 * u - u * u);
	return x < 0 ? -y : y;
}

/** One-pole smoothing of a gain in dB (≤ 0): falling = attack coefficient, rising = release. */
export function smoothDb(env: number, target: number, att: number, rel: number): number {
	const c = target < env ? att : rel;
	const e = c * env + (1 - c) * target;
	return Math.abs(e) < 1e-7 ? 0 : e;
}

/** Linear → dB with a −200 dB floor. */
export function linToDb(x: number): number {
	return 20 * Math.log10(Math.max(x, 1e-10));
}
