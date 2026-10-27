/**
 * Band-limited sample-rate conversion with a Kaiser-windowed sinc kernel, for arbitrary rate pairs.
 *
 * The kernel is a zero-phase low-pass designed at the lower of the two rates (`min(from, to)`):
 *
 * | quality | passband (flat) | stop band from | attenuation | taps per output (at the input rate) |
 * |---|---|---|---|---|
 * | `high` | 0 … 0.45·min | 0.5·min (Nyquist) | ≥ 100 dB design (Kaiser β ≈ 10.06) | ≈ 140 × from/min |
 * | `fast` | 0 … 0.42·min | 0.5·min | ≥ 70 dB design (β ≈ 6.76) | ≈ 50 × from/min |
 *
 * so nothing above the lower Nyquist aliases into the output (downsampling) and no image survives
 * (upsampling). Rational ratios with a small reduced denominator use exact polyphase tables (one per output
 * phase, each normalised to unity DC gain); other ratios (non-integer rates, coprime rates) use a dense
 * 4096-phase table with linear interpolation between phases. The output sample `n` sits exactly at input
 * time `n · from / to` (time aligned, no group delay) and the output length is `round(len · to / from)`.
 * Samples outside the input are zero.
 */
import { besselI0 } from './oversample.ts';

/** Quality of {@link resample}. */
export type ResampleQuality = 'fast' | 'high';

const SPECS: Record<ResampleQuality, { atten: number; pass: number; stop: number }> = {
	high: { atten: 100, pass: 0.45, stop: 0.5 },
	fast: { atten: 70, pass: 0.42, stop: 0.5 },
};

/** Largest exact polyphase table (coefficients); bigger ratios use the dense interpolated table. */
const MAX_EXACT_TABLE = 1 << 21;
const DENSE_PHASES = 4096;

function gcd(a: number, b: number): number {
	while (b) [a, b] = [b, a % b];
	return a;
}

type Kernel = {
	/** Half width (input samples) of the window. */
	hw: number;
	/** Taps per phase (`2K`); tap `idx` multiplies `x[base − K + 1 + idx]`. */
	taps: number;
	k: number;
	/** Number of phase rows. */
	phases: number;
	coeffs: Float64Array;
};

// Scrubbing and interpreted clips repeatedly convert short buffers at the same rates. The
// coefficient tables depend only on these rates and quality, never on channel/sample data.
// Keep both retention and entry count bounded when a speed ramp visits many different rates.
const MAX_CACHED_KERNEL_BYTES = 16 * 1024 * 1024;
const MAX_CACHED_KERNELS = 8;
const kernels = new Map<string, Kernel>();
let cachedKernelBytes = 0;

function kernelFor(from: number, to: number, quality: ResampleQuality, exactPhases: number): Kernel {
	const key = `${from}/${to}/${quality}`;
	const cached = kernels.get(key);
	if (cached) {
		kernels.delete(key);
		kernels.set(key, cached);
		return cached;
	}
	const probe = buildKernel(from, to, quality, 1, 0);
	const exact = exactPhases > 0 && exactPhases * probe.taps <= MAX_EXACT_TABLE;
	const phases = exact ? exactPhases : DENSE_PHASES;
	const kernel = buildKernel(from, to, quality, phases, exact ? phases : phases + 1);
	const bytes = kernel.coeffs.byteLength;
	if (bytes <= MAX_CACHED_KERNEL_BYTES) {
		while (kernels.size >= MAX_CACHED_KERNELS || cachedKernelBytes + bytes > MAX_CACHED_KERNEL_BYTES) {
			const oldest = kernels.keys().next().value!;
			cachedKernelBytes -= kernels.get(oldest)!.coeffs.byteLength;
			kernels.delete(oldest);
		}
		kernels.set(key, kernel);
		cachedKernelBytes += bytes;
	}
	return kernel;
}

function buildKernel(
	from: number,
	to: number,
	quality: ResampleQuality,
	phases: number,
	rows: number,
): Kernel {
	const spec = SPECS[quality];
	const minRate = Math.min(from, to);
	const fc = ((spec.pass + spec.stop) / 2) * minRate;
	const fcN = (2 * fc) / from; // cycles per input sample × 2
	const dw = (2 * Math.PI * (spec.stop - spec.pass) * minRate) / from;
	const hw = (spec.atten - 7.95) / (2.285 * dw) / 2;
	const beta = 0.1102 * (spec.atten - 8.7); // Both qualities use attenuation > 50 dB.
	const i0b = besselI0(beta);
	const k = Math.ceil(hw) + 1;
	const taps = 2 * k;
	const coeffs = new Float64Array(rows * taps);
	for (let p = 0; p < rows; p++) {
		const frac = p / phases;
		let sum = 0;
		for (let idx = 0; idx < taps; idx++) {
			const j = idx - k + 1;
			const u = frac - j;
			let h = 0;
			if (Math.abs(u) < hw) {
				const r = u / hw;
				const w = besselI0(beta * Math.sqrt(1 - r * r)) / i0b;
				const x = fcN * u;
				const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
				h = fcN * sinc * w;
			}
			coeffs[p * taps + idx] = h;
			sum += h;
		}
		for (let idx = 0; idx < taps; idx++) coeffs[p * taps + idx] /= sum;
	}
	return { hw, taps, k, phases, coeffs };
}

function dot(x: Float32Array, start: number, c: Float64Array, row: number, taps: number): number {
	let s = 0;
	if (start >= 0 && start + taps <= x.length) {
		for (let i = 0; i < taps; i++) s += c[row + i] * x[start + i];
	} else {
		const lo = Math.max(0, -start);
		const hi = Math.min(taps, x.length - start);
		for (let i = lo; i < hi; i++) s += c[row + i] * x[start + i];
	}
	return s;
}

/**
 * Resample planar audio from `fromRate` to `toRate` (Hz). Returns new arrays of length
 * `round(len · toRate / fromRate)`; a copy when the rates are equal.
 */
export function resample(
	planar: Float32Array[],
	fromRate: number,
	toRate: number,
	quality: ResampleQuality = 'high',
): Float32Array[] {
	if (!(fromRate > 0) || !(toRate > 0)) throw new Error('resample: rates must be positive');
	if (planar.length === 0) return [];
	const len = Math.min(...planar.map((c) => c.length));
	if (fromRate === toRate) return planar.map((c) => c.slice(0, len));
	const outLen = Math.round((len * toRate) / fromRate);
	const out = planar.map(() => new Float32Array(outLen));
	const integer = Number.isInteger(fromRate) && Number.isInteger(toRate);
	const g = integer ? gcd(fromRate, toRate) : 1;
	const L = toRate / g;
	const M = fromRate / g;
	const kern = kernelFor(fromRate, toRate, quality, integer ? L : 0);
	const { taps, k, coeffs } = kern;
	if (integer && L * taps <= MAX_EXACT_TABLE) {
		for (let n = 0; n < outLen; n++) {
			const num = n * M;
			const base = Math.floor(num / L);
			const ph = num - base * L;
			const start = base - k + 1;
			for (let c = 0; c < planar.length; c++) out[c][n] = dot(planar[c], start, coeffs, ph * taps, taps);
		}
		return out;
	}
	// dense table: DENSE_PHASES + 1 rows (row P = a whole-sample shift of row 0), linear interpolation
	const step = fromRate / toRate;
	for (let n = 0; n < outLen; n++) {
		const t = n * step;
		const base = Math.floor(t);
		const pos = (t - base) * DENSE_PHASES;
		const p0 = Math.min(DENSE_PHASES - 1, Math.floor(pos));
		const w = pos - p0;
		const start = base - k + 1;
		for (let c = 0; c < planar.length; c++) {
			const a = dot(planar[c], start, coeffs, p0 * taps, taps);
			const b = dot(planar[c], start, coeffs, (p0 + 1) * taps, taps);
			out[c][n] = a + (b - a) * w;
		}
	}
	return out;
}
