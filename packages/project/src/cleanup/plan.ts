// Cut planning for one media (spec 14 TC-020…TC-023; docs/wp-notes/transcript-cleanup.md "Planning"). A faithful port
// of the research prototype's `cut` (private `.prproj-analysis/research/edits/mac/autocut.py`): kept words snapped to
// their speech frames (±50 ms), joined across gaps ≤ `maxGapS`, non-speech runs longer than that inside a joined range
// cut out, then level-referenced edges, pads, optional breath before an onset, overlaps merged and pieces shorter than
// `minPieceS` dropped. Additions (spec): untranscribed voice kept unless its finding is accepted, rejected pauses and
// breaths kept, the gap policy's air inside / between sentences (`keepGapS`, `keepGapSentenceS`), word mode for media
// without a voice analysis, and the "avoid harsh cuts" guard. Times are media seconds. Pure.
import { VOICE_CLASS_BREATH, VOICE_CLASS_SPEECH } from '@jasper/audio-dsp';
import { FR, levelDbAt, type CleanupVoice } from './detector.ts';
import { edgeThreshold, levelInPoint, levelOutPoint } from './edges.ts';
import type { AWord } from './rules.ts';
import type { CleanupSettings } from './schema.ts';

export type Span = [number, number];

export type MediaPlanInput = {
	/** Candidate words (seconds). */
	words: readonly AWord[];
	/** Parallel to `words`: removed by an accepted finding. */
	removed: readonly boolean[];
	voice: CleanupVoice | null;
	settings: CleanupSettings;
	/** Speech without words kept as speech (untranscribed voice whose finding is not accepted), seconds. */
	keepSpeech?: readonly Span[];
	/** Pauses not to cut (rejected pause findings), seconds. */
	keepPauses?: readonly Span[];
	/** Breath-like runs kept before an onset (seconds): rejected breath findings, or every breath with policy `keep`… */
	keepBreaths?: readonly Span[];
	/** … except these (accepted breath findings) when the policy is `keep`. */
	removeBreaths?: readonly Span[];
	/**
	 * Removed words between kept words closer than `maxGapS` are cut out too (default). `false` = the prototype's
	 * behaviour (they stay inside the joined range), for the port check.
	 */
	strictRemoval?: boolean;
};

export type MediaPlan = {
	/** Kept pieces, sorted, disjoint, seconds. */
	kept: Span[];
	/** The edge mode used (`word` when the media has no usable voice analysis). */
	mode: CleanupSettings['edges']['mode'];
};

const overlaps = (spans: readonly Span[] | undefined, a: number, b: number) =>
	!!spans && spans.some(([x, y]) => x < b && y > a);
const contains = (spans: readonly Span[] | undefined, t: number) =>
	!!spans && spans.some(([x, y]) => x <= t && t < y);

/** Prototype `runs`: half-open runs of true in a boolean list. */
function runsOf(mask: readonly boolean[]): Span[] {
	const out: Span[] = [];
	let i = 0;
	while (i < mask.length) {
		if (!mask[i]) {
			i++;
			continue;
		}
		let j = i;
		while (j < mask.length && mask[j]) j++;
		out.push([i, j]);
		i = j;
	}
	return out;
}

const SENTENCE_END = /[.?!…]["'»”’)]*$/u;

/** Plans the kept pieces of one media (see the module comment). */
export function planMediaCuts(input: MediaPlanInput): MediaPlan {
	const P = input.settings;
	const voice = input.voice && input.voice.frameCount > 0 && input.voice.levels.floorDb !== null ? input.voice : null;
	const mode = voice ? P.edges.mode : 'word';
	const keepIdx: number[] = [];
	for (let k = 0; k < input.words.length; k++) if (!input.removed[k]) keepIdx.push(k);
	if (!keepIdx.length && !input.keepSpeech?.length) return { kept: [], mode };
	const maxGap = P.gaps.maxGapS;

	// 1. kept word extents (snapped to speech frames)
	type R = { a: number; b: number; k: number; minA: number; maxB: number }; // k: last kept word (−1: none)
	const piece = (a: number, b: number, k: number): R => ({
		a,
		b,
		k,
		minA: Number.NEGATIVE_INFINITY,
		maxB: Number.POSITIVE_INFINITY,
	});
	const rng: R[] = [];
	const speechMode = !!voice && mode !== 'word';
	if (voice && speechMode) {
		for (const k of keepIdx) {
			const ext = speechExtent(voice, input.words[k]!, 5);
			if (ext) rng.push(piece(ext[0], ext[1], k)); // else: no voice under the word (misplaced time / hallucination)
		}
	} else for (const k of keepIdx) rng.push(piece(input.words[k]!.s, input.words[k]!.e, k));
	for (const [a, b] of input.keepSpeech ?? []) rng.push(piece(a, b, -1));
	rng.sort((x, y) => x.a - y.a || x.b - y.b || x.k - y.k);

	// 2. join across gaps ≤ maxGap (and rejected pauses)
	const out0: R[] = [];
	for (const r of rng) {
		const l = out0[out0.length - 1];
		if (l && (r.a - l.b <= maxGap || overlaps(input.keepPauses, l.b, r.a))) {
			l.b = Math.max(l.b, r.b);
			if (r.k >= 0 && (l.k < 0 || input.words[r.k]!.e >= input.words[l.k]!.e)) l.k = r.k;
		} else out0.push({ ...r });
	}

	// 3. pause compression inside the joined ranges
	let out: R[] = [];
	const lastKeptBefore = lastKeptFinder(input.words, keepIdx);
	if (voice && speechMode) {
		const mg = Math.round(maxGap / FR);
		for (const r of out0) {
			const fa = Math.round(r.a / FR);
			const fb = Math.round(r.b / FR);
			let cur = fa;
			const mask: boolean[] = [];
			for (let f = fa; f < fb; f++) mask.push(voice.classes[f] !== VOICE_CLASS_SPEECH);
			for (const [x, y] of runsOf(mask)) {
				if (y - x > mg && x > 0 && fa + y < fb && !overlaps(input.keepPauses, (fa + x) * FR, (fa + y) * FR)) {
					out.push(piece(cur * FR, (fa + x) * FR, lastKeptBefore((fa + x) * FR)));
					cur = fa + y;
				}
			}
			out.push(piece(cur * FR, fb * FR, r.k));
		}
	} else out = out0.map((r) => ({ ...r }));

	// 3b. removed words inside a joined range go too (the prototype kept a removed word closer than maxGap to kept
	// ones); the kept words' sound wins where they touch
	if (input.strictRemoval !== false) out = subtractRemoved(out, input, keepIdx, voice, speechMode, piece);

	// 4. edges, pads, breath before the onset (never past a removed word next to the piece)
	const res: R[] = [];
	const thrOut = voice ? edgeThreshold(voice, P.edges, 'out') : null;
	const thrIn = voice ? edgeThreshold(voice, P.edges, 'in') : null;
	const breathMax = Math.round(P.gaps.breathKeepMaxS / FR);
	for (const r of out) {
		let { a, b } = r;
		if (voice && mode === 'level' && thrOut !== null && thrIn !== null) {
			b = Math.min(levelOutPoint(voice, a, b, thrOut), r.maxB);
			a = Math.max(levelInPoint(voice, a, thrIn), r.minA);
		}
		let a2 = a - P.edges.padBeforeS;
		const b2 = Math.min(b + P.edges.padAfterS, r.maxB);
		if (voice && speechMode) {
			let f = Math.trunc(a / FR) - 1;
			let m = 0;
			const keepPolicy = P.gaps.breath === 'keep';
			const keepHere = (fr: number) => {
				const t = fr * FR;
				return keepPolicy ? !contains(input.removeBreaths, t) : contains(input.keepBreaths, t);
			};
			while (f > 0 && voice.classes[f] === VOICE_CLASS_BREATH && m < breathMax && keepHere(f)) {
				f -= 1;
				m += 1;
			}
			// prototype `keep_breath`: a2 = min(a2, (k + 1) · FR) whenever the policy keeps breaths
			if (m > 0 || keepPolicy) a2 = Math.min(a2, (f + 1) * FR);
		}
		res.push({ ...r, a: Math.max(0, a2, r.minA), b: b2 });
	}
	res.sort((x, y) => x.a - y.a);

	// 5. the gap policy's air: inside a sentence keepGapS, between sentences keepGapSentenceS
	const pads = P.edges.padBeforeS + P.edges.padAfterS;
	const wa = pads > 0 ? P.edges.padAfterS / pads : 0.5;
	for (let i = 0; i + 1 < res.length; i++) {
		const cur = res[i]!;
		const nxt = res[i + 1]!;
		const gap = nxt.a - cur.b;
		if (!(gap > 0)) continue;
		const lastWord = cur.k >= 0 ? input.words[cur.k]! : null;
		const want = lastWord && SENTENCE_END.test(lastWord.text.trim()) ? P.gaps.keepGapSentenceS : P.gaps.keepGapS;
		const extra = want - pads;
		if (!(extra > 1e-9)) continue;
		let ea = Math.min(extra * wa, gap / 2, cur.maxB - cur.b);
		let eb = Math.min(extra - ea, gap - ea, nxt.a - nxt.minA);
		if (voice && speechMode) {
			// never into speech (removed words stay removed)
			ea = Math.min(ea, nonSpeechAfter(voice, cur.b));
			eb = Math.min(eb, nonSpeechBefore(voice, nxt.a));
		}
		cur.b += Math.max(0, ea);
		nxt.a -= Math.max(0, eb);
	}

	// 6. merge overlaps, drop short pieces
	const merged: R[] = [];
	for (const r of res) {
		const l = merged[merged.length - 1];
		if (l && r.a <= l.b) {
			l.b = Math.max(l.b, r.b);
			if (r.k >= 0) l.k = r.k;
		} else merged.push({ ...r });
	}
	const kept = merged.filter((x) => x.b - x.a >= P.guards.minPieceS).map((x) => [x.a, x.b] as Span);
	return { kept, mode };
}

/** Speech frames of a word (prototype: its frames ± `pad` frames), as seconds; null without speech. */
export function speechExtent(voice: CleanupVoice, w: { s: number; e: number }, pad: number): Span | null {
	const a = Math.trunc(w.s / FR);
	const b = Math.ceil(w.e / FR);
	const lo = Math.max(0, a - pad);
	const hi = Math.min(voice.frameCount, b + pad);
	let first = -1;
	let last = -1;
	for (let f = lo; f < hi; f++)
		if (voice.classes[f] === VOICE_CLASS_SPEECH) {
			if (first < 0) first = f;
			last = f;
		}
	return first < 0 ? null : [first * FR, (last + 1) * FR];
}

/**
 * The spans of removed words (their own speech frames, or word times in word mode), minus the kept words' sound
 * (their speech frames within ± 50 ms, as the planner keeps them).
 */
export function removedSpans(
	input: Pick<MediaPlanInput, 'words' | 'removed'>,
	keepIdx: readonly number[],
	voice: CleanupVoice | null,
	speechMode: boolean,
): Span[] {
	const keptExt: Span[] = [];
	for (const k of keepIdx) {
		const w = input.words[k]!;
		// the kept words' extents as step 1 takes them (± 50 ms): kept sound wins where the timestamps disagree
		const e = voice && speechMode ? speechExtent(voice, w, 5) : ([w.s, w.e] as Span);
		if (e) keptExt.push(e);
	}
	keptExt.sort((x, y) => x[0] - y[0]);
	const out: Span[] = [];
	for (let k = 0; k < input.words.length; k++) {
		if (!input.removed[k]) continue;
		const w = input.words[k]!;
		const e = voice && speechMode ? speechExtent(voice, w, 0) : ([w.s, w.e] as Span);
		if (!e) continue;
		let parts: Span[] = [e];
		for (const [x, y] of keptExt) {
			if (y <= e[0]) continue;
			if (x >= e[1]) break;
			parts = parts.flatMap(([p, q]) => {
				const r: Span[] = [];
				if (x > p) r.push([p, Math.min(q, x)]);
				if (y < q) r.push([Math.max(p, y), q]);
				return r.filter(([u, v]) => v - u > 1e-9);
			});
		}
		out.push(...parts);
	}
	out.sort((x, y) => x[0] - y[0]);
	const merged: Span[] = [];
	for (const sp of out) {
		const l = merged[merged.length - 1];
		if (l && sp[0] <= l[1] + 1e-9) l[1] = Math.max(l[1], sp[1]);
		else merged.push([sp[0], sp[1]]);
	}
	return merged;
}

function subtractRemoved<R extends { a: number; b: number; k: number; minA: number; maxB: number }>(
	pieces: R[],
	input: MediaPlanInput,
	keepIdx: readonly number[],
	voice: CleanupVoice | null,
	speechMode: boolean,
	make: (a: number, b: number, k: number) => R,
): R[] {
	const rem = removedSpans(input, keepIdx, voice, speechMode);
	if (!rem.length) return pieces;
	const lastKeptBefore = lastKeptFinder(input.words, keepIdx);
	const out: R[] = [];
	let j = 0;
	for (const p of pieces) {
		while (j < rem.length && rem[j]![1] <= p.a) j++;
		let cur: R = p;
		let q = j;
		while (q < rem.length && rem[q]![0] < cur.b) {
			const [x, y] = rem[q]!;
			if (x > cur.a) {
				const left = make(cur.a, x, lastKeptBefore(x));
				left.minA = cur.minA;
				left.maxB = x;
				out.push(left);
			}
			const rest = make(Math.max(cur.a, y), cur.b, cur.k);
			rest.minA = y;
			rest.maxB = cur.maxB;
			cur = rest;
			q++;
		}
		if (cur.b - cur.a > 1e-9) out.push(cur);
	}
	// edges never move into removed sound next to a piece either (the in point searches 80 ms back, the out point
	// walks forward through loud frames)
	let r = 0;
	for (const p of out) {
		while (r < rem.length && rem[r]![1] <= p.a + 1e-9) r++;
		const before = r > 0 ? rem[r - 1]![1] : Number.NEGATIVE_INFINITY;
		p.minA = Math.max(p.minA, Math.min(before, p.a));
		let q = r;
		while (q < rem.length && rem[q]![0] < p.b - 1e-9) q++;
		const after = q < rem.length ? rem[q]![0] : Number.POSITIVE_INFINITY;
		p.maxB = Math.min(p.maxB, Math.max(after, p.b));
	}
	return out;
}

/** The last kept word ending before `t` (+ 60 ms), by binary search over kept words in end order. */
function lastKeptFinder(words: readonly AWord[], keepIdx: readonly number[]): (t: number) => number {
	const byEnd = [...keepIdx].sort((x, y) => words[x]!.e - words[y]!.e);
	return (t: number) => {
		let lo = 0;
		let hi = byEnd.length;
		while (lo < hi) {
			const m = (lo + hi) >> 1;
			if (words[byEnd[m]!]!.e <= t + 0.06) lo = m + 1;
			else hi = m;
		}
		return lo > 0 ? byEnd[lo - 1]! : -1;
	};
}

/** Seconds of non-speech from `t` forward (until the first speech frame). */
function nonSpeechAfter(v: CleanupVoice, t: number): number {
	let f = Math.max(0, Math.round(t / FR));
	const start = f;
	while (f < v.frameCount && v.classes[f] !== VOICE_CLASS_SPEECH) f++;
	return (f - start) * FR;
}

/** Seconds of non-speech before `t` (back to the last speech frame). */
function nonSpeechBefore(v: CleanupVoice, t: number): number {
	let f = Math.min(v.frameCount, Math.round(t / FR)) - 1;
	const start = f;
	while (f >= 0 && v.classes[f] !== VOICE_CLASS_SPEECH) f--;
	return (start - f) * FR;
}

/**
 * The "avoid harsh cuts" guard (TC-023): whether a cut between kept pieces ending at `out` and starting at `inn`
 * (seconds) lands on loud sound — no frame within `window` of an edge is below the in-threshold.
 */
export function isHarshCut(voice: CleanupVoice, settings: CleanupSettings, out: number, inn: number): boolean {
	const thr = edgeThreshold(voice, settings.edges, 'in');
	if (thr === null) return false;
	const w = Math.max(0, Math.round(settings.guards.harshWindowS / FR));
	const quietNear = (t: number) => {
		const c = Math.round(t / FR);
		for (let f = c - w; f <= c + w; f++) if (levelDbAt(voice, f) < thr) return true;
		return false;
	};
	return !quietNear(out) || !quietNear(inn);
}
