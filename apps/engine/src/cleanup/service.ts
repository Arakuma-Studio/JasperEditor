// The `cleanup-analysis` job (spec 14 TC-010…TC-026; docs/wp-notes/transcript-cleanup.md "Engine"): assembles what
// the pure detector needs for a sequence — the project (the request's copy, else the live one: the open editor's when
// one holds the project, else the saved one), the voice analysis of every speech media (cached, or a `voice-analysis`
// child job), the settings (the sequence's, a built-in or user preset, overrides) — runs `analyzeSequenceCleanup`
// and keeps the result in memory for the 16 newest jobs (`GET /api/cleanup/analyses/:id`); the job result carries the
// totals. Media without a usable analysis (offline, not in the engine store, no audio) are planned in word mode and
// reported. Nothing changes the document: applying is the client's `cleanup.apply` transaction.
import { randomBytes } from 'node:crypto';
import type {
	CleanupAnalysisFile,
	CleanupAnalysisJobResult,
	CleanupAnalyzeRequest,
	EngineJob,
} from '@jasper/api';
import { mgRegistry } from '@jasper/mg-templates';
import {
	analyzeSequenceCleanup,
	builtinCleanupSettings,
	type CleanupSettings,
	type CleanupVoice,
	CROCKFORD_ALPHABET,
	cleanupLanguageOf,
	EDIT_SPAN_CONFIRM_PAD_S,
	EDIT_SPAN_PAD_S,
	type EditRepeat,
	type EditSpan,
	type EditWord,
	editSpans,
	findEditRepeats,
	loadProject,
	mergeCleanupSettings,
	type ProjectDocument,
	readSequenceCleanup,
	resolvePresetSettings,
	type Sequence,
	sequenceCleanupSettings,
	speechClipsOf,
	transcriptForMedia,
} from '@jasper/project';
import type { AgentService } from '../agent/service.ts';
import { mediaKeyOf } from '../export/planner.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import { HttpError } from '../tools/reply.ts';
import type { CoreServices } from '../tools/services.ts';
import type { VoiceAnalysisService } from '../voice/service.ts';
import { type EditWordsService, spanKey } from './edit-words.ts';
import type { CleanupPresetLibrary } from './presets.ts';

/** Analyses kept for `GET /api/cleanup/analyses/:id`. */
const KEEP_ANALYSES = 16;

type Core = Pick<CoreServices, 'queue' | 'registry'>;

export class CleanupAnalysisService {
	private readonly analyses = new Map<string, CleanupAnalysisFile>();

	constructor(
		private readonly core: Core,
		private readonly deps: {
			voice: () => VoiceAnalysisService | undefined;
			agent: () => AgentService | undefined;
			presets: CleanupPresetLibrary;
			/** Chunked transcriptions for the repeats-in-the-edit check (absent: the check reports it cannot run). */
			editWords?: () => EditWordsService | undefined;
			now?: () => Date;
		},
	) {}

	registerRunner(): void {
		this.core.queue.registerRunner('cleanup-analysis', (ctx) => this.run(ctx));
	}

	submit(req: CleanupAnalyzeRequest, origin?: EngineJob['origin']): EngineJob {
		return this.core.queue.submit({
			kind: 'cleanup-analysis',
			title: 'Clean Up Voice – analysis',
			priority: 'interactive',
			cpuSlots: 1,
			...(origin ? { origin } : {}),
			projectId: req.projectId,
			input: req,
			stage: 'Waiting',
		});
	}

	get(id: string): CleanupAnalysisFile | null {
		return this.analyses.get(id) ?? null;
	}

	private keep(file: CleanupAnalysisFile): void {
		this.analyses.set(file.analysisId, file);
		while (this.analyses.size > KEEP_ANALYSES) this.analyses.delete(this.analyses.keys().next().value!);
	}

	/** The project: the request's copy, else the live document (editor session first, then the saved one). */
	private async document(req: CleanupAnalyzeRequest): Promise<{ doc: ProjectDocument; revision: number }> {
		if (req.document !== undefined) {
			const raw = req.document as { document?: unknown; schemaVersion?: unknown };
			const envelope = raw && typeof raw === 'object' && 'document' in raw ? raw : { document: raw };
			try {
				return { doc: loadProject(envelope, { mgTemplates: mgRegistry }).document, revision: -1 };
			} catch (e) {
				throw new JobError('VALIDATION_FAILED', `Invalid project: ${(e as Error).message}`, false);
			}
		}
		const agent = this.deps.agent();
		if (!agent) throw new JobError('NOT_AVAILABLE', 'The agent service is not running', true);
		let r: { result: unknown; revision?: number };
		try {
			r = await agent.query({ projectId: req.projectId, query: 'doc.get', args: {} });
		} catch (e) {
			const code = (e as { code?: string }).code ?? 'PROJECT_NOT_FOUND';
			throw new JobError(code, (e as Error).message, false);
		}
		const d = r.result as ProjectDocument | undefined;
		if (!d || typeof d !== 'object' || !d.sequences || typeof d.sequences !== 'object')
			throw new JobError('VALIDATION_FAILED', 'The project has no readable document', false);
		return { doc: d, revision: r.revision ?? -1 };
	}

	private async settingsFor(seq: Sequence, req: CleanupAnalyzeRequest): Promise<CleanupSettings> {
		const users = (await this.deps.presets.list()).presets;
		const user = (id: string) => {
			const p = users.find((x) => x.id === id);
			return p ? resolvePresetSettings(p) : null;
		};
		let base: CleanupSettings;
		if (req.presetId) {
			const b = builtinCleanupSettings(req.presetId) ?? user(req.presetId);
			if (!b) throw new JobError('PRESET_NOT_FOUND', `Cleanup preset not found: ${req.presetId}`, false);
			base = b;
		} else base = sequenceCleanupSettings(seq, user);
		return req.overrides ? mergeCleanupSettings(base, req.overrides) : base;
	}

	private async run(ctx: JobContext): Promise<CleanupAnalysisJobResult> {
		const t0 = Date.now();
		const req = ctx.input as CleanupAnalyzeRequest;
		ctx.progress(null, { stage: 'Reading the project' });
		const { doc, revision } = await this.document(req);
		const seqs = Object.values(doc.sequences);
		const seq = req.sequenceId ? doc.sequences[req.sequenceId] : seqs.length === 1 ? seqs[0] : undefined;
		if (!seq)
			throw new JobError(
				req.sequenceId ? 'SEQUENCE_NOT_FOUND' : 'VALIDATION_FAILED',
				req.sequenceId
					? `Sequence not found: ${req.sequenceId}`
					: 'sequenceId is required (several sequences)',
				false,
			);
		const scope = {
			...(req.clipIds ? { clipIds: req.clipIds } : {}),
			...(req.range ? { range: req.range } : {}),
		};
		const sc = speechClipsOf(doc, seq, scope);
		if (!sc.ok) throw new JobError(sc.code, sc.message, false, { clipIds: sc.clipIds });
		const settings = await this.settingsFor(seq, req);

		// voice analyses of the speech media
		const voices = new Map<string, CleanupVoice | null>();
		const voice = {
			cached: [] as string[],
			analysed: [] as string[],
			missing: [] as { mediaId: string; reason: string }[],
		};
		const wanted = new Map<string, { mediaId: string; stream: number }>();
		for (const c of sc.clips)
			wanted.set(`${c.mediaId}\u0000${c.channels.streamIndex}`, {
				mediaId: c.mediaId,
				stream: c.channels.streamIndex,
			});
		const svc = this.deps.voice();
		let done = 0;
		for (const [key, { mediaId, stream }] of wanted) {
			ctx.signal.throwIfAborted();
			ctx.progress(wanted.size ? (done / wanted.size) * 0.9 : null, { stage: 'Voice analysis' });
			const miss = (reason: string) => {
				voices.set(key, null);
				voice.missing.push({ mediaId, reason });
			};
			const asset = doc.media[mediaId];
			const mk = asset ? mediaKeyOf(asset) : null;
			if (!svc) miss('voice analysis is not available in this engine');
			else if (!mk || !this.core.registry.get(mk)) miss('the media is not in the engine store (offline)');
			else {
				try {
					const { rec, streamIndex } = svc.target(mk, stream);
					let a = await svc.read(rec, streamIndex);
					if (a) voice.cached.push(mediaId);
					else if (req.analyzeVoice === false) miss('no voice analysis yet (analyzeVoice: false)');
					else {
						const job = svc.submit(mk, { streamIndex, projectId: req.projectId }, ctx.job.origin, ctx.job.id);
						const onAbort = () => this.core.queue.cancel(job.id);
						ctx.signal.addEventListener('abort', onAbort, { once: true });
						const fin = await this.core.queue.wait(job.id);
						ctx.signal.removeEventListener('abort', onAbort);
						ctx.signal.throwIfAborted();
						if (fin.state !== 'succeeded')
							miss(`voice analysis ${fin.state}: ${fin.error?.message ?? ''}`.trim());
						else {
							a = await svc.read(rec, streamIndex);
							if (a) voice.analysed.push(mediaId);
							else miss('voice analysis file unreadable');
						}
					}
					if (a) voices.set(key, a);
				} catch (e) {
					if (ctx.signal.aborted) throw e;
					miss(e instanceof HttpError || e instanceof Error ? e.message : String(e));
				}
			}
			done++;
		}
		ctx.signal.throwIfAborted();
		const edit = req.editRepeats
			? await this.editRepeats(req, doc, seq, scope, settings, ctx, (mediaId, stream) =>
					voices.get(`${mediaId}\u0000${stream}`),
				)
			: null;
		ctx.signal.throwIfAborted();
		ctx.progress(0.92, { stage: 'Detecting and planning' });
		const analysis = analyzeSequenceCleanup({
			doc,
			seq,
			voice: (mediaId, stream) => voices.get(`${mediaId}\u0000${stream}`) ?? null,
			settings,
			...(req.script !== undefined ? { script: req.script } : {}),
			...(req.language ? { language: req.language } : {}),
			...(req.decisions ? { decisions: req.decisions } : {}),
			scope,
			...(edit ? { editRepeats: edit.repeats } : {}),
		});
		if (!analysis.ok)
			throw new JobError(analysis.code, analysis.message, false, { clipIds: analysis.clipIds });
		let id = '';
		for (const b of randomBytes(12)) id += CROCKFORD_ALPHABET[b & 31];
		const analysisId = `cla_${id}`;
		this.keep({
			format: 'jasper-cleanup-analysis',
			version: 1,
			analysisId,
			projectId: req.projectId,
			sequenceId: seq.id,
			revision,
			createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
			analysis,
		});
		const byKind: CleanupAnalysisJobResult['byKind'] = {};
		for (const f of analysis.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
		ctx.progress(1, { stage: 'Done' });
		return {
			analysisId,
			url: `/api/cleanup/analyses/${analysisId}`,
			projectId: req.projectId,
			sequenceId: seq.id,
			findings: analysis.findings.length,
			byKind,
			groups: analysis.groups.length,
			ranges: analysis.plan.ranges.length,
			stats: analysis.plan.stats,
			voice,
			elapsedMs: Date.now() - t0,
			...(edit ? { editRepeats: edit.report } : {}),
		};
	}

	/**
	 * The repeats-in-the-edit check (docs/wp-notes/transcript-cleanup.md "Repeats at cuts"): chunked words of the kept
	 * spans and / or of the mixdown, then `findEditRepeats`. A source that cannot run (no speech service, a failed
	 * transcription, a check too large) is reported in `missing`; the analysis goes on without it.
	 */
	private async editRepeats(
		req: CleanupAnalyzeRequest,
		doc: ProjectDocument,
		seq: Sequence,
		scope: { clipIds?: string[]; range?: { from: number; to: number } },
		settings: CleanupSettings,
		ctx: JobContext,
		voice: (mediaId: string, stream: number) => CleanupVoice | null | undefined,
	): Promise<{ repeats: EditRepeat[]; report: NonNullable<CleanupAnalysisJobResult['editRepeats']> }> {
		const report: NonNullable<CleanupAnalysisJobResult['editRepeats']> = {
			spans: 0,
			cached: 0,
			transcribed: 0,
			jobIds: [],
			found: 0,
			suggestedRemove: 0,
			missing: [],
		};
		const sp = editSpans(doc, seq, scope);
		if (!sp.ok) throw new JobError(sp.code, sp.message, false, { clipIds: sp.clipIds });
		report.spans = sp.spans.length;
		const svc = this.deps.editWords?.();
		const wantSpans = req.editRepeats === 'spans' || req.editRepeats === 'both';
		const wantMix = req.editRepeats === 'mix' || req.editRepeats === 'both';
		// the transcript's model and language, unless the request names them
		const t = sp.spans[0] ? transcriptForMedia(doc, sp.spans[0].mediaId) : null;
		const options = {
			...((req.editModel ?? t?.model) ? { model: req.editModel ?? t?.model ?? undefined } : {}),
			...((req.language ?? t?.language) ? { language: req.language ?? t?.language ?? undefined } : {}),
			projectId: req.projectId,
		};
		const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));
		let words: Map<string, EditWord[]> | null = null;
		let second: Map<string, EditWord[]> | null = null;
		let mix: EditWord[] | null = null;
		if (wantSpans) {
			if (!svc)
				report.missing.push({ source: 'spans', reason: 'speech to text is not available in this engine' });
			else
				try {
					ctx.progress(0.9, { stage: 'Transcribing the kept spans' });
					const r = await svc.spanWords(doc, seq, sp.spans, options, ctx, [
						EDIT_SPAN_PAD_S,
						EDIT_SPAN_CONFIRM_PAD_S,
					]);
					[words, second] = [r.words[0] ?? null, r.words[1] ?? null];
					Object.assign(report, { cached: r.report.cached, transcribed: r.report.transcribed });
					if (r.report.jobId) report.jobIds.push(r.report.jobId);
				} catch (e) {
					if (ctx.signal.aborted) throw e;
					report.missing.push({ source: 'spans', reason: reason(e) });
				}
		}
		if (wantMix) {
			if (!svc)
				report.missing.push({ source: 'mix', reason: 'speech to text is not available in this engine' });
			else
				try {
					ctx.progress(0.91, { stage: 'Transcribing the mixdown' });
					const r = await svc.mixWords(doc, seq, options, ctx);
					mix = r.words;
					if (r.jobId) report.jobIds.push(r.jobId);
				} catch (e) {
					if (ctx.signal.aborted) throw e;
					report.missing.push({ source: 'mix', reason: reason(e) });
				}
		}
		const cleanup = readSequenceCleanup(seq);
		const lang = cleanupLanguageOf(options.language ?? null);
		// the confirming decodes: the span decode with other padding, and the stored transcript
		const stored = (s: { mediaId: string }) => transcriptForMedia(doc, s.mediaId)?.words ?? null;
		const repeats = findEditRepeats({
			spans: sp.spans,
			rate: seq.settings.frameRate,
			...(words ? { words: (s) => words!.get(spanKey(s)) ?? null } : {}),
			confirm: [...(second ? [(s: EditSpan) => second!.get(spanKey(s)) ?? null] : []), stored],
			...(mix ? { mix } : {}),
			voice,
			settings,
			language: options.language ?? null,
			lists: lang ? (cleanup.lists?.[lang] ?? null) : null,
			script: req.script === undefined ? (cleanup.script?.text ?? null) : req.script,
		});
		report.found = repeats.length;
		report.suggestedRemove = repeats.filter((r) => r.suggested === 'remove').length;
		return { repeats, report };
	}
}
