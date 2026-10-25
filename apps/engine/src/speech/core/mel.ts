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
const N_FFT = 400;
/** Hop length (10 ms). */
export const HOP = 160;
/** Frequency bins of the one-sided spectrum. */
const N_BINS = N_FFT / 2 + 1;

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

type FftPlan = {
	n: number;
	factors: number[];
	cos: Float64Array;
	sin: Float64Array;
	/** Per recursion depth: the r×r table of the r-point DFT twiddles (cos, sin) of that level. */
	dft: Array<{ cos: Float64Array; sin: Float64Array }>;
};

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
	const factors = factorize(n);
	const dft: FftPlan['dft'] = [];
	let len = n;
	for (const r of factors) {
		const m = len / r;
		const step = n / len;
		const c = new Float64Array(r * r);
		const s = new Float64Array(r * r);
		for (let q = 0; q < r; q++)
			for (let j = 0; j < r; j++) {
				const idx = (j * q * m * step) % n;
				c[q * r + j] = cos[idx];
				s[q * r + j] = sin[idx];
			}
		dft.push({ cos: c, sin: s });
		len = m;
	}
	return { n, factors, cos, sin, dft };
}

/** Largest radix (twiddled inputs of one butterfly). */
const MAX_RADIX = 8;
const tr = new Float64Array(MAX_RADIX);
const ti = new Float64Array(MAX_RADIX);

/**
 * Recursive decimation-in-time DFT of `n` points read from (re, im) at `off` with `stride`, written contiguously to
 * (outRe, outIm) at `o`. SG-013: the twiddles of each level's r-point DFT are precomputed and no buffer is
 * allocated per call (the butterfly scratch is shared: a level uses it only after its sub-transforms returned).
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
	for (let j = 0; j < r; j++)
		fftRec(p, re, im, off + j * stride, stride * r, m, fi + 1, outRe, outIm, o + j * m);
	const step = p.n / n;
	const dc = p.dft[fi].cos;
	const ds = p.dft[fi].sin;
	for (let k = 0; k < m; k++) {
		// twiddled inputs (j·k·step < n·step = p.n: no wrap-around)
		for (let j = 0; j < r; j++) {
			const idx = j * k * step;
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
			const row = q * r;
			for (let j = 0; j < r; j++) {
				const c = dc[row + j];
				const s = ds[row + j];
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
const frameIm = new Float64Array(N_FFT);
const frameOutRe = new Float64Array(N_FFT);
const frameOutIm = new Float64Array(N_FFT);

/** DFT of `x` (real, length N_FFT); returns |X[k]|² for k = 0..N_BINS-1 into `out`. */
export function powerSpectrumFrame(x: Float64Array, out: Float32Array | Float64Array, outOff = 0): void {
	frameIm.fill(0);
	fftRec(fftPlan, x, frameIm, 0, 1, N_FFT, 0, frameOutRe, frameOutIm, 0);
	for (let k = 0; k < N_BINS; k++)
		out[outOff + k] = frameOutRe[k] * frameOutRe[k] + frameOutIm[k] * frameOutIm[k];
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

/**
 * Streaming log-mel front end (spec 16 SG-014): the same frames as `logMel(audio ++ zeros(pad))`, computed while
 * the audio arrives, so a long file never needs its whole spectrogram (or its samples) in memory. Each frame's
 * raw `log10(max(e, 1e-10))` mel values (before Whisper's `max − 8` floor and scaling, which need the global
 * maximum) go to `onFrame` (a reused buffer: copy it); `end()` returns the frame count and that maximum.
 */
export class LogMelStream {
	private buf = new Float32Array(1 << 16);
	/** Absolute sample index of buf[0]. */
	private bufStart = 0;
	private bufLen = 0;
	private readonly head = new Float32Array(N_FFT / 2 + 1);
	private pushed = 0;
	private next = 0;
	private max = Number.NEGATIVE_INFINITY;
	private readonly x = new Float64Array(N_FFT);
	/** float32 like the batch path's power spectrum, so both give the same values. */
	private readonly pow = new Float32Array(N_BINS);
	private readonly row: Float32Array;
	private readonly filters: Float32Array;
	private readonly ranges: Array<[number, number]> = [];
	private ended = false;

	constructor(
		private readonly nMels: number,
		private readonly onFrame: (raw: Float32Array, frame: number) => void,
	) {
		this.row = new Float32Array(nMels);
		this.filters = melFilters(nMels);
		for (let m = 0; m < nMels; m++) {
			let a = 0;
			while (a < N_BINS && this.filters[m * N_BINS + a] === 0) a++;
			let b = N_BINS;
			while (b > a && this.filters[m * N_BINS + b - 1] === 0) b--;
			this.ranges.push([a, b]);
		}
	}

	get samples(): number {
		return this.pushed;
	}

	push(chunk: Float32Array): void {
		if (this.ended) throw new Error('LogMelStream: push after end');
		if (!chunk.length) return;
		for (let i = 0; i < chunk.length && this.pushed + i < this.head.length; i++)
			this.head[this.pushed + i] = chunk[i];
		this.append(chunk);
		this.pushed += chunk.length;
		while (this.pushed >= this.next * HOP + N_FFT / 2 + 1) this.frame(this.next++, -1);
		this.compact();
	}

	/** Appends `pad` zero samples (Whisper pads 30 s) and computes the remaining frames. */
	end(pad = 0): { frames: number; max: number } {
		const zeros = new Float32Array(Math.min(pad, 1 << 16));
		let left = pad;
		while (left > 0) {
			const n = Math.min(left, zeros.length);
			this.push(n === zeros.length ? zeros : zeros.subarray(0, n));
			left -= n;
		}
		this.ended = true;
		const total = this.pushed;
		const frames = Math.floor(total / HOP);
		while (this.next < frames) this.frame(this.next++, total);
		return { frames, max: this.max };
	}

	private append(chunk: Float32Array): void {
		const need = this.bufLen + chunk.length;
		if (need > this.buf.length) {
			const grown = new Float32Array(Math.max(need, this.buf.length * 2));
			grown.set(this.buf.subarray(0, this.bufLen));
			this.buf = grown;
		}
		this.buf.set(chunk, this.bufLen);
		this.bufLen = need;
	}

	/** Drops samples no later frame reads. */
	private compact(): void {
		const keepFrom = Math.max(0, this.next * HOP - N_FFT / 2);
		const drop = keepFrom - this.bufStart;
		if (drop <= 0 || drop < this.buf.length / 2) return;
		this.buf.copyWithin(0, drop, this.bufLen);
		this.bufLen -= drop;
		this.bufStart = keepFrom;
	}

	private sample(i: number, total: number): number {
		if (i < 0) return this.head[-i] ?? 0;
		if (total >= 0 && i >= total) i = 2 * (total - 1) - i;
		if (i < 0) return this.head[-i] ?? 0;
		const j = i - this.bufStart;
		return j >= 0 && j < this.bufLen ? this.buf[j] : 0;
	}

	private frame(f: number, total: number): void {
		const base = f * HOP - N_FFT / 2;
		const x = this.x;
		if (base >= this.bufStart && base + N_FFT <= this.bufStart + this.bufLen && (total < 0 || base + N_FFT <= total)) {
			const o = base - this.bufStart;
			for (let i = 0; i < N_FFT; i++) x[i] = this.buf[o + i] * hann[i];
		} else for (let i = 0; i < N_FFT; i++) x[i] = this.sample(base + i, total) * hann[i];
		powerSpectrumFrame(x, this.pow);
		const pow = this.pow;
		for (let m = 0; m < this.nMels; m++) {
			const [a, b] = this.ranges[m];
			const fo = m * N_BINS;
			let s = 0;
			for (let k = a; k < b; k++) s += this.filters[fo + k] * pow[k];
			// the batch path accumulates in float32 (melEnergies' Float32Array): round the same way
			const v = Math.log10(Math.max(Math.fround(s), 1e-10));
			this.row[m] = v;
			if (v > this.max) this.max = v;
		}
		this.onFrame(this.row, f);
	}
}

/**
 * Whisper's window input from raw frame-major log-mel frames (`LogMelStream`): `count` frames starting at frame 0
 * of `raw`, floored at `max − 8`, scaled `(x + 4) / 4`, written band-major into `out` (nMels × N_FRAMES, the rest
 * zero — OpenAI's `pad_or_trim`).
 */
export function windowFromRaw(
	raw: Float32Array,
	count: number,
	nMels: number,
	max: number,
	out: Float32Array,
	nFrames: number,
): void {
	out.fill(0);
	const floor = max - 8;
	for (let f = 0; f < count; f++) {
		const o = f * nMels;
		for (let m = 0; m < nMels; m++) {
			const v = raw[o + m];
			out[m * nFrames + f] = ((v > floor ? v : floor) + 4) / 4;
		}
	}
}
