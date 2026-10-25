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
	type R = [number, number, number]; // start, end, last kept word index (−1: none)
	const rng: R[] = [];
	if (voice && mode !== 'word') {
		const n = voice.frameCount;
		const sp = (k: number) => voice.classes[k] === VOICE_CLASS_SPEECH;
		for (const k of keepIdx) {
			const w = input.words[k]!;
			const a = Math.trunc(w.s / FR);
			const b = Math.ceil(w.e / FR);
			const lo = Math.max(0, a - 5);
			const hi = Math.min(n, b + 5);
			let first = -1;
			let last = -1;
			for (let f = lo; f < hi; f++)
				if (sp(f)) {
					if (first < 0) first = f;
					last = f;
				}
			if (first < 0) continue; // no voice under the word: misplaced word time or hallucination
			rng.push([first * FR, (last + 1) * FR, k]);
		}
		for (const [a, b] of input.keepSpeech ?? []) rng.push([a, b, -1]);
	} else {
		for (const k of keepIdx) rng.push([input.words[k]!.s, input.words[k]!.e, k]);
		for (const [a, b] of input.keepSpeech ?? []) rng.push([a, b, -1]);
	}
	rng.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);

	// 2. join across gaps ≤ maxGap (and rejected pauses)
	const out0: R[] = [];
	for (const [a, b, k] of rng) {
		const l = out0[out0.length - 1];
		if (l && (a - l[1] <= maxGap || overlaps(input.keepPauses, l[1], a))) {
			l[1] = Math.max(l[1], b);
			if (k >= 0 && (l[2] < 0 || input.words[k]!.e >= input.words[l[2]]!.e)) l[2] = k;
		} else out0.push([a, b, k]);
	}

	// 3. pause compression inside the joined ranges
	let out: R[] = [];
	if (voice && mode !== 'word') {
		const mg = Math.round(maxGap / FR);
		for (const [a, b, k] of out0) {
			const fa = Math.round(a / FR);
			const fb = Math.round(b / FR);
			let cur = fa;
			const mask: boolean[] = [];
			for (let f = fa; f < fb; f++) mask.push(voice.classes[f] !== VOICE_CLASS_SPEECH);
			for (const [x, y] of runsOf(mask)) {
				if (y - x > mg && x > 0 && fa + y < fb && !overlaps(input.keepPauses, (fa + x) * FR, (fa + y) * FR)) {
					out.push([cur * FR, (fa + x) * FR, lastWordBefore(input.words, keepIdx, (fa + x) * FR)]);
					cur = fa + y;
				}
			}
			out.push([cur * FR, fb * FR, k]);
		}
	} else out = out0.map((r) => [r[0], r[1], r[2]] as R);

	// 4. edges, pads, breath before the onset
	const res: R[] = [];
	const thrOut = voice ? edgeThreshold(voice, P.edges, 'out') : null;
	const thrIn = voice ? edgeThreshold(voice, P.edges, 'in') : null;
	const breathMax = Math.round(P.gaps.breathKeepMaxS / FR);
	for (let [a, b, k] of out) {
		if (voice && mode === 'level' && thrOut !== null && thrIn !== null) {
			b = levelOutPoint(voice, a, b, thrOut);
			a = levelInPoint(voice, a, thrIn);
		}
		let a2 = a - P.edges.padBeforeS;
		const b2 = b + P.edges.padAfterS;
		if (voice && mode !== 'word') {
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
		res.push([Math.max(0, a2), b2, k]);
	}
	res.sort((x, y) => x[0] - y[0]);

	// 5. the gap policy's air: inside a sentence keepGapS, between sentences keepGapSentenceS
	const pads = P.edges.padBeforeS + P.edges.padAfterS;
	const wa = pads > 0 ? P.edges.padAfterS / pads : 0.5;
	for (let i = 0; i + 1 < res.length; i++) {
		const cur = res[i]!;
		const nxt = res[i + 1]!;
		const gap = nxt[0] - cur[1];
		if (!(gap > 0)) continue;
		const lastWord = cur[2] >= 0 ? input.words[cur[2]]! : null;
		const want = lastWord && SENTENCE_END.test(lastWord.text.trim()) ? P.gaps.keepGapSentenceS : P.gaps.keepGapS;
		const extra = want - pads;
		if (!(extra > 1e-9)) continue;
		let ea = Math.min(extra * wa, gap / 2);
		let eb = Math.min(extra - ea, gap - ea);
		if (voice && mode !== 'word') {
			// never into speech (removed words stay removed)
			ea = Math.min(ea, nonSpeechAfter(voice, cur[1]));
			eb = Math.min(eb, nonSpeechBefore(voice, nxt[0]));
		}
		cur[1] += Math.max(0, ea);
		nxt[0] -= Math.max(0, eb);
	}

	// 6. merge overlaps, drop short pieces
	const merged: R[] = [];
	for (const r of res) {
		const l = merged[merged.length - 1];
		if (l && r[0] <= l[1]) {
			l[1] = Math.max(l[1], r[1]);
			if (r[2] >= 0) l[2] = r[2];
		} else merged.push([r[0], r[1], r[2]]);
	}
	const kept = merged.filter((x) => x[1] - x[0] >= P.guards.minPieceS).map((x) => [x[0], x[1]] as Span);
	return { kept, mode };
}

function lastWordBefore(words: readonly AWord[], keepIdx: readonly number[], t: number): number {
	let best = -1;
	for (const k of keepIdx) if (words[k]!.e <= t + 0.06) best = k;
	return best;
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
