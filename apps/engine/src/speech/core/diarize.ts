// Speaker labelling ("who spoke when") without a model. Ported from FilmCraft `crates/speech/src/diarize.rs`
// (MIT OR Apache-2.0), plus an exact speaker-count hint.
//
// A classical, openly documented method (MFCC statistics + agglomerative clustering, as in the speaker-clustering
// literature, e.g. Reynolds & Torres-Carrasquillo 2005):
//
// 1. The words are grouped into **chunks**: a new chunk starts at a pause of at least `chunkGap` or when the chunk
//    reaches `maxChunk`; chunks shorter than `minChunk` are joined to the previous one (a short first chunk joins
//    the next).
// 2. Each chunk gets a voice vector: 40-band log-mel energies → DCT-II → MFCC 1–19 over the chunk's voiced frames
//    (within 30 dB of its loudest), then the mean and standard deviation of each coefficient (38 values), each
//    scaled by that coefficient's spread over all voiced frames of the file (within 40 dB of the file's peak).
// 3. Average-linkage agglomerative clustering with RMS distance merges the closest clusters until the closest pair
//    is farther apart than `threshold` and at most `maxSpeakers` remain — or, with `speakerCount`, until exactly
//    that many remain. Clusters holding less than 5 % of the voiced frames, or less than 1.5 s of voiced speech,
//    are folded into their nearest neighbour (never below `speakerCount`).
// 4. Speakers are numbered in order of first appearance.
//
// Works for interviews and dialogue with distinct voices and clean turns; overlapping speech, very similar voices
// or music beds confuse it. Times are 16 kHz sample indices.
import { HOP, melEnergies, SAMPLE_RATE } from './mel.ts';

export type DiarizeParams = {
	/** Samples. */
	chunkGap: number;
	minChunk: number;
	maxChunk: number;
	threshold: number;
	maxSpeakers: number;
	/** Exactly this many speakers (when the audio has at least that many chunks). */
	speakerCount?: number;
};

const ms = (m: number) => Math.round((m * SAMPLE_RATE) / 1000);

export const DEFAULT_DIARIZE: DiarizeParams = {
	chunkGap: ms(250),
	minChunk: ms(700),
	maxChunk: ms(4000),
	threshold: 0.4,
	maxSpeakers: 6,
};

/**
 * JasperEditor addition: a cluster with less than 1.5 s of voiced speech (150 frames) is folded too, whatever its
 * share — on short recordings 5 % is a fraction of a second, and one stressed word of a single reader otherwise
 * becomes a "speaker" (measured on a 17 s German LibriVox reading: 3 speakers → 1; FilmCraft found 2).
 */
export const MIN_SPEAKER_FRAMES = 150;

const N_MELS = 40;
const N_MFCC = 20;

type W = { start: number; end: number };
type Range = { start: number; end: number };

/** Word index ranges of the chunks. */
export function diarizeChunks(w: readonly W[], p: DiarizeParams): Range[] {
	const out: Range[] = [];
	let a = 0;
	for (let i = 1; i <= w.length; i++) {
		if (i === w.length || w[i].start - w[i - 1].end >= p.chunkGap || w[i].end - w[a].start > p.maxChunk) {
			if (a < i) out.push({ start: a, end: i });
			a = i;
		}
	}
	const merged: Range[] = [];
	for (const c of out) {
		const dur = w[c.end - 1].end - w[c.start].start;
		const last = merged[merged.length - 1];
		if (last && dur < p.minChunk) last.end = c.end;
		else merged.push({ ...c });
	}
	if (merged.length > 1 && w[merged[0].end - 1].end - w[0].start < p.minChunk) {
		const first = merged.shift() as Range;
		merged[0].start = first.start;
	}
	return merged;
}

function mfccFrames(audio: Float32Array): { frames: number; energy: Float32Array; mfcc: Float32Array } {
	const { frames, data: mel } = melEnergies(audio, N_MELS);
	const energy = new Float32Array(frames);
	const mfcc = new Float32Array(frames * N_MFCC);
	const dct = new Float32Array(N_MFCC * N_MELS);
	for (let k = 0; k < N_MFCC; k++)
		for (let m = 0; m < N_MELS; m++) dct[k * N_MELS + m] = Math.cos((Math.PI * k * (m + 0.5)) / N_MELS);
	const lm = new Float32Array(N_MELS);
	for (let f = 0; f < frames; f++) {
		let e = 0;
		for (let m = 0; m < N_MELS; m++) {
			const v = mel[m * frames + f];
			e += v;
			lm[m] = Math.log(v + 1e-10);
		}
		energy[f] = 10 * Math.log10(e + 1e-10);
		for (let k = 0; k < N_MFCC; k++) {
			let s = 0;
			for (let m = 0; m < N_MELS; m++) s += dct[k * N_MELS + m] * lm[m];
			mfcc[f * N_MFCC + k] = s;
		}
	}
	return { frames, energy, mfcc };
}

function rmsDistance(a: Float32Array, b: Float32Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
	return Math.sqrt(s / Math.max(1, a.length));
}

/**
 * Speaker label (0-based, numbered by first appearance) of every word, and the number of speakers.
 * `words` and `audio` share the time base (16 kHz samples).
 */
export function diarize(
	audio: Float32Array,
	words: readonly W[],
	p: DiarizeParams = DEFAULT_DIARIZE,
): { labels: number[]; speakers: number } {
	if (!words.length) return { labels: [], speakers: 0 };
	const one = () => ({ labels: words.map(() => 0), speakers: 1 });
	const ch = diarizeChunks(words, p);
	if (ch.length < 2 || p.speakerCount === 1) return one();
	const { frames, energy, mfcc } = mfccFrames(audio);
	const dim = 2 * (N_MFCC - 1);
	const vecs: Float32Array[] = [];
	const weight: number[] = [];
	for (const c of ch) {
		const a = Math.min(frames, Math.max(0, Math.floor(words[c.start].start / HOP)));
		const b = Math.max(a, Math.min(frames, Math.max(0, Math.floor(words[c.end - 1].end / HOP))));
		let peak = Number.NEGATIVE_INFINITY;
		for (let f = a; f < b; f++) peak = Math.max(peak, energy[f]);
		const voiced: number[] = [];
		for (let f = a; f < b; f++) if (energy[f] > peak - 30) voiced.push(f);
		const v = new Float32Array(dim);
		if (voiced.length) {
			const n = voiced.length;
			for (let k = 1; k < N_MFCC; k++) {
				let mean = 0;
				for (const f of voiced) mean += mfcc[f * N_MFCC + k];
				mean /= n;
				let vr = 0;
				for (const f of voiced) vr += (mfcc[f * N_MFCC + k] - mean) ** 2;
				vr /= n;
				v[k - 1] = mean;
				v[N_MFCC - 1 + k - 1] = Math.sqrt(vr);
			}
		}
		vecs.push(v);
		weight.push(voiced.length);
	}
	// scale each dimension by its spread over all voiced frames of the file
	let filePeak = Number.NEGATIVE_INFINITY;
	for (let f = 0; f < frames; f++) filePeak = Math.max(filePeak, energy[f]);
	const all: number[] = [];
	for (let f = 0; f < frames; f++) if (energy[f] > filePeak - 40) all.push(f);
	const nf = Math.max(1, all.length);
	for (let k = 1; k < N_MFCC; k++) {
		let mean = 0;
		for (const f of all) mean += mfcc[f * N_MFCC + k];
		mean /= nf;
		let vr = 0;
		for (const f of all) vr += (mfcc[f * N_MFCC + k] - mean) ** 2;
		const sd = Math.max(1e-6, Math.sqrt(vr / nf));
		for (const v of vecs) {
			v[k - 1] = (v[k - 1] - mean) / sd;
			v[N_MFCC - 1 + k - 1] /= sd;
		}
	}
	// average-linkage agglomerative clustering
	const n = vecs.length;
	const dist = new Float32Array(n * n);
	for (let i = 0; i < n; i++)
		for (let j = i + 1; j < n; j++) {
			const d = rmsDistance(vecs[i], vecs[j]);
			dist[i * n + j] = d;
			dist[j * n + i] = d;
		}
	const clusters: number[][] = Array.from({ length: n }, (_, i) => [i]);
	const link = (a: number[], b: number[]) => {
		let s = 0;
		for (const i of a) for (const j of b) s += dist[i * n + j];
		return s / (a.length * b.length);
	};
	const exact = p.speakerCount && p.speakerCount > 0 ? Math.min(p.speakerCount, n) : null;
	const maxSpeakers = Math.max(1, p.maxSpeakers);
	for (;;) {
		if (clusters.length <= 1) break;
		if (exact !== null && clusters.length <= exact) break;
		let best = { d: Number.POSITIVE_INFINITY, i: 0, j: 0 };
		for (let i = 0; i < clusters.length; i++)
			for (let j = i + 1; j < clusters.length; j++) {
				const d = link(clusters[i], clusters[j]);
				if (d < best.d) best = { d, i, j };
			}
		if (exact === null && best.d > p.threshold && clusters.length <= maxSpeakers) break;
		const b = clusters.splice(best.j, 1)[0];
		clusters[best.i].push(...b);
	}
	// fold clusters with < 5 % of the voiced frames into their nearest neighbour
	const total = Math.max(
		1,
		weight.reduce((s, x) => s + x, 0),
	);
	for (;;) {
		if (clusters.length <= 1) break;
		if (exact !== null && clusters.length <= exact) break;
		const si = clusters.findIndex((c) => {
			const w = c.reduce((s, i) => s + weight[i], 0);
			return w < 0.05 * total || w < MIN_SPEAKER_FRAMES;
		});
		if (si < 0) break;
		const s = clusters.splice(si, 1)[0];
		let near = 0;
		for (let c = 1; c < clusters.length; c++) if (link(s, clusters[c]) < link(s, clusters[near])) near = c;
		clusters[near].push(...s);
	}
	if (clusters.length === 1) return one();
	const label = new Array<number>(n).fill(0);
	clusters.forEach((c, ci) => {
		for (const i of c) label[i] = ci;
	});
	const order: number[] = [];
	for (const l of label) if (!order.includes(l)) order.push(l);
	const labels = new Array<number>(words.length).fill(0);
	ch.forEach((c, k) => {
		const sp = Math.max(0, order.indexOf(label[k]));
		for (let i = c.start; i < c.end; i++) labels[i] = sp;
	});
	return { labels, speakers: order.length };
}
