// Music remix (ported from filmcraft `audio-dsp/src/remix.rs`): retime music to a target duration by cutting it at
// musically similar beat boundaries (Essential Sound ▸ Duration ▸ Remix, the Remix tool).
//
//   mono mix ─► STFT (≈46 ms Hann, ¼ hop) ─► log-magnitude spectral flux = onset envelope
//            ─► tempo: autocorrelation of the envelope, 50–200 BPM, log-Gaussian prior at 120 BPM
//            ─► beats: dynamic programming (onset strength + penalty on the squared log ratio of beat spacing to the
//               period), backtracked from the strongest end (Ellis 2007)
//            ─► per beat: 12-bin chroma and 12 mel cepstra (26 mel bands, DCT-II, c0 dropped)
//            ─► beat self-similarity S(i, j) = 0.6·cos(chroma) + 0.4·(1 + cos(z-scored cepstra))/2
//   plan:  output = piece₀ ⧺ … ⧺ piece_k; each joint leaves the source at beat boundary b_i and continues at b_j, chosen
//          where the context of the jump (CONTEXT beats before and after) is most similar.
//   render: pieces concatenated with an equal-power crossfade centred on every joint.
//
// Segments (0…100) sets the joints: 0–33 → 1, 34–67 → 2, 68–100 → 3 (more when a long extension needs them);
// Variations (0…100) how far from the evenly spaced positions a joint may move: ±(1 + 7·v/100) beats. The intro and
// outro are kept; the plan is within half a beat of the target when the beat grid allows it, always within one beat.
// Deterministic. Positions are samples of the analysed signal. The spectra are processed streaming (no frame store),
// so a five-minute song analyses in a few hundred MB less than the reference.
import { Fft } from '../core/fft.ts';
import { hann } from '../core/stft.ts';

/** Beats of context on each side of a joint that the similarity looks at. */
export const CONTEXT = 4;
/** Shortest piece, in beats (no stutter edits). */
export const MIN_PIECE_BEATS = 4;
/** Crossfade at each joint (seconds). */
export const XFADE_S = 0.02;

export type Piece = { src: number; len: number };
export type Plan = { pieces: Piece[]; xfade: number };
export type RemixParams = { segments: number; variations: number };
export const DEFAULT_REMIX_PARAMS: RemixParams = { segments: 50, variations: 50 };

export type Analysis = {
	sampleRate: number;
	/** Source length (samples). */
	len: number;
	/** Beat positions (samples), increasing. */
	beats: number[];
	/** Beat period (samples). */
	period: number;
	bpm: number;
	/** Beat self-similarity, beats.length², row-major. */
	sim: Float32Array;
};

export class RemixError extends Error {
	constructor(readonly code: 'NO_BEAT' | 'TOO_SHORT' | 'TARGET_TOO_SHORT') {
		super(
			code === 'NO_BEAT'
				? 'no beat found in the audio'
				: code === 'TOO_SHORT'
					? 'the music is too short to remix'
					: 'the target duration is too short for this music',
		);
		this.name = 'RemixError';
	}
}

export const planLength = (p: Plan): number => p.pieces.reduce((s, x) => s + x.len, 0);
export const identityPlan = (len: number, xfade: number): Plan => ({ pieces: [{ src: 0, len }], xfade });

/** Source positions each joint cuts at: [end of the outgoing piece, start of the incoming one]. */
export function planCuts(p: Plan): [number, number][] {
	const out: [number, number][] = [];
	for (let i = 0; i + 1 < p.pieces.length; i++)
		out.push([p.pieces[i]!.src + p.pieces[i]!.len, p.pieces[i + 1]!.src]);
	return out;
}

function jumpScore(a: Analysis, i: number, j: number): number {
	const m = a.beats.length;
	let s = 0;
	let n = 0;
	for (let k = 0; k < CONTEXT; k++) {
		if (i + k < m && j + k < m) {
			s += a.sim[(i + k) * m + (j + k)]!;
			n++;
		}
		if (i > k && j > k) {
			s += a.sim[(i - 1 - k) * m + (j - 1 - k)]!;
			n++;
		}
	}
	return n > 0 ? s / n : 0;
}

/** Calls `frame(t, mag)` for every STFT frame (frames start at t·hop; zero-padded past the end). */
function stftFrames(
	x: Float32Array,
	n: number,
	hop: number,
	frame: (t: number, mag: Float64Array) => void,
): number {
	const fft = new Fft(n);
	const w = hann(n);
	const frames = x.length >= n ? Math.floor((x.length - n) / hop) + 1 : 1;
	const re = new Float64Array(n);
	const im = new Float64Array(n);
	const mag = new Float64Array(n / 2 + 1);
	for (let t = 0; t < frames; t++) {
		const s = t * hop;
		for (let i = 0; i < n; i++) {
			re[i] = s + i < x.length ? x[s + i]! * w[i]! : 0;
			im[i] = 0;
		}
		fft.forward(re, im);
		for (let k = 0; k <= n / 2; k++) mag[k] = Math.sqrt(re[k]! * re[k]! + im[k]! * im[k]!);
		frame(t, mag);
	}
	return frames;
}

/** STFT frame of the onset envelope: the power of two nearest to 46 ms. */
function onsetFrame(sr: number): number {
	const n = Math.max(sr * 0.046, 256);
	return 1 << Math.round(Math.log2(n));
}

/** Below this normalised autocorrelation at the beat period there is no usable pulse. */
const MIN_PULSE = 0.1;
/** Above this mean of the unit-variance onset envelope the sound is steady (no onsets to cut at). */
const MAX_STEADY_FLUX = 1.2;

/** Onset strength per hop: half-wave rectified log-magnitude spectral flux, unit standard deviation. */
export function onsetEnvelope(x: Float32Array, sr: number): { env: Float64Array; n: number; hop: number } {
	const n = onsetFrame(sr);
	const hop = n / 4;
	const bins = n / 2 + 1;
	const prev = new Float64Array(bins);
	const values: number[] = [];
	stftFrames(x, n, hop, (t, mag) => {
		let flux = 0;
		for (let k = 0; k < bins; k++) {
			const lg = Math.log(1 + 1000 * mag[k]!);
			if (t > 0) flux += Math.max(lg - prev[k]!, 0);
			prev[k] = lg;
		}
		values.push(t > 0 ? flux : 0);
	});
	const env = Float64Array.from(values);
	let mean = 0;
	for (const v of env) mean += v;
	mean /= Math.max(env.length, 1);
	let sd = 0;
	for (const v of env) sd += (v - mean) * (v - mean);
	sd = Math.sqrt(sd / Math.max(env.length, 1));
	if (sd > 0) for (let i = 0; i < env.length; i++) env[i] = env[i]! / sd;
	return { env, n, hop };
}

/** Beat period in envelope frames from the autocorrelation (50–200 BPM, prior centred at 120 BPM). */
function tempo(env: Float64Array, frameRate: number): number | null {
	let mean = 0;
	for (const v of env) mean += v;
	mean /= Math.max(env.length, 1);
	const e = env.map((v) => v - mean);
	const lo = Math.max(Math.floor((frameRate * 60) / 200), 2);
	const hi = Math.min(Math.ceil((frameRate * 60) / 50), Math.floor(e.length / 2));
	if (hi <= lo + 2) return null;
	const ac = (lag: number) => {
		let s = 0;
		for (let i = 0; i + lag < e.length; i++) s += e[i]! * e[i + lag]!;
		return s / (e.length - lag);
	};
	const raw: number[] = [];
	for (let lag = lo - 1; lag <= hi + 1; lag++) raw.push(ac(lag));
	let best = Number.NEGATIVE_INFINITY;
	let bk = 0;
	for (let k = 1; k < raw.length - 1; k++) {
		const lag = lo - 1 + k;
		const bpm = (60 * frameRate) / lag;
		const w = raw[k]! * Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
		if (w > best) {
			best = w;
			bk = k;
		}
	}
	if (best <= 0 || raw[bk]! <= MIN_PULSE * ac(0)) return null;
	const a = raw[bk - 1]!;
	const b = raw[bk]!;
	const c = raw[bk + 1]!;
	const den = a - 2 * b + c;
	const d = den < 0 ? Math.min(Math.max((0.5 * (a - c)) / den, -0.5), 0.5) : 0;
	return lo - 1 + bk + d;
}

/** Dynamic-programming beat tracker: frame indices of beats. */
function trackBeats(env: Float64Array, period: number): number[] {
	const n = env.length;
	const score = new Float64Array(n);
	const back = new Int32Array(n).fill(-1);
	const tight = 100;
	const lo = Math.max(Math.round(period * 0.5), 1);
	const hi = Math.round(period * 2);
	for (let t = 0; t < n; t++) {
		let best = 0;
		let arg = -1;
		if (t >= lo)
			for (let prev = Math.max(t - hi, 0); prev <= t - lo; prev++) {
				const r = Math.log((t - prev) / period);
				const v = score[prev]! - tight * r * r;
				if (arg === -1 || v > best) {
					best = v;
					arg = prev;
				}
			}
		score[t] = env[t]! + (arg === -1 ? 0 : Math.max(best, 0));
		back[t] = arg !== -1 && best > 0 ? arg : -1;
	}
	const tail = Math.max(n - (Math.ceil(period) + 1), 0);
	let t = tail;
	for (let k = tail; k < n; k++) if (score[k]! > score[t]!) t = k;
	const beats = [t];
	while (back[t]! !== -1) {
		t = back[t]!;
		beats.push(t);
	}
	return beats.reverse();
}

const hzToMel = (f: number) => 2595 * Math.log10(1 + f / 700);
const melToHz = (m: number) => 700 * (10 ** (m / 2595) - 1);
const MEL_BANDS = 26;

/** Per-beat chroma (12) and z-scored cepstra (12) from a 2× larger STFT. */
function beatFeatures(
	x: Float32Array,
	sr: number,
	beats: number[],
): { chroma: Float64Array[]; cep: Float64Array[] } {
	const n = Math.max(onsetFrame(sr) * 2, 1024);
	const hop = n / 2;
	const bins = n / 2 + 1;
	const hz = (k: number) => (k * sr) / n;
	const pc = new Int8Array(bins).fill(-1);
	for (let k = 0; k < bins; k++) {
		const f = hz(k);
		if (f >= 55 && f <= 5000)
			pc[k] = ((((Math.round(12 * Math.log2(f / 440)) + 9) % 12) + 12) % 12) as number;
	}
	const fmax = Math.min(sr / 2, 8000);
	const m0 = hzToMel(30);
	const m1 = hzToMel(fmax);
	const edges = Array.from({ length: MEL_BANDS + 2 }, (_, i) =>
		melToHz(m0 + ((m1 - m0) * i) / (MEL_BANDS + 1)),
	);
	// Sparse triangular weights: each bin feeds at most two bands.
	const wBand: { band: number; w: number }[][] = Array.from({ length: bins }, () => []);
	for (let b = 0; b < MEL_BANDS; b++) {
		const l = edges[b]!;
		const c = edges[b + 1]!;
		const r = edges[b + 2]!;
		for (let k = 0; k < bins; k++) {
			const f = hz(k);
			const w = f > l && f < c ? (f - l) / (c - l) : f >= c && f < r ? (r - f) / (r - c) : 0;
			if (w > 0) wBand[k]!.push({ band: b, w });
		}
	}
	const m = beats.length;
	const chroma = Array.from({ length: m }, () => new Float64Array(12));
	const cep = Array.from({ length: m }, () => new Float64Array(12));
	const cnt = new Float64Array(m);
	const band = new Float64Array(MEL_BANDS);
	const end = x.length;
	let bi = 0;
	stftFrames(x, n, hop, (t, mag) => {
		const centre = t * hop + n / 2;
		while (bi < m && centre >= (bi + 1 < m ? beats[bi + 1]! : end)) bi++;
		if (bi >= m || centre < beats[bi]!) return;
		const c = chroma[bi]!;
		band.fill(0);
		for (let k = 0; k < bins; k++) {
			const p = mag[k]! * mag[k]!;
			if (pc[k]! >= 0) c[pc[k]!] = c[pc[k]!]! + p;
			for (const { band: b, w } of wBand[k]!) band[b] = band[b]! + w * p;
		}
		const q = cep[bi]!;
		for (let j = 0; j < 12; j++) {
			let s = 0;
			for (let b = 0; b < MEL_BANDS; b++)
				s += Math.log(band[b]! + 1e-10) * Math.cos((Math.PI * (j + 1) * (b + 0.5)) / MEL_BANDS);
			q[j] = q[j]! + s;
		}
		cnt[bi] = cnt[bi]! + 1;
	});
	for (let i = 0; i < m; i++) {
		const q = cep[i]!;
		if (cnt[i]! > 0) for (let j = 0; j < 12; j++) q[j] = q[j]! / cnt[i]!;
		const c = chroma[i]!;
		let norm = 0;
		for (let j = 0; j < 12; j++) norm += c[j]! * c[j]!;
		norm = Math.sqrt(norm);
		if (norm > 0) for (let j = 0; j < 12; j++) c[j] = c[j]! / norm;
	}
	for (let j = 0; j < 12; j++) {
		let mean = 0;
		for (const q of cep) mean += q[j]!;
		mean /= Math.max(m, 1);
		let sd = 0;
		for (const q of cep) sd += (q[j]! - mean) ** 2;
		sd = Math.max(Math.sqrt(sd / Math.max(m, 1)), 1e-6);
		for (const q of cep) q[j] = (q[j]! - mean) / sd;
	}
	return { chroma, cep };
}

function cosSim(a: Float64Array, b: Float64Array): number {
	let d = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < 12; i++) {
		d += a[i]! * b[i]!;
		na += a[i]! * a[i]!;
		nb += b[i]! * b[i]!;
	}
	return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : 0;
}

/** How far the analysed beats sit before the attack of each beat (half a crossfade), samples. */
function beatLead(sampleRate: number): number {
	return Math.round(XFADE_S * 0.5 * sampleRate);
}

function localMax(env: Float64Array, t: number, r: number): number {
	let m = 0;
	for (let i = Math.max(t - r, 0); i < Math.min(t + r + 1, env.length); i++) m = Math.max(m, env[i]!);
	return m;
}

/** Analyses planar audio (channels summed to mono). Throws RemixError for audio without a usable beat. */
export function analyzeMusic(channels: readonly Float32Array[], sampleRate: number): Analysis {
	const len = Math.max(0, ...channels.map((c) => c.length));
	const k = 1 / Math.max(channels.length, 1);
	const mono = new Float32Array(len);
	for (const c of channels) for (let i = 0; i < c.length; i++) mono[i] = mono[i]! + c[i]! * k;
	const { env, n, hop } = onsetEnvelope(mono, sampleRate);
	// Steady sounds (a held tone, broadband noise) have a flux without onsets: mean ≳ standard deviation. Music's
	// flux is sparse peaks (mean/sd ≈ 0.4 on the generated test music, 1.5 on a steady sine). A steady tone's
	// frame-phase ripple can pass the autocorrelation test alone.
	let envMean = 0;
	for (const v of env) envMean += v;
	envMean /= Math.max(env.length, 1);
	if (envMean > MAX_STEADY_FLUX) throw new RemixError('NO_BEAT');
	const frameRate = sampleRate / hop;
	const period = tempo(env, frameRate);
	if (period === null) throw new RemixError('NO_BEAT');
	const frames = trackBeats(env, period);
	const strengths = frames.map((t) => localMax(env, t, 2)).sort((a, b) => a - b);
	const median = strengths[strengths.length >> 1] ?? 0;
	while (frames.length && localMax(env, frames[0]!, 2) < 0.3 * median) frames.shift();
	while (frames.length && localMax(env, frames[frames.length - 1]!, 2) < 0.3 * median) frames.pop();
	const offGrid = (a: number, b: number) => Math.abs((b - a) / period - 1) > 0.05;
	while (frames.length > 2 && offGrid(frames[frames.length - 2]!, frames[frames.length - 1]!)) frames.pop();
	while (frames.length > 2 && offGrid(frames[0]!, frames[1]!)) frames.shift();
	// The flux of frame t peaks as soon as an attack enters the newer window, at about t·hop + n − ¾·hop; joints sit
	// half a crossfade earlier so a joint's fade is over when the beat's attack starts.
	const beats: number[] = [];
	for (const t of frames) {
		const b = t * hop + n - Math.floor((3 * hop) / 4) - beatLead(sampleRate);
		if (b > 0 && b < len && beats[beats.length - 1] !== b) beats.push(b);
	}
	if (beats.length < 2 * MIN_PIECE_BEATS + 2)
		throw new RemixError(beats.length < 4 ? 'NO_BEAT' : 'TOO_SHORT');
	const { chroma, cep } = beatFeatures(mono, sampleRate, beats);
	const m = beats.length;
	const sim = new Float32Array(m * m);
	for (let i = 0; i < m; i++)
		for (let j = 0; j < m; j++)
			sim[i * m + j] = 0.6 * cosSim(chroma[i]!, chroma[j]!) + 0.4 * (1 + cosSim(cep[i]!, cep[j]!)) * 0.5;
	const periodS = period * hop;
	return { sampleRate, len, beats, period: periodS, bpm: (60 * sampleRate) / periodS, sim };
}

/** Joints the Segments slider asks for. */
export function jointsFor(segments: number): number {
	return 1 + Math.floor(Math.min(Math.max(segments, 0), 100) / 34);
}

/** Plans a remix of the analysed music to `target` samples (throws RemixError TARGET_TOO_SHORT). */
export function planRemix(a: Analysis, target: number, params: RemixParams = DEFAULT_REMIX_PARAMS): Plan {
	const xfade = Math.round(XFADE_S * a.sampleRate);
	const len = a.len;
	const half = Math.trunc(a.period / 2);
	if (Math.abs(target - len) <= half) return identityPlan(len, xfade);
	const b = a.beats;
	const m = b.length;
	const minPiece = Math.trunc(MIN_PIECE_BEATS * a.period);
	if (target < 2 * minPiece) throw new RemixError('TARGET_TOO_SHORT');
	const window = 1 + Math.round((7 * Math.min(Math.max(params.variations, 0), 100)) / 100);
	let k = Math.min(jointsFor(params.segments), Math.max(Math.round(Math.abs(target - len) / a.period), 1));
	while (k > 1 && Math.trunc(target / (k + 1)) < minPiece) k--;
	if (target > len) {
		const maxSpan = Math.max(len - 2 * minPiece, Math.trunc(a.period));
		while ((target - len) / k > maxSpan * 0.9 && Math.trunc(target / (k + 2)) >= minPiece) k++;
	}
	const nearest = (x: number) => {
		let lo = 0;
		let hi = m;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (b[mid]! < x) lo = mid + 1;
			else hi = mid;
		}
		return Math.min(lo, m - 1);
	};
	const closest = (x: number) => {
		const i = nearest(x);
		return i > 0 && Math.abs(x - b[i - 1]!) <= Math.abs(b[i]! - x) ? i - 1 : i;
	};
	const pieces: Piece[] = [];
	let src = 0;
	let out = 0;
	const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
	for (let jn = 0; jn < k; jn++) {
		const left = k - jn;
		const outLeft = target - out;
		const piece = Math.trunc(outLeft / (left + 1));
		const srcLeft = len - src;
		const span = Math.trunc((srcLeft - outLeft) / left);
		const ni = closest(src + piece);
		const last = jn + 1 === k;
		let best: { score: number; err: number; i: number; j: number } | null = null;
		for (let i = Math.max(ni - window, 0); i <= Math.min(ni + window, m - 1); i++) {
			if (b[i]! - src < minPiece) continue;
			const nj = closest(b[i]! + span);
			for (let j = Math.max(nj - window, 0); j <= Math.min(nj + window, m - 1); j++) {
				if (j === i || len - b[j]! < minPiece || b[j]! > b[i]! !== target < len) continue;
				const newOut = out + (b[i]! - src);
				const restSrc = len - b[j]!;
				const err = target - newOut - restSrc;
				if (last) {
					if (Math.abs(err) > Math.max(half, 1) * 2) continue;
				} else {
					const remOut = target - newOut;
					if (remOut < left * minPiece) continue;
					const rem = restSrc - remOut;
					if (sign(rem) !== sign(len - target) || Math.abs(rem) < (left - 1) * a.period * 0.75) continue;
				}
				const score = jumpScore(a, i, j);
				const keyErr = last ? Math.trunc(Math.abs(err) / Math.max(half, 1)) : 0;
				const better =
					best === null ||
					keyErr < best.err ||
					(keyErr === best.err &&
						(score > best.score || (score === best.score && (i < best.i || (i === best.i && j < best.j)))));
				if (better) best = { score, err: keyErr, i, j };
			}
		}
		if (!best) throw new RemixError('TARGET_TOO_SHORT');
		pieces.push({ src, len: b[best.i]! - src });
		out += b[best.i]! - src;
		src = b[best.j]!;
	}
	pieces.push({ src, len: len - src });
	return { pieces, xfade };
}
