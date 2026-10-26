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
import {
	builtinLists,
	type CleanupLanguage,
	type CleanupLanguageLists,
	cleanupLanguageOf,
	cleanupNorm,
	phraseTokens,
	restartStopWords,
} from './lists.ts';
import {
	type AWord,
	claimWord,
	phrases,
	type RuleContext,
	ruleAsrSuspects,
	ruleFillers,
	ruleLexicalReview,
	ruleMarkerPhrases,
	ruleOffScript,
	ruleRestarts,
	ruleStutters,
	ruleTakes,
	type WordLabel,
} from './rules.ts';
import type {
	CleanupFinding,
	CleanupLists,
	CleanupSettings,
	FindingKind,
	FindingSuggestion,
	RetakeGroup,
	RetakeTake,
	RuleAction,
} from './schema.ts';
import { ScriptIndex, scriptLines, scriptTokens } from './script.ts';
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
export type CleanupVoice = Pick<VoiceAnalysis, 'classes' | 'level' | 'frameCount' | 'levels'>;

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
};

export type ScriptLineReport = { index: number; text: string; said: boolean; takes: number };

export type DetectResult = {
	mediaId: string;
	stream: number;
	language: CleanupLanguage | null;
	/** Candidate words (seconds, media time). `guarded[k]`: dropped by the hallucination guard before the rules. */
	words: AWord[];
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
	stutter: 0.8,
	'off-script': 0.85,
	'head-tail': 0.8,
	untranscribed: 0.5,
	'asr-suspect': 0.4,
	hallucination: 0.9,
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
 * The hallucination guard (`common.py clean_words`, TC-003): runs of ≥ `run` identical tokens, and — with a voice
 * analysis — words whose frames are less than `share` speech or breath-like (an empty frame span counts as none).
 */
export function hallucinationGuard(
	words: readonly AWord[],
	voice: CleanupVoice | null | undefined,
	run: number,
	share: number,
): boolean[] {
	const out = new Array<boolean>(words.length).fill(false);
	const n = words.length;
	let i = 0;
	while (i < n) {
		let j = i;
		while (j + 1 < n && words[j + 1]!.n === words[i]!.n) j++;
		if (j - i + 1 >= run) {
			for (let k = i; k <= j; k++) out[k] = true;
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
				if (hi <= lo || on / (hi - lo) < share) out[k] = true;
			}
		}
		i = j + 1;
	}
	return out;
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

class UnionFind {
	private readonly p: number[];
	constructor(n: number) {
		this.p = Array.from({ length: n }, (_, i) => i);
	}
	find(x: number): number {
		let r = x;
		while (this.p[r] !== r) r = this.p[r]!;
		while (this.p[x] !== r) {
			const nx = this.p[x]!;
			this.p[x] = r;
			x = nx;
		}
		return r;
	}
	union(a: number, b: number): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb) this.p[Math.max(ra, rb)] = Math.min(ra, rb);
	}
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
		const n = cleanupNorm(w.text);
		if (!n) continue;
		const conf = typeof w.confidence === 'number' && Number.isFinite(w.confidence) ? w.confidence : null;
		words.push({ i, n, s, e, text: w.text, conf });
	}
	words.sort((a, b) => a.s - b.s || a.i - b.i);

	// hallucination guard: runs, words over non-speech, known phrases over non-speech
	const guarded =
		settings.rules.hallucination === 'off'
			? new Array<boolean>(words.length).fill(false)
			: hallucinationGuard(words, voice, T.hallucinationRun, T.hallucinationSpeechShare);
	if (settings.rules.hallucination !== 'off' && voice) {
		const phrasesH = lists.hallucinations.map((h) => h.split(' ')).sort((a, b) => b.length - a.length);
		for (let k = 0; k < words.length; k++) {
			for (const p of phrasesH) {
				if (k + p.length > words.length || !p.every((x, q) => words[k + q]!.n === x)) continue;
				const s = words[k]!.s;
				const e = words[k + p.length - 1]!.e;
				if (speechShare(voice, s, e) < 0.5) for (let q = 0; q < p.length; q++) guarded[k + q] = true;
				break;
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
	const sTokens = input.script ? scriptTokens(input.script) : [];
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
	ruleRestarts(ctx);
	const { units, hits } = ruleTakes(ctx);

	// take groups and the script
	const lines = input.script ? scriptLines(input.script, stop) : [];
	const index = lines.length ? new ScriptIndex(lines) : null;
	const unitContent = units.map((u) => u.map((k) => aw[k]!.n).filter((t) => !fillers.has(t)));
	const unitCw = unitContent.map((c) => c.filter((t) => !stop.has(t) && t.length >= 3));
	const unitLine = units.map((_, u) => (index ? index.match(unitCw[u]!, T.scriptLineSimilarity) : null));
	const uf = new UnionFind(units.length);
	for (const h of hits) uf.union(h.from, h.to);
	const members = new Map<number, number[]>();
	for (const h of hits)
		for (const u of [h.from, h.to]) {
			const r = uf.find(u);
			const list = members.get(r) ?? [];
			if (!list.includes(u)) list.push(u);
			members.set(r, list);
		}
	const groups: RetakeGroup[] = [];
	const unitGroup = new Map<number, number>();
	const retakeAction = settings.rules.retake;
	for (const list of [...members.values()].sort((a, b) => Math.min(...a) - Math.min(...b))) {
		list.sort((a, b) => a - b);
		const gi = groups.length;
		const maxContent = Math.max(...list.map((u) => unitContent[u]!.length));
		const maxCov = Math.max(0, ...list.map((u) => unitLine[u]?.coverage ?? 0));
		const takes: RetakeTake[] = list.map((u) => {
			const ws = units[u]!.map((k) => aw[k]!);
			const probs = ws.map((w) => w.conf).filter((p): p is number => p !== null);
			const m = unitLine[u];
			const complete =
				m && maxCov > 0 ? m.coverage >= 0.6 * maxCov : unitContent[u]!.length >= 0.6 * maxContent;
			return {
				range: { start: input.words[ws[0]!.i]!.start, end: input.words[ws[ws.length - 1]!.i]!.end },
				words: [ws[0]!.i, ws[ws.length - 1]!.i],
				text: ws.map((w) => w.text.trim()).join(' '),
				...(m ? { scriptLine: m.line, coverage: Math.round(m.coverage * 1000) / 1000 } : {}),
				meanProb: probs.length
					? Math.round((probs.reduce((a, b) => a + b, 0) / probs.length) * 1000) / 1000
					: null,
				complete,
			};
		});
		// keep the last complete take; with a script an earlier take covering ≥ 20 % more of the line wins
		let chosen = takes.length - 1;
		while (chosen > 0 && !takes[chosen]!.complete) chosen--;
		if (!takes[chosen]!.complete) chosen = takes.length - 1;
		const cc = takes[chosen]!.coverage;
		if (cc !== undefined) {
			let best = -1;
			for (let t = 0; t < takes.length; t++) {
				const c = takes[t]!.coverage;
				if (
					t !== chosen &&
					c !== undefined &&
					c >= cc + T.scriptPreferEarlier &&
					(best < 0 || c >= takes[best]!.coverage!)
				)
					best = t;
			}
			if (best >= 0) chosen = best;
		}
		const last = takes.length - 1;
		if (chosen !== last) {
			// the chosen take loses its take labels; the other takes (the last one too) become retakes
			for (const k of units[list[chosen]!]!) {
				const l = labels[k];
				if (l && (l.kind === 'retake' || l.kind === 'false-start' || l.kind === 'restart')) labels[k] = null;
			}
			for (let t = 0; t < takes.length; t++)
				if (t !== chosen)
					for (const k of units[list[t]!]!) claimWord(ctx, k, 'retake', retakeAction, list[t]);
		}
		for (const u of list) unitGroup.set(u, gi);
		groups.push({ id: `g${gi}`, takes, chosen });
	}
	// group ids on the take labels
	for (let u = 0; u < units.length; u++) {
		const g = unitGroup.get(u);
		if (g === undefined) continue;
		for (const k of units[u]!) {
			const l = labels[k];
			if (l && (l.kind === 'retake' || l.kind === 'false-start')) labels[k] = { ...l, group: g };
		}
	}

	const phs = phrases(aw, T.phraseGapS);
	ruleOffScript(ctx, phs);
	ruleMarkerPhrases(ctx, phs, markers);
	ruleStutters(ctx);
	// head / tail: before the first / after the last unit on script — one that says a script line, or (outside the
	// lines said) one whose words come from the script by the off-script test: opening and closing lines are often
	// paraphrased, and cutting them as chatter was the largest error on the user's material (TC-071 calibration).
	if (index && settings.rules.headTail !== 'off') {
		const said = units.map((_, u) => unitLine[u] !== null);
		let first = said.indexOf(true);
		let lastU = said.lastIndexOf(true);
		const vocab = new Set(sTokens);
		const onScript = (u: number) => {
			const c = unitContent[u]!;
			return (
				c.length >= T.offScriptMinTokens &&
				c.filter((x) => vocab.has(x)).length / c.length >= T.offScriptSimilarity
			);
		};
		if (first >= 0) {
			for (let u = 0; u < first; u++)
				if (onScript(u)) {
					first = u;
					break;
				}
			for (let u = units.length - 1; u > lastU; u--)
				if (onScript(u)) {
					lastU = u;
					break;
				}
			for (let k = 0; k < units[first]![0]!; k++) claimWord(ctx, k, 'head-tail', settings.rules.headTail);
			const end = units[lastU]![units[lastU]!.length - 1]!;
			for (let k = end + 1; k < aw.length; k++) claimWord(ctx, k, 'head-tail', settings.rules.headTail);
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

	// ---- findings
	type Raw = {
		kind: FindingKind;
		suggested: FindingSuggestion;
		start: number;
		end: number;
		words: [number, number] | null;
		text: string;
		group?: number;
		confidence?: number;
	};
	const raw: Raw[] = [];
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
		const confs = aw
			.slice(k, j + 1)
			.map((w) => w.conf)
			.filter((c): c is number => c !== null);
		raw.push({
			kind: l.kind,
			suggested: l.action,
			start: input.words[a.i]!.start,
			end: input.words[b.i]!.end,
			words: [a.i, b.i],
			text: aw
				.slice(k, j + 1)
				.map((w) => w.text.trim())
				.join(' '),
			...(l.group !== undefined ? { group: l.group } : {}),
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
			raw.push({
				kind: 'hallucination',
				suggested: settings.rules.hallucination as FindingSuggestion,
				start: input.words[words[k]!.i]!.start,
				end: input.words[words[j]!.i]!.end,
				words: [words[k]!.i, words[j]!.i],
				text: words
					.slice(k, j + 1)
					.map((w) => w.text.trim())
					.join(' '),
			});
			k = j + 1;
		}
	}
	// frame findings
	if (voice) raw.push(...frameFindings(voice, words, settings));

	raw.sort((x, y) => x.start - y.start || x.end - y.end || x.kind.localeCompare(y.kind));
	const findings: CleanupFinding[] = [];
	const seen = new Map<string, number>();
	for (const r of raw) {
		let fp = findingFingerprint(input.mediaId, stream, r.kind, toSec(r.start), toSec(r.end), r.text);
		const n = (seen.get(fp) ?? 0) + 1;
		seen.set(fp, n);
		if (n > 1) fp = `${fp}~${n}`;
		findings.push({
			id: `f${findings.length}`,
			kind: r.kind,
			range: { start: r.start, end: r.end },
			words: r.words,
			confidence: Math.round((r.confidence ?? CONFIDENCE[r.kind]) * 1000) / 1000,
			reason: reasonOf(r.kind, r.text, r.end - r.start, r.group, groups),
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
	return { mediaId: input.mediaId, stream, language: lang, words, guarded, findings, groups, script };
}

function reasonOf(
	kind: FindingKind,
	text: string,
	flicks: number,
	group: number | undefined,
	groups: readonly RetakeGroup[],
): CleanupFinding['reason'] {
	const params: Record<string, string | number> = { seconds: Math.round(toSec(flicks) * 100) / 100 };
	if (text) params.text = text.length > 120 ? `${text.slice(0, 117)}…` : text;
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

/** Pauses, breaths and untranscribed voice from the frame classes (between the first and last candidate word). */
function frameFindings(
	voice: CleanupVoice,
	words: readonly AWord[],
	settings: CleanupSettings,
): Array<{
	kind: FindingKind;
	suggested: FindingSuggestion;
	start: number;
	end: number;
	words: null;
	text: string;
}> {
	const out: Array<{
		kind: FindingKind;
		suggested: FindingSuggestion;
		start: number;
		end: number;
		words: null;
		text: string;
	}> = [];
	if (!words.length) return out;
	const F = FLICKS_PER_SECOND * FR;
	const lo = Math.max(0, wordFrames(words[0]!)[0]);
	let hi = 0;
	for (const w of words) hi = Math.max(hi, wordFrames(w)[1]);
	hi = Math.min(voice.frameCount, hi);
	const push = (kind: FindingKind, action: RuleAction, a: number, b: number) => {
		if (action === 'off') return;
		out.push({
			kind,
			suggested: action,
			start: Math.round(a * F),
			end: Math.round(b * F),
			words: null,
			text: '',
		});
	};
	const T = settings.thresholds;
	const mg = Math.round(settings.gaps.maxGapS / FR);
	// word coverage of frames (any candidate word, guarded or not)
	const covered = new Uint8Array(Math.max(0, hi - lo));
	for (const w of words) {
		const [a, b] = wordFrames(w);
		for (let f = Math.max(lo, a); f < Math.min(hi, b); f++) covered[f - lo] = 1;
	}
	let f = lo;
	while (f < hi) {
		const c = voice.classes[f]!;
		let g = f;
		if (c === VOICE_CLASS_SPEECH) {
			let any = false;
			while (g < hi && voice.classes[g] === VOICE_CLASS_SPEECH) {
				if (covered[g - lo]) any = true;
				g++;
			}
			if (!any && (g - f) * FR >= T.untranscribedMinS - 1e-9)
				push('untranscribed', settings.rules.untranscribed, f, g);
		} else {
			while (g < hi && voice.classes[g] !== VOICE_CLASS_SPEECH) g++;
			const between = f > lo && clsAt(voice, f - 1) === VOICE_CLASS_SPEECH && g < hi;
			if (between && g - f > mg) push('pause', settings.rules.pause, f, g);
			// breath-like runs touching speech on either side (within 30 ms)
			let k = f;
			while (k < g) {
				if (voice.classes[k] !== VOICE_CLASS_BREATH) {
					k++;
					continue;
				}
				let m = k;
				while (m < g && voice.classes[m] === VOICE_CLASS_BREATH) m++;
				const near =
					(k - f <= 3 && f > lo && clsAt(voice, f - 1) === VOICE_CLASS_SPEECH) ||
					(g - m <= 3 && g < hi && clsAt(voice, g) === VOICE_CLASS_SPEECH);
				if (near) push('breath', settings.rules.breath, k, m);
				k = m;
			}
		}
		f = g;
	}
	return out;
}

/** dB of the level of frame k (−120 beyond the analysis). */
export function levelDbAt(v: CleanupVoice, k: number): number {
	return k >= 0 && k < v.frameCount ? voiceLevelDb(v.level[k]!) : -120;
}
