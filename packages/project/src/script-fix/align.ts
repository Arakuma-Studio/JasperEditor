// Transcript ↔ script word alignment (spec 17 SC-010 … SC-016). Ported from the scriptfix spike (`sfalign.py`
// `align`, `sim_matrix`, `merge_cells`, `path_stats`; FINDINGS §2.3): one Viterbi pass over the transcript tokens with
// the states aligned (H), transcript word inserted (I) and off-script (OFF); diagonal moves, skips of ≤ 8 script tokens
// (directions free), jumps anywhere (retakes, dropped lines), 2:1 / 3:1 / 1:2 / 1:3 merge cells, free start and end.
//
// Bounded cost (SC-015) without changing the result: every cell of row i can also be reached by a "landing" — a jump
// from the row's best cell (rowbest − jump) or an entry from OFF (OFF − offEnter) — at the same score plus the cell's
// own similarity. A cell whose score is below that landing base can never be on a better path than the landing (all
// moves out of a cell add the same amounts to both), so it is dropped. Dropped cells of the next row then only differ
// from the landing value by their similarity, so only positions with a similarity worth more than −1 can survive a
// landing: those come from an exact-match / phonetic index of the script vocabulary. The DP therefore touches the band
// of live cells around the current alignment plus the positions of the current word in the script. A per-row cap on
// live cells (`maxActivePerRow`, only reached by degenerate input such as one word repeated thousands of times) is the
// sole approximation; rows where it bit are counted in the report. Deterministic: ties resolve like the spike (first
// move in the order diagonal, skip 1…8, jump, OFF; lowest script index).

import { cachedKey, PSIM_MIN_INDEL, psim, psimAtLeast } from './phonetic.ts';
import type { ParsedScript } from './script.ts';
import {
	exactMatch,
	functionWords,
	isContentWord,
	normalizeWord,
	numberEqual,
	type ScriptFixLanguage,
	scriptFixLanguage,
	spokenForm,
} from './text.ts';

/**
 * Every weight and bound of the aligner and the candidate finder (SC-013, SC-015, SC-020). Scores are points: a path's
 * score is the sum of its cells and moves.
 */
export const ALIGN_DEFAULTS = Object.freeze({
	/** Exact match of a content word (not a function word, ≥ 3 letters). */
	exactContent: 3,
	/** Exact match of a function word. */
	exactFunction: 1.5,
	/** Non-exact cell: max(subFloor, subScale · psim − subOffset). */
	subScale: 4,
	subOffset: 3,
	subFloor: -1.5,
	/** Merge cells (2:1, 3:1, 1:2, 1:3) need this phonetic similarity of the concatenations. */
	mergeMinPsim: 0.7,
	/** Transcript word inserted (said but not in the script). */
	insertion: 1,
	/** Per word spent off-script. */
	offWord: 0.4,
	/** Entering / leaving the off-script state. */
	offEnter: 2,
	offLeave: 2,
	/** Jump anywhere in the script (retake = backwards, dropped line = forwards). */
	jump: 4,
	/** Most script tokens skipped in one move; cost skipOpen + skipPerToken × spoken tokens skipped (directions free). */
	maxSkip: 8,
	skipOpen: 0.5,
	skipPerToken: 0.5,
	/** Phonetic similarity is computed only for word pairs whose key bigrams have a Dice coefficient ≥ this. */
	prefilterDice: 0.45,
	/** Candidate anchors: ≥ anchorRun consecutive exact cells, or one exact content word, on each side (SC-020). */
	anchorRun: 2,
	/** Largest candidate region (SC-020). */
	maxRegionTranscript: 4,
	maxRegionScript: 4,
	/** Inputs over these are refused with E_LIMIT (SC-015). */
	maxTranscriptWords: 200_000,
	maxScriptTokens: 60_000,
	/** Live cells kept per transcript token (degenerate input only; see the module comment). */
	maxActivePerRow: 1024,
	/** Cells stored for the backtrace over the whole run (≈ 7 bytes each); the per-row cap shrinks to fit. */
	maxStoredCells: 30_000_000,
	/** Merge cells evaluated per transcript token (degenerate input only: the best-scoring ones are kept). */
	maxMergeCellsPerRow: 512,
});

/** Weights and bounds of one alignment (see `ALIGN_DEFAULTS`). */
export type AlignOptions = { -readonly [K in keyof typeof ALIGN_DEFAULTS]: number };

/** Defaults overridden by the finite values of `o`. */
export function alignOptions(o: Partial<AlignOptions> | undefined): AlignOptions {
	const out: AlignOptions = { ...ALIGN_DEFAULTS };
	if (o)
		for (const k of Object.keys(ALIGN_DEFAULTS) as Array<keyof AlignOptions>) {
			const v = o[k];
			if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
		}
	out.maxSkip = Math.max(0, Math.min(32, Math.floor(out.maxSkip)));
	return out;
}

/** A transcript word that takes part in the alignment (words normalising to nothing are skipped, SC-010). */
export type TranscriptToken = {
	/** Index of the word in the transcript's `words`. */
	word: number;
	norm: string;
};

/**
 * One step of the alignment path, in transcript order. `t` = transcript token indices [first, last] (into
 * `AlignmentResult.tokens`), `s` = script token indices [first, last] (into `ParsedScript.tokens`).
 */
export type AlignStep =
	| { kind: 'cell'; t: [number, number]; s: [number, number]; psim: number; exact: boolean }
	| { kind: 'ins'; t: [number, number]; after: number }
	| { kind: 'skip'; s: [number, number] }
	| { kind: 'off'; t: [number, number] }
	| { kind: 'jump' }
	| { kind: 'jumpOff' };

/** Alignment report of one media transcript (SC-016). Token counts are transcript tokens unless named otherwise. */
export type AlignmentReport = {
	mediaId: string | null;
	transcriptId: string | null;
	transcriptTokens: number;
	scriptTokens: number;
	/** In exact cells (aligned to the script word for word). */
	exactTokens: number;
	/** In non-exact cells (recognition errors, paraphrases). */
	substitutedTokens: number;
	/** Said but not in the script, inside aligned passages. */
	insertedTokens: number;
	/** Off-script chatter. */
	offScriptTokens: number;
	/** exactTokens / transcriptTokens (0 when empty). */
	alignedShare: number;
	/** offScriptTokens / transcriptTokens. */
	offScriptShare: number;
	/** Backward moves between consecutive cells (retakes). */
	retakeJumps: number;
	/** Jump moves (retakes and dropped lines) and entries from off-script. */
	jumps: number;
	/** Script tokens passed over by skip moves. */
	skippedScriptTokens: number;
	/** Script lines (0-based) with at least one token in a cell. */
	usedLines: number[];
	/** Script lines with spoken words none of which was aligned. */
	unusedLines: number[];
	/** Rows where the live-cell or merge-cell cap dropped cells that could have mattered (0 on ordinary input). */
	cappedRows: number;
	mergeCells: number;
	storedCells: number;
};

export type AlignmentResult =
	| {
			ok: true;
			language: ScriptFixLanguage;
			tokens: TranscriptToken[];
			steps: AlignStep[];
			/** Score of the best path. */
			score: number;
			report: AlignmentReport;
	  }
	| {
			ok: false;
			code: 'E_LIMIT';
			message: string;
			detail: { transcriptWords: number; scriptTokens: number };
	  };

/** Words of a transcript as alignment tokens (SC-010): normalised, empties skipped, word indices kept. */
export function transcriptTokens(words: ReadonlyArray<{ text: string }>): TranscriptToken[] {
	const out: TranscriptToken[] = [];
	for (let i = 0; i < words.length; i++) {
		const text = words[i]?.text;
		const norm = normalizeWord(typeof text === 'string' ? text : '');
		if (norm) out.push({ word: i, norm });
	}
	return out;
}

/** What `alignTranscript` needs. */
export type AlignInput = {
	words: ReadonlyArray<{ text: string }>;
	script: ParsedScript;
	/** The transcript's language tag; defaults to the script's rule set. */
	language?: string | null;
	mediaId?: string | null;
	transcriptId?: string | null;
	options?: Partial<AlignOptions>;
};

const NEG = Number.NEGATIVE_INFINITY;
const EPS = 1e-9;

function bigrams(s: string): string[] {
	if (s.length < 2) return [s];
	const set = new Set<string>();
	for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
	return [...set];
}

/** A growable list of numbers backed by a typed array. */
class Grow<T extends Int32Array | Int16Array | Uint8Array | Float64Array> {
	arr: T;
	n = 0;
	constructor(private readonly make: (n: number) => T) {
		this.arr = make(1024);
	}
	push(v: number): void {
		if (this.n === this.arr.length) {
			const next = this.make(this.arr.length * 2);
			next.set(this.arr);
			this.arr = next;
		}
		this.arr[this.n++] = v;
	}
}

/** Bigram index of a vocabulary's phonetic keys. */
/**
 * Bigram index of a vocabulary's phonetic keys. Postings are sorted by key length so a lookup can visit only the
 * lengths that can reach a psim threshold.
 */
type KeyIndex = {
	/** Bigram → postings (vocabulary ids sorted by key length, then id) and their key lengths. */
	postings: Map<string, { ids: Int32Array; lens: Int32Array }>;
	sizes: Int32Array;
};
function keyIndex(keys: readonly string[]): KeyIndex {
	const lists = new Map<string, number[]>();
	const sizes = new Int32Array(keys.length);
	keys.forEach((k, id) => {
		const g = bigrams(k);
		sizes[id] = g.length;
		for (const x of g) {
			let p = lists.get(x);
			if (!p) lists.set(x, (p = []));
			p.push(id);
		}
	});
	const postings = new Map<string, { ids: Int32Array; lens: Int32Array }>();
	for (const [x, ids] of lists) {
		ids.sort((a, b) => keys[a]!.length - keys[b]!.length || a - b);
		postings.set(x, { ids: Int32Array.from(ids), lens: Int32Array.from(ids, (id) => keys[id]!.length) });
	}
	return { postings, sizes };
}

/** The k-th largest value of `a` (1-based; quickselect, reorders `a`). */
function kthLargest(a: Float64Array, k: number): number {
	let lo = 0;
	let hi = a.length - 1;
	const target = k - 1;
	while (lo < hi) {
		const pivot = a[(lo + hi) >> 1]!;
		let i = lo;
		let j = hi;
		while (i <= j) {
			while (a[i]! > pivot) i++;
			while (a[j]! < pivot) j--;
			if (i <= j) {
				const t = a[i]!;
				a[i] = a[j]!;
				a[j] = t;
				i++;
				j--;
			}
		}
		if (target <= j) hi = j;
		else if (target >= i) lo = i;
		else return a[target]!;
	}
	return a[target]!;
}

/** [from, to) of at most `cap` entries of ascending `a` nearest `center` (all of `a` when it is short enough). */
function nearWindow(a: ArrayLike<number>, center: number, cap: number): [number, number] {
	const n = a.length;
	if (n <= cap) return [0, n];
	let lo = 0;
	let hi = n;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (a[mid]! < center) lo = mid + 1;
		else hi = mid;
	}
	const from = Math.max(0, Math.min(lo - (cap >> 1), n - cap));
	return [from, from + cap];
}

/** First index in sorted `a` with a[i] ≥ v. */
function lowerBound(a: Int32Array, v: number): number {
	let lo = 0;
	let hi = a.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (a[mid]! < v) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

type Vocab = { ids: Int32Array; words: string[]; positions: number[][] };
function vocab(norms: readonly string[]): Vocab {
	const map = new Map<string, number>();
	const words: string[] = [];
	const positions: number[][] = [];
	const ids = new Int32Array(norms.length);
	norms.forEach((n, i) => {
		let id = map.get(n);
		if (id === undefined) {
			id = words.length;
			map.set(n, id);
			words.push(n);
			positions.push([]);
		}
		ids[i] = id;
		positions[id]!.push(i);
	});
	return { ids, words, positions };
}

/**
 * Aligns one media transcript to the whole script (SC-013, SC-014). Never throws; refuses inputs over the SC-015
 * bounds with E_LIMIT.
 */
export function alignTranscript(input: AlignInput): AlignmentResult {
	const opt = alignOptions(input.options);
	const script = input.script;
	const lang =
		input.language !== undefined && input.language !== null
			? scriptFixLanguage(input.language)
			: script.language;
	const words = Array.isArray(input.words) ? input.words : [];
	const sTokens = Array.isArray(script?.tokens) ? script.tokens : [];
	if (words.length > opt.maxTranscriptWords || sTokens.length > opt.maxScriptTokens)
		return {
			ok: false,
			code: 'E_LIMIT',
			message: `Alignment is limited to ${opt.maxTranscriptWords} transcript words and ${opt.maxScriptTokens} script words`,
			detail: { transcriptWords: words.length, scriptTokens: sTokens.length },
		};
	const tokens = transcriptTokens(words);
	const tn = tokens.map((t) => t.norm);
	const sn = sTokens.map((t) => t.norm);
	const direction = sTokens.map((t) => t.kind !== 'word');
	const core = alignCore(tn, sn, direction, lang, opt);
	return {
		ok: true,
		language: lang,
		tokens,
		steps: core.steps,
		score: core.score,
		report: alignmentReport(core, tokens.length, script, input.mediaId ?? null, input.transcriptId ?? null),
	};
}

/** Per-media alignment (SC-014): each transcript separately against the whole script, in input order. */
export function alignTranscripts<T extends Omit<AlignInput, 'script' | 'options'>>(
	items: readonly T[],
	script: ParsedScript,
	options?: Partial<AlignOptions>,
): Array<{ item: T; result: AlignmentResult }> {
	return items.map((item) => ({ item, result: alignTranscript({ ...item, script, options }) }));
}

type CoreResult = {
	ok: true;
	steps: AlignStep[];
	score: number;
	mergeCells: number;
	storedCells: number;
	cappedRows: number;
};

/** The aligner on normalised tokens (exported for tests and benchmarks). */
export function alignCore(
	tn: readonly string[],
	sn: readonly string[],
	direction: readonly boolean[],
	lang: ScriptFixLanguage,
	opt: AlignOptions,
): CoreResult {
	const T = tn.length;
	const S = sn.length;
	if (T === 0) return { ok: true, steps: [], score: 0, mergeCells: 0, storedCells: 0, cappedRows: 0 };
	if (S === 0) {
		const steps: AlignStep[] = tn.map((_, i) => ({ kind: 'off', t: [i, i] }));
		return { ok: true, steps, score: -opt.offWord * T, mergeCells: 0, storedCells: 0, cappedRows: 0 };
	}
	const stop = functionWords(lang);
	const K = opt.maxSkip;
	const C_JUMP = K + 1;
	const C_OFF = K + 2;
	const C_START = K + 3;
	const C_MERGE = K + 4;

	// ---------------------------------------------------------------- vocabularies and 1:1 similarities
	const tv = vocab(tn);
	const sv = vocab(sn);
	const tSpoken = tv.words.map((w) => spokenForm(w, lang));
	const sSpoken = sv.words.map((w) => spokenForm(w, lang));
	const sKeys = sv.words.map((w) => cachedKey(w, lang));
	const sIndex = keyIndex(sKeys);
	const sByNorm = new Map(sv.words.map((w, i) => [w, i]));
	const sNumeric = sv.words.flatMap((w, i) => (/^\d/.test(w) ? [i] : []));
	const firstPos = sv.positions.map((p) => p[0]!);

	type Sim = { sv: Int32Array; v: Float64Array; ps: Float64Array; maxV: number; firstPos: number };
	const sims: Array<Sim | undefined> = new Array(tv.words.length);
	const counts = new Int32Array(sv.words.length);
	function simOf(t: number): Sim {
		const sim = sims[t];
		if (sim) return sim;
		const w = tv.words[t]!;
		const found = new Map<number, [number, number]>();
		const touched: number[] = [];
		const g = bigrams(cachedKey(w, lang));
		for (const x of g) {
			const post = sIndex.postings.get(x);
			if (post)
				for (let q = 0; q < post.ids.length; q++) {
					const s = post.ids[q]!;
					if (counts[s] === 0) touched.push(s);
					counts[s]!++;
				}
		}
		for (const s of touched) {
			const dice = (2 * counts[s]!) / (g.length + sIndex.sizes[s]! + 1e-9);
			counts[s] = 0;
			if (dice >= opt.prefilterDice) found.set(s, subScore(w, t, s));
		}
		const same = sByNorm.get(w);
		if (same !== undefined)
			found.set(same, [isContentWord(w, stop) ? opt.exactContent : opt.exactFunction, 1]);
		if (/^\d/.test(w)) {
			for (const s of sv.words.keys()) if (numberEqual(w, sv.words[s]!)) found.set(s, [opt.exactContent, 1]);
		} else for (const s of sNumeric) if (numberEqual(w, sv.words[s]!)) found.set(s, [opt.exactContent, 1]);
		const ids = [...found.keys()].sort((a, b) => a - b);
		const out: Sim = {
			sv: Int32Array.from(ids),
			v: Float64Array.from(ids, (s) => found.get(s)![0]),
			ps: Float64Array.from(ids, (s) => found.get(s)![1]),
			maxV: opt.subFloor,
			firstPos: 0,
		};
		let best = opt.subFloor;
		let bestPos = 0;
		for (let k = 0; k < ids.length; k++) {
			const v = out.v[k]!;
			const p = firstPos[ids[k]!]!;
			if (v > best || (v === best && p < bestPos)) {
				best = v;
				bestPos = p;
			}
		}
		out.maxV = best;
		out.firstPos = bestPos;
		sims[t] = out;
		return out;
	}
	function subScore(w: string, t: number, s: number): [number, number] {
		const x = sv.words[s]!;
		if (w === x) return [isContentWord(x, stop) ? opt.exactContent : opt.exactFunction, 1];
		if (numberEqual(w, x)) return [opt.exactContent, 1];
		const ps = psim(tSpoken[t]!, sSpoken[s]!, lang);
		return [Math.max(opt.subFloor, opt.subScale * ps - opt.subOffset), ps];
	}
	/** Script positions a landing can reach in a row of word t: similarity worth more than −1, plus the first best. */
	const landings: Array<Int32Array | undefined> = new Array(tv.words.length);
	function landingsOf(t: number): Int32Array {
		let l = landings[t];
		if (l) return l;
		const sim = simOf(t);
		const pos: number[] = [sim.firstPos];
		for (let k = 0; k < sim.sv.length; k++)
			if (sim.v[k]! >= landMin) for (const p of sv.positions[sim.sv[k]!]!) pos.push(p);
		l = Int32Array.from(new Set(pos)).sort();
		landings[t] = l;
		return l;
	}

	// ---------------------------------------------------------------- merge cells (2:1, 3:1, 1:2, 1:3)
	// Generated row by row (no storage over the whole run): a:1 cells from the concatenation of the a transcript tokens
	// ending at the row, 1:b cells from script b-grams matched to the row's word (grouped by transcript vocabulary).
	const tKeys = tv.words.map((w) => cachedKey(w, lang));
	const tIndex = keyIndex(tKeys);
	const sCounts = new Int32Array(sv.words.length);
	const tCounts = new Int32Array(tv.words.length);
	const found: number[] = [];
	// psim ≥ mergeMinPsim needs |key length difference| × cheapest insertion ≤ (1 − mergeMinPsim) × longest key
	const lenRatio = (1 - opt.mergeMinPsim) / PSIM_MIN_INDEL;
	/**
	 * Vocabulary entries sharing ≥ half of the bigrams of `s`'s key (the spike's lookup) with psim ≥ mergeMinPsim.
	 * Only postings whose key length can reach that psim are visited (exact pruning).
	 */
	function lookup(
		s: string,
		index: KeyIndex,
		spoken: readonly string[],
		cache: Map<string, Array<[number, number]>>,
		cnt: Int32Array,
	): Array<[number, number]> {
		let hit = cache.get(s);
		if (hit) return hit;
		const key = cachedKey(s, lang);
		const g = bigrams(key);
		const need = Math.max(1, Math.floor(0.5 * g.length));
		const L = key.length;
		const lo = lenRatio < 1 ? Math.ceil(L * (1 - lenRatio) - 1e-9) : 0;
		const hi = lenRatio < 1 ? Math.floor(L / (1 - lenRatio) + 1e-9) : Number.MAX_SAFE_INTEGER;
		found.length = 0;
		for (const x of g) {
			const post = index.postings.get(x);
			if (!post) continue;
			const end = post.lens.length;
			for (let q = lowerBound(post.lens, lo); q < end && post.lens[q]! <= hi; q++) {
				const id = post.ids[q]!;
				if (cnt[id] === 0) found.push(id);
				cnt[id]!++;
			}
		}
		hit = [];
		for (let q = 0; q < found.length; q++) {
			const id = found[q]!;
			const c = cnt[id]!;
			cnt[id] = 0;
			if (c < need) continue;
			const ps = psimAtLeast(s, spoken[id]!, lang, opt.mergeMinPsim);
			if (ps >= opt.mergeMinPsim) hit.push([id, ps]);
		}
		hit.sort((a, b) => a[0] - b[0]);
		if (cache.size >= 100_000) cache.clear();
		cache.set(s, hit);
		return hit;
	}
	const tSp = Array.from(tv.ids, (id) => tSpoken[id]!);
	const sSp = Array.from(sv.ids, (id) => sSpoken[id]!);
	const sCache = new Map<string, Array<[number, number]>>();
	const tCache = new Map<string, Array<[number, number]>>();
	// 1:b cells per transcript vocabulary entry and b: script end positions (ascending) and similarities
	const bByVocab: Array<{ js: number[]; ps: number[] } | undefined>[] = [
		new Array(tv.words.length),
		new Array(tv.words.length),
	];
	for (const b of [2, 3])
		for (let j = b - 1; j < S; j++) {
			const s = sSp.slice(j - b + 1, j + 1).join('');
			if (s.length < 4) continue;
			for (const [id, ps] of lookup(s, tIndex, tSpoken, tCache, tCounts)) {
				const byB = bByVocab[b - 2]!;
				let l = byB[id];
				if (!l) byB[id] = l = { js: [], ps: [] };
				l.js.push(j);
				l.ps.push(ps);
			}
		}
	const mergeScore = (ps: number, n: number) =>
		((ps >= 1 ? opt.exactContent : opt.subScale * ps - opt.subOffset) * (n + 1)) / 2;
	// the row's merge cells
	const rA = new Grow((n) => new Uint8Array(n));
	const rB = new Grow((n) => new Uint8Array(n));
	const rJ = new Grow((n) => new Int32Array(n));
	const rSc = new Grow((n) => new Float64Array(n));
	const rPs = new Grow((n) => new Float64Array(n));
	const rKeep = new Grow((n) => new Int32Array(n));
	let mergeCells = 0;
	const capMerges = Math.max(16, Math.floor(opt.maxMergeCellsPerRow));
	/** Fills the row's merge cells (generation order) and returns the indices to evaluate (all, or the best capMerges). */
	function rowMerges_(i: number): { keep: Int32Array; n: number; capped: boolean } {
		rA.n = rB.n = rJ.n = rSc.n = rPs.n = rKeep.n = 0;
		const add = (a: number, b: number, j: number, ps: number) => {
			rA.push(a);
			rB.push(b);
			rJ.push(j);
			rSc.push(mergeScore(ps, Math.max(a, b)));
			rPs.push(ps);
		};
		// a list longer than the cap (a word repeated all over the script) contributes its cells nearest the
		// previous row's best cell only
		const center = i > 0 ? rowArg[i - 1]! + 1 : 0;
		let generationCapped = false;
		for (const a of [2, 3]) {
			if (i < a - 1) continue;
			const s = tSp.slice(i - a + 1, i + 1).join('');
			if (s.length < 4) continue;
			for (const [id, ps] of lookup(s, sIndex, sSpoken, sCache, sCounts)) {
				const pos = sv.positions[id]!;
				const [from, to] = nearWindow(pos, center, capMerges);
				if (to - from < pos.length) generationCapped = true;
				for (let q = from; q < to; q++) add(a, 1, pos[q]!, ps);
			}
		}
		for (const b of [2, 3]) {
			const l = bByVocab[b - 2]![tv.ids[i]!];
			if (!l) continue;
			const [from, to] = nearWindow(l.js, center, capMerges);
			if (to - from < l.js.length) generationCapped = true;
			for (let q = from; q < to; q++) add(1, b, l.js[q]!, l.ps[q]!);
		}
		const n = rA.n;
		mergeCells += n;
		if (n <= capMerges) {
			for (let q = 0; q < n; q++) rKeep.push(q);
			return { keep: rKeep.arr, n, capped: generationCapped };
		}
		// degenerate rows: the capMerges best scores (ties: generation order), evaluated in generation order
		const thr = kthLargest(rSc.arr.slice(0, n), capMerges);
		let above = 0;
		for (let q = 0; q < n; q++) if (rSc.arr[q]! > thr) above++;
		let ties = capMerges - above;
		for (let q = 0; q < n; q++) {
			const v = rSc.arr[q]!;
			if (v > thr || (v === thr && ties-- > 0)) rKeep.push(q);
		}
		return { keep: rKeep.arr, n: rKeep.n, capped: true };
	}

	// ---------------------------------------------------------------- skip costs
	const spokenCum = new Float64Array(S + 1);
	for (let j = 0; j < S; j++) spokenCum[j + 1] = spokenCum[j]! + (direction[j] ? 0 : 1);
	/** Cost of skipping script tokens a..b (inclusive). */
	const skipCost = (a: number, b: number) => {
		const n = spokenCum[b + 1]! - spokenCum[a]!;
		return n > 0 ? opt.skipOpen + opt.skipPerToken * n : 0;
	};

	// ---------------------------------------------------------------- DP state
	const capRow = Math.max(16, Math.min(opt.maxActivePerRow, Math.floor(opt.maxStoredCells / T)));
	// working row (dense by script index, valid where wStamp === row)
	const wStamp = new Int32Array(S).fill(-1);
	const wBest = new Float64Array(S);
	const wCode = new Int16Array(S);
	const wPst = new Uint8Array(S);
	const wH = new Float64Array(S);
	const wI = new Float64Array(S);
	const wIb = new Uint8Array(S);
	const wMerge = new Int32Array(S);
	const touched = new Int32Array(S);
	let nTouched = 0;
	// the last four kept rows (values for transitions and merge bases)
	type Slot = {
		row: number;
		stamp: Int32Array;
		idx: Int32Array;
		js: Int32Array;
		H: Float64Array;
		I: Float64Array;
		n: number;
	};
	const slots: Slot[] = Array.from({ length: 4 }, () => ({
		row: -1,
		stamp: new Int32Array(S).fill(-1),
		idx: new Int32Array(S),
		js: new Int32Array(capRow),
		H: new Float64Array(capRow),
		I: new Float64Array(capRow),
		n: 0,
	}));
	// stored cells for the backtrace
	const cJ = new Grow((n) => new Int32Array(n));
	const cCode = new Grow((n) => new Int16Array(n));
	const cFlags = new Grow((n) => new Uint8Array(n)); // bit0 H prev state, bit1 I prev state
	type MergeRec = { a: number; b: number; how: number; k: number; state: number; ps: number };
	const cMerge = new Map<number, MergeRec>();
	const rowMerges: MergeRec[] = [];
	const landMin = -Math.max(opt.insertion, opt.offWord) - EPS;
	const rowStart = new Int32Array(T + 1);
	const rowBest = new Float64Array(T);
	const rowState = new Uint8Array(T);
	const rowArg = new Int32Array(T);
	const off = new Float64Array(T);
	const offBack = new Uint8Array(T);
	let lastHb = NEG;
	let lastArgH = 0;
	let lastIb = NEG;
	let lastArgI = 0;
	let cappedRows = 0;
	// merge bases: 'how' codes
	const HOW_START = 0;
	const HOW_CONT = 1;
	const HOW_SKIP = 2;
	const HOW_JUMP = 3;
	const HOW_OFF = 4;
	const vRow = new Float64Array(sv.words.length).fill(opt.subFloor);
	let curRow = -1;
	let curLandBase = 0;
	let curLandCode = 0;
	/** Adds script position j to the working row with its landing value. */
	function touch(j: number): void {
		if (wStamp[j] === curRow) return;
		wStamp[j] = curRow;
		wBest[j] = curLandBase;
		wCode[j] = curLandCode;
		wPst[j] = 0;
		wI[j] = NEG;
		wIb[j] = 0;
		wMerge[j] = -1;
		touched[nTouched++] = j;
	}

	for (let i = 0; i < T; i++) {
		const t = tv.ids[i]!;
		const sim = simOf(t);
		for (let k = 0; k < sim.sv.length; k++) vRow[sim.sv[k]!] = sim.v[k]!;
		let landBase: number;
		let landCode: number;
		if (i === 0) {
			landBase = -opt.offEnter;
			landCode = C_START;
		} else {
			const lj = rowBest[i - 1]! - opt.jump;
			const lo = off[i - 1]! - opt.offEnter;
			if (lj >= lo) {
				landBase = lj;
				landCode = C_JUMP;
			} else {
				landBase = lo;
				landCode = C_OFF;
			}
		}
		nTouched = 0;
		curRow = i;
		curLandBase = landBase;
		curLandCode = landCode;
		const prev = i > 0 ? slots[(i - 1) & 3]! : null;
		if (prev)
			for (let q = 0; q < prev.n; q++) {
				const jp = prev.js[q]!;
				const h = prev.H[q]!;
				const iv = prev.I[q]!;
				const c = iv > h ? iv : h;
				const st = iv > h ? 1 : 0;
				touch(jp);
				wI[jp] = c - opt.insertion;
				wIb[jp] = st;
				for (let k = 0; k <= K; k++) {
					const to = jp + 1 + k;
					if (to >= S) break;
					touch(to);
					const v = k === 0 ? c : c - skipCost(jp + 1, jp + k);
					if (v > wBest[to]! || (v === wBest[to]! && k < wCode[to]!)) {
						wBest[to] = v;
						wCode[to] = k;
						wPst[to] = st;
					}
				}
			}
		const land = landingsOf(t);
		let rowCapped = false;
		if (land.length <= capRow) for (let q = 0; q < land.length; q++) touch(land[q]!);
		else {
			// a word that occurs more often than the cap: the positions nearest the previous best cell, and the first best
			rowCapped = true;
			const [from, to] = nearWindow(land, i > 0 ? rowArg[i - 1]! + 1 : 0, capRow);
			for (let q = from; q < to; q++) touch(land[q]!);
			touch(sim.firstPos);
		}
		const rm = rowMerges_(i);
		if (rm.capped) rowCapped = true;
		for (let q = 0; q < rm.n; q++) touch(rJ.arr[rm.keep[q]!]!);
		for (let q = 0; q < nTouched; q++) {
			const j = touched[q]!;
			wH[j] = wBest[j]! + vRow[sv.ids[j]!]!;
		}
		// merges ending at token i
		rowMerges.length = 0;
		for (let q = 0; q < rm.n; q++) {
			const m = rm.keep[q]!;
			const a = rA.arr[m]!;
			const b = rB.arr[m]!;
			const j = rJ.arr[m]!;
			const i0 = i - a;
			const j0 = j - b;
			let base: number;
			let how = HOW_START;
			let hk = 0;
			let hs = 0;
			if (i0 < 0) base = -opt.offEnter;
			else {
				const slot = slots[i0 & 3]!;
				base = NEG;
				for (let k = 0; k <= K; k++) {
					const jj = j0 - k;
					if (jj < 0) break;
					if (slot.stamp[jj] !== i0) continue;
					const x = slot.idx[jj]!;
					const h = slot.H[x]!;
					const iv = slot.I[x]!;
					const c = iv > h ? iv : h;
					const v = k === 0 ? c : c - skipCost(jj + 1, j0);
					if (v > base) {
						base = v;
						how = k === 0 ? HOW_CONT : HOW_SKIP;
						hk = k;
						hs = iv > h ? 1 : 0;
					}
				}
				const vj = rowBest[i0]! - opt.jump;
				if (vj > base) {
					base = vj;
					how = HOW_JUMP;
				}
				const vo = off[i0]! - opt.offEnter;
				if (vo > base) {
					base = vo;
					how = HOW_OFF;
				}
			}
			const v = base + rSc.arr[m]!;
			if (v > wH[j]!) {
				wH[j] = v;
				wCode[j] = C_MERGE;
				wMerge[j] = rowMerges.length;
				rowMerges.push({ a, b, how, k: hk, state: hs, ps: rPs.arr[m]! });
			}
		}
		for (let k = 0; k < sim.sv.length; k++) vRow[sim.sv[k]!] = opt.subFloor;
		// row maxima (ties: lowest script index)
		let hb = NEG;
		let argH = 0;
		let ib = NEG;
		let argI = 0;
		for (let q = 0; q < nTouched; q++) {
			const j = touched[q]!;
			const h = wH[j]!;
			if (h > hb || (h === hb && j < argH)) {
				hb = h;
				argH = j;
			}
			const iv = wI[j]!;
			if (iv > ib || (iv === ib && j < argI)) {
				ib = iv;
				argI = j;
			}
		}
		rowBest[i] = hb >= ib ? hb : ib;
		rowState[i] = hb >= ib ? 0 : 1;
		rowArg[i] = hb >= ib ? argH : argI;
		if (i === 0) {
			off[i] = -opt.offWord;
			offBack[i] = 0;
		} else {
			const o1 = off[i - 1]!;
			const o2 = rowBest[i - 1]! - opt.offLeave;
			off[i] = (o1 >= o2 ? o1 : o2) - opt.offWord;
			offBack[i] = o1 >= o2 ? 0 : 1;
		}
		if (i === T - 1) {
			lastHb = hb;
			lastArgH = argH;
			lastIb = ib;
			lastArgI = argI;
		}
		// keep the cells a landing cannot beat
		const thr = Math.max(rowBest[i]! - opt.jump, off[i]! - opt.offEnter) - EPS;
		let nKeep = 0;
		for (let q = 0; q < nTouched; q++) {
			const j = touched[q]!;
			if (wH[j]! < thr) wH[j] = NEG;
			if (wI[j]! < thr) wI[j] = NEG;
			if (wH[j]! > NEG || wI[j]! > NEG) touched[nKeep++] = j;
		}
		let keep = touched.subarray(0, nKeep);
		if (nKeep > capRow) {
			rowCapped = true;
			const order = Array.from(keep).sort((x, y) => {
				const vx = Math.max(wH[x]!, wI[x]!);
				const vy = Math.max(wH[y]!, wI[y]!);
				return vy - vx || x - y;
			});
			// the row's best cell is always kept (it is the first in this order)
			keep = Int32Array.from(order.slice(0, capRow));
		}
		keep.sort();
		if (rowCapped) cappedRows++;
		const slot = slots[i & 3]!;
		slot.row = i;
		slot.n = keep.length;
		rowStart[i] = cJ.n;
		for (let q = 0; q < keep.length; q++) {
			const j = keep[q]!;
			slot.stamp[j] = i;
			slot.idx[j] = q;
			slot.js[q] = j;
			slot.H[q] = wH[j]!;
			slot.I[q] = wI[j]!;
			if (wH[j]! > NEG && wCode[j] === C_MERGE) cMerge.set(cJ.n, rowMerges[wMerge[j]!]!);
			cJ.push(j);
			cCode.push(wH[j]! > NEG ? wCode[j]! : -1);
			cFlags.push((wPst[j]! & 1) | ((wIb[j]! & 1) << 1));
		}
	}
	rowStart[T] = cJ.n;

	// ---------------------------------------------------------------- backtrace
	const find = (i: number, j: number): number => {
		let lo = rowStart[i]!;
		let hi = rowStart[i + 1]! - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const v = cJ.arr[mid]!;
			if (v === j) return mid;
			if (v < j) lo = mid + 1;
			else hi = mid - 1;
		}
		return -1;
	};
	const psOf = (i: number, j: number): number => {
		const sim = simOf(tv.ids[i]!);
		const s = sv.ids[j]!;
		for (let k = 0; k < sim.sv.length; k++) if (sim.sv[k] === s) return sim.ps[k]!;
		return 0;
	};
	const fin: Array<[number, number, number]> = [
		[lastHb, 0, lastArgH],
		[lastIb, 1, lastArgI],
		[off[T - 1]!, 2, -1],
	];
	let best = fin[0]!;
	for (const f of fin) if (f[0] > best[0]) best = f;
	const score = best[0];
	let state = best[1];
	let j = best[2];
	let i = T - 1;
	const steps: AlignStep[] = [];
	let guard = 4 * (T + S) + 16;
	while (i >= 0 && guard-- > 0) {
		if (state === 2) {
			steps.push({ kind: 'off', t: [i, i] });
			if (offBack[i] === 1 && i > 0) {
				i--;
				state = rowState[i]!;
				j = rowArg[i]!;
			} else {
				i--;
				state = 2;
			}
			continue;
		}
		const cell = find(i, j);
		if (cell < 0) break; // unreachable by construction; never throw
		if (state === 1) {
			steps.push({ kind: 'ins', t: [i, i], after: j });
			state = (cFlags.arr[cell]! >> 1) & 1;
			i--;
			continue;
		}
		const code = cCode.arr[cell]!;
		if (code === C_MERGE) {
			const m = cMerge.get(cell)!;
			steps.push({ kind: 'cell', t: [i - m.a + 1, i], s: [j - m.b + 1, j], psim: m.ps, exact: m.ps >= 1 });
			const i0 = i - m.a;
			const j0 = j - m.b;
			if (m.how === HOW_START) break;
			if (m.how === HOW_CONT) {
				i = i0;
				j = j0;
				state = m.state;
			} else if (m.how === HOW_SKIP) {
				steps.push({ kind: 'skip', s: [j0 - m.k + 1, j0] });
				i = i0;
				j = j0 - m.k;
				state = m.state;
			} else if (m.how === HOW_JUMP) {
				steps.push({ kind: 'jump' });
				i = i0;
				state = rowState[i]!;
				j = rowArg[i]!;
			} else {
				steps.push({ kind: 'jumpOff' });
				i = i0;
				state = 2;
			}
			continue;
		}
		const ex = exactMatch(tn[i]!, sn[j]!);
		steps.push({ kind: 'cell', t: [i, i], s: [j, j], psim: ex ? 1 : psOf(i, j), exact: ex });
		const pst = cFlags.arr[cell]! & 1;
		if (code === 0) {
			state = pst;
			i--;
			j--;
		} else if (code >= 1 && code <= K) {
			steps.push({ kind: 'skip', s: [j - code, j - 1] });
			state = pst;
			i--;
			j = j - 1 - code;
		} else if (code === C_JUMP) {
			steps.push({ kind: 'jump' });
			i--;
			if (i >= 0) {
				state = rowState[i]!;
				j = rowArg[i]!;
			}
		} else if (code === C_OFF) {
			steps.push({ kind: 'jumpOff' });
			i--;
			state = 2;
		} else break;
	}
	steps.reverse();
	return { ok: true, steps, score, mergeCells, storedCells: cJ.n, cappedRows };
}

function alignmentReport(
	core: CoreResult,
	transcriptCount: number,
	script: ParsedScript,
	mediaId: string | null,
	transcriptId: string | null,
): AlignmentReport {
	let exactTokens = 0;
	let substitutedTokens = 0;
	let insertedTokens = 0;
	let offScriptTokens = 0;
	let retakeJumps = 0;
	let jumps = 0;
	let skipped = 0;
	let lastJ: number | null = null;
	const used = new Set<number>();
	for (const s of core.steps) {
		if (s.kind === 'cell') {
			const n = s.t[1] - s.t[0] + 1;
			if (s.exact) exactTokens += n;
			else substitutedTokens += n;
			if (lastJ !== null && s.s[0] < lastJ - 1) retakeJumps++;
			lastJ = s.s[1];
			for (let j = s.s[0]; j <= s.s[1]; j++) used.add(script.tokens[j]!.line);
		} else if (s.kind === 'ins') insertedTokens++;
		else if (s.kind === 'off') offScriptTokens++;
		else if (s.kind === 'jump' || s.kind === 'jumpOff') jumps++;
		else if (s.kind === 'skip') skipped += s.s[1] - s.s[0] + 1;
	}
	const spokenLines = new Set<number>();
	for (const t of script.tokens) if (t.kind === 'word') spokenLines.add(t.line);
	const share = (n: number) => (transcriptCount > 0 ? n / transcriptCount : 0);
	return {
		mediaId,
		transcriptId,
		transcriptTokens: transcriptCount,
		scriptTokens: script.tokens.length,
		exactTokens,
		substitutedTokens,
		insertedTokens,
		offScriptTokens,
		alignedShare: share(exactTokens),
		offScriptShare: share(offScriptTokens),
		retakeJumps,
		jumps,
		skippedScriptTokens: skipped,
		usedLines: [...used].sort((a, b) => a - b),
		unusedLines: [...spokenLines].filter((l) => !used.has(l)).sort((a, b) => a - b),
		cappedRows: core.cappedRows,
		mergeCells: core.mergeCells,
		storedCells: core.storedCells,
	};
}

/** Script lines with spoken words that no media transcript said (SC-016, over every media's report). */
export function unusedScriptLines(script: ParsedScript, reports: readonly AlignmentReport[]): number[] {
	const used = new Set<number>();
	for (const r of reports) for (const l of r.usedLines) used.add(l);
	const lines = new Set<number>();
	for (const t of script.tokens) if (t.kind === 'word' && !used.has(t.line)) lines.add(t.line);
	return [...lines].sort((a, b) => a - b);
}
