// Fix Transcript at the engine (spec 17 SC-014, SC-016, SC-035/036, SC-053, SC-055, SC-061…063, SC-073, SC-090,
// SC-092; docs/wp-notes/script-correction.md "Fix job, API and MCP"): the `transcript-fix` job, its pre-flight
// refusals, the refresher of feature `transcript-correction` and its accept / reject hooks. The decisions are the pure
// `@jasper/project/script-fix` model; this file does the I/O around it:
//   1. the live document, the sequence's script (`Sequence.cleanup.script`) and Fix Transcript settings (SC-055);
//   2. the scope (SC-063): every media transcript the sequence's audio clips play / the words it uses / the words it
//      uses inside In–Out;
//   3. per media, one at a time (bounded memory): align against the whole script (SC-014), find candidates (personal
//      glossary entries too, SC-073; rejected fingerprints skipped unless "Show rejected"), keep those in scope, decide
//      the spelling fixes that need no audio, build the score windows;
//   4. `propose`: the windows through `SpeechService.score` (device plan, fallback, cancellation, progress per scored
//      reading; SC-035/036), Δ_tok and the strictness preset's decisions, `replaceWordsEdit`;
//   5. the patch report of every edit (`planReplaceWords`, SC-053) and ONE proposal of feature `transcript-correction`
//      (items `transcriptFixItem`, Maybe and re-offered rejected items unselected) — or, for `dryRun`, only the report
//      with the windows that would be scored and an estimated scoring time.
import type {
	SpeechScoreRequest,
	SpeechScoreResult,
	TranscriptFixDecisionJson,
	TranscriptFixMediaReport,
	TranscriptFixReport,
	TranscriptFixRequest,
	TranscriptFixResult,
} from '@jasper/api';
import {
	FLICKS_PER_SECOND,
	flicksPerFrame,
	PROPOSAL_LIMITS,
	type ProjectDocument,
	type Proposal,
	type ProposalItemInput,
	planReplaceWords,
	type ReplaceWordsPlan,
	readSequenceCleanup,
	type Sequence,
	scriptFixRejected,
	scriptFixSettingsOf,
	sequenceWords,
	TRANSCRIPT_CORRECTION_FEATURE,
	type Transcript,
	transcriptFixItem,
	transcriptFixItemId,
	transcriptForMedia,
} from '@jasper/project';
import {
	type AlignmentReport,
	alignTranscript,
	buildScoreWindows,
	type CandidateScore,
	candidateScores,
	decideFix,
	type FixCandidate,
	type FixDecision,
	findFixCandidates,
	type GlossaryEntryInput,
	type ParsedScript,
	parseScript,
	type ReplaceWordsEdit,
	replaceWordsEdit,
	type ScoreWindow,
	type StrictnessPreset,
	scoreRequestWindows,
	scriptFixLanguage,
	unusedScriptLines,
} from '@jasper/project/script-fix';
import type { AgentService } from '../agent/service.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { ProposalService, Requester } from '../proposals/service.ts';
import { liveDocument } from '../sound-design/plan.ts';
import { engineMediaKey } from '../sound-design/voice.ts';
import type { SpeechScoreOptions } from '../speech/service.ts';
import { HttpError } from '../tools/reply.ts';
import { type FixCostStore, REFERENCE_COST } from './costs.ts';

// ---------------------------------------------------------------------------------------------------------------
// Dependencies (structural, so tests fake them at the service boundary)

/** The part of the speech model store the job reads (`SpeechModelStore`). */
export type FixSpeechModels = {
	entries: ReadonlyArray<{ id: string; multilingual: boolean }>;
	entry(id: string): { id: string; multilingual: boolean } | null;
	defaultId(): string;
	installed(e: never): Promise<boolean>;
};
/** The part of `SpeechService` the job uses. */
export type FixSpeech = {
	readonly models: FixSpeechModels;
	/** CPU threads transcription uses (the speech thread cap). */
	threads?(): number;
	score(request: SpeechScoreRequest, signal: AbortSignal, opts?: SpeechScoreOptions): Promise<SpeechScoreResult>;
};
/** The personal glossary library (`SpeechGlossary.list`). */
export type FixGlossary = {
	list(): Promise<{ entries: ReadonlyArray<{ from: readonly string[]; to: string; lang?: string | null }> }>;
};

export type TranscriptFixDeps = {
	agent: () => AgentService | undefined;
	proposals: () => ProposalService | undefined;
	speech: () => FixSpeech | undefined;
	glossary: () => FixGlossary | undefined;
	costs?: FixCostStore;
	log?: (m: string) => void;
};

export type TranscriptFixJobInput = {
	projectId: string;
	sequenceId: string;
	request: TranscriptFixRequest;
	who: Requester;
};

export type FixSettings = TranscriptFixReport['settings'];

// ---------------------------------------------------------------------------------------------------------------
// Limits (bounded memory, SC-090)

/** Candidates kept per job (over all media); the rest are counted in `guard.candidatesCapped`. */
export const MAX_JOB_CANDIDATES = 20_000;
/** Decisions listed in the report (counts are not capped). */
const MAX_REPORT_DECISIONS = 2_000;
/** Patch skips listed in the report. */
const MAX_REPORT_SKIPS = 200;
/** SC-092 request bounds (`SpeechScoreRequestSchema`). */
const MAX_READINGS = 64;
const MAX_READING_WORDS = 224;
const MAX_WORD_CHARS = 128;
const MAX_WINDOWS = 20_000;
const MAX_WINDOW_FLICKS = 30 * FLICKS_PER_SECOND;
/** Score failures that leave one media unscored (its candidates are kept as they are) instead of failing the job. */
const PER_MEDIA_CODES = new Set([
	'ASSET_NOT_FOUND',
	'MEDIA_OFFLINE',
	'NO_AUDIO',
	'SPEECH_LANGUAGE_UNKNOWN',
	'SPEECH_LANGUAGE_UNSUPPORTED',
]);

const noAudio = (code: string, message: string) => ({ code, message });

// ---------------------------------------------------------------------------------------------------------------
// Pre-flight: settings, sources, scope, model (refused at once by the route; the job repeats it on its document)

type ScopeMedia = {
	mediaId: string;
	name: string;
	transcript: Transcript;
	/** Word indices the sequence uses (scope `used` / `inOut`); null = the whole recording. */
	inScope: Set<number> | null;
	speechSeconds: number;
};

export type Prepared = {
	doc: ProjectDocument;
	revision: number | null;
	seq: Sequence;
	settings: FixSettings;
	mode: 'propose' | 'dryRun';
	device?: 'auto' | 'cpu' | 'gpu';
	scriptText: string | null;
	glossary: GlossaryEntryInput[];
	sourcesUsed: Array<'script' | 'glossary'>;
	media: ScopeMedia[];
	/** Scoring model per media (null: none usable; `problem` says why). */
	models: Map<string, string | null>;
	modelProblem: string | null;
	rejected: Set<string>;
	warnings: { code: string; message: string }[];
};

const refuse = (status: number, code: string, message: string, eCode: string, detail: object = {}): never => {
	throw new HttpError(status, code, message, { code: eCode, ...detail });
};

/** The request's settings over the sequence's stored ones (SC-055) over the defaults. */
export function fixSettings(seq: Sequence, req: TranscriptFixRequest): FixSettings {
	const stored = scriptFixSettingsOf(seq);
	return {
		sources: [...(req.sources ?? stored.sources)],
		scope: req.scope ?? stored.scope,
		strictness: req.strictness ?? stored.strictness,
		showRejected: req.showRejected === true,
	};
}

const isAudioTrack = (seq: Sequence) => {
	const ids = new Set(seq.audioTracks.map((t) => t.id));
	return (trackId: string) => ids.has(trackId);
};

/** SC-063: the media transcripts in scope, in the order the sequence first plays them. */
export function scopeMedia(doc: ProjectDocument, seq: Sequence, scope: FixSettings['scope']): ScopeMedia[] {
	const onAudio = isAudioTrack(seq);
	const first = new Map<string, number>();
	for (const c of Object.values(seq.clips)) {
		if (c.kind !== 'audio' || !onAudio(c.trackId)) continue;
		const at = first.get(c.mediaId);
		if (at === undefined || c.start < at) first.set(c.mediaId, c.start);
	}
	const order = [...first].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([m]) => m);
	let used: Map<string, Set<number>> | null = null;
	if (scope !== 'recordings') {
		const F = flicksPerFrame(seq.settings.frameRate);
		const lo = scope === 'inOut' ? (seq.inPoint ?? 0) * F : Number.NEGATIVE_INFINITY;
		const hi = scope === 'inOut' && seq.outPoint !== null ? seq.outPoint * F : Number.POSITIVE_INFINITY;
		used = new Map();
		for (const w of sequenceWords(doc, seq)) {
			const mid = w.start + (w.end - w.start) / 2;
			if (mid < lo || mid >= hi) continue;
			let set = used.get(w.transcriptId);
			if (!set) used.set(w.transcriptId, (set = new Set()));
			set.add(w.index);
		}
	}
	const out: ScopeMedia[] = [];
	for (const mediaId of order) {
		const t = transcriptForMedia(doc, mediaId);
		if (!t || !Array.isArray(t.words) || !t.words.length) continue;
		const inScope = used ? (used.get(t.id) ?? new Set<number>()) : null;
		if (inScope && !inScope.size) continue;
		let sec = 0;
		t.words.forEach((w, i) => {
			if (!inScope || inScope.has(i)) sec += Math.max(0, w.end - w.start) / FLICKS_PER_SECOND;
		});
		const asset = doc.media[mediaId] as { originalName?: unknown } | undefined;
		out.push({
			mediaId,
			name: typeof asset?.originalName === 'string' ? asset.originalName : mediaId,
			transcript: t,
			inScope,
			speechSeconds: sec,
		});
	}
	return out;
}

const LANG_RE = /^[a-z]{2,3}$/;

/** The model that scores a transcript: the one that made it, else the default, else any installed that fits. */
async function scoringModel(models: FixSpeechModels, t: Transcript): Promise<string | null> {
	const lang = String(t.language ?? '').toLowerCase();
	const fits = async (id: string | undefined) => {
		if (!id) return false;
		const e = models.entry(id);
		if (!e || (!e.multilingual && lang !== 'en')) return false;
		try {
			return await models.installed(e as never);
		} catch {
			return false;
		}
	};
	const tried = new Set<string>();
	for (const id of [t.model, models.defaultId(), ...models.entries.map((e) => e.id)]) {
		if (!id || tried.has(id)) continue;
		tried.add(id);
		if (await fits(id)) return id;
	}
	return null;
}

/**
 * Everything the job needs, or the refusal (HttpError with an `E_*` code): unknown sequence, no source (no script
 * attached and no glossary entry, or both turned off), no transcript in scope, In–Out without marks, and — to
 * propose — no installed speech model for the transcripts.
 */
export async function prepare(
	deps: TranscriptFixDeps,
	doc: ProjectDocument,
	revision: number | null,
	sequenceId: string,
	req: TranscriptFixRequest,
): Promise<Prepared> {
	const seq = Object.hasOwn(doc.sequences, sequenceId) ? doc.sequences[sequenceId] : undefined;
	if (!seq) return refuse(404, 'NOT_FOUND', `Sequence not found: ${sequenceId}`, 'E_NOT_FOUND');
	const settings = fixSettings(seq, req);
	const mode = req.mode ?? 'propose';
	const warnings: Prepared['warnings'] = [];
	// sources (SC-001, SC-073)
	const script = readSequenceCleanup(seq).script;
	const scriptText = settings.sources.includes('script') && script?.text?.trim() ? script.text : null;
	let glossary: GlossaryEntryInput[] = [];
	if (settings.sources.includes('glossary')) {
		const g = deps.glossary();
		if (!g)
			warnings.push({ code: 'W_NO_GLOSSARY', message: 'The personal glossary is not available in this engine' });
		else
			try {
				glossary = (await g.list()).entries.map((e) => ({
					from: [...e.from],
					to: e.to,
					...(e.lang ? { lang: e.lang } : {}),
				}));
			} catch (e) {
				warnings.push({
					code: 'W_NO_GLOSSARY',
					message: `The personal glossary could not be read: ${(e as Error).message}`.slice(0, 300),
				});
			}
	}
	const sourcesUsed: Prepared['sourcesUsed'] = [];
	if (scriptText) sourcesUsed.push('script');
	if (glossary.length) sourcesUsed.push('glossary');
	if (!sourcesUsed.length)
		return refuse(
			409,
			'NO_FIX_SOURCE',
			settings.sources.includes('script') && !script?.text?.trim()
				? 'Nothing to fix from: the sequence has no script attached and the personal glossary is empty or off'
				: 'Nothing to fix from: the sources that are on (script / personal glossary) are empty',
			'E_NO_SOURCE',
			{ sources: settings.sources },
		);
	if (settings.sources.includes('script') && !scriptText)
		warnings.push({ code: 'W_NO_SCRIPT', message: 'No script is attached: only the personal glossary is used' });
	if (settings.scope === 'inOut' && seq.inPoint === null && seq.outPoint === null)
		return refuse(400, 'VALIDATION_FAILED', 'Scope In–Out needs an In or Out mark on the sequence', 'E_INVALID_PARAM');
	// scope (SC-063)
	const all = scopeMedia(doc, seq, settings.scope);
	const media: ScopeMedia[] = [];
	for (const m of all) {
		if (m.transcript.task === 'translate') {
			warnings.push({
				code: 'W_TRANSLATED',
				message: `${m.name}: its transcript is a translation, not what was said; it is left out`,
			});
			continue;
		}
		media.push(m);
	}
	if (!media.length)
		return refuse(
			409,
			'NO_TRANSCRIPT',
			settings.scope === 'recordings'
				? 'No audio clip of the sequence has a transcript: transcribe the speech first'
				: 'No transcribed words in the scope: transcribe the speech first, or choose a wider scope',
			'E_NO_TRANSCRIPT',
			{ scope: settings.scope },
		);
	// model (SC-035)
	const models = new Map<string, string | null>();
	let modelProblem: string | null = null;
	const speech = deps.speech();
	if (!speech) modelProblem = 'The speech service is not running';
	else
		for (const m of media) {
			const id = await scoringModel(speech.models, m.transcript);
			models.set(m.mediaId, id);
		}
	if (!modelProblem && media.every((m) => !models.get(m.mediaId)))
		modelProblem =
			'No speech model that can score these transcripts is downloaded (Preferences ▸ Transcription, or install_speech_model)';
	if (mode === 'propose' && modelProblem)
		return refuse(409, 'SPEECH_MODEL_NOT_INSTALLED', modelProblem, 'E_NO_SPEECH_MODEL');
	return {
		doc,
		revision,
		seq,
		settings,
		mode,
		...(req.device ? { device: req.device } : {}),
		scriptText,
		glossary,
		sourcesUsed,
		media,
		models,
		modelProblem,
		rejected: scriptFixRejected(seq),
		warnings,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// The pipeline (job and refresher)

/** A decided candidate with its proposal item (null when kept / pending). */
export type Decided = {
	candidate: FixCandidate;
	decision: FixDecision | null;
	edit: ReplaceWordsEdit | null;
	item: ProposalItemInput | null;
};

type MediaRun = {
	report: TranscriptFixMediaReport;
	alignment: AlignmentReport | null;
	decided: Decided[];
};

export type PipelineOptions = {
	signal: AbortSignal;
	progress?: (fraction: number, stage: string) => void;
	log?: (text: string) => void;
	trackChild?: SpeechScoreOptions['trackChild'];
	scratchDir?: () => Promise<string>;
	threads?: number;
	/** Refresh: only these media, and only candidates whose item id is listed. */
	mediaIds?: ReadonlySet<string>;
	itemIds?: ReadonlySet<string>;
};

export type PipelineResult = {
	media: MediaRun[];
	skipped: Record<string, number>;
	guard: { candidatesCapped: number; itemsCapped: number };
	device: unknown;
	fallback?: unknown;
	scoreWindows: number;
	scoreReadings: number;
	estimate?: TranscriptFixReport['estimate'];
	timings: { alignMs: number; scoreMs: number; decideMs: number };
	unusedLines: number[];
	warnings: { code: string; message: string }[];
};

const itemIdOf = (c: FixCandidate) => transcriptFixItemId(c.id);
const bump = (m: Record<string, number>, k: string, n = 1) => {
	m[k] = (m[k] ?? 0) + n;
};

/** The words of a reading as the SC-092 request accepts them, or null (a window that cannot be scored). */
function requestable(w: ScoreWindow): boolean {
	if (!(w.end > w.start) || w.end - w.start > MAX_WINDOW_FLICKS) return false;
	return w.readings.every(
		(r) =>
			r.words.length >= 1 &&
			r.words.length <= MAX_READING_WORDS &&
			r.words.every((x) => x.trim().length >= 1 && x.trim().length <= MAX_WORD_CHARS),
	);
}

/** Windows with more readings than one request window holds are split (same range: still one encoder pass). */
function chunked(w: ScoreWindow): ScoreWindow[] {
	if (w.readings.length <= MAX_READINGS) return [w];
	const base = w.readings[0]!;
	const out: ScoreWindow[] = [];
	const per = MAX_READINGS - 1;
	for (let k = 0; k * per < w.regions.length; k++) {
		const regions = w.regions.slice(k * per, (k + 1) * per);
		const ids = new Set(regions.map((r) => r.readingId));
		out.push({
			...w,
			id: `${w.id}.${k}`,
			readings: [base, ...w.readings.filter((r) => ids.has(r.id))],
			regions,
		});
	}
	return out;
}

/** The SC-061 item of a decided fix (Maybe items and re-offered rejected fixes unselected). */
function itemOf(c: FixCandidate, d: FixDecision, edit: ReplaceWordsEdit): ProposalItemInput {
	const item = transcriptFixItem(
		{
			transcriptId: c.transcriptId,
			mediaId: c.mediaId,
			kind: c.kind,
			category: c.category,
			asr: c.asr,
			script: c.script,
			start: c.start,
			end: c.end,
			contextBefore: c.contextBefore,
			contextAfter: c.contextAfter,
			fingerprint: c.fingerprint,
		},
		{ group: d.group!, rule: d.rule, deltaTok: d.deltaTok, words: d.words },
		edit,
		{ id: itemIdOf(c) },
	);
	return d.selected ? item : { ...item, selected: false };
}

/** Runs steps 3–4 for every media of `p` (one at a time). */
export async function runPipeline(deps: TranscriptFixDeps, p: Prepared, o: PipelineOptions): Promise<PipelineResult> {
	const timings = { alignMs: 0, scoreMs: 0, decideMs: 0 };
	const skipped: Record<string, number> = {};
	const guard = { candidatesCapped: 0, itemsCapped: 0 };
	const warnings: PipelineResult['warnings'] = [];
	const strictness = p.settings.strictness as StrictnessPreset;
	const scripts = new Map<string, ParsedScript>();
	const scriptFor = (lang: string) => {
		if (!p.scriptText) return null;
		const key = scriptFixLanguage(lang) ?? '';
		let s = scripts.get(key);
		if (!s) scripts.set(key, (s = parseScript(p.scriptText, { language: lang })));
		return s;
	};
	const media = p.media.filter((m) => !o.mediaIds || o.mediaIds.has(m.mediaId));
	const runs: MediaRun[] = [];
	const alignments: AlignmentReport[] = [];
	let kept = 0;
	// ---- 3. align, candidates, no-audio decisions, windows (all media first: progress is weighted by windows)
	type Planned = { m: ScopeMedia; run: MediaRun; windows: ScoreWindow[]; audio: FixCandidate[] };
	const planned: Planned[] = [];
	for (let mi = 0; mi < media.length; mi++) {
		const m = media[mi]!;
		if (o.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		o.progress?.(0.02 + (0.13 * mi) / Math.max(1, media.length), `Aligning ${m.name}`);
		const t0 = Date.now();
		const t = m.transcript;
		const words = t.words;
		const lang = String(t.language ?? '');
		const script = scriptFor(lang);
		let alignment: Extract<ReturnType<typeof alignTranscript>, { ok: true }> | null = null;
		if (script) {
			const a = alignTranscript({ words, script, language: lang, mediaId: m.mediaId, transcriptId: t.id });
			if (!a.ok) throw new JobError('E_LIMIT', `${m.name}: ${a.message}`, false, { mediaId: m.mediaId, ...a.detail });
			alignment = a;
		}
		const found = findFixCandidates({
			mediaId: m.mediaId,
			transcriptId: t.id,
			words,
			language: lang,
			script,
			alignment,
			glossary: p.glossary,
			rejected: p.rejected,
			includeRejected: p.settings.showRejected,
		});
		for (const [k, n] of Object.entries(found.skippedCounts)) if (n) bump(skipped, k, n);
		const alignmentReport = alignment?.report ?? null;
		if (alignmentReport) alignments.push(alignmentReport);
		alignment = null; // the path is not needed past here (bounded memory)
		timings.alignMs += Date.now() - t0;
		const inScope = (c: FixCandidate) => {
			if (!m.inScope) return true;
			if (c.toWord > c.fromWord) {
				for (let k = c.fromWord; k < c.toWord; k++) if (!m.inScope.has(k)) return false;
				return true;
			}
			return m.inScope.has(c.fromWord - 1) && m.inScope.has(c.fromWord);
		};
		const cands: FixCandidate[] = [];
		for (const c of found.candidates) {
			if (!inScope(c)) {
				bump(skipped, 'scope');
				continue;
			}
			if (o.itemIds && !o.itemIds.has(itemIdOf(c))) continue;
			if (kept >= MAX_JOB_CANDIDATES) {
				guard.candidatesCapped++;
				bump(skipped, 'limit');
				continue;
			}
			kept++;
			cands.push(c);
		}
		const d0 = Date.now();
		const decided: Decided[] = cands.map((c) => ({ candidate: c, decision: null, edit: null, item: null }));
		const audio: FixCandidate[] = [];
		for (const x of decided) {
			if (x.candidate.needsAudio) audio.push(x.candidate);
			else x.decision = decideFix(x.candidate, null, strictness);
		}
		const built = buildScoreWindows(words, audio);
		const unplaced = new Set(built.unplaced.map((u) => u.candidateId));
		if (unplaced.size) bump(skipped, 'unplaced', unplaced.size);
		const windows: ScoreWindow[] = [];
		const unscorable = new Set<string>();
		for (const w of built.windows) {
			if (!requestable(w)) {
				for (const r of w.regions) unscorable.add(r.candidateId);
				continue;
			}
			windows.push(...chunked(w));
		}
		if (windows.length > MAX_WINDOWS) {
			for (const w of windows.splice(MAX_WINDOWS)) for (const r of w.regions) unscorable.add(r.candidateId);
			guard.candidatesCapped += unscorable.size;
		}
		if (unscorable.size) {
			bump(skipped, 'unscorable', unscorable.size);
			warnings.push({
				code: 'W_UNSCORABLE',
				message: `${m.name}: ${unscorable.size} candidate(s) lie in audio windows the speech check cannot take (over 30 s or too many words) and are kept as they are`,
			});
		}
		timings.decideMs += Date.now() - d0;
		const readings = windows.reduce((n, w) => n + w.readings.length, 0);
		const run: MediaRun = {
			report: {
				mediaId: m.mediaId,
				transcriptId: t.id,
				name: m.name,
				language: lang,
				words: words.length,
				wordsInScope: m.inScope ? m.inScope.size : words.length,
				alignment: alignmentReport
					? { ...alignmentReport, unusedLines: alignmentReport.unusedLines.slice(0, 500) }
					: null,
				candidates: cands.length,
				windows: windows.length,
				readings,
			},
			alignment: alignmentReport,
			decided,
		};
		runs.push(run);
		planned.push({
			m,
			run,
			windows,
			audio: audio.filter((c) => !unplaced.has(c.id) && !unscorable.has(c.id)),
		});
	}
	const totalWindows = planned.reduce((n, x) => n + x.windows.length, 0);
	const totalReadings = planned.reduce((n, x) => n + x.run.report.readings, 0);
	let device: unknown = null;
	let fallback: unknown;
	let estimate: TranscriptFixReport['estimate'];
	// ---- 4. the audio check (propose) or its estimate (dry run)
	if (p.mode === 'dryRun') {
		let seconds = 0;
		let measured = 0;
		for (const x of planned) {
			if (!x.windows.length) continue;
			const model = p.models.get(x.m.mediaId) ?? null;
			const cost = (model && (await deps.costs?.get(model))) || null;
			if (cost) measured++;
			const c = cost ?? REFERENCE_COST;
			seconds += c.loadSec + x.windows.length * c.windowSec + x.run.report.readings * c.readingSec;
		}
		const scoredMedia = planned.filter((x) => x.windows.length).length;
		const basis = scoredMedia > 0 && measured === scoredMedia ? 'measured' : 'reference';
		estimate = {
			seconds: Math.round(seconds * 10) / 10,
			windows: totalWindows,
			readings: totalReadings,
			basis,
			note:
				basis === 'measured'
					? '≈ from the last measured audio check of the same model on this machine (load + encoder pass per window + decoder per reading)'
					: '≈ from the reference cost measured on the build VM (CPU, whisper-large-v3-turbo: 6.4 s load, 5.05 s per window, 0.17 s per reading); the first run here records this machine’s own figures',
		};
	} else {
		const speech = deps.speech();
		let done = 0;
		for (const x of planned) {
			if (o.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			const model = p.models.get(x.m.mediaId) ?? null;
			const scores = new Map<string, CandidateScore>();
			let problem: { code: string; message: string } | null = null;
			const lang = String(x.m.transcript.language ?? '').toLowerCase();
			const key = engineMediaKey(p.doc.media[x.m.mediaId]);
			if (x.windows.length) {
				if (!speech) problem = noAudio('NOT_AVAILABLE', 'The speech service is not running');
				else if (!model) problem = noAudio('SPEECH_MODEL_NOT_INSTALLED', 'No installed speech model fits its language');
				else if (!LANG_RE.test(lang))
					problem = noAudio('SPEECH_LANGUAGE_UNKNOWN', `The transcript's language "${lang}" is not a language code`);
				else if (!key) problem = noAudio('MEDIA_OFFLINE', 'The media is not in the engine store (offline)');
			}
			if (x.windows.length && !problem && speech && model && key) {
				const s0 = Date.now();
				const share = x.windows.length / Math.max(1, totalWindows);
				const base = 0.15 + (0.75 * done) / Math.max(1, totalWindows);
				try {
					const scratch = o.scratchDir ? await o.scratchDir() : undefined;
					const res = await speech.score(
						{
							mediaId: key,
							language: lang,
							model,
							...(p.device ? { device: p.device } : {}),
							windows: scoreRequestWindows(x.windows),
						},
						o.signal,
						{
							onProgress: (f, stage) =>
								o.progress?.(base + 0.75 * share * f, `${x.m.name}: ${stage}`.slice(0, 200)),
							...(o.log ? { log: o.log } : {}),
							...(o.trackChild ? { trackChild: o.trackChild } : {}),
							...(scratch ? { scratchDir: scratch } : {}),
							...(o.threads ? { threads: o.threads } : {}),
						},
					);
					device ??= res.device;
					if (res.fallback) fallback ??= res.fallback;
					for (const [k, v] of candidateScores(x.windows, res.windows)) scores.set(k, v);
					const tm = res.timings;
					if (tm && deps.costs && tm.encoderPasses > 0)
						await deps.costs.record(model, {
							loadSec: (tm.loadMs + tm.decodeMs) / 1000,
							windowSec: tm.encoderMs / tm.encoderPasses / 1000,
							readingSec: tm.readings > 0 ? tm.decoderMs / tm.readings / 1000 : REFERENCE_COST.readingSec,
							device: String(res.device.label ?? '').slice(0, 200),
							at: new Date().toISOString(),
						});
				} catch (e) {
					if (o.signal.aborted || (e instanceof JobError && e.code === 'JOB_CANCELLED'))
						throw new JobError('JOB_CANCELLED', 'Cancelled');
					if (e instanceof JobError && PER_MEDIA_CODES.has(e.code)) problem = noAudio(e.code, e.message);
					else if (e instanceof JobError) throw new JobError(e.code, `${x.m.name}: ${e.message}`, e.retryable ?? false, e.detail);
					else throw new JobError('SPEECH_SCORE_FAILED', `${x.m.name}: ${(e as Error).message}`, false);
				}
				timings.scoreMs += Date.now() - s0;
			}
			done += x.windows.length;
			if (problem) {
				x.run.report.unscored = problem;
				warnings.push({
					code: 'W_UNSCORED',
					message: `${x.m.name}: the audio check could not run (${problem.message}); its candidates are kept as they are`.slice(0, 400),
				});
			}
			const d0 = Date.now();
			for (const d of x.run.decided)
				if (d.candidate.needsAudio) d.decision = decideFix(d.candidate, scores.get(d.candidate.id) ?? null, strictness);
			timings.decideMs += Date.now() - d0;
		}
	}
	// ---- edits and items
	const d0 = Date.now();
	for (const r of runs)
		for (const x of r.decided) {
			if (!x.decision || x.decision.group === null) continue;
			const edit = replaceWordsEdit(x.candidate, x.decision);
			if (!edit) continue;
			try {
				x.item = itemOf(x.candidate, x.decision, edit);
				x.edit = edit;
			} catch (e) {
				// a malformed edit is a producer bug, never the document's: the fix is left out and reported
				bump(skipped, 'malformed');
				warnings.push({
					code: 'W_FIX_MALFORMED',
					message: `A fix was left out: ${(e as Error).message}`.slice(0, 300),
				});
			}
		}
	timings.decideMs += Date.now() - d0;
	const anyScript = [...scripts.values()][0] ?? null;
	const unused = anyScript ? unusedScriptLines(anyScript, alignments) : [];
	return {
		media: runs,
		skipped,
		guard,
		device,
		...(fallback ? { fallback } : {}),
		scoreWindows: totalWindows,
		scoreReadings: totalReadings,
		...(estimate ? { estimate } : {}),
		timings,
		unusedLines: unused.slice(0, 2000),
		warnings,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Patch report (SC-053)

/** The patch report of every edit, one `planReplaceWords` per transcript (each edit alone when they do not compose). */
export function patchReport(doc: ProjectDocument, decided: readonly Decided[]): TranscriptFixReport['patch'] {
	const byTranscript = new Map<string, ReplaceWordsEdit[]>();
	for (const d of decided)
		if (d.edit) {
			let l = byTranscript.get(d.candidate.transcriptId);
			if (!l) byTranscript.set(d.candidate.transcriptId, (l = []));
			l.push(d.edit);
		}
	const patched = new Set<string>();
	const skips = new Map<string, { clipId: string; sequenceId: string; kind: string; reason: string }>();
	let edits = 0;
	let stale = 0;
	const take = (plan: ReplaceWordsPlan) => {
		for (const x of plan.patched) patched.add(`${x.sequenceId}/${x.clipId}`);
		for (const x of plan.skipped)
			skips.set(`${x.sequenceId}/${x.clipId}`, {
				clipId: x.clipId,
				sequenceId: x.sequenceId,
				kind: x.kind,
				reason: x.reason,
			});
		stale += plan.stale.length;
	};
	for (const [transcriptId, list] of byTranscript) {
		list.sort((a, b) => a.start - b.start || a.end - b.end);
		edits += list.length;
		const all = planReplaceWords(doc, { transcriptId, edits: list });
		if (all.ok || all.problem?.code === 'E_STALE') {
			take(all);
			continue;
		}
		// edits that do not compose (one would overlap another): each on its own
		for (const e of list) take(planReplaceWords(doc, { transcriptId, edits: [e] }));
	}
	return {
		edits,
		patched: patched.size,
		skipped: [...skips.values()].slice(0, MAX_REPORT_SKIPS),
		stale,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// The report

function decisionJson(x: Decided, mode: Prepared['mode']): TranscriptFixDecisionJson {
	const c = x.candidate;
	const d = x.decision;
	return {
		...(x.item ? { itemId: x.item.id } : {}),
		candidateId: c.id,
		fingerprint: c.fingerprint,
		mediaId: c.mediaId,
		kind: c.kind,
		category: c.category,
		asr: [...c.asr],
		script: [...c.script],
		decision: d ? d.decision : mode === 'dryRun' ? 'pending' : 'keep',
		group: d?.group ?? null,
		rule: d?.rule ?? (mode === 'dryRun' ? 'needs-audio' : 'unscored'),
		deltaTok: d?.deltaTok ?? null,
		start: x.edit?.start ?? c.start,
		end: x.edit?.end ?? c.end,
		...(c.rejected ? { rejected: true } : {}),
	};
}

export function buildReport(
	p: Prepared,
	r: PipelineResult,
	patch: TranscriptFixReport['patch'],
	t: { readMs: number; totalMs: number },
): TranscriptFixReport {
	const byGroup: Record<string, number> = {};
	const byCategory: Record<string, number> = {};
	const byKind: Record<string, number> = {};
	const decisions: TranscriptFixDecisionJson[] = [];
	let total = 0;
	let truncated = false;
	for (const m of r.media)
		for (const x of m.decided) {
			total++;
			const g = x.decision ? (x.decision.group ?? 'keep') : p.mode === 'dryRun' ? 'pending' : 'keep';
			bump(byGroup, g);
			bump(byCategory, x.candidate.category);
			bump(byKind, x.candidate.kind);
			if (decisions.length < MAX_REPORT_DECISIONS) decisions.push(decisionJson(x, p.mode));
			else truncated = true;
		}
	const guard = r.guard.candidatesCapped || r.guard.itemsCapped ? r.guard : undefined;
	return {
		settings: p.settings,
		sourcesUsed: p.sourcesUsed,
		perMedia: r.media.map((m) => m.report),
		candidates: { total, byGroup, byCategory, byKind },
		decisions,
		decisionsTruncated: truncated,
		skipped: r.skipped,
		unusedLines: r.unusedLines,
		patch,
		speech: {
			model: [...p.models.values()].find((x) => !!x) ?? null,
			...(p.modelProblem ? { problem: p.modelProblem } : {}),
		},
		device: r.device ?? null,
		...(r.fallback ? { fallback: r.fallback } : {}),
		...(r.estimate ? { estimate: r.estimate } : {}),
		timings: {
			readMs: t.readMs,
			alignMs: r.timings.alignMs,
			scoreMs: r.timings.scoreMs,
			decideMs: r.timings.decideMs,
			totalMs: t.totalMs,
			speechSeconds: Math.round(p.media.reduce((n, m) => n + m.speechSeconds, 0) * 1000) / 1000,
		},
		...(guard ? { guard } : {}),
		warnings: [...p.warnings, ...r.warnings].slice(0, 100),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// The proposal

/** What the stored proposal keeps to re-plan its items (refresh, SC-062). */
export type FixProposalReport = {
	format: 'jasper-transcript-fix';
	version: 1;
	settings: FixSettings;
	device?: 'auto' | 'cpu' | 'gpu';
	mediaIds: string[];
	counts: Record<string, number>;
	perMedia: Array<{ mediaId: string; name: string; alignedShare: number | null; offScriptShare: number | null }>;
};

export function fixReportOf(p: Pick<Proposal, 'report'>): FixProposalReport | null {
	const r = p.report as Partial<FixProposalReport> | undefined;
	if (!r || r.format !== 'jasper-transcript-fix' || r.version !== 1 || !r.settings) return null;
	return r as FixProposalReport;
}

const GROUP_ORDER: Record<string, number> = { fix: 0, spelling: 1, maybe: 2 };

/** The items in time order per media; over the proposal's item cap, Maybe items go first, then the latest ones. */
export function proposalItems(r: PipelineResult): { items: ProposalItemInput[]; capped: number } {
	const items: ProposalItemInput[] = [];
	for (const m of r.media) for (const x of m.decided) if (x.item) items.push(x.item);
	if (items.length <= PROPOSAL_LIMITS.maxItems) return { items, capped: 0 };
	const ranked = items
		.map((it, i) => ({ it, i, g: GROUP_ORDER[it.group ?? ''] ?? 3 }))
		.sort((a, b) => a.g - b.g || a.i - b.i)
		.slice(0, PROPOSAL_LIMITS.maxItems)
		.sort((a, b) => a.i - b.i)
		.map((x) => x.it);
	return { items: ranked, capped: items.length - ranked.length };
}

function plural(n: number, one: string, other: string) {
	return `${n} ${n === 1 ? one : other}`;
}

function proposalDraft(p: Prepared, r: PipelineResult, items: ProposalItemInput[]): Record<string, unknown> {
	const counts: Record<string, number> = {};
	for (const it of items) bump(counts, it.group ?? 'fix');
	const parts = [
		plural(counts.fix ?? 0, 'fix', 'fixes'),
		`${counts.spelling ?? 0} spelling`,
		`${counts.maybe ?? 0} maybe (unselected)`,
	];
	const aligned = r.media
		.map((m) => m.alignment)
		.filter((a): a is AlignmentReport => !!a);
	const share = aligned.length
		? aligned.reduce((n, a) => n + a.exactTokens, 0) / Math.max(1, aligned.reduce((n, a) => n + a.transcriptTokens, 0))
		: null;
	const summary = `${parts.join(' · ')} in ${plural(r.media.length, 'recording', 'recordings')}${share !== null ? ` · ${Math.round(share * 100)} % aligned to the script` : ''}. Each fix replaces the words in the transcript and patches the subtitles and caption tracks showing them; accepting is one undo step.`;
	const report: FixProposalReport = {
		format: 'jasper-transcript-fix',
		version: 1,
		settings: p.settings,
		...(p.device ? { device: p.device } : {}),
		mediaIds: r.media.map((m) => m.report.mediaId),
		counts,
		perMedia: r.media.map((m) => ({
			mediaId: m.report.mediaId,
			name: m.report.name,
			alignedShare: m.alignment?.alignedShare ?? null,
			offScriptShare: m.alignment?.offScriptShare ?? null,
		})),
	};
	return {
		feature: TRANSCRIPT_CORRECTION_FEATURE,
		title: 'Fix transcript',
		sequenceId: p.seq.id,
		summary: summary.slice(0, PROPOSAL_LIMITS.maxSummary),
		items,
		report,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// The job

const asJobError = (e: unknown): unknown => {
	if (e instanceof HttpError) {
		const eCode = (e.detail as { code?: unknown } | undefined)?.code;
		return new JobError(
			typeof eCode === 'string' && eCode.startsWith('E_') ? eCode : e.code,
			e.message,
			e.status === 503 || e.code === 'PROPOSAL_LIMIT',
			e.detail,
		);
	}
	return e;
};

function parseJobInput(raw: unknown): TranscriptFixJobInput {
	const x = raw as Partial<TranscriptFixJobInput> | null;
	if (!x || typeof x.projectId !== 'string' || typeof x.sequenceId !== 'string' || !x.request || !x.who)
		throw new JobError('INVALID_SPEC', 'Malformed transcript-fix job input', false);
	return x as TranscriptFixJobInput;
}

/** The `transcript-fix` job runner. */
export async function runTranscriptFixJob(ctx: JobContext, deps: TranscriptFixDeps): Promise<TranscriptFixResult> {
	try {
		return await runJob(ctx, deps);
	} catch (e) {
		throw asJobError(e);
	}
}

async function runJob(ctx: JobContext, deps: TranscriptFixDeps): Promise<TranscriptFixResult> {
	const t0 = Date.now();
	const input = parseJobInput(ctx.input);
	const agent = deps.agent();
	if (!agent) throw new JobError('NOT_AVAILABLE', 'The agent service is not running', true);
	ctx.progress(0.01, { stage: 'Reading the project' });
	const { doc, revision } = await liveDocument(agent, input.projectId);
	const p = await prepare(deps, doc, revision, input.sequenceId, input.request);
	const readMs = Date.now() - t0;
	const r = await runPipeline(deps, p, {
		signal: ctx.signal,
		progress: (f, stage) => ctx.progress(f, { stage }),
		log: (t) => ctx.log(t),
		trackChild: (c) => ctx.trackChild(c),
		scratchDir: () => ctx.scratchDir(),
		threads: ctx.slots,
	});
	if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
	ctx.progress(0.91, { stage: 'Checking the subtitles' });
	const decided = r.media.flatMap((m) => m.decided);
	const { items, capped } = p.mode === 'propose' ? proposalItems(r) : { items: [], capped: 0 };
	r.guard.itemsCapped = capped;
	const kept = new Set(items.map((it) => it.id));
	const patch = patchReport(doc, p.mode === 'propose' ? decided.filter((d) => d.item && kept.has(d.item.id)) : decided);
	const report = () => buildReport(p, r, patch, { readMs, totalMs: Date.now() - t0 });
	const base = { mode: p.mode, projectId: input.projectId, sequenceId: p.seq.id };
	if (p.mode === 'dryRun' || !items.length) {
		ctx.progress(1, { stage: p.mode === 'dryRun' ? 'Dry run done' : 'Nothing to fix' });
		return { ...base, proposalId: null, itemCount: 0, revision: revision ?? null, report: report() };
	}
	const proposals = deps.proposals();
	if (!proposals) throw new JobError('NOT_AVAILABLE', 'The proposal service is not running', true);
	ctx.progress(0.95, { stage: `Checking ${items.length} fixes` });
	const created = await proposals.create(input.projectId, proposalDraft(p, r, items), input.who);
	if (ctx.signal.aborted) {
		await proposals.delete(input.projectId, created.proposal.id).catch(() => undefined);
		throw new JobError('JOB_CANCELLED', 'Cancelled');
	}
	ctx.progress(1, { stage: 'Proposal ready for review' });
	return {
		...base,
		proposalId: created.proposal.id,
		itemCount: created.proposal.items.length,
		revision: created.revision,
		report: report(),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Refresh (SC-062): re-plan stale items for their media only

export function transcriptFixRefresher(deps: TranscriptFixDeps) {
	return async (input: {
		projectId: string;
		proposal: Proposal;
		itemIds: string[];
		doc: ProjectDocument;
		revision: number;
	}) => {
		const rep = fixReportOf(input.proposal);
		const seqId = input.proposal.sequenceId;
		if (!rep || !seqId)
			throw new HttpError(422, 'VALIDATION_FAILED', 'The proposal has no transcript-fix report to re-plan from', {
				code: 'E_INVALID_PARAM',
			});
		const wanted = new Set(input.itemIds);
		const mediaIds = new Set<string>();
		for (const it of input.proposal.items)
			if (wanted.has(it.id)) {
				const m = (it.meta as { mediaId?: unknown } | undefined)?.mediaId;
				if (typeof m === 'string') mediaIds.add(m);
			}
		const dropped: { itemId: string; reason: string }[] = [];
		let p: Prepared;
		try {
			p = await prepare(deps, input.doc, input.revision, seqId, {
				sources: rep.settings.sources,
				scope: rep.settings.scope,
				strictness: rep.settings.strictness,
				showRejected: rep.settings.showRejected,
				mode: 'propose',
				...(rep.device ? { device: rep.device } : {}),
			});
		} catch (e) {
			if (e instanceof HttpError && e.status !== 503) {
				// nothing to fix from any more (script detached, transcript gone…): every item goes
				return {
					items: [],
					dropped: input.itemIds.map((itemId) => ({ itemId, reason: e.message.slice(0, 300) })),
				};
			}
			throw e;
		}
		const ac = new AbortController();
		const r = await runPipeline(deps, p, { signal: ac.signal, mediaIds, itemIds: wanted });
		const fresh = new Map<string, Decided>();
		for (const m of r.media) for (const x of m.decided) fresh.set(itemIdOf(x.candidate), x);
		const items: ProposalItemInput[] = [];
		for (const id of input.itemIds) {
			const x = fresh.get(id);
			if (!x) dropped.push({ itemId: id, reason: 'The transcript and the script no longer disagree there' });
			else if (!x.item)
				dropped.push({
					itemId: id,
					reason:
						x.decision?.rule === 'unscored'
							? 'The audio could not be checked again; the transcript is kept'
							: 'The audio check now keeps the transcript',
				});
			else items.push(x.item);
		}
		return { items, dropped };
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Accept and reject hooks (SC-055, SC-062)

const SCRIPT_FIX_MAX_REJECTED = 10_000;

function fingerprintOf(it: Proposal['items'][number]): string | null {
	const f = (it.meta as { fingerprint?: unknown } | undefined)?.fingerprint;
	return typeof f === 'string' && f ? f : null;
}

/** `scriptFix.configure` remembering the rejected items' fingerprints (and forgetting re-offered ones accepted now). */
export function rejectionCommand(
	doc: ProjectDocument,
	proposal: Proposal,
	accepted: readonly string[] = [],
): Record<string, unknown> | null {
	const seqId = proposal.sequenceId;
	const seq = seqId && Object.hasOwn(doc.sequences, seqId) ? doc.sequences[seqId] : undefined;
	if (!seq) return null;
	const remembered = scriptFixRejected(seq);
	const acceptedSet = new Set(accepted);
	const reject = new Set<string>();
	const unreject = new Set<string>();
	for (const it of proposal.items) {
		const f = fingerprintOf(it);
		if (!f) continue;
		if (it.state === 'rejected' && !remembered.has(f)) reject.add(f);
		if (acceptedSet.has(it.id) && remembered.has(f)) unreject.add(f);
	}
	for (const f of unreject) reject.delete(f);
	const room = SCRIPT_FIX_MAX_REJECTED - (remembered.size - unreject.size);
	const list = [...reject].slice(0, Math.max(0, room));
	if (!list.length && !unreject.size) return null;
	return {
		type: 'scriptFix.configure',
		sequenceId: seq.id,
		...(list.length ? { reject: list } : {}),
		...(unreject.size ? { unreject: [...unreject] } : {}),
	};
}

/** The accept extension of `transcript-correction`: History "Fix transcript: N fixes" and the rejections. */
export function transcriptFixAcceptExtension(input: {
	doc: ProjectDocument;
	proposal: Proposal;
	itemIds: readonly string[];
}): { label: string; commands: Record<string, unknown>[] } {
	const n = input.itemIds.length;
	const cmd = rejectionCommand(input.doc, input.proposal, input.itemIds);
	return { label: `Fix transcript: ${plural(n, 'fix', 'fixes')}`, commands: cmd ? [cmd] : [] };
}

/**
 * The reject listener of `transcript-correction`: when the user's rejection leaves nothing to decide, the rejected
 * fixes are remembered in one undo step ("Fix transcript: remember N rejected fixes").
 */
export function transcriptFixRejectListener(deps: TranscriptFixDeps) {
	return async (input: { projectId: string; proposal: Proposal; who: Requester }) => {
		const open = input.proposal.items.some((it) => it.state === 'pending' || it.state === 'stale');
		if (open) return;
		const agent = deps.agent();
		if (!agent) return;
		const { doc } = await liveDocument(agent, input.projectId);
		const cmd = rejectionCommand(doc, input.proposal);
		if (!cmd) return;
		const n = (cmd.reject as string[] | undefined)?.length ?? 0;
		if (!n) return;
		const out = await agent.transact(
			input.projectId,
			{
				label: `Fix transcript: remember ${plural(n, 'rejected fix', 'rejected fixes')}`,
				sequenceId: input.proposal.sequenceId ?? undefined,
				commands: [cmd],
			} as never,
			{ fallbackAgent: input.who.agent, preApproved: true, asUser: true },
		);
		const res = out.result as { ok: boolean; errors?: { message?: string }[] };
		if (!res.ok) deps.log?.(`could not remember rejected fixes: ${res.errors?.[0]?.message ?? 'refused'}`);
	};
}
