// Transcript cleanup of a sequence (spec 14 TC-010, TC-020…TC-026; docs/wp-notes/transcript-cleanup.md "Planning a
// sequence"): finds the speech clips (transcribed audio clips) in the scope, runs the detector once per media over
// the words those clips play, applies the decisions (accepted / rejected findings, retake choices, the sequence's
// rejected fingerprints), plans the kept pieces of every clip in media time, places them on the sequence's frame
// grid, applies the frame guards, and returns the removed ranges (sequence frames) with their reasons and the
// statistics. A range is removed only where every speech clip covering it removes it (two microphones on two tracks
// keep each other's speech). Dry run: nothing here changes the document; `cleanup.apply` applies `plan.ranges`.
// Pure: the caller supplies the voice analyses (the engine's `voice-analysis` job).
import { VOICE_CLASS_BREATH, VOICE_CLASS_SPEECH } from '@jasper/audio-dsp';
import { transcriptForMedia } from '../captions/sequence-transcript.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../time.ts';
import { isRemapped } from '../time-remap/model.ts';
import {
	type CleanupSegmentIn,
	type CleanupVoice,
	type DetectResult,
	detectCleanup,
	FR,
} from './detector.ts';
import { snapEdge } from './edges.ts';
import { cleanupLanguageOf } from './lists.ts';
import { isHarshCut, planMediaCuts, type Span } from './plan.ts';
import {
	builtinCleanupSettings,
	type CleanupFinding,
	type CleanupSettings,
	FAST_SETTINGS,
	FINDING_KINDS,
	type FindingKind,
	mergeCleanupSettings,
	type RetakeGroup,
	readSequenceCleanup,
} from './schema.ts';

export type CleanupDecisions = {
	/** Finding ids or fingerprints to remove (over their suggestion). */
	accept?: readonly string[];
	/** Finding ids or fingerprints to keep (over their suggestion and `accept`). */
	reject?: readonly string[];
	/** Kinds to accept / reject as a whole (item decisions win). */
	acceptKinds?: readonly FindingKind[];
	rejectKinds?: readonly FindingKind[];
	/** Retake group id → index of the take to keep. */
	retakes?: Readonly<Record<string, number>>;
};

export type CleanupScope = {
	/** Only these clips (speech clips, or clips linked / grouped with them); default every transcribed audio clip. */
	clipIds?: readonly string[];
	/** Only this sequence-frame range `[from, to)` (e.g. the In / Out marks). */
	range?: { from: number; to: number } | null;
};

export type CleanupRefusal = {
	ok: false;
	code: 'E_UNSUPPORTED' | 'E_INVALID_PARAM' | 'E_NOT_FOUND';
	message: string;
	clipIds: string[];
};

export type CleanupPlanRange = {
	/** Sequence frames, half-open. */
	start: number;
	end: number;
	/** What the removed time was, most first (`pause` = silence, `breath`, `untranscribed` = voice without words…). */
	reasons: FindingKind[];
};

export type CleanupStats = {
	/** Seconds of the speech clips inside the scope. */
	inputDuration: number;
	outputDuration: number;
	/** Removed seconds per reason. */
	removedByKind: Partial<Record<FindingKind, number>>;
	/** Joins the cuts make. */
	joins: number;
	cutsPerMinute: number;
	/** Non-speech seconds left per minute of output (null without voice analyses). */
	deadAirPerMinute: number | null;
	/** The longest non-speech stretch left in the output, joins included (s; null without voice analyses). */
	largestSilenceLeft: number | null;
};

export type CleanupPlan = {
	sequenceId: string;
	/** The speech clips the plan cuts (`cleanup.apply` targets them, their linked partners and clip groups). */
	clipIds: string[];
	ranges: CleanupPlanRange[];
	/** Kept pieces per speech clip (sequence frames). */
	kept: Array<{ clipId: string; start: number; end: number }>;
	stats: CleanupStats;
	/** Accepted findings the guards did not cut (TC-023 "avoid harsh cuts"). */
	skipped: Array<{ findingId: string; reason: 'harsh-cut' }>;
	fadeMs: number;
	jlFrames: number;
};

export type CleanupMediaReport = {
	mediaId: string;
	stream: number;
	transcriptId: string;
	language: string | null;
	/** Whether a voice analysis was supplied (else word mode). */
	voice: boolean;
	edgeMode: CleanupSettings['edges']['mode'];
	clipIds: string[];
};

export type CleanupAnalysis = {
	ok: true;
	settings: CleanupSettings;
	findings: CleanupFinding[];
	groups: RetakeGroup[];
	/** Script lines and whether they were said (null without a script). */
	script: DetectResult['script'];
	media: CleanupMediaReport[];
	plan: CleanupPlan;
};

export type VoiceLookup = (mediaId: string, stream: number) => CleanupVoice | null | undefined;

/** The settings of a sequence: its preset (built-in or user preset from `userPresets`) with its overrides. */
export function sequenceCleanupSettings(
	seq: { cleanup?: unknown },
	userPresets: (id: string) => CleanupSettings | null = () => null,
): CleanupSettings {
	const c = readSequenceCleanup(seq);
	const id = c.settings?.presetId;
	const base = builtinCleanupSettings(id) ?? (id ? userPresets(id) : null) ?? FAST_SETTINGS;
	return mergeCleanupSettings(base, c.settings?.overrides);
}

const clipEnd = (c: { start: number; duration: number }) => c.start + c.duration;

/** Segment scores of a transcript (spec 14 TC-003 field, read leniently: malformed entries are skipped). */
export function transcriptSegments(t: { segments?: unknown }): CleanupSegmentIn[] {
	const raw = (t as { segments?: unknown }).segments;
	if (!Array.isArray(raw)) return [];
	const out: CleanupSegmentIn[] = [];
	const fin = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
	for (const s of raw) {
		if (!s || typeof s !== 'object') continue;
		const r = s as Record<string, unknown>;
		const start = fin(r.start);
		const end = fin(r.end);
		if (start === undefined || end === undefined || end < start) continue;
		const seg: CleanupSegmentIn = { start, end };
		const a = fin(r.avgLogprob);
		const n = fin(r.noSpeechProb);
		const c = fin(r.compressionRatio);
		if (a !== undefined) seg.avgLogprob = a;
		if (n !== undefined) seg.noSpeechProb = n;
		if (c !== undefined) seg.compressionRatio = c;
		out.push(seg);
	}
	return out;
}

type SpeechClip = Clip & { kind: 'audio'; mediaId: string; channels: { streamIndex: number } };

/** The speech clips of a scope: enabled audio clips whose media has a transcript. Refuses retimed clips (TC-020). */
export function speechClipsOf(
	doc: Pick<ProjectDocument, 'transcripts'>,
	seq: Sequence,
	scope: CleanupScope = {},
): { ok: true; clips: SpeechClip[] } | CleanupRefusal {
	const audioTracks = new Set(seq.audioTracks.map((t) => t.id));
	const wanted = scope.clipIds ? new Set(scope.clipIds) : null;
	if (wanted) {
		const missing = [...wanted].filter((id) => !seq.clips[id]);
		if (missing.length)
			return {
				ok: false,
				code: 'E_NOT_FOUND',
				message: `Clips not found: ${missing.join(', ')}`,
				clipIds: missing,
			};
		// linked partners and group members of the given clips count as given
		for (const id of [...wanted]) {
			const c = seq.clips[id]!;
			if (c.linkId) for (const m of seq.links[c.linkId]?.members ?? []) wanted.add(m);
			if (c.groupId) for (const m of seq.groups[c.groupId]?.members ?? []) wanted.add(m);
		}
	}
	const r = scope.range ?? null;
	const clips: SpeechClip[] = [];
	const retimed: string[] = [];
	for (const c of Object.values(seq.clips)) {
		if (c.kind !== 'audio' || !c.enabled || !audioTracks.has(c.trackId)) continue;
		if (wanted && !wanted.has(c.id)) continue;
		if (r && (clipEnd(c) <= r.from || c.start >= r.to)) continue;
		if (!transcriptForMedia(doc, c.mediaId)) continue;
		if (c.speed.reverse || c.speed.rate !== 1 || isRemapped(c)) {
			retimed.push(c.id);
			continue;
		}
		clips.push(c as SpeechClip);
	}
	if (retimed.length)
		return {
			ok: false,
			code: 'E_UNSUPPORTED',
			message: `Clean Up works on clips at 100 % speed, not reversed or time-remapped: ${retimed.join(', ')}`,
			clipIds: retimed,
		};
	if (!clips.length)
		return {
			ok: false,
			code: 'E_INVALID_PARAM',
			message: 'No transcribed audio clip in the scope (transcribe the speech first)',
			clipIds: [],
		};
	clips.sort((a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId));
	return { ok: true, clips };
}

/** Whether finding `f` is removed under `d` (and the sequence's persisted rejections). */
export function isAccepted(f: CleanupFinding, d: CleanupDecisions, rejected: ReadonlySet<string>): boolean {
	const has = (list: readonly string[] | undefined) =>
		!!list && (list.includes(f.id) || list.includes(f.fingerprint));
	if (has(d.reject)) return false;
	if (has(d.accept)) return true;
	if (d.rejectKinds?.includes(f.kind)) return false;
	if (d.acceptKinds?.includes(f.kind)) return true;
	if (rejected.has(f.fingerprint)) return false;
	return f.suggested === 'remove';
}

const HARSH_KINDS: ReadonlySet<FindingKind> = new Set(['filler-vocalic', 'filler-phrase', 'stutter']);
const WORD_KINDS: ReadonlySet<FindingKind> = new Set(
	FINDING_KINDS.filter((k) => k !== 'pause' && k !== 'breath' && k !== 'untranscribed'),
);
const TAKE_KINDS: ReadonlySet<FindingKind> = new Set(['retake', 'false-start', 'restart']);

export type AnalyzeSequenceInput = {
	doc: Pick<ProjectDocument, 'transcripts' | 'media'>;
	seq: Sequence;
	voice: VoiceLookup;
	/** Default: the sequence's settings (preset + overrides). */
	settings?: CleanupSettings;
	/** Default: the sequence's attached script. `null` = analyse without a script. */
	script?: string | null;
	/** Override the transcripts' language. */
	language?: string | null;
	decisions?: CleanupDecisions;
	scope?: CleanupScope;
};

/** Detects and plans the cleanup of a sequence (dry run). */
export function analyzeSequenceCleanup(input: AnalyzeSequenceInput): CleanupAnalysis | CleanupRefusal {
	const { doc, seq } = input;
	const stored = readSequenceCleanup(seq);
	const settings = input.settings ?? sequenceCleanupSettings(seq);
	const script = input.script === undefined ? (stored.script?.text ?? null) : input.script;
	const rejected = new Set(stored.rejected ?? []);
	const decisions = input.decisions ?? {};
	const sc = speechClipsOf(doc, seq, input.scope);
	if (!sc.ok) return sc;
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const range = input.scope?.range ?? null;
	// clip extent inside the scope (sequence frames)
	const extentOf = (c: Clip): [number, number] => [
		Math.max(c.start, range?.from ?? c.start),
		Math.min(clipEnd(c), range?.to ?? clipEnd(c)),
	];
	const toMediaFlicks = (c: Clip, frame: number) => c.sourceIn + (frame - c.start) * F;

	// one detection per media + stream
	type MediaRun = {
		key: string;
		mediaId: string;
		stream: number;
		clips: SpeechClip[];
		result: DetectResult;
		voice: CleanupVoice | null;
		transcriptId: string;
		language: string | null;
	};
	const runs = new Map<string, MediaRun>();
	for (const c of sc.clips) {
		const key = `${c.mediaId}\u0000${c.channels.streamIndex}`;
		const r = runs.get(key);
		if (r) r.clips.push(c);
		else
			runs.set(key, {
				key,
				mediaId: c.mediaId,
				stream: c.channels.streamIndex,
				clips: [c],
				result: null as never,
				voice: null,
				transcriptId: '',
				language: null,
			});
	}
	const findings: CleanupFinding[] = [];
	const groups: RetakeGroup[] = [];
	let script0: DetectResult['script'] = null;
	const media: CleanupMediaReport[] = [];
	for (const run of runs.values()) {
		const t = transcriptForMedia(doc, run.mediaId)!;
		const voice = input.voice(run.mediaId, run.stream) ?? null;
		const language = input.language ?? t.language;
		const lang = cleanupLanguageOf(language);
		const lists = lang ? stored.lists?.[lang] : undefined;
		const result = detectCleanup({
			mediaId: run.mediaId,
			stream: run.stream,
			words: t.words,
			segments: transcriptSegments(t as unknown as { segments?: unknown }),
			voice,
			script,
			language,
			lists: lists ?? null,
			settings,
			spans: run.clips.map((c) => {
				const [a, b] = extentOf(c);
				return { start: toMediaFlicks(c, a), end: toMediaFlicks(c, b) };
			}),
		});
		// renumber ids across media
		const gBase = groups.length;
		for (const g of result.groups) groups.push({ ...g, id: `g${groups.length}` });
		for (const f of result.findings) {
			const nf: CleanupFinding = { ...f, id: `f${findings.length}` };
			if (f.group !== undefined) nf.group = `g${gBase + Number(f.group.slice(1))}`;
			findings.push(nf);
		}
		result.findings = findings.slice(findings.length - result.findings.length);
		result.groups = groups.slice(gBase);
		script0 ??= result.script;
		Object.assign(run, {
			result,
			voice: voice && voice.frameCount > 0 ? voice : null,
			transcriptId: t.id,
			language: result.language,
		});
		media.push({
			mediaId: run.mediaId,
			stream: run.stream,
			transcriptId: t.id,
			language: result.language,
			voice: !!run.voice,
			edgeMode: run.voice && run.voice.levels.floorDb !== null ? settings.edges.mode : 'word',
			clipIds: run.clips.map((c) => c.id),
		});
	}

	// ---- decisions → per-media plan inputs, per clip pieces
	type ClipPlan = {
		clip: SpeechClip;
		run: MediaRun;
		keptFrames: Array<[number, number]>;
		extent: [number, number];
	};
	const clipPlans: ClipPlan[] = [];
	const skipped: CleanupPlan['skipped'] = [];
	const accepted = new Set<CleanupFinding>();
	for (const f of findings) if (isAccepted(f, decisions, rejected)) accepted.add(f);
	// retake choices
	const forcedKeep = new Set<string>(); // `${mediaRunKey}:${transcriptIndex}`
	const forcedRemove = new Set<string>();
	for (const run of runs.values())
		for (const g of run.result.groups) {
			const choice = decisions.retakes?.[g.id];
			if (choice === undefined || !Number.isInteger(choice) || choice < 0 || choice >= g.takes.length)
				continue;
			g.takes.forEach((take, ti) => {
				for (let i = take.words[0]; i <= take.words[1]; i++)
					(ti === choice ? forcedKeep : forcedRemove).add(`${run.key}:${i}`);
			});
			g.chosen = choice;
		}

	for (const run of runs.values()) {
		const res = run.result;
		const words = res.words;
		const byIndex = new Map<number, number>();
		words.forEach((w, k) => byIndex.set(w.i, k));
		const harshSkip = new Set<CleanupFinding>();
		const removedFor = () => {
			const removed = new Array<boolean>(words.length).fill(false);
			const takeOnly = new Array<boolean>(words.length).fill(true);
			for (const f of res.findings) {
				if (!f.words || !WORD_KINDS.has(f.kind) || !accepted.has(f) || harshSkip.has(f)) continue;
				for (let i = f.words[0]; i <= f.words[1]; i++) {
					const k = byIndex.get(i);
					if (k === undefined) continue;
					removed[k] = true;
					if (!TAKE_KINDS.has(f.kind)) takeOnly[k] = false;
				}
			}
			words.forEach((w, k) => {
				const key = `${run.key}:${w.i}`;
				if (forcedRemove.has(key)) removed[k] = true;
				if (forcedKeep.has(key) && takeOnly[k]) removed[k] = false;
			});
			return removed;
		};
		const sec = (f: number) => f / FLICKS_PER_SECOND;
		const spans = (pred: (f: CleanupFinding) => boolean): Span[] =>
			res.findings.filter(pred).map((f) => [sec(f.range.start), sec(f.range.end)] as Span);
		const keepSpeech = spans((f) => f.kind === 'untranscribed' && !accepted.has(f));
		const keepPauses = spans(
			(f) =>
				f.kind === 'pause' &&
				!accepted.has(f) &&
				(decisionTouches(f, decisions) || rejected.has(f.fingerprint)),
		);
		const keepBreaths = spans((f) => f.kind === 'breath' && !accepted.has(f));
		const removeBreaths = spans((f) => f.kind === 'breath' && accepted.has(f));
		for (const clip of run.clips) {
			const extent = extentOf(clip);
			const [lo, hi] = [sec(toMediaFlicks(clip, extent[0])), sec(toMediaFlicks(clip, extent[1]))];
			const inClip = words.map((w) => w.s + (w.e - w.s) / 2 >= lo && w.s + (w.e - w.s) / 2 < hi);
			const planOnce = () => {
				const removed = removedFor();
				const ws = words.filter((_, k) => inClip[k]);
				const rm = removed.filter((_, k) => inClip[k]);
				const clipSpan = (s: readonly Span[]) => s.filter(([a, b]) => b > lo && a < hi);
				return planMediaCuts({
					words: ws,
					removed: rm,
					voice: run.voice,
					settings,
					keepSpeech: clipSpan(keepSpeech),
					keepPauses: clipSpan(keepPauses),
					keepBreaths: clipSpan(keepBreaths),
					removeBreaths: clipSpan(removeBreaths),
				}).kept;
			};
			let kept = planOnce();
			// TC-023 avoid harsh cuts: an accepted filler / stutter whose cut lands on loud sound stays (one re-plan)
			if (run.voice && settings.guards.avoidHarshCuts) {
				let any = false;
				for (const f of res.findings) {
					if (!HARSH_KINDS.has(f.kind) || !accepted.has(f) || harshSkip.has(f)) continue;
					const fs = sec(f.range.start);
					const fe = sec(f.range.end);
					if (fe <= lo || fs >= hi) continue;
					const i = kept.findIndex(
						(p, k) => p[1] <= fs + 1e-9 && (kept[k + 1]?.[0] ?? Number.POSITIVE_INFINITY) >= fe - 1e-9,
					);
					const next = kept[i + 1];
					if (i < 0 || !next || next[0] - kept[i]![1] > 2) continue;
					if (isHarshCut(run.voice, settings, kept[i]![1], next[0])) {
						harshSkip.add(f);
						skipped.push({ findingId: f.id, reason: 'harsh-cut' });
						any = true;
					}
				}
				if (any) kept = planOnce();
			}
			const keptFrames = keptToFrames(clip, rate, run.voice, kept, settings.edges.snapWindowS, extent);
			// frame guards: no cut shorter than minCutFrames, no kept sliver shorter than minSliverFrames
			const g = settings.guards;
			const joined: Array<[number, number]> = [];
			for (const p of keptFrames) {
				const l = joined[joined.length - 1];
				if (l && p[0] - l[1] < g.minCutFrames) l[1] = p[1];
				else joined.push([p[0], p[1]]);
			}
			clipPlans.push({
				clip,
				run,
				keptFrames: joined.filter((p) => p[1] - p[0] >= g.minSliverFrames),
				extent,
			});
		}
	}

	// ---- removed ranges: where every speech clip covering a frame removes it
	const events = new Set<number>();
	for (const cp of clipPlans) {
		events.add(cp.extent[0]);
		events.add(cp.extent[1]);
		for (const [a, b] of cp.keptFrames) {
			events.add(a);
			events.add(b);
		}
	}
	const pts = [...events].sort((a, b) => a - b);
	const removedRanges: Array<[number, number]> = [];
	for (let i = 0; i + 1 < pts.length; i++) {
		const a = pts[i]!;
		const b = pts[i + 1]!;
		let covered = false;
		let keep = false;
		for (const cp of clipPlans) {
			if (cp.extent[0] > a || cp.extent[1] < b) continue;
			covered = true;
			if (cp.keptFrames.some(([x, y]) => x <= a && y >= b)) {
				keep = true;
				break;
			}
		}
		if (!covered || keep) continue;
		const l = removedRanges[removedRanges.length - 1];
		if (l && l[1] === a) l[1] = b;
		else removedRanges.push([a, b]);
	}

	// ---- reasons and statistics
	const kindFrames = new Map<string, Int8Array>(); // per media run: finding kind index per 10 ms frame (−1 none)
	for (const run of runs.values()) {
		const n = run.voice?.frameCount ?? 0;
		const arr = new Int8Array(n).fill(-1);
		for (const f of run.result.findings) {
			if (!f.words || !WORD_KINDS.has(f.kind) || !accepted.has(f)) continue;
			const a = Math.max(0, Math.floor(f.range.start / FLICKS_PER_SECOND / FR));
			const b = Math.min(n, Math.ceil(f.range.end / FLICKS_PER_SECOND / FR));
			const ki = FINDING_KINDS.indexOf(f.kind);
			for (let k = a; k < b; k++) if (arr[k] === -1) arr[k] = ki;
		}
		kindFrames.set(run.key, arr);
	}
	const topClipAt = (frame: number) =>
		clipPlans.find((cp) => cp.extent[0] <= frame && frame < cp.extent[1]) ?? null;
	const removedByKind: Partial<Record<FindingKind, number>> = {};
	const ranges: CleanupPlanRange[] = removedRanges.map(([a, b]) => {
		const secs = new Map<FindingKind, number>();
		for (const cp of clipPlans) {
			const s = Math.max(a, cp.extent[0]);
			const e = Math.min(b, cp.extent[1]);
			if (e <= s || topClipAt(s) !== cp) continue;
			const v = cp.run.voice;
			const kf = kindFrames.get(cp.run.key)!;
			const m0 = toMediaFlicks(cp.clip, s) / FLICKS_PER_SECOND / FR;
			const m1 = toMediaFlicks(cp.clip, e) / FLICKS_PER_SECOND / FR;
			for (let k = Math.floor(m0); k < Math.ceil(m1); k++) {
				const w = Math.min(k + 1, m1) - Math.max(k, m0);
				if (w <= 0) continue;
				let kind: FindingKind;
				if (k >= 0 && k < kf.length && kf[k]! >= 0) kind = FINDING_KINDS[kf[k]!]!;
				else if (v && k >= 0 && k < v.frameCount)
					kind =
						v.classes[k] === VOICE_CLASS_SPEECH
							? 'untranscribed'
							: v.classes[k] === VOICE_CLASS_BREATH
								? 'breath'
								: 'pause';
				else kind = 'pause';
				secs.set(kind, (secs.get(kind) ?? 0) + w * FR);
			}
		}
		for (const [k, s] of secs) removedByKind[k] = (removedByKind[k] ?? 0) + s;
		const reasons = [...secs.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k);
		return { start: a, end: b, reasons: reasons.length ? reasons : ['pause'] };
	});
	for (const k of Object.keys(removedByKind) as FindingKind[])
		removedByKind[k] = Math.round(removedByKind[k]! * 1000) / 1000;

	// input = union of extents
	const ext = clipPlans.map((cp) => cp.extent).sort((x, y) => x[0] - y[0]);
	const union: Array<[number, number]> = [];
	for (const [a, b] of ext) {
		const l = union[union.length - 1];
		if (l && a <= l[1]) l[1] = Math.max(l[1], b);
		else union.push([a, b]);
	}
	const fps = rate.num / rate.den;
	const inputFrames = union.reduce((s, [a, b]) => s + b - a, 0);
	const removedFrames = removedRanges.reduce((s, [a, b]) => s + b - a, 0);
	const outputDuration = (inputFrames - removedFrames) / fps;
	const atEdge = (a: number, b: number) => union.some(([x, y]) => a === x || b === y);
	const joins = removedRanges.filter(([a, b]) => !atEdge(a, b)).length;

	// dead air: walk the output in order through the top speech clip's media frames
	let nonSpeech = 0;
	let longest = 0;
	let runLen = 0;
	let anyVoice = false;
	for (const [ua, ub] of union) {
		let f = ua;
		let ri = removedRanges.findIndex(([, b]) => b > ua);
		while (f < ub) {
			const r = ri >= 0 ? removedRanges[ri] : undefined;
			if (r && f >= r[0]) {
				f = r[1];
				ri = ri + 1 < removedRanges.length ? ri + 1 : -1;
				continue;
			}
			const stop = Math.min(ub, r ? r[0] : ub);
			const cp = topClipAt(f);
			if (!cp) {
				f = stop;
				continue;
			}
			const e = Math.min(stop, cp.extent[1]);
			const v = cp.run.voice;
			if (v) {
				anyVoice = true;
				const m0 = Math.floor(toMediaFlicks(cp.clip, f) / FLICKS_PER_SECOND / FR);
				const m1 = Math.ceil(toMediaFlicks(cp.clip, e) / FLICKS_PER_SECOND / FR);
				for (let k = m0; k < m1; k++) {
					const speech = k >= 0 && k < v.frameCount && v.classes[k] === VOICE_CLASS_SPEECH;
					if (speech) runLen = 0;
					else {
						nonSpeech += FR;
						runLen += FR;
						longest = Math.max(longest, runLen);
					}
				}
			}
			f = e;
		}
		runLen = 0;
	}
	const minutes = outputDuration / 60;
	const stats: CleanupStats = {
		inputDuration: round3(inputFrames / fps),
		outputDuration: round3(outputDuration),
		removedByKind,
		joins,
		cutsPerMinute: minutes > 0 ? round3(joins / minutes) : 0,
		deadAirPerMinute: anyVoice && minutes > 0 ? round3(nonSpeech / minutes) : null,
		largestSilenceLeft: anyVoice ? round3(longest) : null,
	};
	const plan: CleanupPlan = {
		sequenceId: seq.id,
		clipIds: sc.clips.map((c) => c.id),
		ranges,
		kept: clipPlans.flatMap((cp) =>
			cp.keptFrames.map(([start, end]) => ({ clipId: cp.clip.id, start, end })),
		),
		stats,
		skipped,
		fadeMs: settings.joins.fadeMs,
		jlFrames: settings.joins.jlFrames,
	};
	return { ok: true, settings, findings, groups, script: script0, media, plan };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Kept pieces of a clip's media (seconds) as sequence frames: each edge snapped to a frame boundary of the clip's
 * placement (`snapEdge`: the quietest boundary within `snapWindowS`, else in points down and out points up),
 * clamped to `extent`, overlaps merged. The clip plays forward at 100 % speed.
 */
export function keptToFrames(
	clip: Pick<Clip, 'start' | 'sourceIn'>,
	rate: Rational,
	voice: CleanupVoice | null,
	kept: readonly Span[],
	snapWindowS: number,
	extent: readonly [number, number],
): Array<[number, number]> {
	const F = flicksPerFrame(rate);
	const toFrameX = (t: number) => clip.start + (t * FLICKS_PER_SECOND - clip.sourceIn) / F;
	const boundaryAt = (f: number) => (clip.sourceIn + (f - clip.start) * F) / FLICKS_PER_SECOND;
	const cands = (t: number) => {
		const x = Math.floor(toFrameX(t));
		const out: number[] = [];
		for (let f = x - 1; f <= x + 2; f++) out.push(boundaryAt(f));
		return out;
	};
	const out: Array<[number, number]> = [];
	for (const [a, b] of kept) {
		const fa = Math.round(toFrameX(snapEdge(voice, a, 'in', snapWindowS, cands(a))));
		const fb = Math.round(toFrameX(snapEdge(voice, b, 'out', snapWindowS, cands(b))));
		const s = Math.max(extent[0], fa);
		const e = Math.min(extent[1], fb);
		if (e <= s) continue;
		const l = out[out.length - 1];
		if (l && s <= l[1]) l[1] = Math.max(l[1], e);
		else out.push([s, e]);
	}
	return out;
}

function decisionTouches(f: CleanupFinding, d: CleanupDecisions): boolean {
	return (
		!!d.reject?.includes(f.id) || !!d.reject?.includes(f.fingerprint) || !!d.rejectKinds?.includes(f.kind)
	);
}
