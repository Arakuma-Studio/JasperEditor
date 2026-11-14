// Clean Up Voice controller (spec 14 TC-040…TC-044; docs/wp-notes/transcript-cleanup.md "Clean Up UI"): one per
// editor session, shared by the Text panel's Clean Up mode, the keyboard commands, the timeline overlay and the
// Program monitor chip.
//
// - Analyze: the engine's `cleanup-analysis` job on the committed document (sent with the request, so the analysis is
//   of exactly what the editor holds) — voice analyses (cached or computed, with progress), detector, planner; Cancel
//   cancels the job. Then the voice analyses are fetched once and handed to the planner worker (`planner.ts`).
// - Review: decisions (per finding, per kind, retake choices) and settings / script / list changes re-plan in the
//   worker, so the statistics and the marks follow at once; an edit of what the analysis read (clips, tracks,
//   transcripts, media) makes the review stale — Apply then asks for a new analysis.
// - Apply: ONE transaction "Clean Up Voice: N cuts" (`cleanup.apply` + the rejections to remember,
//   `cleanup.configure`), one undo step.
// - Play result / Play removed: a derived preview (`@jasper/session` `derivedPreviewFor`) — never committed, never in
//   History; the playhead is mapped in and back. ±1 s preview of a finding plays the timeline around it.
//
// Nothing here throws to the caller: failures land in `state.error` (shown by the panel) or come back as
// `{ok: false, reason}`.
import {
	type CleanupAnalysisJobResult,
	CleanupAnalysisJobResultSchema,
	type EngineJob,
	TERMINAL_JOB_STATES,
} from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import {
	type CleanupAnalysis,
	type CleanupPreset,
	type CleanupScope,
	type CleanupSettings,
	type CleanupVoice,
	cleanupApplyCommands,
	cleanupFindingFrames,
	type FindingKind,
	makeEnvelope,
	type ProjectDocument,
	readSequenceCleanup,
	resolvePresetSettings,
	type Sequence,
	sequenceCleanupSettings,
	speechClipsOf,
} from '@jasper/project';
import { derivedPreviewFor, type EditorSession, toDerivedFrame, toOriginalFrame } from '@jasper/session';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { t } from '../../../i18n/runtime.ts';
import { mediaKeyOf } from '../../../import/assets.ts';
import { playTimelineWindow } from '../../../sound/in-context.ts';
import {
	analysisInputsChanged,
	applyLabel,
	chooseTake as chooseTakeIn,
	decideItem,
	decideKind,
	EMPTY_DECISIONS,
	findingAccepted,
	groupFindings,
	removedPreview,
	resultPreview,
	scopeOf,
	stepFinding,
	toCleanupDecisions,
	type UiDecisions,
} from './model.ts';
import { CleanupPlanner, type PlanRequest, voiceKey } from './planner.ts';

export type CleanupPhase = 'idle' | 'analyzing' | 'loading' | 'review' | 'applying';
export type ScopeChoice = 'sequence' | 'inout' | 'clips';

export type CleanupUiState = {
	/** The Transcript tab shows the transcript editor or Clean Up. */
	mode: 'edit' | 'cleanup';
	phase: CleanupPhase;
	/** Job progress 0…1 (null: indeterminate) and stage while analysing. */
	progress: number | null;
	stage: string | null;
	jobId: string | null;
	error: { code: string; message: string } | null;
	scopeChoice: ScopeChoice;
	sequenceId: string | null;
	/** The scope analysed. */
	scope: CleanupScope | null;
	/** The committed document analysed. */
	base: ProjectDocument | null;
	analysis: CleanupAnalysis | null;
	/** A re-plan is running. */
	planning: boolean;
	/** Last re-plan time (ms) and where it ran. */
	planMs: number | null;
	planner: 'worker' | 'main' | 'engine' | null;
	decisions: UiDecisions;
	/** The finding under review (keyboard, list, transcript). */
	current: string | null;
	autoAdvance: boolean;
	/** The analysed clips, tracks, transcripts or media changed: Analyze again before Apply. */
	stale: boolean;
	/** Voice analyses: read from the cache / computed / missing (planned from word timings). */
	voice: { cached: string[]; analysed: string[]; missing: { mediaId: string; reason: string }[] } | null;
	userPresets: CleanupPreset[];
	/** Which derived preview plays. */
	preview: 'result' | 'removed' | null;
	/** Elapsed time of the analysis job (ms). */
	elapsedMs: number | null;
	/**
	 * Check the cuts for repeats ("y si | y si buscas"): the analysis transcribes every kept clip again on its own
	 * (cached per clip; docs/wp-notes/transcript-cleanup.md "Repeats at cuts"). Remembered in this browser.
	 */
	checkCuts: boolean;
	/** What the last analysis's check of the cuts did (null: not run). */
	editCheck: NonNullable<CleanupAnalysisJobResult['editRepeats']> | null;
};

const CHECK_CUTS_KEY = 'jasper.cleanup.checkCuts';
/** The remembered "check the cuts" choice (off until turned on: the first run decodes every kept clip). */
function storedCheckCuts(): boolean {
	try {
		return globalThis.localStorage?.getItem(CHECK_CUTS_KEY) === '1';
	} catch {
		return false;
	}
}

const initial = (): CleanupUiState => ({
	mode: 'edit',
	phase: 'idle',
	progress: null,
	stage: null,
	jobId: null,
	error: null,
	scopeChoice: 'sequence',
	sequenceId: null,
	scope: null,
	base: null,
	analysis: null,
	planning: false,
	planMs: null,
	planner: null,
	decisions: EMPTY_DECISIONS,
	current: null,
	autoAdvance: true,
	stale: false,
	voice: null,
	userPresets: [],
	preview: null,
	elapsedMs: null,
	checkCuts: storedCheckCuts(),
	editCheck: null,
});

type Result = { ok: true } | { ok: false; reason: string };

const POLL_MS = 300;

const errText = (e: unknown) =>
	e instanceof EngineError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : String(e);

export class CleanupController {
	readonly store: StoreApi<CleanupUiState>;
	private engine: EngineClient | null = null;
	private planner: CleanupPlanner | null = null;
	private voices = new Map<string, CleanupVoice | null>();
	private run = 0;
	private plannedCleanup: unknown = undefined;
	private previewStartFrame = 0;
	private readonly offs: Array<() => void> = [];

	constructor(private readonly session: EditorSession) {
		this.store = createStore<CleanupUiState>(initial);
		this.offs.push(
			session.on('doc.changed', () => this.onDocChanged()),
			session.on('closed', () => this.dispose()),
			derivedPreviewFor(session).store.subscribe((s) => {
				if (!s.active && this.store.getState().preview) this.store.setState({ preview: null });
			}),
		);
	}

	getState(): CleanupUiState {
		return this.store.getState();
	}

	private set(patch: Partial<CleanupUiState>): void {
		this.store.setState(patch);
	}

	/** The engine the controller talks to (the panel and the commands hand theirs). */
	attachEngine(engine: EngineClient | null | undefined): void {
		if (engine) this.engine = engine;
	}

	setMode(mode: 'edit' | 'cleanup'): void {
		this.set({ mode });
		if (mode === 'edit') this.stopPreview();
	}

	setScopeChoice(scopeChoice: ScopeChoice): void {
		this.set({ scopeChoice });
	}

	setAutoAdvance(autoAdvance: boolean): void {
		this.set({ autoAdvance });
	}

	/** Whether the next analysis checks the cuts for repeats (remembered in this browser). */
	setCheckCuts(checkCuts: boolean): void {
		this.set({ checkCuts });
		try {
			globalThis.localStorage?.setItem(CHECK_CUTS_KEY, checkCuts ? '1' : '0');
		} catch {
			/* private mode: the choice lasts for this session */
		}
	}

	clearError(): void {
		this.set({ error: null });
	}

	private seq(): Sequence | null {
		const id = this.store.getState().sequenceId ?? this.session.getState().activeSequenceId;
		return id ? ((this.session.getCommitted().sequences[id] as Sequence | undefined) ?? null) : null;
	}

	// ---- presets

	async refreshPresets(): Promise<void> {
		if (!this.engine) return;
		try {
			const r = await this.engine.call('cleanupPresetsList');
			this.set({ userPresets: r.presets });
		} catch {
			/* the built-ins still work; the picker lists what it has */
		}
	}

	/** The settings of a sequence (its preset — built-in or user — and overrides). */
	settingsOf(seq: Sequence): CleanupSettings {
		const users = this.store.getState().userPresets;
		return sequenceCleanupSettings(seq, (id) => {
			const p = users.find((x) => x.id === id);
			return p ? resolvePresetSettings(p) : null;
		});
	}

	async savePreset(name: string): Promise<Result> {
		const seq = this.seq();
		if (!seq || !this.engine) return { ok: false, reason: t('The engine is not available') };
		const c = readSequenceCleanup(seq);
		const pid = c.settings?.presetId;
		const users = this.store.getState().userPresets;
		const user = users.find((p) => p.id === pid);
		try {
			const preset = await this.engine.call('cleanupPresetCreate', {
				body: {
					name,
					basedOn: user?.basedOn ?? (pid === 'builtin.natural' ? 'builtin.natural' : 'builtin.fast'),
					// a user preset's own values plus the sequence's overrides
					settings: mergeOverrides(user?.settings ?? {}, c.settings?.overrides ?? {}) as never,
				},
			});
			await this.refreshPresets();
			this.configure({ settings: { presetId: preset.id } }, t('Clean Up Preset'));
			return { ok: true };
		} catch (e) {
			return { ok: false, reason: errText(e) };
		}
	}

	async deletePreset(id: string): Promise<Result> {
		if (!this.engine) return { ok: false, reason: t('The engine is not available') };
		try {
			await this.engine.call('cleanupPresetDelete', { params: { presetId: id } });
			await this.refreshPresets();
			return { ok: true };
		} catch (e) {
			return { ok: false, reason: errText(e) };
		}
	}

	/** A `cleanup.configure` edit of the active sequence (settings, script, lists): undoable, coalesced per field. */
	configure(fields: Record<string, unknown>, label = t('Clean Up Settings'), coalesce?: string): Result {
		const seq = this.seq();
		if (!seq) return { ok: false, reason: t('Open a sequence first') };
		const r = this.session.apply({
			label,
			origin: 'user',
			sequenceId: seq.id,
			commands: [{ type: 'cleanup.configure', sequenceId: seq.id, ...fields }] as never[],
			...(coalesce ? { coalesceKey: `cleanup:${seq.id}:${coalesce}` } : {}),
		});
		if (!r.ok) return { ok: false, reason: r.errors[0]?.message ?? t('The change was refused') };
		return { ok: true };
	}

	// ---- analyze

	/** Runs the analysis job on the committed document (TC-040). */
	async analyze(engine?: EngineClient | null): Promise<Result> {
		this.attachEngine(engine);
		const st = this.store.getState();
		if (st.phase === 'analyzing' || st.phase === 'loading' || st.phase === 'applying')
			return { ok: false, reason: t('An analysis is running') };
		const sessionState = this.session.getState();
		const seqId = sessionState.activeSequenceId;
		const doc = this.session.getCommitted();
		const seq = seqId ? doc.sequences[seqId] : undefined;
		if (!seq) return this.fail('E_NOT_FOUND', t('Open a sequence first'));
		if (!this.engine) return this.fail('NOT_AVAILABLE', t('Clean Up needs the engine'));
		const sc = scopeOf(seq, st.scopeChoice, sessionState.selection.timeline.clips);
		if (!sc.ok) return this.fail('E_INVALID_PARAM', sc.reason);
		// refusals the detector would give (no transcript, retimed clips) show at once
		const clips = speechClipsOf(doc, seq, sc.scope);
		if (!clips.ok) return this.fail(clips.code, clips.message);
		this.stopPreview();
		this.planner?.dispose();
		this.planner = null;
		const my = ++this.run;
		this.set({
			phase: 'analyzing',
			progress: null,
			stage: t('Starting'),
			error: null,
			sequenceId: seq.id,
			scope: sc.scope,
			analysis: null,
			stale: false,
			decisions: EMPTY_DECISIONS,
			current: null,
			voice: null,
			elapsedMs: null,
			editCheck: null,
		});
		const engineClient = this.engine;
		try {
			await this.refreshPresets();
			const envelope = makeEnvelope(doc, {
				revision: sessionState.revision,
				savedAt: new Date().toISOString(),
				platform: 'web',
			});
			let job: EngineJob = await engineClient.analyzeCleanup({
				projectId: this.session.projectId,
				sequenceId: seq.id,
				document: envelope,
				...(sc.scope.clipIds ? { clipIds: [...sc.scope.clipIds] } : {}),
				...(sc.scope.range ? { range: sc.scope.range } : {}),
				...(st.checkCuts ? { editRepeats: 'spans' as const } : {}),
			});
			if (my !== this.run) return { ok: false, reason: 'superseded' };
			this.set({ jobId: job.id });
			while (!TERMINAL_JOB_STATES.has(job.state)) {
				await new Promise((r) => setTimeout(r, POLL_MS));
				if (my !== this.run) return { ok: false, reason: 'superseded' };
				job = await engineClient.getJob(job.id);
				if (my !== this.run) return { ok: false, reason: 'superseded' };
				this.set({ progress: job.progress, stage: job.stage ?? null });
			}
			if (job.state === 'cancelled') {
				this.set({ phase: 'idle', jobId: null, progress: null, stage: null });
				return { ok: false, reason: t('Cancelled') };
			}
			if (job.state !== 'succeeded')
				return this.fail(
					job.error?.code ?? 'CLEANUP_ANALYSIS_FAILED',
					job.error?.message ?? t('The analysis failed'),
				);
			const res = CleanupAnalysisJobResultSchema.safeParse(job.result);
			if (!res.success) return this.fail('INVALID_RESPONSE', t('The engine sent an unreadable result'));
			const file = await engineClient.getCleanupAnalysis(res.data.analysisId);
			if (my !== this.run) return { ok: false, reason: 'superseded' };
			this.set({ phase: 'loading', stage: t('Loading the voice analyses'), progress: null, jobId: null });
			// the voice analyses for live re-planning (the engine just computed or read them)
			this.voices.clear();
			let local = true;
			for (const m of file.analysis.media) {
				const key = voiceKey(m.mediaId, m.stream);
				if (!m.voice) {
					this.voices.set(key, null);
					continue;
				}
				const mk = mediaKeyOf(doc.media[m.mediaId]);
				try {
					if (!mk) throw new Error('not in the engine store');
					this.voices.set(key, await engineClient.getVoiceAnalysis(mk, m.stream));
				} catch {
					local = false;
				}
				if (my !== this.run) return { ok: false, reason: 'superseded' };
			}
			if (local) {
				this.planner = new CleanupPlanner();
				this.planner.init({
					doc: { transcripts: doc.transcripts, media: doc.media },
					seq,
					voices: [...this.voices],
					...(file.analysis.editRepeats ? { editRepeats: file.analysis.editRepeats } : {}),
				});
			}
			this.plannedCleanup = seq.cleanup;
			const order = this.listOrder(file.analysis, EMPTY_DECISIONS);
			this.set({
				phase: 'review',
				base: doc,
				analysis: file.analysis,
				voice: res.data.voice,
				elapsedMs: res.data.elapsedMs,
				editCheck: res.data.editRepeats ?? null,
				planner: local ? (this.planner?.inWorker ? 'worker' : 'main') : 'engine',
				current: order[0] ?? null,
				progress: null,
				stage: null,
			});
			return { ok: true };
		} catch (e) {
			if (my !== this.run) return { ok: false, reason: 'superseded' };
			return this.fail(e instanceof EngineError ? e.code : 'E_INTERNAL', errText(e));
		}
	}

	private fail(code: string, message: string): Result {
		this.set({
			phase: this.store.getState().analysis ? 'review' : 'idle',
			error: { code, message },
			jobId: null,
			progress: null,
			stage: null,
		});
		return { ok: false, reason: message };
	}

	/** Cancels a running analysis (the engine job and its voice-analysis children). */
	async cancel(): Promise<void> {
		const { jobId, phase } = this.store.getState();
		if (phase !== 'analyzing' && phase !== 'loading') return;
		this.run++;
		this.set({ phase: 'idle', jobId: null, progress: null, stage: null, analysis: null });
		if (jobId && this.engine) await this.engine.cancelJob(jobId).catch(() => undefined);
	}

	/** Leaves the review without applying (nothing changes). */
	discard(): void {
		this.run++;
		this.stopPreview();
		this.planner?.dispose();
		this.planner = null;
		this.set({
			phase: 'idle',
			analysis: null,
			base: null,
			decisions: EMPTY_DECISIONS,
			current: null,
			stale: false,
			error: null,
		});
	}

	// ---- re-planning

	private onDocChanged(): void {
		const st = this.store.getState();
		if (st.phase !== 'review' || !st.base || !st.sequenceId) return;
		const doc = this.session.getCommitted();
		if (analysisInputsChanged(st.base, doc, st.sequenceId)) {
			if (!st.stale) {
				this.stopPreview();
				this.set({ stale: true });
			}
			return;
		}
		const seq = doc.sequences[st.sequenceId];
		if (seq && seq.cleanup !== this.plannedCleanup) void this.replan();
	}

	private planRequest(seq: Sequence, d: UiDecisions): PlanRequest {
		const st = this.store.getState();
		return {
			settings: this.settingsOf(seq),
			cleanup: seq.cleanup,
			script: readSequenceCleanup(seq).script?.text ?? null,
			decisions: toCleanupDecisions(d),
			scope: st.scope ?? {},
		};
	}

	/** Re-plans with the current decisions and the sequence's current settings, script and lists. */
	async replan(): Promise<void> {
		const st = this.store.getState();
		if (st.phase !== 'review' || !st.base || !st.sequenceId) return;
		const seq = this.session.getCommitted().sequences[st.sequenceId] as Sequence | undefined;
		if (!seq) return;
		const req = this.planRequest(seq, st.decisions);
		this.plannedCleanup = seq.cleanup;
		this.set({ planning: true });
		const my = this.run;
		if (this.planner) {
			const out = await this.planner.plan(req);
			if (out.superseded || my !== this.run) return;
			this.accept(out.result, out.ms);
			return;
		}
		// no local voice analyses: the engine re-plans (same code, same inputs)
		await this.replanViaEngine(req, my);
	}

	private async replanViaEngine(req: PlanRequest, my: number): Promise<void> {
		const st = this.store.getState();
		const engine = this.engine;
		if (!engine || !st.base || !st.sequenceId) return;
		const t0 = Date.now();
		try {
			const base = st.base;
			const seq = { ...base.sequences[st.sequenceId]!, cleanup: req.cleanup } as Sequence;
			const doc = { ...base, sequences: { ...base.sequences, [seq.id]: seq } } as ProjectDocument;
			let job = await engine.analyzeCleanup({
				projectId: this.session.projectId,
				sequenceId: seq.id,
				document: makeEnvelope(doc, { revision: 0, savedAt: new Date().toISOString(), platform: 'web' }),
				...(req.scope.clipIds ? { clipIds: [...req.scope.clipIds] } : {}),
				...(req.scope.range ? { range: req.scope.range } : {}),
				decisions: req.decisions as never,
				analyzeVoice: false,
				// the check of the cuts again: its transcriptions are cached, so it decodes nothing new
				...(st.editCheck ? { editRepeats: 'spans' as const } : {}),
			});
			while (!TERMINAL_JOB_STATES.has(job.state)) {
				await new Promise((r) => setTimeout(r, POLL_MS));
				if (my !== this.run) return;
				job = await engine.getJob(job.id);
			}
			if (my !== this.run) return;
			const res = CleanupAnalysisJobResultSchema.safeParse(job.result);
			if (job.state !== 'succeeded' || !res.success) {
				this.set({
					planning: false,
					error: {
						code: job.error?.code ?? 'E_INTERNAL',
						message: job.error?.message ?? t('Re-planning failed'),
					},
				});
				return;
			}
			const file = await engine.getCleanupAnalysis(res.data.analysisId);
			if (my !== this.run) return;
			this.accept(file.analysis, Date.now() - t0);
		} catch (e) {
			if (my === this.run) this.set({ planning: false, error: { code: 'E_INTERNAL', message: errText(e) } });
		}
	}

	private accept(result: CleanupAnalysis | { ok: false; code: string; message: string }, ms: number): void {
		if (!result.ok) {
			this.set({ planning: false, error: { code: result.code, message: result.message } });
			return;
		}
		const st = this.store.getState();
		const current =
			st.current && result.findings.some((f) => f.id === st.current)
				? st.current
				: (this.listOrder(result, st.decisions)[0] ?? null);
		this.set({ analysis: result, planning: false, planMs: ms, current, error: null });
	}

	private setDecisions(d: UiDecisions): void {
		this.set({ decisions: d });
		void this.replan();
	}

	// ---- decisions and navigation

	private listOrder(a: CleanupAnalysis, d: UiDecisions): string[] {
		const rejected = this.rememberedRejections();
		return groupFindings(a, d, rejected).flatMap((g) => g.findings.map((f) => f.id));
	}

	/** Fingerprints the sequence remembers as rejected. */
	rememberedRejections(): Set<string> {
		const seq = this.seq();
		return new Set(seq ? (readSequenceCleanup(seq).rejected ?? []) : []);
	}

	select(id: string | null, opts: { seek?: boolean } = {}): void {
		this.set({ current: id });
		if (id && opts.seek !== false) this.seekTo(id);
	}

	private seekTo(id: string): void {
		const { analysis } = this.store.getState();
		const seq = this.seq();
		const f = analysis?.findings.find((x) => x.id === id);
		if (!f || !seq || !analysis || this.store.getState().preview) return;
		const at = cleanupFindingFrames(seq, analysis, f);
		if (at) this.session.transport.seek(at.start);
	}

	step(dir: 1 | -1): string | null {
		const st = this.store.getState();
		if (!st.analysis) return null;
		const next = stepFinding(this.listOrder(st.analysis, st.decisions), st.current, dir);
		this.select(next);
		return next;
	}

	/** Accept / reject / clear a finding (default the current one); auto-advance moves to the next. */
	decide(what: 'accept' | 'reject' | 'clear', id?: string): boolean {
		const st = this.store.getState();
		const fid = id ?? st.current;
		if (!st.analysis || !fid || !st.analysis.findings.some((f) => f.id === fid)) return false;
		this.setDecisions(decideItem(st.decisions, fid, what));
		if (st.autoAdvance && what !== 'clear' && (id === undefined || id === st.current)) this.step(1);
		return true;
	}

	/** Accept / reject / clear a kind (default the current finding's). */
	decideKind(what: 'accept' | 'reject' | 'clear', kind?: FindingKind): boolean {
		const st = this.store.getState();
		if (!st.analysis) return false;
		const k = kind ?? st.analysis.findings.find((f) => f.id === st.current)?.kind;
		if (!k) return false;
		this.setDecisions(decideKind(st.decisions, k, what, st.analysis.findings));
		return true;
	}

	chooseTake(groupId: string, index: number): boolean {
		const st = this.store.getState();
		const g = st.analysis?.groups.find((x) => x.id === groupId);
		if (!g || !Number.isInteger(index) || index < 0 || index >= g.takes.length) return false;
		this.setDecisions(chooseTakeIn(st.decisions, groupId, index));
		return true;
	}

	/** The voice analysis of a media stream in the review (timeline overlay), or null. */
	voiceOf(mediaId: string, stream: number): CleanupVoice | null {
		return this.voices.get(voiceKey(mediaId, stream)) ?? null;
	}

	/** Whether finding `id` is removed under the current decisions. */
	isAccepted(id: string): boolean {
		const st = this.store.getState();
		const f = st.analysis?.findings.find((x) => x.id === id);
		return !!f && findingAccepted(f, st.decisions, this.rememberedRejections());
	}

	// ---- apply

	/** Why Apply is not possible right now, or null. */
	applyBlocker(): string | null {
		const st = this.store.getState();
		if (st.phase !== 'review' || !st.analysis) return t('Analyze first');
		if (st.stale) return t('The sequence changed since the analysis: Analyze again');
		if (st.planning) return t('Updating the plan…');
		return null;
	}

	/** Applies the plan as ONE undo step (TC-043). */
	apply(): Result {
		const blocker = this.applyBlocker();
		if (blocker) return { ok: false, reason: blocker };
		const st = this.store.getState();
		const seq = this.seq();
		if (!seq || !st.analysis) return { ok: false, reason: t('Open a sequence first') };
		const commands = cleanupApplyCommands(
			seq.id,
			st.analysis,
			toCleanupDecisions(st.decisions),
			this.rememberedRejections(),
		);
		if (!commands.length) return { ok: false, reason: t('Nothing to cut or remember') };
		this.stopPreview();
		this.set({ phase: 'applying' });
		const cuts = st.analysis.plan.ranges.length;
		const r = this.session.apply({
			label: applyLabel(cuts),
			origin: 'user',
			sequenceId: seq.id,
			commands,
		});
		if (!r.ok) {
			const message = r.errors[0]?.message ?? t('Apply was refused');
			this.set({ phase: 'review', error: { code: r.errors[0]?.code ?? 'E_INTERNAL', message } });
			return { ok: false, reason: message };
		}
		this.run++;
		this.planner?.dispose();
		this.planner = null;
		this.set({
			phase: 'idle',
			analysis: null,
			base: null,
			decisions: EMPTY_DECISIONS,
			current: null,
			stale: false,
			error: null,
		});
		return { ok: true };
	}

	// ---- previews

	/** Plays the plan applied (a derived timeline, never committed), from the playhead (TC-042). */
	playResult(): Result {
		return this.playDerived('result');
	}

	/** Plays only what the plan removes. */
	playRemoved(): Result {
		return this.playDerived('removed');
	}

	private playDerived(kind: 'result' | 'removed'): Result {
		const st = this.store.getState();
		const seq = this.seq();
		if (st.phase !== 'review' || !st.analysis || !seq) return { ok: false, reason: t('Analyze first') };
		if (st.stale) return { ok: false, reason: t('The sequence changed since the analysis: Analyze again') };
		const built = kind === 'result' ? resultPreview(seq, st.analysis) : removedPreview(seq, st.analysis);
		if (!built) return { ok: false, reason: t('Nothing is removed') };
		this.stopPreview();
		const transport = this.session.transport;
		const from = Math.round(transport.getState().frame);
		const r = derivedPreviewFor(this.session).start({
			label: kind === 'result' ? t('Clean Up result') : t('Clean Up: removed parts'),
			kind: `cleanup.${kind}`,
			sequenceId: seq.id,
			commands: built.commands,
			omitted: built.omitted,
		});
		if (!r.ok) return { ok: false, reason: r.message };
		this.previewStartFrame = from;
		this.set({ preview: kind });
		transport.pause();
		transport.seek(kind === 'result' ? toDerivedFrame(r.preview.omitted, from) : 0);
		transport.play(1);
		return { ok: true };
	}

	/** Ends a derived preview; the playhead goes back to the matching frame of the sequence. */
	stopPreview(): void {
		const dp = derivedPreviewFor(this.session);
		const active = dp.getState().active;
		if (!active?.kind.startsWith('cleanup.')) return;
		const transport = this.session.transport;
		transport.pause();
		const frame = transport.getState().frame;
		dp.stop();
		const target =
			active.kind === 'cleanup.result' ? toOriginalFrame(active.omitted, frame) : this.previewStartFrame;
		transport.seek(target);
		this.set({ preview: null });
		// The Player still holds the shorter derived document until the Program monitor re-renders: it clamps the seek
		// to its own end and reports that frame back. Seek again once the sequence is back in the Player.
		const again = () => {
			if (!derivedPreviewFor(this.session).getState().active && transport.getState().frame !== target)
				transport.seek(target);
		};
		if (typeof requestAnimationFrame === 'function')
			requestAnimationFrame(() => requestAnimationFrame(again));
		else setTimeout(again, 50);
	}

	/** Plays the timeline from 1 s before a finding to 1 s after it (default the current finding). */
	previewFinding(id?: string): Result {
		const st = this.store.getState();
		const seq = this.seq();
		const f = st.analysis?.findings.find((x) => x.id === (id ?? st.current));
		if (!f || !seq || !st.analysis) return { ok: false, reason: t('Select a finding first') };
		const at = cleanupFindingFrames(seq, st.analysis, f);
		if (!at) return { ok: false, reason: t('The finding is not on the timeline') };
		this.stopPreview();
		const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
		playTimelineWindow(this.session, seq, {
			center: at.start,
			returnTo: at.start,
			title: t('Clean Up finding'),
			before: 1,
			after: (at.end - at.start) / fps + 1,
		});
		return { ok: true };
	}

	dispose(): void {
		this.run++;
		this.planner?.dispose();
		this.planner = null;
		for (const off of this.offs.splice(0)) off();
	}
}

function mergeOverrides(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const g of ['rules', 'thresholds', 'edges', 'gaps', 'guards', 'joins']) {
		const m = { ...((a[g] as object) ?? {}), ...((b[g] as object) ?? {}) };
		if (Object.keys(m).length) out[g] = m;
	}
	return out;
}

const controllers = new WeakMap<EditorSession, CleanupController>();

/** The Clean Up controller of a session (one per session). */
export function cleanupFor(session: EditorSession): CleanupController {
	let c = controllers.get(session);
	if (!c) {
		c = new CleanupController(session);
		controllers.set(session, c);
	}
	return c;
}
