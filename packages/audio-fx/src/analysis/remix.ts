// Music remix (ported from filmcraft `audio-dsp/src/remix.rs`): retime music to a target duration by cutting it at
// musically similar beat boundaries (Essential Sound ▸ Duration ▸ Remix, the Remix tool).
//
//   mono mix ─► STFT (≈46 ms Hann, ¼ hop) ─► log-magnitude spectral flux = onset envelope
//            ─► tempo: autocorrelation of the envelope, 50–210 BPM: the metrical level whose multiples are strongest
//               under a perceptual prior (flat 90–180 BPM), then the tempo octave (a half / third period as strong
//               as the period is the beat)
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
//
// P6-E11 (spec 12; wp-note "Phase 6 → WP-E7"; ideas from earshot `skills/real-sound/scripts/arrange.py`, MIT,
// reimplemented): the beat grid sits on the MEASURED attacks (the onset envelope lags them by up to a hop, and a joint on
// a lagging grid chops the downbeat), every joint `JOINT_LEAD_S` before its beat's attack; the analysis carries the
// bar lines (downbeats, 3 or 4 beats per bar detected) and the drop candidates (`findDrops`), and `planAnchoredRemix`
// lands chosen source moments (the drop) on chosen output times within a millisecond, joining at bar lines only.
import { Fft } from '../core/fft.ts';
import { hann } from '../core/stft.ts';

/** Beats of context on each side of a joint that the similarity looks at. */
export const CONTEXT = 4;
/** Shortest piece, in beats (no stutter edits). */
export const MIN_PIECE_BEATS = 4;
/** Crossfade at each joint (seconds). */
export const XFADE_S = 0.02;
/**
 * How far before its beat's measured attack a joint sits (seconds): ≥ 3 ms (spec 12 P6-E11) with a margin for the
 * attack measurement (5 ms RMS windows). The timeline's joint crossfade ends at the joint (`clip.remix`), so nothing of
 * either side's attack is faded or doubled.
 */
export const JOINT_LEAD_S = 0.005;

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
	/** The measured attack of each beat (samples; `beats[i]` = `attacks[i]` − the joint lead). */
	attacks: number[];
	/** Indices into `beats` of the bar lines (downbeats), `beatsPerBar` apart. */
	downbeats: number[];
	beatsPerBar: number;
	/** The bar lines are a guess (no beat per bar is clearly accented: the strongest phase is used). */
	barsGuessed: boolean;
	/** Drop candidates, best first (`findDrops`). */
	drops: MusicDrop[];
};

export type RemixErrorCode =
	| 'NO_BEAT'
	| 'TOO_SHORT'
	| 'TARGET_TOO_SHORT'
	| 'ANCHOR_OUT_OF_RANGE'
	| 'ANCHOR_UNREACHABLE'
	| 'NO_PLAN_NEAR_TARGET';

export class RemixError extends Error {
	constructor(
		readonly code: RemixErrorCode,
		message?: string,
		/** NO_PLAN_NEAR_TARGET: the nearest output lengths a plan reaches (samples), shorter first. */
		readonly nearestTargets: number[] = [],
	) {
		super(
			message ??
				(code === 'NO_BEAT'
					? 'no beat found in the audio'
					: code === 'TOO_SHORT'
						? 'the music is too short to remix'
						: code === 'TARGET_TOO_SHORT'
							? 'the target duration is too short for this music'
							: code === 'ANCHOR_OUT_OF_RANGE'
								? 'an anchor lies outside the music or the target'
								: code === 'ANCHOR_UNREACHABLE'
									? 'no plan lands the anchor there'
									: 'no plan ends within half a beat of the target'),
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

export function jumpScore(a: Analysis, i: number, j: number): number {
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

/** Tempo search range (BPM). */
export const TEMPO_MIN_BPM = 50;
export const TEMPO_MAX_BPM = 210;
/**
 * Perceptual tempo prior: flat over the preferred band (listeners tap most music between ≈ 90 and 180 BPM; the
 * resonance of beat perception peaks near 2 Hz — van Noorden & Moelants 1999, Moelants 2002), a log-Gaussian of one
 * octave outside it.
 */
export const TEMPO_PREFERRED_BPM: readonly [number, number] = [90, 180];
/** Lags summed either side of a period: a pulse whose period is not a whole number of hops spreads over them. */
const LAG_SPREAD = 2;
/** Multiples of a period its metrical salience averages (a beat's bars are periodic too; a sub-beat's are not). */
const COMB = 4;
/**
 * Tempo octave: a pulse between the beats whose attack (linear amplitude rise) is at least this share of the beats'
 * (≈ −14 dB) is a beat of its own (a fast click, a snare between kicks); a quieter one subdivides the beat (hats).
 * Hats sit 15–25 dB under the kick and snare of a mix; the log-compressed onset envelope cannot tell them apart.
 */
export const SUBDIVISION_RATIO = 0.2;

function tempoPrior(bpm: number): number {
	const [lo, hi] = TEMPO_PREFERRED_BPM;
	const o = bpm < lo ? Math.log2(lo / bpm) : bpm > hi ? Math.log2(bpm / hi) : 0;
	return Math.exp(-0.5 * o * o);
}

/**
 * Beat period in envelope frames (fractional; TEMPO_MIN_BPM…TEMPO_MAX_BPM), or null without a usable pulse.
 *
 * 1. Periodicity: the autocorrelation of the mean-free onset envelope; the strength of a period L is the positive
 *    autocorrelation summed over L ± LAG_SPREAD lags, so a period of 34.45 hops (150 BPM at 22.05 kHz), whose peak
 *    splits over lags 34 and 35, is not weaker than twice it (68.9, one lag) — the cause of the old half-tempo lock.
 * 2. Metrical level: the period whose multiples (L, 2L, 3L, 4L) are strongest on average, times the prior — the beat
 *    repeats in its bars; a sub-beat level (eighths) or a dotted level (three sixteenths) has weak multiples.
 * 3. The period is refined to a fraction of a hop on its largest strong multiple. The tempo octave is decided on the
 *    attacks themselves (`tempoOctave`).
 */
function tempo(env: Float64Array, frameRate: number): number | null {
	let mean = 0;
	for (const v of env) mean += v;
	mean /= Math.max(env.length, 1);
	const e = env.map((v) => v - mean);
	const bpmOf = (lag: number) => (60 * frameRate) / lag;
	const lo = Math.max(Math.floor((frameRate * 60) / TEMPO_MAX_BPM), 2);
	const hi = Math.min(Math.ceil((frameRate * 60) / TEMPO_MIN_BPM), Math.floor(e.length / 2));
	if (hi <= lo + 2) return null;
	const top = Math.min(Math.floor(e.length / 2), COMB * hi + LAG_SPREAD + 1);
	const ac = new Float64Array(top + 1);
	for (let lag = 0; lag <= top; lag++) {
		let s = 0;
		for (let i = 0; i + lag < e.length; i++) s += e[i]! * e[i + lag]!;
		ac[lag] = s / (e.length - lag);
	}
	const ac0 = ac[0]!;
	if (!(ac0 > 0)) return null;
	/** Positive autocorrelation summed over round(L) ± LAG_SPREAD (0 outside the computed lags). */
	const strength = (L: number) => {
		const c = Math.round(L);
		if (c - LAG_SPREAD < 1 || c + LAG_SPREAD > top) return 0;
		let s = 0;
		for (let j = c - LAG_SPREAD; j <= c + LAG_SPREAD; j++) s += Math.max(ac[j]!, 0);
		return s;
	};
	/** Mean strength over the multiples of L that were computed (at least L itself). */
	const salience = (L: number) => {
		let s = 0;
		let n = 0;
		for (let k = 1; k <= COMB; k++) {
			if (Math.round(k * L) + LAG_SPREAD > top) break;
			s += strength(k * L);
			n++;
		}
		return n ? s / n : 0;
	};
	let period = 0;
	let best = 0;
	for (let lag = lo; lag <= hi; lag++) {
		const w = salience(lag) * tempoPrior(bpmOf(lag));
		if (w > best) {
			best = w;
			period = lag;
		}
	}
	if (!(best > 0)) return null;
	// a usable pulse: the autocorrelation peak near the period stands out of the envelope's own energy
	const c = Math.round(period);
	let peak = 0;
	for (let j = c - LAG_SPREAD; j <= c + LAG_SPREAD; j++) peak = Math.max(peak, ac[j] ?? 0);
	if (peak <= MIN_PULSE * ac0) return null;
	// refine: the centroid of the peak (above its window's floor) at the largest multiple still strong
	let refined = period;
	for (let k = COMB; k >= 1; k--) {
		const m = Math.round(k * period);
		if (m + LAG_SPREAD > top || strength(k * period) < 0.5 * strength(period)) continue;
		let floor = Number.POSITIVE_INFINITY;
		for (let j = m - LAG_SPREAD; j <= m + LAG_SPREAD; j++) floor = Math.min(floor, Math.max(ac[j]!, 0));
		let sw = 0;
		let sj = 0;
		for (let j = m - LAG_SPREAD; j <= m + LAG_SPREAD; j++) {
			const w = Math.max(ac[j]!, 0) - floor;
			sw += w;
			sj += w * j;
		}
		if (sw > 0) {
			const r = sj / sw / k;
			if (Math.abs(r - period) <= 0.5 + LAG_SPREAD / k) refined = r;
		}
		break;
	}
	return refined;
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

/** How far the analysed beats (joint positions) sit before the measured attack of each beat, samples. */
export function beatLead(sampleRate: number): number {
	return Math.round(JOINT_LEAD_S * sampleRate);
}

function localMax(env: Float64Array, t: number, r: number): number {
	let m = 0;
	for (let i = Math.max(t - r, 0); i < Math.min(t + r + 1, env.length); i++) m = Math.max(m, env[i]!);
	return m;
}

function monoOf(channels: readonly Float32Array[]): Float32Array {
	const len = Math.max(0, ...channels.map((c) => c.length));
	const k = 1 / Math.max(channels.length, 1);
	const mono = new Float32Array(len);
	for (const c of channels) for (let i = 0; i < c.length; i++) mono[i] = mono[i]! + c[i]! * k;
	return mono;
}

/** Sample position of the attack the flux of envelope frame `t` reports (it peaks as an attack enters the window). */
const fluxSample = (t: number, n: number, hop: number) => t * hop + n - Math.floor((3 * hop) / 4);

/**
 * Mean attack (linear amplitude rise near the expected position) of the tracked beats and of the `div − 1` pulses
 * evenly between consecutive beats (`sub[j − 1]` for the j-th), and of the even / odd beats.
 */
function pulseAttacks(
	mono: Float32Array,
	sr: number,
	n: number,
	hop: number,
	frames: readonly number[],
	div: number,
): { beat: number; sub: number[]; even: number; odd: number } {
	const radius = 1.5 * hop;
	let beat = 0;
	const sub = new Array<number>(Math.max(0, div - 1)).fill(0);
	let even = 0;
	let odd = 0;
	let ne = 0;
	let no = 0;
	let pairs = 0;
	for (let i = 0; i < frames.length; i++) {
		const sa = fluxSample(frames[i]!, n, hop);
		const r = strongestRise(mono, sa, radius, sr).rise;
		if (i % 2 === 0) {
			even += r;
			ne++;
		} else {
			odd += r;
			no++;
		}
		if (i + 1 >= frames.length) continue;
		const sb = fluxSample(frames[i + 1]!, n, hop);
		beat += r;
		pairs++;
		for (let j = 1; j < div; j++)
			sub[j - 1] = sub[j - 1]! + strongestRise(mono, sa + ((sb - sa) * j) / div, radius, sr).rise;
	}
	const d = Math.max(pairs, 1);
	return {
		beat: beat / d,
		sub: sub.map((v) => v / d),
		even: ne ? even / ne : 0,
		odd: no ? odd / no : 0,
	};
}

/**
 * The tempo octave, decided on the attacks (`SUBDIVISION_RATIO`): a period whose every other beat is much quieter is
 * a subdivision of twice the period; pulses halfway (or a third of the way) between the beats as loud as a beat make
 * the faster level the beat (a 150 BPM click is not 75 BPM; a snare between kicks is a beat, a hat is not).
 */
function tempoOctave(
	env: Float64Array,
	mono: Float32Array,
	sr: number,
	n: number,
	hop: number,
	period: number,
): number {
	const frameRate = sr / hop;
	const bpmOf = (p: number) => (60 * frameRate) / p;
	let p = period;
	const at = pulseAttacks(mono, sr, n, hop, trackBeats(env, p), 2);
	const strong = Math.max(at.even, at.odd);
	if (
		strong > 0 &&
		Math.min(at.even, at.odd) < SUBDIVISION_RATIO * strong &&
		bpmOf(2 * p) >= TEMPO_MIN_BPM - 1e-9
	)
		return 2 * p;
	for (let guard = 0; guard < 2; guard++) {
		let moved = false;
		for (const div of [2, 3]) {
			if (bpmOf(p / div) > TEMPO_MAX_BPM + 1e-9) continue;
			const a = div === 2 && guard === 0 ? at : pulseAttacks(mono, sr, n, hop, trackBeats(env, p), div);
			if (a.beat > 0 && a.sub.every((v) => v >= SUBDIVISION_RATIO * a.beat)) {
				p /= div;
				moved = true;
				break;
			}
		}
		if (!moved) break;
	}
	return p;
}

/** Beat frames of the onset envelope, the period and per-beat onset strength (throws NO_BEAT). */
function trackedBeats(
	mono: Float32Array,
	sampleRate: number,
): { env: Float64Array; n: number; hop: number; frames: number[]; period: number } {
	const { env, n, hop } = onsetEnvelope(mono, sampleRate);
	// Steady sounds (a held tone, broadband noise) have a flux without onsets: mean ≳ standard deviation. Music's
	// flux is sparse peaks (mean/sd ≈ 0.4 on the generated test music, 1.5 on a steady sine). A steady tone's
	// frame-phase ripple can pass the autocorrelation test alone.
	let envMean = 0;
	for (const v of env) envMean += v;
	envMean /= Math.max(env.length, 1);
	if (envMean > MAX_STEADY_FLUX) throw new RemixError('NO_BEAT');
	const frameRate = sampleRate / hop;
	const first = tempo(env, frameRate);
	if (first === null) throw new RemixError('NO_BEAT');
	const period = tempoOctave(env, mono, sampleRate, n, hop, first);
	const frames = trackBeats(env, period);
	const strengths = frames.map((t) => localMax(env, t, 2)).sort((a, b) => a - b);
	const median = strengths[strengths.length >> 1] ?? 0;
	while (frames.length && localMax(env, frames[0]!, 2) < 0.3 * median) frames.shift();
	while (frames.length && localMax(env, frames[frames.length - 1]!, 2) < 0.3 * median) frames.pop();
	const offGrid = (a: number, b: number) => Math.abs((b - a) / period - 1) > 0.05;
	while (frames.length > 2 && offGrid(frames[frames.length - 2]!, frames[frames.length - 1]!)) frames.pop();
	while (frames.length > 2 && offGrid(frames[0]!, frames[1]!)) frames.shift();
	return { env, n, hop, frames, period };
}

/**
 * The attacks of the tracked beats: each beat moved onto the strongest 1 ms-RMS rise within 1.5 hops of where the
 * flux reports it (the envelope's frame lags the attack), with its onset strength and accent (the rise).
 */
function beatAttacks(
	mono: Float32Array,
	sampleRate: number,
): {
	env: Float64Array;
	hop: number;
	period: number;
	attacks: number[];
	strengths: number[];
	accents: number[];
} {
	const { env, n, hop, frames, period } = trackedBeats(mono, sampleRate);
	const attacks: number[] = [];
	const strengths: number[] = [];
	const accents: number[] = [];
	for (const t of frames) {
		const hit = strongestRise(mono, fluxSample(t, n, hop), 1.5 * hop, sampleRate);
		const b = hit.at;
		if (b > 0 && b < mono.length && (attacks.length === 0 || b > attacks[attacks.length - 1]! + hop)) {
			attacks.push(b);
			strengths.push(localMax(env, t, 2));
			accents.push(hit.rise);
		}
	}
	return { env, hop, period: period * hop, attacks, strengths, accents };
}

/** The bar lines of accented beats: the metre asked or detected (3 or 4), the phase, and whether it is a guess. */
function barLines(
	accents: readonly number[],
	timeSignature: TimeSignature | undefined,
): { downbeats: number[] | null; phase: number; beatsPerBar: number; asked: boolean; confidence: number } {
	const asked = beatsPerBarOf(timeSignature);
	let m: number;
	let bar: ReturnType<typeof barAccent>;
	if (asked !== null) {
		m = asked;
		bar = barAccent(accents, m);
	} else {
		const four = barAccent(accents, 4);
		const three = barAccent(accents, 3);
		const triple = three.ok && (!four.ok || three.contrast >= TRIPLE_MARGIN * four.contrast);
		m = triple ? 3 : 4;
		bar = triple ? three : four;
	}
	let downbeats: number[] | null = null;
	if (bar.ok) {
		downbeats = [];
		for (let i = bar.phase; i < accents.length; i += m) downbeats.push(i);
	}
	return { downbeats, phase: bar.phase, beatsPerBar: m, asked: asked !== null, confidence: bar.contrast };
}

/** Analyses planar audio (channels summed to mono). Throws RemixError for audio without a usable beat. */
export function analyzeMusic(
	channels: readonly Float32Array[],
	sampleRate: number,
	opts: BeatOptions = {},
): Analysis {
	const mono = monoOf(channels);
	const len = mono.length;
	const g = beatAttacks(mono, sampleRate);
	// Joints sit JOINT_LEAD_S before each measured attack (the grid on the attacks, not on the lagging envelope).
	const lead = beatLead(sampleRate);
	const beats: number[] = [];
	const attacks: number[] = [];
	const accents: number[] = [];
	g.attacks.forEach((at, i) => {
		const b = at - lead;
		if (b > 0 && b < len && (beats.length === 0 || b > beats[beats.length - 1]!)) {
			beats.push(b);
			attacks.push(at);
			accents.push(g.accents[i]!);
		}
	});
	if (beats.length < 2 * MIN_PIECE_BEATS + 2)
		throw new RemixError(beats.length < 4 ? 'NO_BEAT' : 'TOO_SHORT');
	const { chroma, cep } = beatFeatures(mono, sampleRate, beats);
	const m = beats.length;
	const sim = new Float32Array(m * m);
	for (let i = 0; i < m; i++)
		for (let j = 0; j < m; j++)
			sim[i * m + j] = 0.6 * cosSim(chroma[i]!, chroma[j]!) + 0.4 * (1 + cosSim(cep[i]!, cep[j]!)) * 0.5;
	const bars = barLines(accents, opts.timeSignature);
	const downbeats: number[] = [];
	if (bars.downbeats) downbeats.push(...bars.downbeats);
	else for (let i = bars.phase; i < m; i += bars.beatsPerBar) downbeats.push(i);
	const drops = findDrops(mono, sampleRate, attacks, downbeats, bars.beatsPerBar, g.period);
	return {
		sampleRate,
		len,
		beats,
		period: g.period,
		bpm: (60 * sampleRate) / g.period,
		sim,
		attacks,
		downbeats,
		beatsPerBar: bars.beatsPerBar,
		barsGuessed: !bars.downbeats,
		drops,
	};
}

/** A drop candidate (spec 12 P6-E11): a bar where the music lifts into a loud section. */
export type MusicDrop = {
	/** Index of its downbeat in the beats. */
	beat: number;
	/**
	 * 1-based bar number from the start of the analysed range: the bars before the first bar line the tracker kept are
	 * counted at the bar length (a quiet first beat is often not kept), so a track starting on its downbeat counts as
	 * musicians do.
	 */
	bar: number;
	/** The downbeat's attack (samples). */
	at: number;
	/** liftDb / 3 + 2 · novelty: the higher, the more of a drop. */
	score: number;
	/** The bar's level over the median of the 4 bars before it and over the bar right before it (dB). */
	liftDb: number;
	/** How different the bar sounds from the one before (chroma and timbre distance, 0…≈2.8). */
	novelty: number;
	/** The bar's level against the loud bars (dB; 0 = the 90th percentile of the bars). */
	levelDb: number;
};

/** Most drop candidates reported. */
export const MAX_DROPS = 6;

/**
 * Drop candidates (adapted from earshot `arrange.py`): bar levels (RMS dB) relative to the loud bars (90th percentile);
 * a bar from the second on that is within 3 dB of the loud bars and stays loud (its 4 bars average over −4 dB) is a
 * candidate, scored by its lift over the median of the 4 bars before it and over the bar right before it (/3) plus
 * twice its novelty (the distance of
 * its unit chroma and unit timbre vectors from the previous bar's). Without such loud bars, the bars over the 75th
 * percentile are candidates. Best first, at most `MAX_DROPS`; deterministic.
 */
export function findDrops(
	mono: Float32Array,
	sampleRate: number,
	attacks: readonly number[],
	downbeats: readonly number[],
	beatsPerBar: number,
	period: number,
): MusicDrop[] {
	const starts = downbeats.map((d) => attacks[d]).filter((x): x is number => x !== undefined);
	if (starts.length < 2) return [];
	const barLen = beatsPerBar * period;
	const level: number[] = [];
	const used: number[] = [];
	for (let k = 0; k < starts.length; k++) {
		const a = Math.max(0, Math.round(starts[k]!));
		const b = Math.min(mono.length, Math.round(k + 1 < starts.length ? starts[k + 1]! : starts[k]! + barLen));
		if (b - a < barLen * 0.5) break;
		let e = 0;
		for (let i = a; i < b; i++) e += mono[i]! * mono[i]!;
		level.push(10 * Math.log10(e / (b - a) + 1e-18));
		used.push(starts[k]!);
	}
	const nb = level.length;
	if (nb < 2) return [];
	const sorted = [...level].sort((x, y) => x - y);
	const pct = (p: number) => sorted[Math.min(nb - 1, Math.max(0, Math.round(p * (nb - 1))))]!;
	const rel = level.map((v) => v - pct(0.9));
	const median = (xs: number[]) => {
		const s = [...xs].sort((x, y) => x - y);
		return s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
	};
	const { chroma, cep } = beatFeatures(mono, sampleRate, used);
	const unit = (v: Float64Array) => {
		let s = 0;
		for (const x of v) s += x * x;
		const k = s > 0 ? 1 / Math.sqrt(s) : 0;
		return Array.from(v, (x) => x * k);
	};
	const feats = used.map((_, k) => [...unit(chroma[k]!), ...unit(cep[k]!)]);
	const nov = feats.map((f, k) => {
		if (k === 0) return 0;
		let s = 0;
		const p = feats[k - 1]!;
		for (let i = 0; i < f.length; i++) s += (f[i]! - p[i]!) ** 2;
		return Math.sqrt(s);
	});
	// the lift over the 4 bars before AND over the bar right before (ours: the median alone also lifts the bar after a
	// drop, whose 4 bars before are mostly the quiet ones)
	const lift = rel.map((r, k) =>
		k ? r - Math.max(median(rel.slice(Math.max(0, k - 4), k)), rel[k - 1]!) : 0,
	);
	const stays = rel.map((_, k) => {
		const w = rel.slice(k, k + 4);
		return w.reduce((x, y) => x + y, 0) / w.length;
	});
	const loudNow = rel.map((r, k) => r > -3 && stays[k]! > -4);
	const anyLoud = loudNow.some((x, k) => x && k > 0);
	const p75 = pct(0.75) - pct(0.9);
	// whole bars before the first bar line kept (a quarter beat of tolerance)
	const before = Math.max(0, Math.floor((used[0]! + 0.25 * period) / barLen));
	const out: MusicDrop[] = [];
	for (let k = 1; k < nb; k++) {
		if (anyLoud ? !loudNow[k] : !(rel[k]! > p75)) continue;
		const q = (x: number) => Math.round(x * 1000) / 1000;
		out.push({
			beat: downbeats[k]!,
			bar: k + 1 + before,
			at: used[k]!,
			score: q(lift[k]! / 3 + 2 * nov[k]!),
			liftDb: q(lift[k]!),
			novelty: q(nov[k]!),
			levelDb: q(rel[k]!),
		});
	}
	return out.sort((x, y) => y.score - x.score || x.bar - y.bar).slice(0, MAX_DROPS);
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

/** A source moment (samples of the analysed range) to land at an output time (samples from the remix's start). */
export type RemixAnchor = { src: number; out: number };

/** An anchored plan: its pieces, the head trimmed off the intro, and where each anchor lands. */
export type AnchoredPlan = Plan & {
	/** Samples of the intro left out before the first piece (`pieces[0].src`; < a bar unless the music must start later). */
	headTrim: number;
	/** Each anchor's output position in the plan and its error (samples; |err| ≤ 1 ms). */
	anchors: { src: number; out: number; at: number; err: number }[];
	/** The output length asked for (samples); `planLength` is within half a beat of it. */
	target: number;
};

/** Anchors per plan. */
export const MAX_REMIX_ANCHORS = 4;

type Joint = { i: number; j: number; loops: number; err: number; score: number };

/**
 * The best bar-line joint (beat indices `i` → `j`, `loops` times) shifting the source by about `shift` samples:
 * playing to beat i and continuing at beat j skips b_j − b_i (negative: the bars between are played again, `loops`
 * times). `err` = shift − loops · (b_j − b_i) must pass `accept`; among the accepted, the lowest `rank(err)`, then the
 * most similar joint context (`jumpScore`), then the earliest.
 */
function bestJoint(
	a: Analysis,
	grid: readonly number[],
	o: {
		shift: number;
		iRange: [number, number];
		jRange: [number, number];
		minPiece: number;
		accept: (err: number, bi: number, bj: number) => boolean;
		rank: (err: number) => number;
		maxLoops: number;
	},
	seen?: (err: number) => void,
): Joint | null {
	const b = a.beats;
	let best: Joint | null = null;
	let bestRank = Number.POSITIVE_INFINITY;
	for (const i of grid) {
		const bi = b[i]!;
		if (bi < o.iRange[0] || bi > o.iRange[1]) continue;
		for (const j of grid) {
			if (j === i) continue;
			const bj = b[j]!;
			if (bj < o.jRange[0] || bj > o.jRange[1]) continue;
			const d = bj - bi;
			if (d < 0 && -d < o.minPiece) continue;
			// a skip forward happens once; bars played again may loop (the counts either side of the exact one)
			let counts: number[] = [1];
			if (d < 0) {
				if (o.shift >= 0) continue;
				const x = o.shift / d;
				counts = [...new Set([Math.floor(x), Math.ceil(x)])].filter((n) => n >= 1 && n <= o.maxLoops);
			} else if (o.shift <= 0) continue;
			const score = jumpScore(a, i, j);
			for (const loops of counts) {
				const err = o.shift - loops * d;
				seen?.(err);
				if (!o.accept(err, bi, bj)) continue;
				const rank = o.rank(err);
				if (
					best === null ||
					rank < bestRank ||
					(rank === bestRank &&
						(score > best.score || (score === best.score && (i < best.i || (i === best.i && j < best.j)))))
				) {
					best = { i, j, loops, err, score };
					bestRank = rank;
				}
			}
		}
	}
	return best;
}

/**
 * Plans a remix of the analysed music to `target` samples that lands each anchor's source moment (`src`, e.g. a
 * drop's attack) at its output time (`out`) within 1 ms (spec 12 P6-E11). Every joint is at a bar line (`downbeats`)
 * so the bars stay whole on both sides; the output's bar grid follows the anchors.
 * - Before the first anchor: no joint when the intro already fits (the head is trimmed by < a bar); else the bars that
 *   would come too early are skipped, or bars before the anchor are played again (up to 8 times), and the head takes
 *   up what whole bars cannot (< a bar). Music too short before the anchor to reach it is ANCHOR_UNREACHABLE.
 * - Between anchors: the source between them must fill the output between them within 1 ms (whole bars), else
 *   ANCHOR_UNREACHABLE.
 * - After the last anchor: bars skipped or played again so the outro ends within half a beat of `target`; else
 *   NO_PLAN_NEAR_TARGET with the nearest output lengths that work (`nearestTargets`). With `fit: 'nearest'` the
 *   nearest of those (not longer than `maxTarget` when given) is planned instead.
 * Deterministic. Throws RemixError.
 */
export function planAnchoredRemix(
	a: Analysis,
	target: number,
	anchors: readonly RemixAnchor[],
	opts: { fit?: 'exact' | 'nearest'; maxTarget?: number } = {},
): AnchoredPlan {
	const sr = a.sampleRate;
	const len = a.len;
	const b = a.beats;
	const tol = Math.max(1, Math.round(0.001 * sr));
	const half = Math.max(1, Math.trunc(a.period / 2));
	const bar = a.period * a.beatsPerBar;
	const minPiece = Math.trunc(MIN_PIECE_BEATS * a.period);
	const xfade = Math.round(XFADE_S * sr);
	const fin = (x: number) => Number.isFinite(x);
	if (!fin(target) || target < 2 * minPiece) throw new RemixError('TARGET_TOO_SHORT');
	if (!anchors.length || anchors.length > MAX_REMIX_ANCHORS)
		throw new RemixError('ANCHOR_OUT_OF_RANGE', `give 1 to ${MAX_REMIX_ANCHORS} anchors`);
	const list = [...anchors].sort((x, y) => x.out - y.out);
	for (const [k, an] of list.entries()) {
		if (!fin(an.src) || !fin(an.out) || an.src < 0 || an.src >= len)
			throw new RemixError('ANCHOR_OUT_OF_RANGE', 'the anchor is outside the analysed music');
		if (an.out < 0 || an.out >= target)
			throw new RemixError(
				'ANCHOR_OUT_OF_RANGE',
				'the anchor lands outside the remix (before its start or after its end)',
			);
		if (k > 0 && !(an.src > list[k - 1]!.src && an.out > list[k - 1]!.out))
			throw new RemixError(
				'ANCHOR_OUT_OF_RANGE',
				'anchors must be in the same order in the music and in the output',
			);
	}
	// bar lines: the analysis' downbeats; guessed ones are re-phased to the first anchor's nearest beat
	let grid = a.downbeats.filter((i) => i >= 0 && i < b.length);
	if (a.barsGuessed || grid.length < 2) {
		let near = 0;
		for (let i = 1; i < b.length; i++)
			if (Math.abs(a.attacks[i]! - list[0]!.src) < Math.abs(a.attacks[near]! - list[0]!.src)) near = i;
		grid = [];
		for (let i = near % a.beatsPerBar; i < b.length; i += a.beatsPerBar) grid.push(i);
	}
	const sec = (x: number) => `${(x / sr).toFixed(2)} s`;
	type Seg = { joint: Joint | null };
	const segs: Seg[] = [];
	// 1. the head: output 0 … first anchor
	const first = list[0]!;
	const need = first.src - first.out;
	let head = 0;
	if (need >= 0 && need < bar) {
		head = need;
		segs.push({ joint: null });
	} else {
		const j = bestJoint(a, grid, {
			shift: need,
			iRange: [minPiece, first.src - minPiece],
			jRange: [0, first.src - minPiece],
			minPiece,
			// the head (err) is what whole bars cannot take up; the first piece [head, b_i) stays a piece
			accept: (err, bi) => err >= 0 && err < bar && bi - err >= minPiece,
			rank: (err) => Math.trunc(err / Math.max(1, a.period)),
			maxLoops: 8,
		});
		if (j) {
			head = j.err;
			segs.push({ joint: j });
		} else if (need >= 0) {
			// no bar-line joint fits: the music starts later (the intro is trimmed)
			head = need;
			segs.push({ joint: null });
		} else
			throw new RemixError(
				'ANCHOR_UNREACHABLE',
				`the music before ${sec(first.src)} is too short to fill ${sec(first.out)} with whole bars`,
			);
	}
	// 2. between anchors
	for (let k = 1; k < list.length; k++) {
		const p = list[k - 1]!;
		const an = list[k]!;
		const shift = an.src - p.src - (an.out - p.out);
		if (Math.abs(shift) <= tol) {
			segs.push({ joint: null });
			continue;
		}
		const j = bestJoint(a, grid, {
			shift,
			iRange: [p.src + minPiece, an.src - minPiece],
			jRange: [0, an.src - minPiece],
			minPiece,
			accept: (err) => Math.abs(err) <= tol,
			rank: (err) => Math.abs(err),
			maxLoops: 8,
		});
		if (!j)
			throw new RemixError(
				'ANCHOR_UNREACHABLE',
				`the music between ${sec(p.src)} and ${sec(an.src)} cannot fill ${sec(an.out - p.out)} with whole bars (within 1 ms)`,
			);
		segs.push({ joint: j });
	}
	// 3. the tail: last anchor … the outro's end
	const last = list[list.length - 1]!;
	const tailFor = (t: number, collect?: (err: number) => void): Joint | null | undefined => {
		const shift = len - last.src - (t - last.out);
		collect?.(shift);
		if (Math.abs(shift) <= half) return null;
		return (
			bestJoint(
				a,
				grid,
				{
					shift,
					iRange: [last.src + minPiece, len - minPiece],
					jRange: [0, len - minPiece],
					minPiece,
					accept: (err) => Math.abs(err) <= half,
					rank: (err) => Math.trunc(Math.abs(err) / Math.max(1, half / 2)),
					maxLoops: 8,
				},
				collect,
			) ?? undefined
		);
	};
	const errs: number[] = [];
	let tail = tailFor(target, (e) => errs.push(e));
	let planTarget = target;
	if (tail === undefined) {
		// what a plan can reach: the output lengths whose error is 0
		const reach = [...new Set(errs.map((e) => Math.round(target + e)))]
			.filter((t) => t > last.out + minPiece && t >= 2 * minPiece)
			.sort((x, y) => x - y);
		const below = reach.filter((t) => t < target).at(-1);
		const above = reach.find((t) => t > target);
		const nearest = [below, above].filter((x): x is number => x !== undefined);
		if (opts.fit === 'nearest') {
			const allowed = nearest
				.filter((t) => opts.maxTarget === undefined || t <= opts.maxTarget)
				.sort((x, y) => Math.abs(x - target) - Math.abs(y - target) || x - y);
			for (const t of allowed) {
				const again = tailFor(t);
				if (again !== undefined) {
					tail = again;
					planTarget = t;
					break;
				}
			}
		}
		if (tail === undefined)
			throw new RemixError(
				'NO_PLAN_NEAR_TARGET',
				`with the anchor at ${sec(last.out)} and joints on bar lines the music ends ${nearest.length ? `at ${nearest.map(sec).join(' or ')}` : 'too far'} from ${sec(target)}, not within half a beat`,
				nearest,
			);
	}
	segs.push({ joint: tail });
	// pieces
	const pieces: Piece[] = [];
	let cur = head;
	for (const sg of segs) {
		const j = sg.joint;
		if (!j) continue;
		const bi = b[j.i]!;
		const bj = b[j.j]!;
		pieces.push({ src: cur, len: bi - cur });
		for (let r = 1; r < j.loops; r++) pieces.push({ src: bj, len: bi - bj });
		cur = bj;
	}
	pieces.push({ src: cur, len: len - cur });
	// where each anchor lands (the first piece that plays its source moment, in output order)
	const placed = list.map((an) => {
		let out = 0;
		let at = Number.NaN;
		for (const pc of pieces) {
			if (
				an.src >= pc.src &&
				an.src < pc.src + pc.len &&
				Math.abs(out + (an.src - pc.src) - an.out) <= tol + 1
			) {
				at = out + (an.src - pc.src);
				break;
			}
			out += pc.len;
		}
		return { src: an.src, out: an.out, at, err: at - an.out };
	});
	if (placed.some((p) => !(Math.abs(p.err) <= tol + 1)))
		throw new RemixError('ANCHOR_UNREACHABLE', 'the plan does not land every anchor (internal check)');
	return { pieces, xfade, headTrim: head, anchors: placed, target: planTarget };
}

/** Beats of music (Sound Design beat cues, `POST /api/audio/beats`; spec 12 §2.2). */
export type BeatAnalysis = {
	sampleRate: number;
	/** Analysed length (samples). */
	len: number;
	bpm: number;
	/** Beat period (samples). */
	period: number;
	/** Attack of each beat (samples, increasing): the tracker's beat refined to the strongest energy rise near it. */
	beats: number[];
	/** Onset strength of each beat (unit-variance spectral flux, its local maximum). */
	strengths: number[];
	/** Accent of each beat: its attack (linear amplitude rise of 5 ms RMS), what the downbeats are read from. */
	accents: number[];
	/**
	 * Downbeats (indices into `beats`, `beatsPerBar` apart) when one beat per bar is clearly accented: the phase whose
	 * beats' accents are strongest, ≥ 15 % above the other phases' mean and above its own bar's other beats in ≥ 60 %
	 * of the bars, over ≥ 2 bars and 8 beats; null when the accent is not clear.
	 */
	downbeats: number[] | null;
	/** Beats per bar of `downbeats` (detected 3 or 4 with `timeSignature: 'auto'`, else the one asked); null without. */
	beatsPerBar: number | null;
	/** How clear the downbeat phase is (0…1). */
	downbeatConfidence: number;
	/** Drop candidates, best first (`findDrops`; on the strongest phase in 4 when there are no downbeats). */
	drops: MusicDrop[];
	/** The drops' bars are a guess (no downbeats). */
	dropBarsGuessed: boolean;
};

/**
 * Metre of the downbeats: 'auto' detects 3 or 4 beats per bar from the accent periodicity (the grouping whose
 * strongest phase stands out most; 3 only when it beats 4 clearly); a number 2…12 groups by it.
 */
export type TimeSignature = 'auto' | number;
export type BeatOptions = { timeSignature?: TimeSignature };

/** Least relative accent of the downbeat phase over the other phases. */
const DOWNBEAT_MIN_ACCENT = 0.15;
/** Share of the bars whose downbeat must stand out of the bar's other beats. */
const DOWNBEAT_CONSISTENCY = 0.6;
/** 'auto' reads 3 beats per bar only when its accent contrast is this many times 4's (4/4 is the common case). */
const TRIPLE_MARGIN = 1.25;

/** A valid explicit metre (an integer 2…12), else null ('auto', or anything else: auto). */
export function beatsPerBarOf(ts: unknown): number | null {
	return typeof ts === 'number' && Number.isInteger(ts) && ts >= 2 && ts <= 12 ? ts : null;
}

/** The accented phase of `accents` grouped by `m` beats and how much it stands out. */
function barAccent(accents: readonly number[], m: number): { phase: number; contrast: number; ok: boolean } {
	const mean = Array.from({ length: m }, (_, p) => {
		let s = 0;
		let c = 0;
		for (let i = p; i < accents.length; i += m) {
			s += accents[i]!;
			c++;
		}
		return c ? s / c : 0;
	});
	let p = 0;
	for (let q = 1; q < m; q++) if (mean[q]! > mean[p]!) p = q;
	const others = mean.filter((_, q) => q !== p);
	const rest = others.reduce((a, b) => a + b, 0) / Math.max(others.length, 1);
	const contrast = mean[p]! > 0 ? Math.max(0, Math.min(1, (mean[p]! - rest) / mean[p]!)) : 0;
	const enough = accents.length >= Math.max(8, 2 * m);
	// bar by bar: the accented beat stands out of the other beats of its own bar (a phase that is strong on average
	// only because a few of its beats happen to be accented — a waltz grouped in four — is not a downbeat)
	let bars = 0;
	let accented = 0;
	for (let i = p; i + m <= accents.length; i += m) {
		let o = 0;
		for (let j = 1; j < m; j++) o += accents[i + j]!;
		o /= m - 1;
		bars++;
		if (accents[i]! >= (1 + DOWNBEAT_MIN_ACCENT) * o) accented++;
	}
	const steady = bars >= 2 && accented >= DOWNBEAT_CONSISTENCY * bars;
	return {
		phase: p,
		contrast,
		ok: enough && steady && rest > 0 && mean[p]! >= (1 + DOWNBEAT_MIN_ACCENT) * rest,
	};
}

/** The strongest energy rise (5 ms RMS either side) within ±`radius` samples of `at`: where and how much. */
function strongestRise(
	x: Float32Array,
	at: number,
	radius: number,
	sr: number,
): { at: number; rise: number } {
	const win = Math.max(1, Math.round(0.005 * sr));
	const lo = Math.max(win, Math.round(at - radius));
	const hi = Math.min(x.length - win - 1, Math.round(at + radius));
	if (hi <= lo) return { at: Math.max(0, Math.min(x.length - 1, Math.round(at))), rise: 0 };
	// prefix sums of squares
	const a0 = lo - win;
	const a1 = hi + win + 1;
	const pre = new Float64Array(a1 - a0 + 1);
	for (let i = a0; i < a1; i++) pre[i - a0 + 1] = pre[i - a0]! + x[i]! * x[i]!;
	const sum = (a: number, b: number) => pre[b - a0]! - pre[a - a0]!;
	let best = lo;
	let bestRise = Number.NEGATIVE_INFINITY;
	for (let i = lo; i <= hi; i++) {
		const rise =
			Math.sqrt(Math.max(0, sum(i, i + win)) / win) - Math.sqrt(Math.max(0, sum(i - win, i)) / win);
		if (rise > bestRise) {
			bestRise = rise;
			best = i;
		}
	}
	return { at: best, rise: Math.max(0, bestRise) };
}

/**
 * Tempo, beats and (when clear) downbeats of planar audio. Shares the remix's beat tracker (tempo by autocorrelation
 * with the tempo octave, dynamic-programming beats); each beat is then placed on the attack itself. Downbeats follow
 * `opts.timeSignature` (default 'auto': 3 or 4 beats per bar). Throws RemixError NO_BEAT for audio without a usable
 * pulse or with fewer than 4 beats. Deterministic.
 */
export function analyzeBeats(
	channels: readonly Float32Array[],
	sampleRate: number,
	opts: BeatOptions = {},
): BeatAnalysis {
	const mono = monoOf(channels);
	const len = mono.length;
	const g = beatAttacks(mono, sampleRate);
	const { attacks: beats, strengths, accents } = g;
	if (beats.length < 4) throw new RemixError('NO_BEAT');
	const bars = barLines(accents, opts.timeSignature);
	const grid: number[] = [];
	if (bars.downbeats) grid.push(...bars.downbeats);
	else for (let i = bars.phase; i < beats.length; i += bars.beatsPerBar) grid.push(i);
	return {
		sampleRate,
		len,
		bpm: (60 * sampleRate) / g.period,
		period: g.period,
		beats,
		strengths,
		accents,
		downbeats: bars.downbeats,
		beatsPerBar: bars.downbeats || bars.asked ? bars.beatsPerBar : null,
		downbeatConfidence: bars.confidence,
		drops: findDrops(mono, sampleRate, beats, grid, bars.beatsPerBar, g.period),
		dropBarsGuessed: !bars.downbeats,
	};
}
