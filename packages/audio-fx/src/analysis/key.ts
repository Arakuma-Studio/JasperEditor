// Musical key of music (spec 12 P6-E11 "Tune to the key"; wp-note "Phase 6 → WP-E7"): a pitch-class profile (chroma)
// of the audio and the Krumhansl–Schmuckler key-finding algorithm.
//
//   mono ─► STFT (≈ 186 ms Hann, ½ hop) ─► power per equal-tempered note C2…B6 (A4 = 440 Hz; each FFT bin to its
//          nearest note, 65–2 000 Hz) summed over the frames ─► √ (amplitude) ─► folded into 12 pitch classes (C = 0)
//   key:   the Pearson correlation of the chroma with the Krumhansl–Kessler major and minor key profiles rotated to each
//          of the 12 tonics (24 keys); the best one wins.
//
// Sources: C. L. Krumhansl, *Cognitive Foundations of Musical Pitch* (Oxford UP, 1990), ch. 4 (the probe-tone profiles
// of Krumhansl & Kessler 1982 and the key-finding algorithm Krumhansl and Schmuckler developed with them); D. Temperley,
// "What's key for key? The Krumhansl–Schmuckler key-finding algorithm reconsidered", *Music Perception* 17 (1999)
// (the correlation formulation). The chroma follows the usual STFT folding (e.g. Müller, *Fundamentals of Music
// Processing*, 2015, §3.1.2); the amplitude compression and the note range are our choices (measured in the wp-note).
//
// Confidence (ours; documented in the wp-note): a key is believable when its correlation is high AND clearly above
// every key with another scale. The relative key (C major / A minor) has the same seven notes, so it never lowers
// the confidence: tuning only needs the scale. `confidence = clamp(r, 0, 1) · clamp(margin / KEY_MARGIN_FULL, 0, 1)`.
// Deterministic and pure; never throws (silence or NaN input gives confidence 0).
import { Fft } from '../core/fft.ts';
import { hann } from '../core/stft.ts';

/** Krumhansl–Kessler probe-tone ratings of the 12 pitch classes in a major key (index 0 = the tonic). */
export const KK_MAJOR: readonly number[] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
/** Krumhansl–Kessler probe-tone ratings of the 12 pitch classes in a minor key (index 0 = the tonic). */
export const KK_MINOR: readonly number[] = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Pitch-class names (sharps; C = 0). */
export const PITCH_CLASS_NAMES: readonly string[] = [
	'C',
	'C♯',
	'D',
	'E♭',
	'E',
	'F',
	'F♯',
	'G',
	'A♭',
	'A',
	'B♭',
	'B',
];

/** Semitones of the major scale and the natural minor scale above the tonic. */
export const MAJOR_SCALE: readonly number[] = [0, 2, 4, 5, 7, 9, 11];
export const MINOR_SCALE: readonly number[] = [0, 2, 3, 5, 7, 8, 10];

/** The margin over the best key of another scale at which the confidence is full. */
export const KEY_MARGIN_FULL = 0.15;
/** Notes of the chroma (MIDI): C2 … B6. */
const NOTE_LO = 36;
const NOTE_HI = 95;

export type KeyMode = 'major' | 'minor';

export type MusicKey = {
	/** Pitch class of the tonic (0 = C … 11 = B). */
	tonic: number;
	mode: KeyMode;
	/** "A minor", "E♭ major". */
	name: string;
	/** 0…1 (see the module header): ≥ 0.6 is clear enough to tune to. */
	confidence: number;
	/** The winning key's correlation (−1…1). */
	correlation: number;
	/** Its correlation minus the best key's with another scale (the relative key does not count). */
	margin: number;
	/** The key's scale as pitch classes, ascending from C. */
	scale: number[];
};

export const keyName = (tonic: number, mode: KeyMode): string =>
	`${PITCH_CLASS_NAMES[((tonic % 12) + 12) % 12]} ${mode}`;

/** Pitch classes of a key's scale (natural minor for minor keys), ascending from C. */
export function keyScale(tonic: number, mode: KeyMode): number[] {
	const t = ((Math.round(tonic) % 12) + 12) % 12;
	return (mode === 'minor' ? MINOR_SCALE : MAJOR_SCALE).map((s) => (s + t) % 12).sort((a, b) => a - b);
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function pearson(a: readonly number[], b: readonly number[]): number {
	let ma = 0;
	let mb = 0;
	for (let i = 0; i < 12; i++) {
		ma += a[i]!;
		mb += b[i]!;
	}
	ma /= 12;
	mb /= 12;
	let num = 0;
	let da = 0;
	let db = 0;
	for (let i = 0; i < 12; i++) {
		const x = a[i]! - ma;
		const y = b[i]! - mb;
		num += x * y;
		da += x * x;
		db += y * y;
	}
	return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** The profile of a key: `profile[(pc − tonic) mod 12]` for each pitch class pc. */
const rotated = (profile: readonly number[], tonic: number) =>
	Array.from({ length: 12 }, (_, pc) => profile[(pc - tonic + 12) % 12]!);

/** Same seven notes (C major and A minor; and a key with itself). */
function sameScale(t1: number, m1: KeyMode, t2: number, m2: KeyMode): boolean {
	const a = keyScale(t1, m1).join();
	return a === keyScale(t2, m2).join();
}

/**
 * Krumhansl–Schmuckler: the key whose Krumhansl–Kessler profile correlates best with `chroma` (12 values, C = 0,
 * non-negative; any scale). Null for an unusable chroma (not 12 finite values, or flat).
 */
export function estimateKey(chroma: ArrayLike<number>): MusicKey | null {
	if (!chroma || chroma.length !== 12) return null;
	const c: number[] = [];
	for (let i = 0; i < 12; i++) {
		const v = chroma[i];
		if (!fin(v) || v < 0) return null;
		c.push(v);
	}
	const max = Math.max(...c);
	if (!(max > 0) || c.every((v) => Math.abs(v - c[0]!) <= max * 1e-9)) return null;
	const scores: { tonic: number; mode: KeyMode; r: number }[] = [];
	for (const mode of ['major', 'minor'] as const)
		for (let tonic = 0; tonic < 12; tonic++)
			scores.push({ tonic, mode, r: pearson(c, rotated(mode === 'major' ? KK_MAJOR : KK_MINOR, tonic)) });
	// best first; ties: major before minor, lower tonic first (deterministic)
	scores.sort((a, b) => b.r - a.r || (a.mode === b.mode ? a.tonic - b.tonic : a.mode === 'major' ? -1 : 1));
	const best = scores[0]!;
	const rival = scores.find((s) => !sameScale(s.tonic, s.mode, best.tonic, best.mode));
	const margin = rival ? best.r - rival.r : best.r;
	const confidence =
		Math.max(0, Math.min(1, best.r)) * Math.max(0, Math.min(1, margin / KEY_MARGIN_FULL));
	const q = (x: number) => Math.round(x * 1000) / 1000;
	return {
		tonic: best.tonic,
		mode: best.mode,
		name: keyName(best.tonic, best.mode),
		confidence: q(confidence),
		correlation: q(best.r),
		margin: q(margin),
		scale: keyScale(best.tonic, best.mode),
	};
}

function monoOf(channels: readonly Float32Array[]): Float32Array {
	const list = Array.isArray(channels) ? channels.filter((c) => c instanceof Float32Array) : [];
	const len = Math.max(0, ...list.map((c) => c.length));
	const k = 1 / Math.max(list.length, 1);
	const mono = new Float32Array(len);
	for (const c of list)
		for (let i = 0; i < c.length; i++) {
			const v = c[i]!;
			if (Number.isFinite(v)) mono[i] = mono[i]! + v * k;
		}
	return mono;
}

/**
 * The chroma of planar audio: 12 pitch-class amplitudes (C = 0), normalised to sum 1 (all zeros for silence). The
 * frames are spread over the whole signal; at most `maxFrames` (default 2 400 ≈ 4 min at 22.05 kHz) are analysed,
 * evenly spaced, so long music costs a bounded time. Deterministic; never throws.
 */
export function chromaOf(
	channels: readonly Float32Array[],
	sampleRate: number,
	opts: { maxFrames?: number } = {},
): number[] {
	const out = new Array<number>(12).fill(0);
	if (!fin(sampleRate) || sampleRate < 4000 || sampleRate > 768_000) return out;
	const x = monoOf(channels);
	const n = 1 << Math.round(Math.log2(Math.max(sampleRate * 0.186, 1024)));
	const hop = n / 2;
	if (x.length < n / 4) return out;
	const frames = x.length >= n ? Math.floor((x.length - n) / hop) + 1 : 1;
	const maxFrames = Math.max(1, Math.floor(opts.maxFrames ?? 2400));
	const stride = frames > maxFrames ? frames / maxFrames : 1;
	const bins = n / 2 + 1;
	const note = new Int16Array(bins).fill(-1);
	for (let k = 1; k < bins; k++) {
		const f = (k * sampleRate) / n;
		const m = Math.round(69 + 12 * Math.log2(f / 440));
		if (m >= NOTE_LO && m <= NOTE_HI) note[k] = m;
	}
	const energy = new Float64Array(NOTE_HI + 1);
	const fft = new Fft(n);
	const w = hann(n);
	const re = new Float64Array(n);
	const im = new Float64Array(n);
	const count = Math.min(frames, maxFrames);
	for (let q = 0; q < count; q++) {
		const s = Math.floor(q * stride) * hop;
		for (let i = 0; i < n; i++) {
			re[i] = s + i < x.length ? x[s + i]! * w[i]! : 0;
			im[i] = 0;
		}
		fft.forward(re, im);
		for (let k = 1; k < bins; k++) {
			const m = note[k]!;
			if (m >= 0) energy[m] = energy[m]! + re[k]! * re[k]! + im[k]! * im[k]!;
		}
	}
	for (let m = NOTE_LO; m <= NOTE_HI; m++) out[m % 12] = out[m % 12]! + Math.sqrt(energy[m]!);
	const sum = out.reduce((a, b) => a + b, 0);
	return sum > 0 && Number.isFinite(sum) ? out.map((v) => v / sum) : new Array<number>(12).fill(0);
}

/** The key of planar audio (`chromaOf` then `estimateKey`); null for silence. */
export function analyzeKey(
	channels: readonly Float32Array[],
	sampleRate: number,
	opts: { maxFrames?: number } = {},
): MusicKey | null {
	return estimateKey(chromaOf(channels, sampleRate, opts));
}
