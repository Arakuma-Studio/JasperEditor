// Log-mel spectrogram front end (Whisper's), from the published recipe (ported from FilmCraft
// `crates/speech/src/mel.rs`, MIT OR Apache-2.0; see licenses/ported/speech.md):
// 16 kHz audio, 400-sample periodic Hann window, hop 160 (100 frames/s), reflect padding of 200 samples at both
// ends (centred frames), power spectrum, Slaney mel filterbank with Slaney area normalisation (0–8 kHz),
// `log10(max(x, 1e-10))`, floor at `max − 8`, then `(x + 4) / 4`. The last STFT frame is dropped, so `n`
// samples give `floor(n / 160)` frames. The filterbank is computed here, not loaded from a file.
//
// Difference from the reference: the 400-point DFT is a mixed-radix FFT (2⁴·5²) instead of a direct DFT
// (same values to float precision, ~20× faster).

export const SAMPLE_RATE = 16_000;
/** FFT size (25 ms). */
export const N_FFT = 400;
/** Hop length (10 ms). */
export const HOP = 160;
/** Frequency bins of the one-sided spectrum. */
export const N_BINS = N_FFT / 2 + 1;

export function hzToMel(f: number): number {
	const fSp = 200 / 3;
	const minLogHz = 1000;
	const minLogMel = minLogHz / fSp;
	const logstep = Math.log(6.4) / 27;
	return f >= minLogHz ? minLogMel + Math.log(f / minLogHz) / logstep : f / fSp;
}

export function melToHz(m: number): number {
	const fSp = 200 / 3;
	const minLogHz = 1000;
	const minLogMel = minLogHz / fSp;
	const logstep = Math.log(6.4) / 27;
	return m >= minLogMel ? minLogHz * Math.exp(logstep * (m - minLogMel)) : fSp * m;
}

const filterCache = new Map<number, Float32Array>();

/** Mel filterbank, `nMels × N_BINS` row-major, for 16 kHz audio and a 400-point FFT. */
export function melFilters(nMels: number): Float32Array {
	const hit = filterCache.get(nMels);
	if (hit) return hit;
	const sr = SAMPLE_RATE;
	const fftfreqs = Array.from({ length: N_BINS }, (_, i) => (i * sr) / N_FFT);
	const lo = hzToMel(0);
	const hi = hzToMel(sr / 2);
	const melF = Array.from({ length: nMels + 2 }, (_, i) => melToHz(lo + ((hi - lo) * i) / (nMels + 1)));
	const w = new Float32Array(nMels * N_BINS);
	for (let m = 0; m < nMels; m++) {
		const enorm = 2 / (melF[m + 2] - melF[m]);
		for (let k = 0; k < N_BINS; k++) {
			const f = fftfreqs[k];
			const lower = (f - melF[m]) / (melF[m + 1] - melF[m]);
			const upper = (melF[m + 2] - f) / (melF[m + 2] - melF[m + 1]);
			w[m * N_BINS + k] = Math.max(0, Math.min(lower, upper)) * enorm;
		}
	}
	filterCache.set(nMels, w);
	return w;
}

// ------------------------------------------------------------------ FFT (mixed radix, N = 400)

type FftPlan = { n: number; factors: number[]; cos: Float64Array; sin: Float64Array };

function factorize(n: number): number[] {
	const out: number[] = [];
	for (const p of [4, 2, 3, 5]) {
		while (n % p === 0) {
			out.push(p);
			n /= p;
		}
	}
	if (n > 1) out.push(n);
	return out;
}

function plan(n: number): FftPlan {
	const cos = new Float64Array(n);
	const sin = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const a = (-2 * Math.PI * i) / n;
		cos[i] = Math.cos(a);
		sin[i] = Math.sin(a);
	}
	return { n, factors: factorize(n), cos, sin };
}

/**
 * In-place-free recursive decimation-in-time DFT of `n` points read from (re, im) at `off` with `stride`,
 * written contiguously to (outRe, outIm) at `o`. `tw` = n_total / n (twiddle step).
 */
function fftRec(
	p: FftPlan,
	re: Float64Array,
	im: Float64Array,
	off: number,
	stride: number,
	n: number,
	fi: number,
	outRe: Float64Array,
	outIm: Float64Array,
	o: number,
): void {
	if (n === 1) {
		outRe[o] = re[off];
		outIm[o] = im[off];
		return;
	}
	const r = p.factors[fi];
	const m = n / r;
	// sub-transforms of x[off + (j + r·k)·stride], j = 0..r-1, each m points, stored at o + j·m
	for (let j = 0; j < r; j++) fftRec(p, re, im, off + j * stride, stride * r, m, fi + 1, outRe, outIm, o + j * m);
	const step = p.n / n;
	const tr = new Float64Array(r);
	const ti = new Float64Array(r);
	for (let k = 0; k < m; k++) {
		// twiddled inputs
		for (let j = 0; j < r; j++) {
			const idx = (j * k * step) % p.n;
			const c = p.cos[idx];
			const s = p.sin[idx];
			const a = outRe[o + j * m + k];
			const b = outIm[o + j * m + k];
			tr[j] = a * c - b * s;
			ti[j] = a * s + b * c;
		}
		// r-point DFT of the twiddled values
		for (let q = 0; q < r; q++) {
			let sr = 0;
			let si = 0;
			for (let j = 0; j < r; j++) {
				const idx = ((j * q * m * step) % p.n) as number;
				const c = p.cos[idx];
				const s = p.sin[idx];
				sr += tr[j] * c - ti[j] * s;
				si += tr[j] * s + ti[j] * c;
			}
			scratchRe[q * m + k] = sr;
			scratchIm[q * m + k] = si;
		}
	}
	for (let i = 0; i < n; i++) {
		outRe[o + i] = scratchRe[i];
		outIm[o + i] = scratchIm[i];
	}
}

const scratchRe = new Float64Array(N_FFT);
const scratchIm = new Float64Array(N_FFT);
const fftPlan = plan(N_FFT);

/** DFT of `x` (real, length N_FFT); returns |X[k]|² for k = 0..N_BINS-1 into `out`. */
export function powerSpectrumFrame(x: Float64Array, out: Float32Array | Float64Array, outOff = 0): void {
	const im = new Float64Array(N_FFT);
	const oRe = new Float64Array(N_FFT);
	const oIm = new Float64Array(N_FFT);
	fftRec(fftPlan, x, im, 0, 1, N_FFT, 0, oRe, oIm, 0);
	for (let k = 0; k < N_BINS; k++) out[outOff + k] = oRe[k] * oRe[k] + oIm[k] * oIm[k];
}

const hann = (() => {
	const w = new Float64Array(N_FFT);
	for (let i = 0; i < N_FFT; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
	return w;
})();

/** Power spectrum frames (`frames × N_BINS`) of `audio`, Whisper framing (see the module docs). */
export function powerSpectrum(audio: Float32Array): { frames: number; data: Float32Array } {
	const pad = N_FFT / 2;
	const n = audio.length;
	const at = (i: number): number => {
		if (n === 0) return 0;
		if (n === 1) return audio[0];
		const p = 2 * (n - 1);
		let j = ((i % p) + p) % p;
		if (j >= n) j = p - j;
		return audio[j];
	};
	const frames = Math.floor(n / HOP);
	const data = new Float32Array(frames * N_BINS);
	const x = new Float64Array(N_FFT);
	for (let f = 0; f < frames; f++) {
		const base = f * HOP - pad;
		if (base >= 0 && base + N_FFT <= n) for (let i = 0; i < N_FFT; i++) x[i] = audio[base + i] * hann[i];
		else for (let i = 0; i < N_FFT; i++) x[i] = at(base + i) * hann[i];
		powerSpectrumFrame(x, data, f * N_BINS);
	}
	return { frames, data };
}

/** Mel energies `nMels × frames` (row-major by mel band, like Whisper's input) before the log. */
export function melEnergies(audio: Float32Array, nMels: number): { frames: number; data: Float32Array } {
	const { frames, data: pow } = powerSpectrum(audio);
	const filters = melFilters(nMels);
	// sparse filter rows: the non-zero bin range of each band
	const ranges: Array<[number, number]> = [];
	for (let m = 0; m < nMels; m++) {
		let a = 0;
		while (a < N_BINS && filters[m * N_BINS + a] === 0) a++;
		let b = N_BINS;
		while (b > a && filters[m * N_BINS + b - 1] === 0) b--;
		ranges.push([a, b]);
	}
	const out = new Float32Array(nMels * frames);
	for (let f = 0; f < frames; f++) {
		const po = f * N_BINS;
		for (let m = 0; m < nMels; m++) {
			const [a, b] = ranges[m];
			const fo = m * N_BINS;
			let s = 0;
			for (let k = a; k < b; k++) s += filters[fo + k] * pow[po + k];
			out[m * frames + f] = s;
		}
	}
	return { frames, data: out };
}

/** Whisper's normalised log-mel spectrogram, `nMels × frames` row-major. */
export function logMel(audio: Float32Array, nMels: number): { frames: number; data: Float32Array } {
	const { frames, data } = melEnergies(audio, nMels);
	let max = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < data.length; i++) {
		const v = Math.log10(Math.max(data[i], 1e-10));
		data[i] = v;
		if (v > max) max = v;
	}
	for (let i = 0; i < data.length; i++) data[i] = (Math.max(data[i], max - 8) + 4) / 4;
	return { frames, data };
}
