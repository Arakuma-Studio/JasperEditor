// The "probably wrong" detector of transcript cleanup (spec 14 TC-010…TC-013; docs/wp-notes/transcript-cleanup.md
// "Detector"). Input: the words of one media's transcript (media time), its segment scores when the recogniser kept
// them, the media's voice analysis (TC-001), an optional script, the language and the settings. Output: typed,
// explained findings with stable fingerprints and the retake groups. Deterministic; no DOM / Node APIs.
//
// Pipeline (the prototype's order, `autocut.py main` + `detect`): candidate words (non-empty normalised text,
// end ≥ start) → hallucination guard (`common.py clean_words`, TC-003) → vocalic fillers → restarts → takes
// (retakes / false starts, take groups, script choice) → off-script → marker phrases → then the spec's additions:
// stutters, head / tail, lexical review, ASR suspects; plus the frame findings: pauses, breaths, untranscribed voice.
import { VOICE_CLASS_BREATH, VOICE_CLASS_SPEECH, voiceLevelDb } from '@jasper/audio-dsp';
import { FLICKS_PER_SECOND } from '../time.ts';
import { RESTART_DIP_DEFAULT, wordDip } from './dip.ts';
import {
	builtinLists,
	type CleanupLanguage,
	type CleanupLanguageLists,
	cleanupLanguageOf,
	cleanupNorm,
	foreignScriptWord,
	phraseTokens,
	restartStopWords,
	sameWord,
} from './lists.ts';
import { type RepeatLink, ruleRepeats } from './repeats.ts';
import {
	type AWord,
	CUT_OFF,
	claimWord,
	phrases,
	type RuleContext,
	ruleAsrSuspects,
	ruleFillers,
	ruleLexicalReview,
	ruleMarkerPhrases,
	ruleOffScript,
	ruleStutters,
	SENTENCE_END,
	type WordLabel,
} from './rules.ts';
import type {
	CleanupEdges,
	CleanupFinding,
	CleanupLists,
	CleanupSettings,
	FindingKind,
	FindingSuggestion,
	RetakeGroup,
	RetakeTake,
	RuleAction,
} from './schema.ts';
import { ScriptAligner, ScriptIndex, scriptLines, scriptTokens } from './script.ts';
import { STRETCH_ABS_S, secondsPerSyllable, stretchedWord } from './stretch.ts';
import type { VoiceAnalysis } from './voice-analysis.ts';

/** Seconds per voice-analysis frame. */
export const FR = 0.01;

export type CleanupWordIn = {
	text: string;
	/** Media time, flicks. */
	start: number;
	end: number;
	confidence: number | null;
	speaker?: string | null;
};

/** A recogniser segment with its decoder scores (spec 14 TC-003; optional — absent on older transcripts). */
export type CleanupSegmentIn = {
	start: number;
	end: number;
	avgLogprob?: number;
	noSpeechProb?: number;
	compressionRatio?: number;
};

/** The parts of a voice analysis the detector and planner read. */
export type CleanupVoice = Pick<VoiceAnalysis, 'classes' | 'level' | 'frameCount' | 'levels'> &
	Partial<Pick<VoiceAnalysis, 'voicing' | 'flatness'>>;

export type DetectInput = {
	mediaId: string;
	/** Audio stream index (fingerprints). */
	stream?: number;
	words: readonly CleanupWordIn[];
	segments?: readonly CleanupSegmentIn[] | null;
	voice?: CleanupVoice | null;
	script?: string | null;
	/** Transcript language tag (`es`, `en-US`, `und`…). */
	language?: string | null;
	/** The sequence's edited lists for this language (replace the built-in list they name). */
	lists?: CleanupLists | null;
	settings: CleanupSettings;
	/** Only words whose midpoint lies in one of these media ranges (flicks) are analysed (absent: all). */
	spans?: ReadonlyArray<{ start: number; end: number }> | null;
	/**
	 * Media ranges (flicks) the recogniser decoded again alone (`Transcript.redecoded`): restarts, false starts and
	 * retakes there are hidden retakes — takes the first decode had written once.
	 */
	redecoded?: ReadonlyArray<readonly [number, number]> | null;
	/** Look for a restart inside one word by its level dip (`wordDip`; default `RESTART_DIP_DEFAULT`, off). */
	restartDip?: boolean;
};

export type ScriptLineReport = { index: number; text: string; said: boolean; takes: number };

export type DetectResult = {
	mediaId: string;
	stream: number;
	language: CleanupLanguage | null;
	/** Candidate words (seconds, media time). `guarded[k]`: dropped by the hallucination guard before the rules. */
	words: AWord[];
	/** Parallel to `words`: the word's sound (seconds) — its time and the voice next to it it holds (frame analysis). */
	sound: Array<[number, number]>;
	guarded: boolean[];
	findings: CleanupFinding[];
	groups: RetakeGroup[];
	/** The script's lines and whether some take says them (null without a script). */
	script: ScriptLineReport[] | null;
};

const CONFIDENCE: Record<FindingKind, number> = {
	pause: 0.95,
	breath: 0.7,
	'filler-vocalic': 0.9,
	'filler-phrase': 0.8,
	'filler-lexical': 0.3,
	restart: 0.85,
	'false-start': 0.9,
	retake: 0.9,
	'hidden-retake': 0.85,
	stutter: 0.8,
	'off-script': 0.85,
	'head-tail': 0.8,
	untranscribed: 0.5,
	'asr-suspect': 0.4,
	hallucination: 0.9,
	fragment: 0.6,
	edge: 0.8,
};

/** FNV-1a (32 bit) of a string, 8 hex digits. */
export function fnv1a(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

/**
 * A finding's fingerprint (TC-013): media id, stream, kind, range rounded to 100 ms and a hash of its normalised text.
 * A re-run of the same analysis gives the same fingerprint; a rejected finding stays rejected.
 */
export function findingFingerprint(
	mediaId: string,
	stream: number,
	kind: FindingKind,
	startSec: number,
	endSec: number,
	text: string,
): string {
	const id = mediaId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
	return `${id}~${stream}~${kind}~${Math.round(startSec * 10)}~${Math.round(endSec * 10)}~${fnv1a(cleanupNorm(text))}`;
}

/** The lists the detector uses: built-ins of the language, with the sequence's edited lists replacing theirs. */
export function effectiveLists(
	lang: CleanupLanguage | null,
	edits?: CleanupLists | null,
): CleanupLanguageLists {
	const b = builtinLists(lang);
	const norm = (xs: readonly string[]) =>
		xs.map((x) => phraseTokens(x).join(' ')).filter((x) => x.length > 0);
	return {
		...b,
		fillers: edits?.fillers ? norm(edits.fillers).filter((x) => !x.includes(' ')) : b.fillers,
		markers: edits?.markers ? norm(edits.markers) : b.markers,
		allow: edits?.allow ? norm(edits.allow).filter((x) => !x.includes(' ')) : b.allow,
	};
}

const toSec = (f: number) => f / FLICKS_PER_SECOND;

/** Class of frame k (silence beyond the analysis). */
const clsAt = (v: CleanupVoice, k: number) => (k >= 0 && k < v.frameCount ? v.classes[k]! : 0);

/** Prototype word frame span: `[int(s/FR), max(int(s/FR)+1, ceil(e/FR)))`. */
export function wordFrames(w: { s: number; e: number }): [number, number] {
	const a = Math.trunc(w.s / FR);
	return [a, Math.max(a + 1, Math.ceil(w.e / FR))];
}

/**
 * The hallucination guard's candidates (`common.py clean_words`, TC-003): `runs` — runs of ≥ `run` identical tokens —
 * and, with a voice analysis, `lowShare` — words outside a run whose frames are less than `share` speech or breath-like
 * (an empty frame span counts as none). A low share alone is no evidence on dense, loudness-normalised audio, where
 * the voice analysis calls short real words non-speech: the detector weighs it (`detectCleanup`).
 */
function hallucinationCandidates(
	words: readonly AWord[],
	voice: CleanupVoice | null | undefined,
	run: number,
	share: number,
): { runs: boolean[]; lowShare: boolean[] } {
	const runs = new Array<boolean>(words.length).fill(false);
	const lowShare = new Array<boolean>(words.length).fill(false);
	const n = words.length;
	let i = 0;
	while (i < n) {
		let j = i;
		while (j + 1 < n && words[j + 1]!.n === words[i]!.n) j++;
		if (j - i + 1 >= run) {
			for (let k = i; k <= j; k++) runs[k] = true;
			i = j + 1;
			continue;
		}
		if (voice) {
			for (let k = i; k <= j; k++) {
				const [a, b] = wordFrames(words[k]!);
				const lo = Math.max(0, a);
				const hi = Math.min(voice.frameCount, b);
				let on = 0;
				for (let f = lo; f < hi; f++) if (voice.classes[f]! > 0) on++;
				if (hi <= lo || on / (hi - lo) < share) lowShare[k] = true;
			}
		}
		i = j + 1;
	}
	return { runs, lowShare };
}

function speechShare(voice: CleanupVoice, s: number, e: number): number {
	const [a, b] = wordFrames({ s, e });
	const lo = Math.max(0, a);
	const hi = Math.min(voice.frameCount, b);
	if (hi <= lo) return 0;
	let on = 0;
	for (let f = lo; f < hi; f++) if (voice.classes[f] === VOICE_CLASS_SPEECH) on++;
	return on / (hi - lo);
}

/** Detects cleanup findings in one media's words (see the module comment). */
export function detectCleanup(input: DetectInput): DetectResult {
	const settings = input.settings;
	const T = settings.thresholds;
	const stream = input.stream ?? 0;
	const lang = cleanupLanguageOf(input.language);
	const lists = effectiveLists(lang, input.lists);
	const voice = input.voice && input.voice.frameCount > 0 ? input.voice : null;

	// candidate words (prototype load_words: e > s − 1e-6, non-empty normalised text)
	const words: AWord[] = [];
	const spans = input.spans ?? null;
	for (let i = 0; i < input.words.length; i++) {
		const w = input.words[i]!;
		if (!(Number.isFinite(w.start) && Number.isFinite(w.end))) continue;
		if (spans) {
			const mid = w.start + (w.end - w.start) / 2;
			if (!spans.some((r) => mid >= r.start && mid < r.end)) continue;
		}
		const s = toSec(w.start);
		const e = toSec(w.end);
		if (!(e > s - 1e-6)) continue;
		// a spoken symbol ("%": "por ciento") is a word over its sound, though it normalises to nothing
		// …and a word in another writing system (Hangul in a Spanish transcript) is a word over its sound: garbage to flag
		const n =
			cleanupNorm(w.text) ||
			spokenSymbol(w.text, lang) ||
			(foreignScriptWord(w.text, input.language)
				? w.text
						.normalize('NFKC')
						.toLowerCase()
						.replace(/[\p{P}\p{S}\s]/gu, '')
				: '');
		if (!n) continue;
		const conf = typeof w.confidence === 'number' && Number.isFinite(w.confidence) ? w.confidence : null;
		words.push({ i, n, s, e, text: w.text, conf });
	}
	words.sort((a, b) => a.s - b.s || a.i - b.i);

	// hallucination guard: runs, words over non-speech, known phrases over non-speech. A word the script says in
	// sequence, one the recogniser is sure of or one said near the speech level around it is no hallucination over
	// non-speech, whatever the voice classes say (docs/wp-notes/transcript-cleanup.md "Hallucinations need non-speech
	// evidence": on a loudness-normalised mixdown the classes gave real script words 0–40 % speech frames)
	const hallOn = settings.rules.hallucination !== 'off';
	const sTokens = input.script ? scriptTokens(input.script) : [];
	const aligner = sTokens.length ? new ScriptAligner(sTokens) : null;
	const allTokens = words.map((w) => w.n);
	const supportMemo = new Map<number, number>();
	/** In-order neighbours the script has around word k (0 without a script). */
	const scriptSupport = (k: number) => {
		if (!aligner) return 0;
		let v = supportMemo.get(k);
		if (v === undefined) {
			v = aligner.support(allTokens, k);
			supportMemo.set(k, v);
		}
		return v;
	};
	const onScriptWord = (k: number) => scriptSupport(k) >= ALIGNED_SUPPORT;
	const confident = (k: number) => words[k]!.conf !== null && words[k]!.conf! >= CONFIDENT_WORD;
	const cand = hallOn
		? hallucinationCandidates(words, voice, T.hallucinationRun, T.hallucinationSpeechShare)
		: null;
	const guarded = cand ? [...cand.runs] : new Array<boolean>(words.length).fill(false);
	const nearSpeech = voice && cand ? nearSpeechLevel(voice, words, cand.lowShare) : () => false;
	const suspect = new Set<number>();
	if (cand && voice)
		for (let k = 0; k < words.length; k++) {
			if (!cand.lowShare[k] || onScriptWord(k) || confident(k) || nearSpeech(k)) continue;
			// positive evidence: the word lies over measured silence (or outside the audio); else only for review
			if (overSilence(voice, words[k]!)) guarded[k] = true;
			else suspect.add(k);
		}
	const hummed = new Set<number>();
	if (hallOn && voice) {
		const phrasesH = lists.hallucinations.map((h) => h.split(' ')).sort((a, b) => b.length - a.length);
		for (let k = 0; k < words.length; k++) {
			for (const p of phrasesH) {
				if (k + p.length > words.length || !p.every((x, q) => words[k + q]!.n === x)) continue;
				const s = words[k]!.s;
				const e = words[k + p.length - 1]!.e;
				const at = p.map((_, q) => k + q);
				// the script says it ("Suscríbete, chau."): speech
				if (at.some(onScriptWord)) break;
				if (speechShare(voice, s, e) < 0.5) {
					// over audible sound near the speech level (a real word the classes missed, or music): for review
					const audible = at.some(nearSpeech);
					for (const q of at)
						if (audible) suspect.add(q);
						else guarded[q] = true;
				} else if (!noFrication(voice, s, e) || !belowSpeech(voice, s, e)) break;
				// over voice without a single fricative, quieter than the speech (humming): flagged for review (round 6,
				// fragment M: "¡Suscríbete al canal!" decoded over 4.9 s of humming at −17…−30 dBFS; run 9, AC: the phrase
				// alone flagged a real, loud "gracias")
				else for (let q = 0; q < p.length; q++) hummed.add(k + q);
				break;
			}
		}
	}
	// words the recogniser likely inserted (round 7): garbage — words in another writing system and the few between two
	// of them ("Pen 와 blah blah금u") —, a stock phrase woven into other speech ("¡Suscríbete | Tengo al solo 30 días para
	// hacer canal!"), and words over sound without a voiced frame (no vowel: "¿Qué pasa?" over noise). A repeat's
	// alignment forgives them between re-said words; one over noise alone in its phrase is a hallucination like the guard's
	for (const k of hummed) suspect.add(k);
	if (hallOn) {
		let last = -1;
		for (let k = 0; k < words.length; k++) {
			if (!foreignScriptWord(words[k]!.text, input.language)) continue;
			suspect.add(k);
			if (last >= 0 && k - last - 1 <= GARBLED_GAP_MAX) for (let q = last + 1; q < k; q++) suspect.add(q);
			last = k;
		}
		for (const p of lists.hallucinations.map((h) => h.split(' ')).filter((p) => p.length > 1))
			for (let k = 0; k < words.length; k++) {
				if (words[k]!.n !== p[0]) continue;
				const at = [k];
				for (let q = k + 1; q < words.length && at.length < p.length; q++) {
					if (q - k > WOVEN_MAX_WORDS || words[q]!.s - words[k]!.e > WOVEN_MAX_S) break;
					if (words[q]!.n === p[at.length]) at.push(q);
				}
				if (at.length === p.length && at[at.length - 1]! - k >= p.length) for (const q of at) suspect.add(q);
			}
		if (voice?.voicing) {
			// …but never a word the script says in sequence, and one the recogniser is sure of only for review
			const noise = words.map((w, k) => !guarded[k] && !onScriptWord(k) && unvoicedSound(voice, w));
			for (let k = 0; k < words.length; ) {
				if (!noise[k]) {
					k++;
					continue;
				}
				let j = k;
				while (j + 1 < words.length && noise[j + 1]) j++;
				// removed only alone between pauses that go (round 11: else for review)
				const alone =
					settings.rules.pause === 'remove' &&
					(k === 0 || words[k]!.s - words[k - 1]!.e >= T.phraseGapS) &&
					(j === words.length - 1 || words[j + 1]!.s - words[j]!.e >= T.phraseGapS);
				for (let q = k; q <= j; q++) {
					if (alone && !confident(q)) guarded[q] = true;
					else suspect.add(q);
				}
				k = j + 1;
			}
		}
	}
	const aw: AWord[] = [];
	const awIndex: number[] = []; // aw position → words position
	for (let k = 0; k < words.length; k++)
		if (!guarded[k]) {
			aw.push(words[k]!);
			awIndex.push(k);
		}

	const fillers = new Set(lists.fillers);
	const stop = new Set(lists.stopWords);
	const labels: (WordLabel | null)[] = new Array(aw.length).fill(null);
	const ctx: RuleContext = {
		words: aw,
		labels,
		settings,
		lists,
		fillers,
		stop,
		restartStop: new Set(restartStopWords(lang)),
		scriptTokens: sTokens,
		inserted: new Set(aw.flatMap((_, k) => (suspect.has(awIndex[k]!) ? [k] : []))),
		voicedSeconds: voice
			? (w) => {
					const [a, b] = wordFrames(w);
					let on = 0;
					for (let f = Math.max(0, a); f < Math.min(voice.frameCount, b); f++)
						if (voice.classes[f] === VOICE_CLASS_SPEECH) on++;
					return on * FR;
				}
			: null,
	};
	const markers = lists.markers.map((m) => m.split(' ')).filter((m) => m.length > 0);

	ruleFillers(ctx);
	const links = ruleRepeats(ctx);
	const units = phrases(aw, T.takeGapS);

	// what each unit says (script lines, head / tail): its words but vocalic fillers and the restarts inside it
	const lines = input.script ? scriptLines(input.script, stop) : [];
	const index = lines.length ? new ScriptIndex(lines) : null;
	const restarted = (k: number) =>
		!!labels[k] && (labels[k]!.kind === 'restart' || labels[k]!.kind === 'false-start');
	const unitContent = units.map((u) =>
		u
			.filter((k) => !restarted(k))
			.map((k) => aw[k]!.n)
			.filter((t) => !fillers.has(t)),
	);
	const unitCw = unitContent.map((c) => c.filter((t) => !stop.has(t) && t.length >= 3));
	const unitLine = units.map((_, u) => (index ? index.match(unitCw[u]!, T.scriptLineSimilarity) : null));

	// take groups (docs/wp-notes/transcript-cleanup.md "Repeats by alignment"): the retake attempts of one sentence and
	// the take that stays — the last retry, which is not itself an attempt
	const groups: RetakeGroup[] = [];
	const retakeAction = settings.rules.retake;
	const finalOf = (l: RepeatLink): RepeatLink => {
		let cur = l;
		for (let guard = 0; guard < links.length; guard++) {
			const next = links.find(
				(m) => m !== cur && m.tier === cur.tier && m.attempt[0] <= cur.retry && cur.retry < m.aside[1],
			);
			if (!next) break;
			cur = next;
		}
		return cur;
	};
	const chains = new Map<number, RepeatLink[]>();
	for (const l of links) {
		if (l.kind !== 'retake') continue;
		const f = finalOf(l);
		const list = chains.get(f.retry) ?? [];
		list.push(l);
		chains.set(f.retry, list);
	}
	const isKey = (t: string) =>
		!fillers.has(t) && ((!stop.has(t) && (t.length >= 3 || /\d/.test(t))) || lists.numbers.includes(t));
	const keysOf = (a: number, b: number) =>
		aw
			.slice(a, b + 1)
			.map((w) => w.n)
			.filter(isKey);
	/** Whether the words `[a1, b1]` say every content word of `[a0, b0]` (ASR variants match). */
	const says = (a1: number, b1: number, a0: number, b0: number) => {
		const have = keysOf(a1, b1);
		return keysOf(a0, b0).every((x) => have.some((y) => sameWord(x, y)));
	};
	for (const [retry, list] of [...chains].sort((x, y) => x[0] - y[0])) {
		list.sort((x, y) => x.attempt[0] - y.attempt[0]);
		const f = finalOf(list[0]!);
		const spans: Array<[number, number]> = [
			...list.map((l) => [l.attempt[0], l.attempt[1] - 1] as [number, number]),
			[retry, Math.max(retry, f.retryEnd)],
		];
		const gi = groups.length;
		const takes: RetakeTake[] = spans.map(([a, b], t) => {
			const ws = aw.slice(a, b + 1);
			const probs = ws.map((w) => w.conf).filter((p): p is number => p !== null);
			const m = index
				? index.match(
						keysOf(a, b).filter((x) => x.length >= 3),
						T.scriptLineSimilarity,
					)
				: null;
			return {
				range: { start: input.words[ws[0]!.i]!.start, end: input.words[ws[ws.length - 1]!.i]!.end },
				words: [ws[0]!.i, ws[ws.length - 1]!.i],
				text: ws.map((w) => w.text.trim()).join(' '),
				...(m ? { scriptLine: m.line, coverage: Math.round(m.coverage * 1000) / 1000 } : {}),
				meanProb: probs.length
					? Math.round((probs.reduce((x, y) => x + y, 0) / probs.length) * 1000) / 1000
					: null,
				complete: t === spans.length - 1 || !CUT_OFF.test(ws[ws.length - 1]!.text.trim()),
			};
		});
		let chosen = takes.length - 1;
		// with a script, an earlier take covering ≥ `scriptPreferEarlier` more of the line wins when it says everything
		// the last take says; the others become retakes, removed only when the chosen take says them too
		const cc = takes[chosen]!.coverage;
		if (cc !== undefined)
			for (let t = 0; t < takes.length - 1; t++) {
				const c = takes[t]!.coverage;
				if (c === undefined || c < cc + T.scriptPreferEarlier) continue;
				if (chosen !== takes.length - 1 && c < takes[chosen]!.coverage!) continue;
				const [a, b] = spans[t]!;
				if (says(a, b, ...spans[spans.length - 1]!)) chosen = t;
			}
		if (chosen !== takes.length - 1) {
			const [ca, cb] = spans[chosen]!;
			for (let k = ca; k <= cb; k++) if (labels[k]?.kind === 'retake') labels[k] = null;
			spans.forEach(([a, b], t) => {
				if (t === chosen) return;
				const action = says(ca, cb, a, b) ? retakeAction : retakeAction === 'off' ? 'off' : 'review';
				for (let k = a; k <= b; k++)
					if (!labels[k] || labels[k]!.kind === 'retake') claimWord(ctx, k, 'retake', action);
			});
		}
		// the group's labels: its attempts, their asides and (after a script choice) the other takes
		const asides = list.map((l) => [l.aside[0], l.aside[1] - 1] as [number, number]);
		for (const [a, b] of [...spans, ...asides])
			for (let k = a; k <= b; k++) {
				const l = labels[k];
				if (l && l.kind === 'retake') labels[k] = { ...l, group: gi };
			}
		groups.push({ id: `g${gi}`, takes, chosen });
	}

	const phs = phrases(aw, T.phraseGapS);
	ruleOffScript(ctx, phs);
	ruleMarkerPhrases(ctx, phs, markers);
	ruleStutters(ctx);
	if (sTokens.length) dropScriptRepeats(ctx);
	// a filler the script says in sequence is scripted speech ("físicas… eh, Nada raro ehh." with the line "eh Nada raro
	// ehh!!!!" lost its "eh"): the filler rules match the token alone, so the script alignment overrides them
	for (let k = 0; k < aw.length; k++) {
		const kind = labels[k]?.kind;
		if ((kind === 'filler-vocalic' || kind === 'filler-phrase') && onScriptWord(awIndex[k]!))
			labels[k] = null;
	}
	// head / tail: before the first unit that says a script line / after the last unit on script — one that says a line
	// or, after it, one whose words come from the script by the prototype's off-script share (over all non-filler tokens,
	// as calibrated; the off-script rule itself now judges content words): closing lines are often paraphrased,
	// and cutting them as tail chatter was the largest error on the user's material (TC-071 calibration). The head side
	// stays strict: pre-roll talk before the first line is usually on topic, and the user cuts it (measured: a
	// symmetric rule left 25 s of pre-roll on 13 shorts against 10 s).
	// Anchored on the script alignment of every transcript word too — words the guard dropped included, so never on
	// the voice classes: a word the script says in sequence is neither head nor tail (a dense cut has no pause of
	// `takeGapS` to make a unit of one line, so no unit said a line until the voice classes dropped words, and the head
	// took 0–666 s of a 931 s scripted cut). A long head or tail, or one holding many script words, is only reviewed.
	if (index && settings.rules.headTail !== 'off') {
		const said = units.map((_, u) => unitLine[u] !== null);
		const first = said.indexOf(true);
		const lastU = said.lastIndexOf(true);
		const vocab = new Set(sTokens);
		const onScript = (u: number) => {
			const c = unitContent[u]!;
			return (
				c.length >= T.offScriptMinTokens &&
				c.filter((x) => vocab.has(x)).length / c.length >= T.offScriptSimilarity
			);
		};
		// the anchors: the starts of the first and the last word on script (seconds)
		let headAt = first >= 0 ? aw[units[first]![0]!]!.s : Number.POSITIVE_INFINITY;
		let tailAt = lastU >= 0 ? aw[units[lastU]![units[lastU]!.length - 1]!]!.s : Number.NEGATIVE_INFINITY;
		// (the words right before / after a word on script that follow the script with fewer neighbours to show —
		// the transcript's first word "Hoy" before "voy a ser mi propio Unity." — are on script too)
		let fa = words.findIndex((w, k) => w.s < headAt && onScriptWord(k));
		while (fa > 0 && scriptSupport(fa - 1) >= LOOSE_SUPPORT) fa--;
		if (fa >= 0) headAt = words[fa]!.s;
		for (let k = words.length - 1; k >= 0 && words[k]!.s > tailAt; k--)
			if (onScriptWord(k)) {
				while (k + 1 < words.length && scriptSupport(k + 1) >= LOOSE_SUPPORT) k++;
				tailAt = Math.max(tailAt, words[k]!.s);
				break;
			}
		if (Number.isFinite(headAt)) {
			// …and the units they lie in are kept whole (the cut's closing "Suscríbete. ¡Chao!" — "chau" in the script)
			const unitAt = (t: number) => units.findIndex((u) => aw[u[0]!]!.s <= t && t <= aw[u[u.length - 1]!]!.s);
			const hu = unitAt(headAt);
			if (hu >= 0) headAt = aw[units[hu]![0]!]!.s;
			const tu = unitAt(tailAt);
			if (tu >= 0) tailAt = aw[units[tu]![units[tu]!.length - 1]!]!.s;
			// after the last word on script, the last unit whose words come from the script
			for (let u = units.length - 1; u >= 0 && aw[units[u]![0]!]!.s > tailAt; u--)
				if (onScript(u)) {
					tailAt = aw[units[u]![units[u]!.length - 1]!]!.s;
					break;
				}
			const t0 = words[0]!.s;
			const span = Math.max(...words.map((w) => w.e)) - t0;
			const claim = (ks: number[], seconds: number) => {
				const scripted = ks.filter((k) => scriptSupport(awIndex[k]!) >= LOOSE_SUPPORT).length;
				const capped = seconds > HEAD_TAIL_MAX_SHARE * span || scripted >= HEAD_TAIL_MAX_SCRIPT_WORDS;
				const action = capped && settings.rules.headTail === 'remove' ? 'review' : settings.rules.headTail;
				for (const k of ks) claimWord(ctx, k, 'head-tail', action);
			};
			const head = aw.flatMap((w, k) => (w.s < headAt ? [k] : []));
			if (head.length) claim(head, headAt - t0);
			const tail = aw.flatMap((w, k) => (w.s > tailAt ? [k] : []));
			if (tail.length) claim(tail, t0 + span - aw[tail[0]!]!.s);
		}
	}
	ruleLexicalReview(ctx, phs, markers);
	ruleAsrSuspects(ctx);
	// decoder scores of the recogniser's segments (TC-003): improbable or repetitive text → review
	if (settings.rules.asrSuspect !== 'off' && input.segments?.length) {
		const segs = [...input.segments].sort((a, b) => a.start - b.start);
		let si = 0;
		for (let k = 0; k < aw.length; k++) {
			const w = input.words[aw[k]!.i]!;
			while (si < segs.length && segs[si]!.end <= w.start) si++;
			const sg = segs[si];
			if (!sg || sg.start > w.start) continue;
			const bad =
				(sg.compressionRatio !== undefined && sg.compressionRatio > 2.4) ||
				(sg.avgLogprob !== undefined && sg.avgLogprob < -1) ||
				(sg.noSpeechProb !== undefined && sg.noSpeechProb > 0.6);
			if (bad) claimWord(ctx, k, 'asr-suspect', 'review');
		}
	}

	// hidden retakes: take labels inside re-decoded ranges (a whole run of one label at a time)
	const redecoded = input.redecoded ?? [];
	if (redecoded.length)
		for (let k = 0; k < aw.length; ) {
			const l = labels[k];
			if (!l || !TAKE_LABELS.has(l.kind)) {
				k++;
				continue;
			}
			let j = k;
			while (j + 1 < aw.length && sameLabel(labels[j + 1], l)) j++;
			const inside = aw.slice(k, j + 1).some((w) => {
				const src = input.words[w.i]!;
				const mid = src.start + (src.end - src.start) / 2;
				return redecoded.some(([a, b]) => mid >= a && mid < b);
			});
			if (inside) for (let q = k; q <= j; q++) labels[q] = { ...labels[q]!, kind: 'hidden-retake' };
			k = j + 1;
		}

	// every removal of a take — whichever rule found it — is adjacent to what says it again and never takes the end of a
	// sentence the kept words before it began (round 10, H1)
	guardRepeats(ctx);

	// a filler phrase said off-mic — no word of it within `LOUD_WORD_DB` of the speech level — is part of an exchange, not
	// a filler: for review (round 11, B5: AJ's off-mic answer "Sí." at −25…−30 dBFS, speech level −8.5 dBFS, was removed)
	if (voice && voice.levels.speechDb !== null)
		for (let k = 0; k < aw.length; ) {
			const l = labels[k];
			if (l?.kind !== 'filler-phrase' || l.action !== 'remove') {
				k++;
				continue;
			}
			let j = k;
			while (j + 1 < aw.length && sameLabel(labels[j + 1], l)) j++;
			if (!aw.slice(k, j + 1).some((w) => loudWord(voice, w)))
				for (let q = k; q <= j; q++) labels[q] = { ...labels[q]!, action: 'review' };
			k = j + 1;
		}

	// what the recogniser likely inserted and no removal takes is a hallucination to review
	for (let k = 0; k < aw.length; k++)
		if (suspect.has(awIndex[k]!) && labels[k]?.action !== 'remove')
			labels[k] = { kind: 'hallucination', action: 'review' };

	// a kept take is what stays of it: words its own restarts, false starts or fillers remove at its edges are not
	// part of it ("… para poder subirlos" said again right after), so no finding overlaps the take that stays
	for (const g of groups) {
		const take = g.takes[g.chosen]!;
		const ks = aw.flatMap((w, k) => (w.i >= take.words[0] && w.i <= take.words[1] ? [k] : []));
		const stays = (k: number) => labels[k]?.action !== 'remove';
		let lo = 0;
		let hi = ks.length - 1;
		while (lo <= hi && !stays(ks[lo]!)) lo++;
		while (hi >= lo && !stays(ks[hi]!)) hi--;
		if (lo > hi || (lo === 0 && hi === ks.length - 1)) continue;
		const ws = ks.slice(lo, hi + 1).map((k) => aw[k]!);
		take.words = [ws[0]!.i, ws[ws.length - 1]!.i];
		take.range = { start: input.words[ws[0]!.i]!.start, end: input.words[ws[ws.length - 1]!.i]!.end };
		take.text = ws.map((w) => w.text.trim()).join(' ');
	}

	// frame analysis: pauses, breaths, untranscribed voice, and the sound each word holds beyond its time (a finding
	// that removes a word removes its sound: docs/wp-notes/transcript-cleanup.md "Every removal has a finding")
	const frameRaw: FrameFinding[] = [];
	const sound: Array<[number, number]> = words.map((w) => [w.s, w.e]);
	if (voice) {
		const ff = frameFindings(
			voice,
			words,
			settings,
			frameRegions(voice, words, spans, voice.frameCount),
			secondsPerSyllable(words.map((w) => ({ text: w.text, seconds: w.e - w.s }))),
			input.restartDip ?? RESTART_DIP_DEFAULT,
		);
		frameRaw.push(...ff.findings);
		// the frames of its time (a frame holding its first or last sample is the word's), and the voice it holds
		ff.sound.forEach(([a, b], k) => {
			const [wa, wb] = wordFrames(words[k]!);
			sound[k] = [Math.min(words[k]!.s, wa * FR, a * FR), Math.max(words[k]!.e, wb * FR, b * FR)];
		});
	} else {
		const regions: Array<[number, number]> = [];
		const rs = spans?.length
			? spans.map((r) => [toSec(r.start), toSec(r.end)] as [number, number]).sort((x, y) => x[0] - y[0])
			: words.length
				? [[words[0]!.s, Math.max(...words.map((w) => w.e))] as [number, number]]
				: [];
		for (const r of rs) {
			const l = regions[regions.length - 1];
			if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]);
			else regions.push([r[0], r[1]]);
		}
		frameRaw.push(...wordGapPauses(words, settings, regions));
	}
	const soundOf = (k: number, k2: number): [number, number] => {
		let a = Number.POSITIVE_INFINITY;
		let b = Number.NEGATIVE_INFINITY;
		for (let q = k; q <= k2; q++) {
			a = Math.min(a, sound[q]![0]);
			b = Math.max(b, sound[q]![1]);
		}
		return [Math.round(a * FLICKS_PER_SECOND), Math.round(b * FLICKS_PER_SECOND)];
	};

	// ---- findings
	type Raw = {
		kind: FindingKind;
		suggested: FindingSuggestion;
		start: number;
		end: number;
		/** The words' own times (flicks) for the fingerprint, when the range holds more of their sound. */
		fp?: [number, number];
		words: [number, number] | null;
		text: string;
		group?: number;
		confidence?: number;
		/** Hidden retakes outside take groups: the take that stays. */
		kept?: string;
		/** A take of a group said after the take that stays. */
		later?: boolean;
		/** Voice for review that is a restart's fragment inside the word `text`. */
		restart?: true;
	};
	const raw: Raw[] = [];
	const laterTake = (g: number, i: number) => {
		const grp = groups[g];
		return !!grp && grp.takes.findIndex((t) => i >= t.words[0] && i <= t.words[1]) > grp.chosen;
	};
	// word findings: runs of analysed words with one label
	for (let k = 0; k < aw.length; ) {
		const l = labels[k];
		if (!l) {
			k++;
			continue;
		}
		let j = k;
		while (
			j + 1 < aw.length &&
			labels[j + 1] &&
			labels[j + 1]!.kind === l.kind &&
			labels[j + 1]!.action === l.action &&
			labels[j + 1]!.group === l.group
		)
			j++;
		const a = aw[k]!;
		const b = aw[j]!;
		// a hidden retake outside a take group names the words that say it again, after it
		const keptTake =
			l.kind === 'hidden-retake' && l.group === undefined
				? aw
						.slice(j + 1, j + 1 + (j - k + 1))
						.map((w) => w.text.trim())
						.join(' ')
				: '';
		const confs = aw
			.slice(k, j + 1)
			.map((w) => w.conf)
			.filter((c): c is number => c !== null);
		const [rs, re] = soundOf(awIndex[k]!, awIndex[j]!);
		raw.push({
			kind: l.kind,
			suggested: l.action,
			start: Math.min(rs, input.words[a.i]!.start),
			end: Math.max(re, input.words[b.i]!.end),
			fp: [input.words[a.i]!.start, input.words[b.i]!.end],
			words: [a.i, b.i],
			text: aw
				.slice(k, j + 1)
				.map((w) => w.text.trim())
				.join(' '),
			...(l.group !== undefined ? { group: l.group } : {}),
			...(keptTake ? { kept: keptTake } : {}),
			...(l.group !== undefined && laterTake(l.group, a.i) ? { later: true } : {}),
			...(l.kind === 'asr-suspect' && confs.length ? { confidence: 1 - Math.min(...confs) } : {}),
		});
		k = j + 1;
	}
	// hallucination guard hits
	if (settings.rules.hallucination !== 'off') {
		for (let k = 0; k < words.length; ) {
			if (!guarded[k]) {
				k++;
				continue;
			}
			let j = k;
			while (j + 1 < words.length && guarded[j + 1]) j++;
			const [hs, he] = soundOf(k, j);
			raw.push({
				kind: 'hallucination',
				suggested: settings.rules.hallucination as FindingSuggestion,
				start: Math.min(hs, input.words[words[k]!.i]!.start),
				end: Math.max(he, input.words[words[j]!.i]!.end),
				fp: [input.words[words[k]!.i]!.start, input.words[words[j]!.i]!.end],
				words: [words[k]!.i, words[j]!.i],
				text: words
					.slice(k, j + 1)
					.map((w) => w.text.trim())
					.join(' '),
			});
			k = j + 1;
		}
	}
	// a removal of words that starts in continuous voice right after another word starts at the quietest 10 ms frame
	// between them, never inside its first word (round 7: cuts started 20–30 ms into a removed "no" / "o" and in loud
	// voice; the frame grid then takes the boundary at or before that point — docs/wp-notes/transcript-cleanup.md
	// "Cut edges in continuous voice")
	if (voice) {
		const posOf = new Map(words.map((w, k) => [w.i, k]));
		for (const r of raw) {
			const k = r.words ? posOf.get(r.words[0]) : undefined;
			if (k === undefined || k === 0) continue;
			const v = startValley(voice, words[k - 1]!, words[k]!);
			if (v !== null) r.start = Math.min(r.start, Math.round(v * FR * FLICKS_PER_SECOND));
		}
	}
	raw.push(...frameRaw);
	// a review-only word alone between two removals, shorter than `SLIVER_S`, is a sliver a cut would leave standing
	// (round 6: "pasa?" 0.10 s, "¿Qué" 0.13 s between pauses; run 9, AD a: the recogniser's "Bueno," over the onset of a
	// removed take's "Así"): its finding proposes removing it (still reviewable) — but a loud voiced sound between two
	// pauses is said on purpose and stays for review (run 9, AG a: the mouth sound "Pup.", voiced, −16 dBFS)
	const pauses = frameRaw.filter((r) => r.kind === 'pause' && r.suggested === 'remove');
	const touches = (x: number, y: number) => Math.abs(x - y) <= FLICKS_PER_SECOND * 0.02;
	const takes = raw.filter((r) => r.words && r.suggested === 'remove');
	const loudVoiced = (r: Raw) => {
		const t = voice?.levels.speechThresholdDb;
		if (!voice || t === null || t === undefined) return false;
		const [a, b] = wordFrames({ s: toSec(r.start), e: toSec(r.end) });
		for (let f = Math.max(0, a); f < Math.min(voice.frameCount, b); f++)
			if (voicedFrame(voice, f) && levelDbAt(voice, f) >= t) return true;
		return false;
	};
	for (const r of raw) {
		if (
			!r.words ||
			r.words[0] !== r.words[1] ||
			r.suggested !== 'review' ||
			!(r.kind === 'asr-suspect' || r.kind === 'filler-lexical') ||
			// the word's own time (its sound holds the decay and air a phrase-final word keeps: round 12)
			(r.fp ? r.fp[1] - r.fp[0] : r.end - r.start) >= SLIVER_S * FLICKS_PER_SECOND
		)
			continue;
		const before = pauses.some((q) => touches(q.end, r.start));
		const after = pauses.some((q) => touches(q.start, r.end));
		const intoTake =
			(before || after) && takes.some((q) => touches(q.start, r.end) || touches(q.end, r.start));
		if ((before && after && !loudVoiced(r)) || intoTake) r.suggested = 'remove';
	}
	// voice without words inside a removed run of retries belongs to it: proposed for removal with it (reviewable;
	// run 4, fragment E: "Que puedo hacer en un mes lo mismo" without words between two parts of a hidden retake)
	// (a run of removed retries may be several findings: the voice between two of them, with no kept word between,
	// goes too — the alignment cuts a chain of takes into one finding per attempt)
	const retries: Array<[number, number]> = [];
	for (const r of raw) {
		if (r.suggested !== 'remove' || !(TAKE_LABELS.has(r.kind) || r.kind === 'hidden-retake')) continue;
		const last = retries.at(-1);
		const between = last
			? aw.some((w, k) => {
					const src = input.words[w.i]!;
					return src.start >= last[1] && src.end <= r.start && labels[k]?.action !== 'remove';
				})
			: true;
		if (last && !between && r.start >= last[0]) last[1] = Math.max(last[1], r.end);
		else retries.push([r.start, r.end]);
	}
	for (const r of raw)
		if (r.kind === 'untranscribed' && retries.some(([a, b]) => a <= r.start && r.end <= b))
			r.suggested = 'remove';

	raw.sort((x, y) => x.start - y.start || x.end - y.end || x.kind.localeCompare(y.kind));
	const findings: CleanupFinding[] = [];
	const seen = new Map<string, number>();
	for (const r of raw) {
		const [fa, fb] = r.fp ?? [r.start, r.end];
		let fp = findingFingerprint(input.mediaId, stream, r.kind, toSec(fa), toSec(fb), r.text);
		const n = (seen.get(fp) ?? 0) + 1;
		seen.set(fp, n);
		if (n > 1) fp = `${fp}~${n}`;
		findings.push({
			id: `f${findings.length}`,
			kind: r.kind,
			range: { start: r.start, end: r.end },
			words: r.words,
			confidence: Math.round((r.confidence ?? CONFIDENCE[r.kind]) * 1000) / 1000,
			reason: reasonOf(r.kind, r.text, r.end - r.start, r.group, groups, r.kept, r.later, r.restart),
			suggested: r.suggested,
			...(r.group !== undefined ? { group: `g${r.group}` } : {}),
			fingerprint: fp,
		});
	}

	// script report
	let script: ScriptLineReport[] | null = null;
	if (lines.length) {
		const takes = new Array<number>(lines.length).fill(0);
		for (const m of unitLine) if (m) takes[m.line]!++;
		script = lines.map((l) => ({
			index: l.index,
			text: l.text,
			said: takes[l.index]! > 0,
			takes: takes[l.index]!,
		}));
	}
	return { mediaId: input.mediaId, stream, language: lang, words, sound, guarded, findings, groups, script };
}

/** Symbols said as words (Whisper writes "1 %" for "uno por ciento"), as one normalised token per language. */
const SPOKEN_SYMBOLS: Readonly<Record<string, readonly [es: string, en: string]>> = {
	'%': ['porciento', 'percent'],
	'€': ['euros', 'euros'],
	$: ['dolares', 'dollars'],
	'£': ['libras', 'pounds'],
	'&': ['y', 'and'],
	'+': ['mas', 'plus'],
	'@': ['arroba', 'at'],
	'°': ['grados', 'degrees'],
};

/** The token of a word that is a spoken symbol and punctuation ("%", "%..."), else ''. */
function spokenSymbol(text: string, lang: CleanupLanguage | null): string {
	const sym = [...text.trim()].filter((c) => !/[\p{P}\s]/u.test(c) || c in SPOKEN_SYMBOLS);
	if (sym.length !== 1 || !(sym[0]! in SPOKEN_SYMBOLS)) return '';
	return SPOKEN_SYMBOLS[sym[0]!]![lang === 'en' ? 1 : 0];
}

export { SENTENCE_END };

/** Labels of the take rules (restarts, false starts, retakes); they become hidden retakes inside re-decoded ranges. */
const TAKE_LABELS: ReadonlySet<FindingKind> = new Set(['restart', 'false-start', 'retake']);

const sameLabel = (x: WordLabel | null | undefined, l: WordLabel) =>
	!!x && x.kind === l.kind && x.action === l.action && x.group === l.group;

/** Kinds that remove words because the speech after them says them again (a take and its retry). */
const REPEAT_KINDS: ReadonlySet<FindingKind> = new Set([
	'restart',
	'false-start',
	'retake',
	'hidden-retake',
	'stutter',
]);
/**
 * The longest silence (seconds) after a word of a removed take — before another attempt of the same retry, an aside or
 * the retry — unless the take is a clause of its own (round 10, H1). *Assumption*: the corpus' longest such silence
 * after a take that starts inside a sentence or is shorter than a clause is 4.55 s (AE: "…imagen. | el procesador…");
 * whole takes wait longer (fragment B, second run: 12 s between "…en toda su vida. ¿Y por qué va a decir puta?" and the
 * take that stays; run 2: 12.5 s after "el otro 1 %…").
 */
const ADJACENT_MAX_S = 5;

/**
 * The central guard of every removal of a take (restart, false start, retake, hidden retake, stutter — whichever rule
 * labelled it), run after every rule: a label run that fails it becomes a review.
 * - Adjacency: the silence after any of its words is at most `ADJACENT_MAX_S`, unless the run opens a clause and, up to
 *   that word, is broken off mid-sentence (no sentence end there) or a whole take (≥ 3 content words).
 * - Sentences: a run that finishes a sentence the kept words before it began (the word before ends no sentence and is a
 *   function word, or is said into the run without a pause) needs the kept speech right after it (other removals between,
 *   no silence longer than `ADJACENT_MAX_S`) to say the last content word of that sentence again; after a function word
 *   ("…las luces y | las sombras.") that copy must end a sentence too — else the run is the grammatical end of the
 *   sentence, not an attempt.
 * Run 9, AD: "…se renderizan las luces y las sombras." was cut as a false start because "las sombras funcionan…" opened
 * the next sentence 15 s later: the alignment bounds what lies between two takes, not the silence, and accepted an
 * attempt that finishes a sentence when its words are re-said in order.
 */
function guardRepeats(ctx: RuleContext): void {
	const w = ctx.words;
	const L = ctx.labels;
	const n = w.length;
	const T = ctx.settings.thresholds;
	const removed = (k: number) => L[k]?.action === 'remove';
	const repeat = (k: number) => removed(k) && REPEAT_KINDS.has(L[k]!.kind);
	const punct = (k: number) => SENTENCE_END.test(w[k]!.text.trim());
	// a sentence end the speaker made (the recogniser's "…" and an inserted "¡Suscríbete!" are none)
	const ends = (k: number) => punct(k) && !CUT_OFF.test(w[k]!.text.trim()) && !ctx.inserted?.has(k);
	const opens = (k: number) => k === 0 || punct(k - 1) || w[k]!.s - w[k - 1]!.e >= T.phraseGapS;
	const key = (x: string) => !ctx.stop.has(x) && (x.length >= 3 || /\d/.test(x));
	const ok = (a: number, b: number) => {
		for (let k = a, keys = 0; k <= b; k++) {
			if (key(w[k]!.n)) keys++;
			if (k + 1 < n && w[k + 1]!.s - w[k]!.e > ADJACENT_MAX_S && !(opens(a) && (!ends(k) || keys >= 3)))
				return false;
		}
		// the sentence it finishes ends at its first sentence end (an aside after it may end another)
		let e = a;
		while (e < b && !ends(e)) e++;
		if (!ends(e)) return true;
		// the kept word before it (removed vocalic fillers are transparent)
		let p = a - 1;
		while (p >= 0 && removed(p) && L[p]!.kind === 'filler-vocalic') p--;
		if (p < 0 || removed(p) || punct(p)) return true;
		const dangling = ctx.stop.has(w[p]!.n);
		if (!dangling && opens(a)) return true;
		// the kept speech after it, other removals between
		let q = b + 1;
		while (q < n && removed(q)) q++;
		if (q >= n) return false;
		for (let k = b; k < q; k++) if (w[k + 1]!.s - w[k]!.e > ADJACENT_MAX_S) return false;
		const last = [...w.slice(a, e + 1)].reverse().find((x) => key(x.n)) ?? w[e]!;
		const len = b - a + 1;
		for (let k = q, seen = 0; k < n && seen < Math.min(2 * len + 8, len + 24); k++) {
			if (removed(k)) continue;
			seen++;
			if (sameWord(w[k]!.n, last.n)) return !dangling || ends(k);
		}
		return false;
	};
	for (let k = 0; k < n; ) {
		if (!repeat(k)) {
			k++;
			continue;
		}
		let j = k;
		while (j + 1 < n && sameLabel(L[j + 1], L[k]!)) j++;
		if (!ok(k, j)) for (let q = k; q <= j; q++) L[q] = { ...L[q]!, action: 'review' };
		k = j + 1;
	}
}

/**
 * Repeats the script itself makes are no restarts, false starts or stutters ("boing boing boing"): a run of one such
 * label whose words, followed by as many words after it, occur in a row in the script loses its label.
 */
function dropScriptRepeats(ctx: RuleContext): void {
	const script = ctx.scriptTokens;
	const kinds: ReadonlySet<FindingKind> = new Set(['restart', 'false-start', 'stutter']);
	const inScript = (toks: readonly string[]) => {
		for (let s = 0; s + toks.length <= script.length; s++) {
			let q = 0;
			while (q < toks.length && script[s + q] === toks[q]) q++;
			if (q === toks.length) return true;
		}
		return false;
	};
	for (let k = 0; k < ctx.words.length; ) {
		const l = ctx.labels[k];
		if (!l || !kinds.has(l.kind)) {
			k++;
			continue;
		}
		let j = k;
		while (j + 1 < ctx.words.length && sameLabel(ctx.labels[j + 1], l)) j++;
		const toks = ctx.words.slice(k, Math.min(ctx.words.length, j + 1 + (j - k + 1))).map((w) => w.n);
		if (toks.length > j - k + 1 && inScript(toks)) for (let q = k; q <= j; q++) ctx.labels[q] = null;
		k = j + 1;
	}
}

function reasonOf(
	kind: FindingKind,
	text: string,
	flicks: number,
	group: number | undefined,
	groups: readonly RetakeGroup[],
	kept?: string,
	later?: boolean,
	restart?: boolean,
): CleanupFinding['reason'] {
	const params: Record<string, string | number> = { seconds: Math.round(toSec(flicks) * 100) / 100 };
	if (later) params.later = 1;
	if (restart) params.restart = 1;
	if (text) params.text = text.length > 120 ? `${text.slice(0, 117)}…` : text;
	if (kept) params.kept = kept.length > 80 ? `${kept.slice(0, 77)}…` : kept;
	if (group !== undefined) {
		const g = groups[group];
		if (g) {
			params.takes = g.takes.length;
			const kept = g.takes[g.chosen];
			if (kept) params.kept = kept.text.length > 80 ? `${kept.text.slice(0, 77)}…` : kept.text;
			if (kept?.scriptLine !== undefined) params.line = kept.scriptLine + 1;
		}
	}
	return { key: `cleanup.reason.${kind}`, params };
}

/** Voice within this many seconds of a word counts as that word's (timestamps are loose). */
const UNCOVERED_MARGIN_S = 0.15;

/**
 * A word longer than this (seconds) holds other sound: no pause protects its inside (`wordHold`). The stretched-word
 * finding uses the speaker's pace as well (`stretchedWord`, round 12).
 */
const STRETCHED_WORD_S = STRETCH_ABS_S;
/** A stretched word holds its first this many seconds; the voice after that is flagged. *Assumption* (run 5, H and G). */
const WORD_HOLD_S = 0.5;
/**
 * Voice running on after a word's time to the end of its speech run, at most this long (seconds), is the word's tail.
 * *Assumption* from round 7 (W a: 0.34 s of "rarísimo." after its timestamp); a longer run stays untranscribed voice.
 */
const WORD_TAIL_S = 0.4;

type FrameFinding = {
	kind: FindingKind;
	suggested: FindingSuggestion;
	start: number;
	end: number;
	words: null;
	text: string;
	/** Voice for review: the fragment of a restart inside the word `text` (`wordDip`, round 13). */
	restart?: true;
};

/** The analysed regions in frames (the clips' media spans, merged), else the words' span. */
function frameRegions(
	voice: CleanupVoice | null,
	words: readonly AWord[],
	spans: DetectInput['spans'],
	frameCount: number,
): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	if (spans?.length) {
		const rs = spans
			.map((r) => [
				Math.max(0, Math.round(toSec(r.start) / FR)),
				Math.min(frameCount, Math.round(toSec(r.end) / FR)),
			])
			.filter(([a, b]) => b! > a!)
			.sort((x, y) => x[0]! - y[0]!) as Array<[number, number]>;
		for (const r of rs) {
			const l = out[out.length - 1];
			if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]);
			else out.push([r[0], r[1]]);
		}
		return out;
	}
	if (!words.length) return out;
	let hi = 0;
	for (const w of words) hi = Math.max(hi, wordFrames(w)[1]);
	const lo = Math.max(0, wordFrames(words[0]!)[0]);
	hi = voice ? Math.min(voice.frameCount, hi) : hi;
	if (hi > lo) out.push([lo, hi]);
	return out;
}

/**
 * Whether the voice analysis hears no speech under a word of plausible length (a quiet word, or one the classes
 * missed): its time is still a word — no pause covers it and the planner keeps it unless a finding removes it.
 */
export function quietWord(voice: CleanupVoice, w: { s: number; e: number }, maxWordS: number): boolean {
	if (w.e - w.s > maxWordS) return false;
	const [a, b] = wordFrames(w);
	for (let f = Math.max(0, a); f < Math.min(voice.frameCount, b); f++)
		if (voice.classes[f] === VOICE_CLASS_SPEECH) return false;
	return true;
}

/**
 * The frame analysis of the analysed regions (docs/wp-notes/transcript-cleanup.md "Every removal has a finding"):
 * every speech frame belongs to a word (its time, and voice next to it within `UNCOVERED_MARGIN_S`, or a shorter
 * wordless rest than `untranscribedMinS` beside it), to untranscribed voice (a wordless stretch at least
 * `untranscribedMinS` long), or is a blip (a wordless speech run shorter than that, alone between non-speech, farther
 * than `UNCOVERED_MARGIN_S` from every word's time: nearer, it is that word's) that a pause around it holds. Findings:
 * **pause** = a run of non-speech and blips longer than `maxGapS`, anywhere in a region — at its head and tail too —
 * except over a word's time (`wordHold`) or a quiet word; **breath** = a breath-like run within 30 ms of speech;
 * **untranscribed** = the wordless stretches. `sound[k]`: the frames of voice beyond its time word k holds (empty:
 * none).
 */
function frameFindings(
	voice: CleanupVoice,
	words: readonly AWord[],
	settings: CleanupSettings,
	regions: ReadonlyArray<readonly [number, number]>,
	/** The speaker's median seconds per syllable (`secondsPerSyllable`), null when unmeasured. */
	pace: number | null = null,
	/** Look for restarts inside words by their level dip (`RESTART_DIP_DEFAULT`). */
	restartDip = RESTART_DIP_DEFAULT,
): { findings: FrameFinding[]; sound: Array<[number, number]> } {
	const out: FrameFinding[] = [];
	const sound = words.map((): [number, number] => [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
	const F = FLICKS_PER_SECOND * FR;
	const push = (kind: FindingKind, action: RuleAction, a: number, b: number, text = '', restart = false) => {
		if (action === 'off') return;
		out.push({
			kind,
			suggested: action,
			start: Math.round(a * F),
			end: Math.round(b * F),
			words: null,
			text,
			...(restart ? { restart: true as const } : {}),
		});
	};
	const T = settings.thresholds;
	const mg = Math.round(settings.gaps.maxGapS / FR);
	const margin = Math.round(UNCOVERED_MARGIN_S / FR);
	const minU = Math.max(1, Math.round(T.untranscribedMinS / FR - 1e-9));
	const tail = Math.round(WORD_TAIL_S / FR);
	const own = (k: number, f: number) => {
		const s = sound[k]!;
		if (f < s[0]) s[0] = f;
		if (f + 1 > s[1]) s[1] = f + 1;
	};
	for (const [lo, hi] of regions) {
		const n = hi - lo;
		if (n <= 0) continue;
		// owner of each frame: the word whose time holds it (−1: none); quiet words hold no pause
		const owner = new Int32Array(n).fill(-1);
		const quiet = new Uint8Array(n);
		words.forEach((w, k) => {
			const [a, b] = wordFrames(w);
			if (b <= lo || a >= hi) return;
			const q = quietWord(voice, w, T.maxWordS);
			for (let f = Math.max(lo, a); f < Math.min(hi, b); f++) {
				if (owner[f - lo] < 0) owner[f - lo] = k;
				if (q) quiet[f - lo] = 1;
			}
		});
		const isSpeech = (f: number) => voice.classes[f] === VOICE_CLASS_SPEECH;
		// quiet speech is voice too: never a pause, untranscribed voice unless a word holds it (round 12)
		const qs = quietSpeech(voice, lo, hi, minU);
		const isVoice = (f: number) => isSpeech(f) || qs[f - lo] === 1;
		// the frames of every word's time (a join's pause never takes any of them: round 11, B1)
		const timeOf = new Uint8Array(n);
		for (const w of words) {
			const [a, b] = wordFrames(w);
			if (b > lo && a < hi) timeOf.fill(1, Math.max(lo, a) - lo, Math.min(hi, b) - lo);
		}
		// a word's loudest frame over its time (the reference of its fading tail)
		const peaks = new Map<number, number>();
		const peakOf = (k: number) => {
			let p = peaks.get(k);
			if (p === undefined) {
				const [a, b] = wordFrames(words[k]!);
				p = Number.NEGATIVE_INFINITY;
				for (let f = Math.max(0, a); f < Math.min(voice.frameCount, b); f++)
					p = Math.max(p, levelDbAt(voice, f));
				peaks.set(k, p);
			}
			return p;
		};
		// a word's fading tail a join's pause may take: voice after the word's time that the word holds, unvoiced, at
		// least `DECAY_BELOW_PEAK_DB` under the word's loudest frame (round 11, B1)
		const decayFrame = (x: number) => {
			const k = owner[x - lo]!;
			return (
				k >= 0 &&
				timeOf[x - lo] === 0 &&
				!voicedFrame(voice, x) &&
				levelDbAt(voice, x) < peakOf(k) - DECAY_BELOW_PEAK_DB
			);
		};
		// a pause never covers a word's time (round 6: closures and quiet bursts inside "gelatina", "ChatGPT", "Triste."
		// were cut; round 15: on a mixdown a word's quiet edges read as measured silence and pauses took "que", "todo"):
		// the frames of a word's time are the word's, but the inside of a stretched word (it holds other sound)
		const inWord = new Uint8Array(n);
		for (const w of words) {
			const h = wordHold(voice, w);
			if (!h) continue;
			const [a, b] = [Math.max(lo, h[0]), Math.min(hi, h[1])];
			if (b > a) inWord.fill(1, a - lo, b - lo);
		}
		const blip = new Uint8Array(n);
		// untranscribed stretches (frames), and which one holds each frame (−1: none)
		const utr: Array<[number, number]> = [];
		const utrAt = new Int32Array(n).fill(-1);
		const untranscribed = (a: number, b: number) => {
			utrAt.fill(utr.length, a - lo, b - lo);
			utr.push([a, b]);
		};
		for (let f = lo; f < hi; ) {
			if (!isVoice(f)) {
				f++;
				continue;
			}
			let g = f;
			let any = false;
			while (g < hi && isVoice(g)) {
				if (owner[g - lo] >= 0) any = true;
				g++;
			}
			if (!any) {
				// a short run within `margin` of a word's time is that word's voice (a timestamp late or early over its
				// quiet edge: round 15's property, a word's onset 30 ms before its time taken by the pause before it);
				// else a blip a pause holds
				let k = -1;
				if (g - f < minU)
					for (let d = 1; d <= margin && k < 0; d++) {
						const l = f - d >= lo ? owner[f - d - lo]! : -1;
						const r = g - 1 + d < hi ? owner[g - 1 + d - lo]! : -1;
						k = l >= 0 ? l : r;
					}
				if (g - f >= minU) untranscribed(f, g);
				else if (k >= 0)
					for (let x = f; x < g; x++) {
						own(k, x);
						owner[x - lo] = k;
					}
				else blip.fill(1, f - lo, g - lo);
			} else
				for (let p = f; p < g; ) {
					if (owner[p - lo] >= 0) {
						p++;
						continue;
					}
					let q = p;
					while (q < g && owner[q - lo] < 0) q++;
					// a wordless stretch of the run: the words beside it own the voice near them
					const left = p > f ? owner[p - 1 - lo]! : -1;
					const right = q < g ? owner[q - lo]! : -1;
					const giveL = (a: number, b: number) => {
						for (let x = a; x < b; x++) {
							own(left, x);
							owner[x - lo] = left;
						}
					};
					const giveR = (a: number, b: number) => {
						for (let x = a; x < b; x++) {
							own(right, x);
							owner[x - lo] = right;
						}
					};
					if (left >= 0 && right >= 0) {
						if (q - p < 2 * margin + minU) {
							const mid = p + Math.ceil((q - p) / 2);
							giveL(p, mid);
							giveR(mid, q);
						} else {
							giveL(p, p + margin);
							giveR(q - margin, q);
							untranscribed(p + margin, q - margin);
						}
					} else if (left >= 0) {
						// a word's voice that runs on after its time to the end of the speech run is its tail (round 7, W a:
						// "rarísimo." ended 0.34 s before its voice; a removed retake left that tail as a fragment)
						if (q - p < margin + minU || q - p <= tail) giveL(p, q);
						else {
							giveL(p, p + margin);
							untranscribed(p + margin, q);
						}
					} else if (q - p < margin + minU) giveR(p, q);
					else {
						giveR(q - margin, q);
						untranscribed(p, q - margin);
					}
					p = q;
				}
			f = g;
		}
		// pauses: non-speech and blips, never over a quiet word, longer than maxGap — at the head and tail too; a shorter
		// gap is part of the speech around it: its halves belong to the word or untranscribed voice on either side, so
		// findings that remove both neighbours leave nothing between them
		// the word or untranscribed voice at frame x ([−1, −1]: none), and frames given to one
		const side = (x: number): [number, number] =>
			x < lo || x >= hi ? [-1, -1] : [owner[x - lo]!, owner[x - lo]! >= 0 ? -1 : utrAt[x - lo]!];
		// …past a quiet word (no speech under it) to the word whose sound it lies on: a quiet word holds its own time,
		// not the decay running on after it or the onset rising after it (round 11: a zero-length word written on the first
		// frame of a kept word's decay took that decay with its removal)
		const soundSide = (x: number, step: 1 | -1): [number, number] => {
			let y = x;
			while (y >= lo && y < hi && quiet[y - lo] === 1) y += step;
			return y !== x && y >= lo && y < hi && owner[y - lo]! >= 0 && quiet[y - lo] === 0 ? side(y) : side(x);
		};
		const attach = (x: number, [w, u]: [number, number]) => {
			if (owner[x - lo]! >= 0) return;
			if (w >= 0) own(w, x);
			else if (u >= 0) {
				const r = utr[u]!;
				r[0] = Math.min(r[0], x);
				r[1] = Math.max(r[1], x + 1);
			}
		};
		for (let f = lo; f < hi; ) {
			const gapAt = (x: number) =>
				(!isVoice(x) || blip[x - lo] === 1) && quiet[x - lo] === 0 && inWord[x - lo] === 0;
			if (!gapAt(f)) {
				f++;
				continue;
			}
			let g = f;
			while (g < hi && gapAt(g)) g++;
			if (g - f > mg) {
				// only a word's fading tail goes with a pause: voice without words before it stays unless its own finding is
				// accepted (round 7: a pause took 0.227 s of an unaccepted untranscribed finding at −34…−51 dBFS), and so does
				// every frame of a word's time (round 11: pauses took the quiet words "las", "3", "que..." whole)
				let [pa, pb] = pauseEdges(voice, settings, lo, hi, f, g, decayFrame);
				// a phrase-final word — one ending a sentence, or the last before a region's tail — keeps its fading decay to
				// measured silence relative to its own level and some air after it (round 12)
				const k = soundSide(f - 1, -1)[0];
				if (k >= 0 && f > lo && pb > pa && (g === hi || phraseFinal(words[k]!.text)))
					pa = Math.max(pa, phraseTailEnd(voice, peakOf(k), f, pb));
				if (pb > pa) push('pause', settings.rules.pause, pa, pb);
				// the rising onset before the speech after the pause and a tail's fading decay are that speech's sound
				const r = soundSide(g, 1);
				for (let x = Math.max(f, pb); x < g; x++) attach(x, r);
				const l = soundSide(f - 1, -1);
				for (let x = f; x < Math.min(g, pa); x++) attach(x, l);
			} else {
				const l = soundSide(f - 1, -1);
				const r = soundSide(g, 1);
				const hasL = l[0] >= 0 || l[1] >= 0;
				const hasR = r[0] >= 0 || r[1] >= 0;
				const mid = hasL && hasR ? gapSplit(voice, f, g) : hasL ? g : f;
				for (let x = f; x < g; x++) attach(x, x < mid ? l : r);
			}
			f = g;
		}
		for (const [a, b] of utr) push('untranscribed', settings.rules.untranscribed, a, b);
		// a word stretched over continuous voice (longer than 1 s, or three times what its syllables take at the speaker's
		// pace — `stretchedWord`, round 12: a restart written as one word under 1 s; at least half its frames
		// speech) holds more than a word: its speech after the first `WORD_HOLD_S` may be a take the transcript holds once,
		// which the re-decode did not fix (run 5, fragment H: "rápida" over 2.2 s of speech at −10 to −24 dBFS) —
		// untranscribed voice for review, its text the word
		for (const w of words) {
			if (!stretchedWord(w.text, w.e - w.s, pace)) continue;
			const [a, b] = wordFrames(w);
			const [x, y] = [Math.max(lo, a), Math.min(hi, b)];
			let n = 0;
			for (let f = x; f < y; f++) if (isSpeech(f)) n++;
			if (y <= x || n * 2 < b - a) continue;
			let first = -1;
			let last = -1;
			for (let f = Math.max(x, Math.round((w.s + WORD_HOLD_S) / FR)); f < y; f++)
				if (isSpeech(f)) {
					if (first < 0) first = f;
					last = f;
				}
			if (first >= 0 && last + 1 - first >= minU)
				push('untranscribed', settings.rules.untranscribed, first, last + 1, w.text.trim());
		}
		// a restart inside one word — the fragment broken off at full voice, a dip, then time for the whole word at the
		// speaker's pace (`wordDip`, round 13: "extra… ¡extremadamente!" written as one word as long as the speaker's
		// clean one, which the re-decode did not split): the fragment and the dip are voice for review, its text the word
		// — off by default since round 15 (`RESTART_DIP_DEFAULT`: on real audio it tripped on closures only)
		for (const w of restartDip ? words : []) {
			const [a, b] = wordFrames(w);
			if (b <= lo || a >= hi) continue;
			const d = wordDip((f) => levelDbAt(voice, f), a, b, w.text, pace);
			if (d && Math.min(hi, d.end) > Math.max(lo, a))
				push(
					'untranscribed',
					settings.rules.untranscribed,
					Math.max(lo, a),
					Math.min(hi, d.end),
					w.text.trim(),
					true,
				);
		}
		// breath-like runs touching speech on either side (within 30 ms)
		for (let f = lo; f < hi; ) {
			if (isSpeech(f)) {
				f++;
				continue;
			}
			let g = f;
			while (g < hi && !isSpeech(g)) g++;
			for (let k = f; k < g; ) {
				if (voice.classes[k] !== VOICE_CLASS_BREATH) {
					k++;
					continue;
				}
				let m = k;
				while (m < g && voice.classes[m] === VOICE_CLASS_BREATH) m++;
				const near =
					(k - f <= 3 && f > lo && clsAt(voice, f - 1) === VOICE_CLASS_SPEECH) ||
					(g - m <= 3 && g < hi && clsAt(voice, g) === VOICE_CLASS_SPEECH);
				// a kept word's time is the word's (round 6: breaths inside "Physics", "jugando", "chiquita" took their
				// fricative onsets), and the unvoiced noise right before a word that opens with a fricative or affricate
				// is its onset: what is left must still be a breath (≥ the class's 120 ms)
				let a = k;
				let b = m;
				for (const w of words) {
					const [wa, wb] = wordFrames(w);
					if (wb <= a || wa >= b) {
						if (wa >= b && wa - b <= 1 && FRICATIVE_ONSET.test(w.n)) b = a;
						continue;
					}
					if (wa <= a) a = Math.max(a, wb);
					else b = Math.min(b, wa);
				}
				if (near && b - a >= BREATH_MIN_FRAMES) push('breath', settings.rules.breath, a, b);
				k = m;
			}
			f = g;
		}
	}
	return { findings: out, sound };
}

/** Quiet speech peaks within this many dB of the file's speech level (round 12: "es un keke." ≈ 20 dB under it). */
const QUIET_SPEECH_DB = 25;
/** Between two syllables the level dips at least this far under both vowels. */
const SYLLABLE_DIP_DB = 6;

/**
 * Speech the classes call non-speech because it is quiet (round 12: the phrase "es un keke.", spoken ≈ 20 dB under the
 * speech level, was cut as a pause): over `[lo, hi)`, a run of frames that are not speech and above measured silence
 * (measured silence of at most `VOICED_BREAK_FRAMES` inside), at least `minFrames` long, peaking within
 * `QUIET_SPEECH_DB` of the file's speech level, holding two vowels (`VOWEL_MIN_FRAMES` voiced frames in a row) with a
 * dip of `SYLLABLE_DIP_DB` under both between them — rising and falling like syllables, unlike a hum, a breath or a
 * decay. 1 per frame of such runs. Nothing without the voicing plane or levels. *Assumption*, labelled: one reported
 * phrase; the thresholds are the reporter's description (voiced, rising / falling, 15–25 dB under the speech level).
 */
function quietSpeech(voice: CleanupVoice, lo: number, hi: number, minFrames: number): Uint8Array {
	const out = new Uint8Array(Math.max(0, hi - lo));
	const speech = voice.levels.speechDb;
	if (!voice.voicing || speech === null || voice.levels.floorDb === null) return out;
	const cand = (k: number) => voice.classes[k] !== VOICE_CLASS_SPEECH && !silentFrame(voice, k);
	for (let f = lo; f < hi; ) {
		if (!cand(f)) {
			f++;
			continue;
		}
		// the run, with short silences inside, ending at its last candidate frame
		let g = f + 1;
		let end = g;
		for (let gap = 0; g < hi && voice.classes[g] !== VOICE_CLASS_SPEECH && gap <= VOICED_BREAK_FRAMES; g++) {
			if (cand(g)) {
				gap = 0;
				end = g + 1;
			} else gap++;
		}
		if (end - f >= minFrames) {
			let peak = Number.NEGATIVE_INFINITY;
			for (let k = f; k < end; k++) peak = Math.max(peak, levelDbAt(voice, k));
			// the vowels: their loudest frame, and the quietest frame since the vowel before
			const vowels: Array<{ peak: number; dip: number }> = [];
			let run = 0;
			let dip = Number.POSITIVE_INFINITY;
			let cur: { peak: number; dip: number } | null = null;
			for (let k = f; k < end; k++) {
				const db = levelDbAt(voice, k);
				if (voicedFrame(voice, k)) {
					run++;
					if (run === VOWEL_MIN_FRAMES) {
						cur = { peak: Number.NEGATIVE_INFINITY, dip };
						for (let x = k - run + 1; x <= k; x++) cur.peak = Math.max(cur.peak, levelDbAt(voice, x));
						vowels.push(cur);
					} else if (cur && run > VOWEL_MIN_FRAMES) cur.peak = Math.max(cur.peak, db);
				} else {
					if (run >= VOWEL_MIN_FRAMES) dip = Number.POSITIVE_INFINITY;
					run = 0;
					cur = null;
					dip = Math.min(dip, db);
				}
			}
			const syllables = vowels.some(
				(v, i) => i > 0 && v.dip <= Math.min(v.peak, vowels[i - 1]!.peak) - SYLLABLE_DIP_DB,
			);
			if (syllables && peak >= speech - QUIET_SPEECH_DB) out.fill(1, f - lo, end - lo);
		}
		f = Math.max(end, f + 1);
	}
	return out;
}

/**
 * Where a short gap `[f, g)` between two sounds splits: the fading decay before measured silence is the sound before it,
 * the rising onset after it the sound after it, and the silence between them is halved; with no silent frame, at the
 * quietest frame (the first of equals). The midpoint alone gave the second half of a short gap — a kept word's decay
 * above silence — to a removed word after it, so its removal clipped that tail (round 11: the sequence property's
 * "tail frame removed", ≈ 1 in 2,000 runs).
 */
function gapSplit(voice: CleanupVoice, f: number, g: number): number {
	let s0 = -1;
	let s1 = -1;
	for (let x = f; x < g; x++)
		if (silentFrame(voice, x)) {
			if (s0 < 0) s0 = x;
			s1 = x + 1;
		}
	if (s0 >= 0) return s0 + Math.ceil((s1 - s0) / 2);
	let best = f;
	for (let x = f + 1; x < g; x++) if (levelDbAt(voice, x) < levelDbAt(voice, best)) best = x;
	return best;
}

/**
 * The frames `[a, b)` a word's time holds against pauses: all of it, measured silence included; null for a stretched
 * word (longer than `STRETCHED_WORD_S`: it holds other sound) or an empty span. Until round 15 measured silence at its
 * edges was left to pauses (loose timestamps), but on a loudness-normalised mixdown the floor lies within 6 dB of a
 * real word's quiet frames, so that "silence" was the word: accepted pauses removed "que", "todo", "con" and
 * "crecían" of `cut_v5.wav` (docs/wp-notes/transcript-cleanup.md "Round 15").
 */
export function wordHold(voice: CleanupVoice, w: { s: number; e: number }): [number, number] | null {
	if (w.e - w.s > STRETCHED_WORD_S) return null;
	const [a, b] = wordFrames(w);
	const x = Math.max(0, a);
	const y = Math.min(voice.frameCount, b);
	return y > x ? [x, y] : null;
}

/** How far back (seconds) from a removed word's start the quietest point before it is looked for. */
const VALLEY_BACK_S = 0.08;

/**
 * Where a removal starting at word `w` begins when `w` follows `prev` in continuous voice (every frame from the end of
 * `prev`'s time to `w`'s start is speech): the quietest 10 ms frame (the latest of equals) from `VALLEY_BACK_S` before
 * `w` — but after the first 60 % of `prev` — up to the frame holding `w`'s start. Null with a non-speech frame between
 * them (the silence and pause rules place that edge).
 */
export function startValley(
	voice: CleanupVoice,
	prev: { s: number; e: number },
	w: { s: number },
): number | null {
	const end = Math.min(voice.frameCount - 1, Math.floor(w.s / FR + 1e-9));
	const [pa, pb] = wordFrames(prev);
	const from = Math.max(0, pa + Math.ceil(0.6 * (pb - pa)), Math.floor((w.s - VALLEY_BACK_S) / FR + 1e-9));
	if (from > end) return null;
	for (let k = Math.min(from, pb - 1); k <= end; k++)
		if (voice.classes[k] !== VOICE_CLASS_SPEECH) return null;
	let best = from;
	let bestDb = Number.POSITIVE_INFINITY;
	for (let k = from; k <= end; k++) {
		const db = levelDbAt(voice, k);
		if (db <= bestDb) {
			best = k;
			bestDb = db;
		}
	}
	return best;
}

/** A kept piece shorter than this (seconds) between two cuts is a sliver. */
const SLIVER_S = 0.15;

/**
 * Whether the voice over `[s, e)` (seconds) has no frame of frication — unvoiced noise (voicing < 0.45, flatness ≥ 0.2)
 * at least 10 dB over the floor — while speech: hummed or sung syllables, where a stock outro phrase is a
 * hallucination. False without the voicing / flatness planes or levels. *Assumption*, labelled: thresholds from the
 * voice analysis' own speech / breath classes; uncalibrated against the round-6 humming (only zero-crossing rates
 * were measured there: 500–800 /s against 3,600–9,700 /s on a real "s").
 */
function noFrication(voice: CleanupVoice, s: number, e: number): boolean {
	const { voicing, flatness } = voice;
	const floor = voice.levels.floorDb;
	if (!voicing || !flatness || floor === null) return false;
	const [a, b] = wordFrames({ s, e });
	let speech = 0;
	for (let f = Math.max(0, a); f < Math.min(voice.frameCount, b); f++) {
		if (voice.classes[f] === VOICE_CLASS_SPEECH) speech++;
		if (voicing[f]! < 115 && flatness[f]! >= 51 && levelDbAt(voice, f) >= floor + 10) return false;
	}
	return speech * FR >= 0.3;
}

/** A hummed phrase stays at least this far (dB) under the file's speech level. */
const HUM_BELOW_SPEECH_DB = 6;

/**
 * Whether the loudest frame over `[s, e)` (seconds) stays `HUM_BELOW_SPEECH_DB` under the file's speech level (95th
 * percentile) — the non-speech evidence a stock phrase over voice without frication needs (round 10, H5). False without
 * levels. *Assumption*, labelled: from two measurements of one speaker — round 6's humming peaked at −17 dBFS, run 9's
 * real "gracias" at −6…−10 dBFS among words of the same level.
 */
function belowSpeech(voice: CleanupVoice, s: number, e: number): boolean {
	const speech = voice.levels.speechDb;
	if (speech === null) return false;
	const [a, b] = wordFrames({ s, e });
	for (let f = Math.max(0, a); f < Math.min(voice.frameCount, b); f++)
		if (levelDbAt(voice, f) > speech - HUM_BELOW_SPEECH_DB) return false;
	return true;
}

/** Words between two words in another writing system with at most this many words between them are garbage too. */
const GARBLED_GAP_MAX = 2;
/** A stock phrase woven into other speech: its words in order within this many words and seconds of its first. */
const WOVEN_MAX_WORDS = 10;
const WOVEN_MAX_S = 4;

/** A vowel: at least this many voiced frames in a row (30 ms). */
const VOWEL_MIN_FRAMES = 3;
/**
 * A word whose loudest frame comes within this many dB of the file's speech level (95th percentile) is said to the
 * microphone: never noise the recogniser wrote words over, whatever its voicing frames say (round 11, B2), and a
 * filler phrase quieter than that is an off-mic exchange (B5). *Assumption*, labelled: run 11's real words flagged as
 * noise peaked 1.5–11 dB under the speech level ("negra", "megas.", "si", "que"); the noise words of rounds 7–9 stayed
 * 15 dB or more under it.
 */
const LOUD_WORD_DB = 12;

/**
 * A word with at least this many in-order script neighbours (`ScriptAligner`, of up to 6) is said in sequence with the
 * script: never a hallucination, never head / tail chatter. *Assumption*, labelled: 3 = half the window, so a script
 * word alone in other talk ("que", "de") does not count.
 */
const ALIGNED_SUPPORT = 3;
/** Words with this support count towards the head / tail cap (`HEAD_TAIL_MAX_SCRIPT_WORDS`). */
const LOOSE_SUPPORT = 2;
/**
 * A head or tail longer than this share of the transcript's span, or holding this many words with `LOOSE_SUPPORT`,
 * is only reviewed: pre-roll and outro chatter are short and off script. *Assumption*, labelled: the TC-071 shorts had
 * ≈ 10 s of pre-roll over 13 recordings; a quarter of a clip is no longer chatter around a script.
 */
const HEAD_TAIL_MAX_SHARE = 0.25;
const HEAD_TAIL_MAX_SCRIPT_WORDS = 5;
/**
 * A word the recogniser is at least this sure of is not invented over non-speech. *Measured* on the loudness-normalised
 * mixdown `cut_v5.wav` (large-v3-turbo, voice analysis v2): the 37 real script words flagged as hallucinations had
 * 0.876–1.0 (36 of them ≥ 0.976), the four without a script counterpart 0.18, 0.29, 0.77 and 0.99 ("the", over
 * audible voice); on its raw source the clear inventions ("кстати.", a stretched "Y", "Ok,", "No,") had 0–0.61. The
 * noise words of runs 6–9 were ASR suspects (confidence under 0.4 or a poor segment score).
 */
const CONFIDENT_WORD = 0.8;
/**
 * A word whose loudest frame comes within this many dB of the speech level around it (the lower of the file's and
 * the neighbouring words' — `nearSpeechLevel`) is audible speech, not a word invented over non-speech. *Measured* on
 * `cut_v5.wav`: the flagged script words peaked at −9.0…−27.7 dBFS, at most 17.2 dB under the file's speech level
 * (−10.5 dBFS). The noise rule (`unvoicedSound`) keeps its own vowel evidence and `LOUD_WORD_DB`: the noise words of
 * runs 7–9 peaked at −27…−41 dBFS, ≈ 17–33 dB under that speaker's speech level (−5.5…−9.5 dBFS in run 11; run 7's
 * was not recorded), so 20 dB would spare some of them.
 */
const NEAR_SPEECH_DB = 20;
/** Neighbouring words (each side, within `LOCAL_S`) whose loudest frames give the local speech level. */
const LOCAL_WORDS = 4;
const LOCAL_S = 10;

/**
 * Whether word k comes within `NEAR_SPEECH_DB` of the speech level around it: the lower of the file's speech level and
 * the median loudest frame of up to `LOCAL_WORDS` words each side within `LOCAL_S` that are not themselves over
 * non-speech (`lowShare`) — a mixdown compresses everything, and a quiet passage has its own level. False without
 * the file's speech level.
 */
function nearSpeechLevel(
	voice: CleanupVoice,
	words: readonly AWord[],
	lowShare: readonly boolean[],
): (k: number) => boolean {
	const file = voice.levels.speechDb;
	if (file === null) return () => false;
	return (k) => {
		const w = words[k]!;
		const peaks: number[] = [];
		for (const dir of [-1, 1]) {
			let n = 0;
			for (let q = k + dir; q >= 0 && q < words.length && n < LOCAL_WORDS; q += dir) {
				const o = words[q]!;
				if (dir < 0 ? w.s - o.e > LOCAL_S : o.s - w.e > LOCAL_S) break;
				if (lowShare[q]) continue;
				peaks.push(wordPeakDb(voice, o));
				n++;
			}
		}
		peaks.sort((a, b) => a - b);
		const local = peaks.length ? peaks[Math.floor((peaks.length - 1) / 2)]! : file;
		return wordPeakDb(voice, w) >= Math.min(file, local) - NEAR_SPEECH_DB;
	};
}

/**
 * Whether a word lies over measured silence — at least half of its frames silent (`silentFrame`) — or outside the
 * analysed audio: the recogniser wrote it over nothing.
 */
function overSilence(voice: CleanupVoice, w: { s: number; e: number }): boolean {
	const [a, b] = wordFrames(w);
	const lo = Math.max(0, a);
	const hi = Math.min(voice.frameCount, b);
	if (hi <= lo) return true;
	let quiet = 0;
	for (let f = lo; f < hi; f++) if (silentFrame(voice, f)) quiet++;
	return quiet * 2 >= hi - lo;
}

/** Whether a word's loudest frame comes within `LOUD_WORD_DB` of the file's speech level; false without levels. */
function loudWord(voice: CleanupVoice, w: { s: number; e: number }): boolean {
	const speech = voice.levels.speechDb;
	if (speech === null) return false;
	const [a, b] = wordFrames(w);
	for (let f = Math.max(0, a); f < Math.min(voice.frameCount, b); f++)
		if (levelDbAt(voice, f) >= speech - LOUD_WORD_DB) return true;
	return false;
}

/**
 * Whether a word lies over noise — strong non-speech evidence only (round 11, B2): the voice analysis calls most of its
 * frames something else than speech, it stays `LOUD_WORD_DB` under the file's speech level, there is no vowel —
 * `VOWEL_MIN_FRAMES` voiced frames (`voicedFrame`) in a row — in its time and 30 ms around it, and at least half of it
 * lies above measured silence (a Spanish or English word holds a vowel). False without the voicing plane or levels.
 * Round 7: Whisper wrote "¿Qué pasa?" over unvoiced noise at −27…−49 dBFS, zero-crossing rate 1,500–10,000 /s; run 9:
 * stray voiced frames in noise (AA b "¿Qué": three, two in a row, −41…−44 dBFS, not speech) are no vowel. Run 11: the
 * vowel rule alone flagged loud real words ("negra" at −11 dBFS) and AG a's "No." / "Espera." (speech-classed, voiced
 * frames never three in a row).
 */
function unvoicedSound(voice: CleanupVoice, w: { s: number; e: number }): boolean {
	if (!voice.voicing || voice.levels.speechDb === null) return false;
	const [a, b] = wordFrames(w);
	if (b <= a || speechShare(voice, w.s, w.e) >= 0.5 || loudWord(voice, w)) return false;
	let loud = 0;
	let run = 0;
	for (let f = Math.max(0, a - 3); f < Math.min(voice.frameCount, b + 3); f++) {
		run = voicedFrame(voice, f) ? run + 1 : 0;
		if (run >= VOWEL_MIN_FRAMES) return false;
		if (f >= a && f < b && !silentFrame(voice, f)) loud++;
	}
	return loud * 2 >= b - a;
}

/** Shortest breath-like run (frames): the voice analysis' class minimum (120 ms). */
const BREATH_MIN_FRAMES = 12;
/** A word that opens with a fricative or affricate (its unvoiced noise before the voiced part is the word). */
const FRICATIVE_ONSET = /^(f|s|z|j|x|ch|sh|th|ph|c[ei]|g[ei]|h)/;

/**
 * Sound rising into an onset belongs to the word when it stays within this many dB of the word's first 100 ms and rises
 * by steps of at most `RAMP_STEP_DB` (going back, a frame louder than the next by more ends the ramp). *Assumption*,
 * labelled: run 9 U b's soft "a" sat 10–17 dB under the speech after it.
 */
const ONSET_RAMP_DB = 20;
const RAMP_STEP_DB = 3;

/** How far (seconds) a pause's edges move over sound to the decay threshold or to silence. */
const PAUSE_EDGE_MAX_S = 0.25;
/**
 * A join's pause takes a word's fading tail only this far (dB) or more under the word's own loudest frame — never by an
 * absolute level alone (round 11, B1: with the floor + 20 dB out threshold a pause took whole quiet off-mic words at
 * −28…−35 dBFS (floor −48 dB), and on a −42 dB floor it trimmed audible tails at −22…−27 dBFS). *Assumption*, labelled:
 * the conservative end of the 25–30 dB the round-11 report proposes; not calibrated against the user's cuts.
 */
const DECAY_BELOW_PEAK_DB = 30;

/** Air (seconds) kept after a phrase-final word's decay where measured silence follows (round 12; 60–100 ms asked). */
const TAIL_PAD_S = 0.08;

/** Whether a word ends a sentence (". ? !"), not written broken off ("…", "..."). */
export function phraseFinal(text: string): boolean {
	const t = text.trim();
	return /[.?!]["'»”’)]*$/u.test(t) && !/(\.\.\.|…)["'»”’)]*[?!]?$/u.test(t);
}

/** The loudest frame (dB) over a word's time. */
export function wordPeakDb(voice: CleanupVoice, w: { s: number; e: number }): number {
	const [a, b] = wordFrames(w);
	let p = Number.NEGATIVE_INFINITY;
	for (let f = Math.max(0, a); f < Math.min(voice.frameCount, b); f++) p = Math.max(p, levelDbAt(voice, f));
	return p;
}

/**
 * The frame (exclusive) where the kept end of a phrase-final word lies (round 12: joins cut 30–180 ms of the soft ends
 * of "azul.", "verdad.", "lo arreglen."). From frame `from` it keeps the word's fading decay — frames that are not both
 * measured silence and `DECAY_BELOW_PEAK_DB` under the word's loudest frame `peak` (a quiet word's tail near the floor
 * still sounds), within `PAUSE_EDGE_MAX_S` — then `TAIL_PAD_S` of the measured silence after it (at most half of it,
 * so a cut stays), never at or past frame `limit` (the next onset, kept piece or removed word).
 */
export function phraseTailEnd(voice: CleanupVoice, peak: number, from: number, limit: number): number {
	const end = Math.min(limit, voice.frameCount);
	const max = Math.round(PAUSE_EDGE_MAX_S / FR);
	const quiet = (k: number) => silentFrame(voice, k) && levelDbAt(voice, k) < peak - DECAY_BELOW_PEAK_DB;
	let x = Math.max(0, from);
	while (x < end && x - from < max && !quiet(x)) x++;
	const pad = Math.round(TAIL_PAD_S / FR);
	let run = 0;
	while (x + run < end && run < 2 * pad && silentFrame(voice, x + run)) run++;
	return x + Math.min(pad, Math.floor(run / 2));
}

/**
 * The first frame after a phrase-final word's time that its kept end starts from: past the last frame of its time that
 * is not both measured silence and `DECAY_BELOW_PEAK_DB` under its loudest frame (`phraseTailEnd`).
 */
export function phraseTailFrom(voice: CleanupVoice, w: { s: number; e: number }, peak: number): number {
	const [a, b] = wordFrames(w);
	let k = Math.min(b, voice.frameCount);
	while (k > a && silentFrame(voice, k - 1) && levelDbAt(voice, k - 1) < peak - DECAY_BELOW_PEAK_DB) k--;
	return k;
}

/**
 * What a pause removes of the gap `[f, g)` (frames) between `lo` and `hi`: before speech that follows, it ends at the
 * last measured silence (`silentFrame`) before the onset, so no cut clips a rising onset; after speech it starts
 * where the decay falls below the level edges' out threshold when speech follows (the Fast style's out point inside
 * the decay), and at measured silence at a tail, so a last word keeps its fading tail. Each edge moves at most
 * `PAUSE_EDGE_MAX_S`; with no silence that close an onset edge stays at the gap's end (a tail with none: no pause).
 * The decay a join's pause takes is a word's fading tail (`decayFrame`: after its time, unvoiced, far under the word's
 * own level), never voice without words and never a frame of a word's time.
 */
function pauseEdges(
	voice: CleanupVoice,
	settings: CleanupSettings,
	lo: number,
	hi: number,
	f: number,
	g: number,
	decayFrame: (k: number) => boolean,
): [number, number] {
	if (voice.levels.floorDb === null) return [f, g];
	const max = Math.round(PAUSE_EDGE_MAX_S / FR);
	let a = f;
	let b = g;
	if (g < hi) {
		// the onset: back to the frame after the last silent one
		let k = g - 1;
		while (k > f && g - k <= max && !silentFrame(voice, k)) k--;
		if (silentFrame(voice, k)) b = k + 1;
		// voiced sound under the speech threshold leading into the onset is the onset's (round 7, U b: the soft "a" of
		// a missed "a ver" at −40…−31 dBFS after 0.25 s of other sound): the pause ends before it, at the last silent
		// frame within `max` before it, else at its first voiced frame
		let first = g;
		for (let x = g - 1, gap = 0; x >= f && !silentFrame(voice, x) && gap <= VOICED_BREAK_FRAMES; x--) {
			if (voicedFrame(voice, x)) {
				first = x;
				gap = 0;
			} else gap++;
		}
		// …and so is sound rising into the onset within `ONSET_RAMP_DB` of the word's level, voiced or not (run 9, U b:
		// the same "a" measured voicing 0.13–0.41): going back from the onset, each frame at most `RAMP_STEP_DB` over the
		// next one and above measured silence
		if (hi > g) {
			let peak = Number.NEGATIVE_INFINITY;
			for (let x = g; x < Math.min(hi, voice.frameCount, g + 10); x++)
				peak = Math.max(peak, levelDbAt(voice, x));
			let x = g - 1;
			while (
				x >= f &&
				g - x <= max &&
				!silentFrame(voice, x) &&
				levelDbAt(voice, x) >= peak - ONSET_RAMP_DB &&
				levelDbAt(voice, x) <= levelDbAt(voice, x + 1) + RAMP_STEP_DB
			)
				x--;
			first = Math.min(first, x + 1);
		}
		if (first < b) {
			let q = first - 1;
			while (q > f && first - q <= max && !silentFrame(voice, q)) q--;
			b = silentFrame(voice, q) ? q + 1 : first;
		}
	}
	if (f > lo) {
		if (g < hi) {
			// a join: a word's fading tail below the out threshold goes with the pause (level edges only)
			const thr = settings.edges.mode === 'level' ? edgeThreshold(voice, settings.edges, 'out') : null;
			if (thr !== null)
				while (
					a > lo &&
					f - a < max &&
					voice.classes[a - 1] === VOICE_CLASS_SPEECH &&
					decayFrame(a - 1) &&
					levelDbAt(voice, a - 1) < thr
				)
					a--;
		} else {
			// a tail: from the first silent frame on
			while (a < b && a - f < max && !silentFrame(voice, a)) a++;
			if (!silentFrame(voice, a)) return [g, g];
		}
	}
	return [a, b];
}

/**
 * Pauses by word timings (media without a voice analysis): the time between words longer than `maxGapS` in each
 * region (seconds), its head and tail included, as the planner's word mode cuts it.
 */
function wordGapPauses(
	words: readonly AWord[],
	settings: CleanupSettings,
	regions: ReadonlyArray<readonly [number, number]>,
): FrameFinding[] {
	const out: FrameFinding[] = [];
	const action = settings.rules.pause;
	if (action === 'off') return out;
	const mg = settings.gaps.maxGapS;
	for (const [lo, hi] of regions) {
		let t = lo;
		const gap = (a: number, b: number) => {
			if (b - a > mg + 1e-6)
				out.push({
					kind: 'pause',
					suggested: action,
					start: Math.round(a * FLICKS_PER_SECOND),
					end: Math.round(b * FLICKS_PER_SECOND),
					words: null,
					text: '',
				});
		};
		for (const w of words) {
			if (w.e <= lo || w.s >= hi) continue;
			if (w.s > t) gap(t, w.s);
			t = Math.max(t, w.e);
		}
		if (hi > t) gap(t, hi);
	}
	return out;
}

/** The level an edge rule compares with: floor + dB, or speech level − dB. Null without levels. */
export function edgeThreshold(voice: CleanupVoice, edges: CleanupEdges, which: 'in' | 'out'): number | null {
	const db = which === 'in' ? edges.inDb : edges.outDb;
	if (edges.reference === 'speech') {
		const s = voice.levels.speechDb;
		return s === null ? null : s - db;
	}
	const f = voice.levels.floorDb;
	return f === null ? null : f + db;
}

/** Unvoiced frames a run of voiced sound may hold (30 ms: a consonant). */
const VOICED_BREAK_FRAMES = 3;

/**
 * Whether frame k is voiced sound above measured silence (voicing ≥ 0.5 — the breath class's ceiling — and at least
 * `SILENCE_DB` over the floor). False without the voicing plane.
 */
export function voicedFrame(voice: CleanupVoice, k: number): boolean {
	const floor = voice.levels.floorDb;
	if (!voice.voicing || floor === null || k < 0 || k >= voice.frameCount) return false;
	return voice.voicing[k]! >= 128 && levelDbAt(voice, k) >= floor + SILENCE_DB;
}

/** A voice frame at most this far (dB) above the noise floor is silence (the speech threshold's minimum margin). */
export const SILENCE_DB = 6;

/** Whether 10 ms voice frame k is silence: not speech, and within `SILENCE_DB` of the noise floor. */
export function silentFrame(voice: CleanupVoice, k: number): boolean {
	const floor = voice.levels.floorDb;
	if (floor === null || k < 0 || k >= voice.frameCount) return false;
	return voice.classes[k] !== VOICE_CLASS_SPEECH && levelDbAt(voice, k) < floor + SILENCE_DB;
}

/** dB of the level of frame k (−120 beyond the analysis). */
export function levelDbAt(v: CleanupVoice, k: number): number {
	return k >= 0 && k < v.frameCount ? voiceLevelDb(v.level[k]!) : -120;
}
