import {
	type AgentOpenProjectRequest,
	type AgentQueryRequest,
	type AgentTxRequest,
	type AgentUiRequest,
	API_HEADER,
	API_VERSION,
	type ApplyStyleRequest,
	type ApplyStyleResult,
	type AssetRelinkRequest,
	type AudioAnalyzeRequest,
	type AudioClassifyRequest,
	type AutomationPassId,
	type AutomationPassRequest,
	type AutomationPassResult,
	type AutoToneRequest,
	type BeatsRequest,
	type BeatsResult,
	buildPath,
	type CaptionFileReadRequest,
	type CleanupAnalysisFile,
	type CleanupAnalyzeRequest,
	type ColorMatchRequest,
	type DerivativeKind,
	type DeriveRequest,
	decodeVoiceAnalysis,
	type EngineJob,
	type EnvelopeJson,
	ErrorShapeSchema,
	type ExportPlanRequest,
	type ExportStartRequest,
	type GlossaryImportRequest,
	type GlossarySaveRequest,
	type GlossaryUpdateRequest,
	type GradingScopesRequest,
	type ImageSequenceRequest,
	type InterchangeExportRequest,
	type InterchangeImportRequest,
	type InterchangePrerenderPlanRequestSchema,
	type JobListQuery,
	type LottieExportRequest,
	type LoudnessNormalizeRequest,
	type MediaRegisterRequest,
	type MediaVariantRequest,
	type MgRenderRequest,
	type MotionAnalysisRequest,
	type PreviewDeleteRequest,
	type PreviewDeleteResult,
	type PreviewRenderRequest,
	type PreviewStatus,
	type PreviewStatusRequest,
	type ProjectCreateRequest,
	type ProjectViewJson,
	type ProposalAcceptRequest,
	type ProposalCreateRequest,
	type ProposalMarkAppliedRequest,
	type ProposalNoteRequest,
	type ProposalRefreshRequest,
	type ProposalRejectRequest,
	type ProposalReopenRequest,
	type ProposalSelectRequest,
	type RecoveryPutRequest,
	type RegisteredMedia,
	type RelinkScanRequest,
	type RemixPlanRequest,
	type RemixPlanResult,
	ROUTES,
	type RouteName,
	type RouteResponse,
	type SceneDetectRequest,
	type SfxRebalanceRequest,
	type SoundBedsRequest,
	type SoundCheckLastRequest,
	type SoundCheckRequest,
	type SoundCuesRequest,
	type SoundDeliveryRequest,
	type SoundDesignPlanRequest,
	type SoundEmbedRequest,
	type SoundIndexRequest,
	type SoundListenRequest,
	type SoundMatchRequest,
	type SoundMomentRequest,
	type SoundPeakRequest,
	type SoundProfileBuildRequest,
	type SoundProfileImportRequest,
	type SoundRoomToneRequest,
	type SoundRootsPutRequest,
	type SoundSearchRequest,
	type SoundVisualRequest,
	type StillRequest,
	type StyleCheckRequest,
	type StyleRecipeCreateRequest,
	type StyleRecipeDuplicateRequest,
	type StyleRecipeUpdateRequest,
	soundSearchParams,
	type TranscriptFixRequest,
	type UploadCreateRequest,
	type UploadCreateResponse,
	UploadOffsetMismatchSchema,
	type VersionRestoreRequest,
	VOICE_ANALYSIS_MAX_FILE_BYTES,
	type VoiceAnalysis,
	type VoiceAnalyzeRequest,
} from '@jasper/api';
import type { z } from 'zod';
import { EngineError } from './errors.ts';
import { type EventHandlers, type EventStream, openEventStream } from './events.ts';

export type EngineClientOptions = {
	/** '' = same origin (the SPA always uses relative URLs, ARCHITECTURE §4.1). */
	baseUrl?: string;
	fetch?: typeof fetch;
	/** Bearer token (Electron packaged mode uses the cookie instead). */
	token?: string;
	/**
	 * Extra headers for every request, read per request: jasper-mcp names its agent (`x-jasper-agent`, shown on
	 * approval cards), the editor marks requests made while an agent's live-UI input is handled
	 * (`x-jasper-agent-input`, security review AGT-3).
	 */
	requestHeaders?: () => Record<string, string>;
};

/**
 * Autosave and recovery serialize documents incrementally. This body is sent verbatim as application/json.
 */
export class JsonText {
	constructor(readonly text: string) {}
}

type CallOptions = {
	params?: Record<string, string | number>;
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	/**
	 * The client makes this request by itself, not because of the input being handled (autosave, the recovery
	 * journal, lease upkeep): `requestHeaders` are left out, so the editor never attributes its own housekeeping to
	 * an agent whose live-UI input happens to be in flight.
	 */
	automatic?: boolean;
};

export type MediaVariant =
	| 'original'
	| 'poster'
	| 'sprite.json'
	| 'peaks.json'
	| 'playback-audio.json'
	| { proxy: '720' | '540' }
	| { sprite: number }
	| { peaks: number };

export type UploadProgress = { loaded: number; total: number };

export type UploadOptions = {
	signal?: AbortSignal;
	onProgress?(progress: UploadProgress): void;
};

export class EngineClient {
	readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;
	private readonly token?: string;
	private readonly requestHeaders?: () => Record<string, string>;

	constructor(opts: EngineClientOptions = {}) {
		this.baseUrl = (opts.baseUrl ?? '').replace(/\/$/, '');
		const f = opts.fetch ?? globalThis.fetch;
		if (!f) throw new Error('No fetch implementation available');
		this.fetchImpl = (input, init) => f(input, init);
		this.token = opts.token;
		this.requestHeaders = opts.requestHeaders;
	}

	url(path: string, query?: CallOptions['query']): string {
		const qs = query
			? Object.entries(query)
					.filter(([, v]) => v !== undefined)
					.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
					.join('&')
			: '';
		return `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
	}

	/**
	 * Headers that authenticate a request made outside `call()` (e.g. keepalive requests during `pagehide`):
	 * `Authorization: Bearer <token>` in token mode, nothing when the session cookie is used; plus the client's
	 * `requestHeaders`.
	 */
	authorizationHeaders(): Record<string, string> {
		return {
			...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
			...(this.requestHeaders?.() ?? {}),
		};
	}

	async call<N extends RouteName>(name: N, opts: CallOptions = {}): Promise<RouteResponse<N>> {
		const route = ROUTES[name];
		if (typeof route.response === 'string')
			throw new EngineError('INVALID_REQUEST', `Route ${name} does not return JSON`);
		const path = buildPath(route.path, opts.params);
		const binary = 'body' in route && route.body === 'binary';
		const headers: Record<string, string> = {
			accept: 'application/json',
			...(opts.automatic
				? this.token
					? { authorization: `Bearer ${this.token}` }
					: {}
				: this.authorizationHeaders()),
			...(opts.headers ?? {}),
		};
		let body: BodyInit | undefined;
		if (opts.body !== undefined) {
			if (binary) {
				headers['content-type'] = 'application/octet-stream';
				body = opts.body as BodyInit;
			} else {
				headers['content-type'] = 'application/json';
				body = opts.body instanceof JsonText ? opts.body.text : JSON.stringify(opts.body);
			}
		}
		const res = await this.fetchResponse(this.url(path, opts.query), {
			method: route.method,
			headers,
			body,
			signal: opts.signal,
			credentials: 'include',
		});
		const apiHeader = res.headers.get(API_HEADER);
		if (apiHeader && Number(apiHeader) !== API_VERSION) {
			throw new EngineError(
				'API_VERSION_MISMATCH',
				`Engine API ${apiHeader} does not match client API ${API_VERSION}`,
				{ status: res.status },
			);
		}
		const text = await res.text();
		let json: unknown = null;
		if (text) {
			try {
				json = JSON.parse(text);
			} catch {
				json = null;
			}
		}
		if (!res.ok) {
			const shape = ErrorShapeSchema.safeParse(json);
			if (shape.success) throw EngineError.fromShape(shape.data, res.status);
			throw new EngineError(res.status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR', `HTTP ${res.status}`, {
				status: res.status,
				retryable: res.status >= 500,
			});
		}
		const schema: z.ZodType = route.response;
		const parsed = schema.safeParse(json);
		if (!parsed.success) {
			throw new EngineError(
				'INVALID_RESPONSE',
				`Invalid response from ${route.method} ${route.path}: ${parsed.error.issues[0]?.message}`,
				{ status: res.status, detail: parsed.error.issues },
			);
		}
		return parsed.data as RouteResponse<N>;
	}

	health() {
		return this.call('health');
	}
	capabilities() {
		return this.call('capabilities');
	}
	licenses() {
		return this.call('licenses');
	}
	listProjects() {
		return this.call('projectsList');
	}
	createProject(req: ProjectCreateRequest) {
		return this.call('projectsCreate', { body: req });
	}
	getProject(projectId: string) {
		return this.call('projectGet', { params: { projectId } });
	}
	/** Saves with `If-Match: <baseRevision>`; a 409 throws `REVISION_CONFLICT` with `{revision}` detail. */
	putProject(projectId: string, envelope: EnvelopeJson | JsonText, baseRevision: number) {
		return this.call('projectPut', {
			params: { projectId },
			body: envelope,
			headers: { 'if-match': String(baseRevision) },
			// A save writes the session's own document; what an agent may put into it was decided when it was edited.
			automatic: true,
		});
	}
	putView(projectId: string, view: ProjectViewJson) {
		return this.call('projectPutView', { params: { projectId }, body: view, automatic: true });
	}
	listVersions(projectId: string) {
		return this.call('projectVersions', { params: { projectId } });
	}
	getVersion(projectId: string, versionId: string) {
		return this.call('projectVersionGet', { params: { projectId, versionId } });
	}
	/** Restores a saved version in place (`replace`, with the caller's lease) or as a new project (`copy`). */
	restoreVersion(projectId: string, versionId: string, req: VersionRestoreRequest) {
		return this.call('projectVersionRestore', { params: { projectId, versionId }, body: req });
	}
	/** Crash-recovery candidates of a project (journals no session holds any more; S01:PER-021). */
	listRecovery(projectId: string) {
		return this.call('projectRecoveryList', { params: { projectId } });
	}
	getRecovery(projectId: string, sessionId: string) {
		return this.call('projectRecoveryGet', { params: { projectId, sessionId } });
	}
	/** Journals this session's unsaved document (needs the session's lease). */
	putRecovery(projectId: string, sessionId: string, req: RecoveryPutRequest | JsonText) {
		return this.call('projectRecoveryPut', { params: { projectId, sessionId }, body: req, automatic: true });
	}
	/** Deletes a journal: the session's own (pass its `leaseId`) or a candidate nobody holds. */
	deleteRecovery(projectId: string, sessionId: string, leaseId?: string) {
		return this.call('projectRecoveryDelete', {
			params: { projectId, sessionId },
			...(leaseId ? { query: { leaseId } } : {}),
			// With its lease, a session clears its own journal after a save (housekeeping); without one, somebody is
			// discarding another session's unsaved changes, which is a decision.
			automatic: !!leaseId,
		});
	}
	deleteProject(projectId: string) {
		return this.call('projectDelete', { params: { projectId } });
	}
	acquireLease(projectId: string, sessionId: string) {
		return this.call('leaseAcquire', { params: { projectId }, body: { sessionId } });
	}
	heartbeatLease(projectId: string, leaseId: string) {
		return this.call('leaseHeartbeat', { params: { projectId, leaseId }, automatic: true });
	}
	releaseLease(projectId: string, leaseId: string) {
		return this.call('leaseRelease', { params: { projectId, leaseId }, automatic: true });
	}
	browseRoots() {
		return this.call('browseRoots');
	}
	browseList(path: string, opts: { all?: boolean } = {}) {
		return this.call('browseList', { query: { path, ...(opts.all ? { all: '1' } : {}) } });
	}
	browseInfo(path: string) {
		return this.call('browseInfo', { query: { path } });
	}
	/** URL of a JPEG thumbnail of a file on the engine host (for `<img src>`). */
	browseThumbnailUrl(path: string, width = 160): string {
		return this.url('/api/browse/thumbnail', { path, width });
	}
	/** URL of a media file's bytes on the engine host (for the preview `<video>` / `<audio>` / `<img>`). */
	browseFileUrl(path: string): string {
		return this.url('/api/browse/file', { path });
	}
	/** A caption / transcript file by path (local engines). */
	readCaptionFile(req: CaptionFileReadRequest) {
		return this.call('captionFileRead', { body: req });
	}
	/** Reads a timeline document into a `project.importTimeline` fragment. */
	importTimeline(req: InterchangeImportRequest, signal?: AbortSignal) {
		return this.call('interchangeImport', { body: req, ...(signal ? { signal } : {}) });
	}
	/** The clips an export to `format` would pre-render. */
	interchangePrerenderPlan(req: z.input<typeof InterchangePrerenderPlanRequestSchema>) {
		return this.call('interchangePrerenderPlan', { body: req });
	}
	/** Exports a sequence as a timeline document (job `interchange-export`). */
	exportTimeline(req: InterchangeExportRequest) {
		return this.call('interchangeExport', { body: req });
	}
	/** S04:AS-011: registers a replacement file for an asset and compares them. */
	relinkAsset(assetId: string, req: AssetRelinkRequest) {
		return this.call('assetRelink', { params: { assetId }, body: req });
	}
	/** S04:AS-011: finds offline assets — last known paths, located files' mappings, a folder (job `relink-scan`). */
	relinkScan(projectId: string, req: RelinkScanRequest) {
		return this.call('relinkScan', { params: { projectId }, body: req });
	}
	/** The full result of a finished `relink-scan` job. */
	relinkScanResult(projectId: string, jobId: string) {
		return this.call('relinkScanResult', { params: { projectId, jobId } });
	}
	/** Sound library status: counts, starter kit, indexing (spec 12 §2.8). */
	soundLibraryStatus() {
		return this.call('soundsStatus');
	}
	/** Ranked library search with facets (`rankSounds`; commercial-safe licences unless `license: 'any'`). */
	searchSounds(req: SoundSearchRequest = {}, signal?: AbortSignal) {
		return this.call('soundsSearch', { query: soundSearchParams(req), ...(signal ? { signal } : {}) });
	}
	getSound(soundId: string) {
		return this.call('soundGet', { params: { soundId } });
	}
	/** URL of a library sound's audio (for `<audio src>` / Web Audio auditioning). */
	soundAudioUrl(soundId: string): string {
		return this.url(buildPath(ROUTES.soundAudio.path, { soundId }));
	}
	/** Waveform peaks and spectrogram of a library sound (u8, base64). */
	getSoundVisual(soundId: string) {
		return this.call('soundVisual', { params: { soundId } });
	}
	/** Registers a library sound's file for a project; commit `media.register` with the returned `library`. */
	registerSound(soundId: string, projectId: string) {
		return this.call('soundRegister', { params: { soundId }, body: { projectId } });
	}
	/** Starts (or joins) a `sound-index` job. */
	indexSounds(req: SoundIndexRequest = {}) {
		return this.call('soundIndex', { body: req });
	}
	getSoundRoots() {
		return this.call('soundRootsGet');
	}
	/** The downloadable sound-pack catalogue with what is installed (spec 12 P6-R1). */
	listSoundPacks() {
		return this.call('soundPacks');
	}
	/** Starts (or joins) a `sound-pack-install` job: download, sha256 check, extraction, then a `sound-index` job. */
	installSoundPack(packId: string) {
		return this.call('soundPackInstall', { params: { packId } });
	}
	/** Removes an installed pack (an agent's request waits for the user's approval in an editor window). */
	removeSoundPack(packId: string) {
		return this.call('soundPackRemove', { params: { packId } });
	}
	/** Describe-it search (spec 12 P6-E14): whether it works here, the model and how much of the library is embedded. */
	soundSemanticStatus(signal?: AbortSignal) {
		return this.call('soundSemanticStatus', { ...(signal ? { signal } : {}) });
	}
	/** The Describe-it search model catalogue (licence, sizes, installed, available, its download job). */
	soundSemanticModels() {
		return this.call('soundSemanticModels');
	}
	/** Starts (or joins) the `model-download` job of a Describe-it search model (show its licence first). */
	installSoundSemanticModel(modelId: string) {
		return this.call('soundSemanticModelInstall', { params: { modelId } });
	}
	/** Removes the model and its cached embeddings (an agent's request waits for the user's approval). */
	removeSoundSemanticModel(modelId: string) {
		return this.call('soundSemanticModelDelete', { params: { modelId } });
	}
	/** Starts (or joins) a `sound-embed` job (embeddings of the sounds that lack one; `full`: all again). */
	embedSounds(req: SoundEmbedRequest = {}) {
		return this.call('soundEmbed', { body: req });
	}
	/** How well a library sound matches a description and its alternatives (Describe-it search model). */
	matchSound(soundId: string, req: SoundMatchRequest, signal?: AbortSignal) {
		return this.call('soundMatch', { params: { soundId }, body: req, ...(signal ? { signal } : {}) });
	}
	/** Find Moment: a `sound-moment` job for the best windows of a sound for a description (`wait`: its end). */
	findSoundMoments(
		soundId: string,
		req: SoundMomentRequest,
		opts: { wait?: boolean; signal?: AbortSignal } = {},
	) {
		return this.call('soundMoments', {
			params: { soundId },
			body: req,
			...(opts.wait ? { query: { wait: '1' as const } } : {}),
			...(opts.signal ? { signal: opts.signal } : {}),
		});
	}
	/** Replaces the user sound folders (local engines); an agent adding, removing or relicensing one is asked about. */
	putSoundRoots(req: SoundRootsPutRequest) {
		return this.call('soundRootsPut', { body: req });
	}
	/** Cue suggestions derived from the edit (spec 12 §2.8; `deriveCues` with the engine's template registry). */
	soundDesignCues(req: SoundCuesRequest, signal?: AbortSignal) {
		return this.call('soundDesignCues', { body: req, ...(signal ? { signal } : {}) });
	}
	soundDesignPeak(req: SoundPeakRequest, signal?: AbortSignal) {
		return this.call('soundDesignPeak', { body: req, ...(signal ? { signal } : {}) });
	}
	/**
	 * Starts a `sound-design` plan job (spec 12 §2.8, P3-R3); its result (`SoundDesignPlanResult`) names the proposal it
	 * stored. Nothing is applied: the user reviews the proposal.
	 */
	planSoundDesign(req: SoundDesignPlanRequest, signal?: AbortSignal) {
		return this.call('soundDesignPlan', { body: req, ...(signal ? { signal } : {}) });
	}
	/**
	 * Rebalance SFX levels (spec 12 §2.4, §2.10): a `sound-design` job (202) solving the sound effects' gains against the
	 * bed; its result (`SfxRebalanceResult`) is a report per clip and either one applied transaction ("Rebalance SFX
	 * Levels", `mode: 'apply'`) or a proposal (`mode: 'propose'`, the default).
	 */
	rebalanceSfx(req: SfxRebalanceRequest, signal?: AbortSignal) {
		return this.call('soundDesignRebalance', { body: req, ...(signal ? { signal } : {}) });
	}
	/**
	 * Ambience beds (spec 12 §4 P6-E12; `POST /api/sound-design/beds/plan`): the scenes, each recording's clean window and
	 * loop points and the transaction that lays a bed per scene (`SoundBedsPlan`). Read-only.
	 */
	planAmbienceBeds(req: SoundBedsRequest, signal?: AbortSignal) {
		return this.call('soundDesignBedsPlan', { body: req, ...(signal ? { signal } : {}) });
	}
	/** Ambience beds: a `sound-design` job (202) that proposes (default) or applies them (`SoundBedsResult`). */
	layAmbienceBeds(req: SoundBedsRequest, signal?: AbortSignal) {
		return this.call('soundDesignBeds', { body: req, ...(signal ? { signal } : {}) });
	}
	/** Room tone (`POST /api/sound-design/room-tone/plan`): the gaps, the floor, the ranked tones, the transaction. */
	planRoomTone(req: SoundRoomToneRequest, signal?: AbortSignal) {
		return this.call('soundDesignRoomTonePlan', { body: req, ...(signal ? { signal } : {}) });
	}
	/** Room tone: a `sound-design` job (202) that proposes (default) or applies the fill (`SoundRoomToneResult`). */
	fillRoomTone(req: SoundRoomToneRequest, signal?: AbortSignal) {
		return this.call('soundDesignRoomTone', { body: req, ...(signal ? { signal } : {}) });
	}
	/**
	 * Delivery preset (spec 12 §2.4, P4-R4; `POST /api/sound-design/delivery`): a `sound-design` job that measures the
	 * sequence and applies (`mode: 'apply'`, one transaction "Apply Delivery Preset") or proposes (the default) the
	 * preset's loudness normalisation, Auto-Match by type, ducking and re-solved sound-effect gains (`SoundDeliveryResult`).
	 */
	applyDelivery(req: SoundDeliveryRequest, signal?: AbortSignal) {
		return this.call('soundDesignDelivery', { body: req, ...(signal ? { signal } : {}) });
	}
	/**
	 * Sound Check (spec 12 §2.6, P5-R1; `POST /api/sound-design/check`): a `sound-check` job whose result
	 * (`SoundCheckResult`) is the report — findings with fixes, listen-here moments, the per-event table, the verdict.
	 * `store: true` also stores its summary in the sequence (`soundDesign.setCheck`).
	 */
	soundCheck(req: SoundCheckRequest, signal?: AbortSignal) {
		return this.call('soundDesignCheck', { body: req, ...(signal ? { signal } : {}) });
	}
	/** The last full Sound Check report of a sequence, kept across engine restarts, and whether it is stale. */
	lastSoundCheck(req: SoundCheckLastRequest, signal?: AbortSignal) {
		return this.call('soundDesignCheckLast', { body: req, ...(signal ? { signal } : {}) });
	}
	/** Sound Check visual data over a range of at most 120 s (`POST /api/sound-design/visual`, P5-R2). */
	soundVisual(req: SoundVisualRequest, signal?: AbortSignal) {
		return this.call('soundDesignVisual', { body: req, ...(signal ? { signal } : {}) });
	}
	/**
	 * Starts a `sound-listen` job (`POST /api/sound-design/listen`, spec 12 §4 P6-E6): the listening transcript of a range
	 * (≤ 10 min) — events attributed to their clips, sections, sync with chance levels, text lines (`SoundListenResult`).
	 */
	soundListen(req: SoundListenRequest, signal?: AbortSignal) {
		return this.call('soundDesignListen', { body: req, ...(signal ? { signal } : {}) });
	}
	/** The reference sound profiles of this engine's library (spec 12 §4 P6-E8). */
	listSoundProfiles() {
		return this.call('soundProfiles');
	}
	/** One reference profile: the whole file (what Export saves). */
	getSoundProfile(profileId: string) {
		return this.call('soundProfileGet', { params: { profileId } });
	}
	/** Starts a `sound-profile` job measuring 1–20 references; result `SoundProfileBuildResult`. */
	buildSoundProfile(req: SoundProfileBuildRequest) {
		return this.call('soundProfileBuild', { body: req });
	}
	renameSoundProfile(profileId: string, name: string) {
		return this.call('soundProfileRename', { params: { profileId }, body: { name } });
	}
	/** Deletes a reference profile (an agent's request waits for the user's approval in an editor window). */
	deleteSoundProfile(profileId: string) {
		return this.call('soundProfileDelete', { params: { profileId } });
	}
	/** Imports a profile file (validated; stored under a new id). */
	importSoundProfile(req: SoundProfileImportRequest) {
		return this.call('soundProfileImport', { body: req });
	}
	/**
	 * Starts a `motion-analysis` job (`POST /api/sound-design/motion`, P6-R2): the sequence's picture rendered small and
	 * measured per frame; result `MotionAnalysisResult` (curve + events), cached by the picture's fingerprint.
	 */
	analyzeMotion(req: MotionAnalysisRequest, signal?: AbortSignal) {
		return this.call('soundDesignMotion', { body: req, ...(signal ? { signal } : {}) });
	}
	/** Proposals of a project (spec 12 §2.5): summaries, newest first. */
	listProposals(projectId: string) {
		return this.call('proposalsList', { params: { projectId } });
	}
	/** A proposal with its items; `revalidate` checks the undecided items on the live document first. */
	getProposal(projectId: string, proposalId: string, opts: { revalidate?: boolean } = {}) {
		return this.call('proposalGet', {
			params: { projectId, proposalId },
			query: opts.revalidate ? { revalidate: '1' } : {},
		});
	}
	/** Stores a proposal after validating it by dry runs (failing items become `invalid`). */
	createProposal(projectId: string, req: ProposalCreateRequest) {
		return this.call('proposalCreate', { params: { projectId }, body: req });
	}
	/** Applies items as ONE transaction (all-or-nothing unless `partial`). */
	acceptProposal(projectId: string, proposalId: string, req: ProposalAcceptRequest) {
		return this.call('proposalAccept', { params: { projectId, proposalId }, body: req });
	}
	rejectProposal(projectId: string, proposalId: string, req: ProposalRejectRequest) {
		return this.call('proposalReject', { params: { projectId, proposalId }, body: req });
	}
	/** Decided items back to review (after their accept was undone in History). */
	reopenProposal(projectId: string, proposalId: string, req: ProposalReopenRequest) {
		return this.call('proposalReopen', { params: { projectId, proposalId }, body: req });
	}
	noteProposalItem(projectId: string, proposalId: string, req: ProposalNoteRequest) {
		return this.call('proposalNote', { params: { projectId, proposalId }, body: req });
	}
	selectProposalAlternative(projectId: string, proposalId: string, req: ProposalSelectRequest) {
		return this.call('proposalSelect', { params: { projectId, proposalId }, body: req });
	}
	/** Editor only: records items whose undone accept the user redid in History as accepted again (nothing applies). */
	markProposalApplied(projectId: string, proposalId: string, req: ProposalMarkAppliedRequest) {
		return this.call('proposalMarkApplied', { params: { projectId, proposalId }, body: req });
	}
	deleteProposal(projectId: string, proposalId: string) {
		return this.call('proposalDelete', { params: { projectId, proposalId } });
	}
	/** "Refresh proposal" (spec 15 EA-003): the feature's producer re-plans stale items; nothing is applied. */
	refreshProposal(projectId: string, proposalId: string, req: ProposalRefreshRequest) {
		return this.call('proposalRefresh', { params: { projectId, proposalId }, body: req });
	}
	/**
	 * An editing-automation pass (spec 15 EA-020…EA-022): `dryRun` → the `AutomationPassResult` at once; `propose`
	 * (default) → an `edit-automation` job (202) whose result is the `AutomationPassResult` naming the proposal.
	 */
	automationPass(
		projectId: string,
		pass: AutomationPassId,
		req: AutomationPassRequest,
		signal?: AbortSignal,
	) {
		return this.call('automationPass', {
			params: { projectId, pass },
			body: req,
			...(signal ? { signal } : {}),
		}) as Promise<AutomationPassResult | EngineJob>;
	}
	/** Style recipes (spec 15 EA-010): the built-ins and the user library, with what loading it repaired. */
	styleRecipes() {
		return this.call('styleRecipesList', {});
	}
	styleRecipe(recipeId: string) {
		return this.call('styleRecipeGet', { params: { recipeId } });
	}
	createStyleRecipe(req: StyleRecipeCreateRequest) {
		return this.call('styleRecipeCreate', { body: req });
	}
	updateStyleRecipe(recipeId: string, req: StyleRecipeUpdateRequest) {
		return this.call('styleRecipeUpdate', { params: { recipeId }, body: req });
	}
	duplicateStyleRecipe(recipeId: string, req: StyleRecipeDuplicateRequest = {}) {
		return this.call('styleRecipeDuplicate', { params: { recipeId }, body: req });
	}
	deleteStyleRecipe(recipeId: string) {
		return this.call('styleRecipeDelete', { params: { recipeId } });
	}
	/** Apply Style (spec 15 EA-012): `dryRun` → the result at once; `propose` → an `apply-style` job (202). */
	applyStyle(projectId: string, req: ApplyStyleRequest, signal?: AbortSignal) {
		return this.call('applyStyle', {
			params: { projectId },
			body: req,
			...(signal ? { signal } : {}),
		}) as Promise<ApplyStyleResult | EngineJob>;
	}
	/**
	 * Fix Transcript (spec 17 SC-090): a `transcript-fix` job (202). Its result (`TranscriptFixResultSchema`) names the
	 * stored `transcript-correction` proposal (`propose`) or carries the pre-run report (`dryRun`). `wait: true` waits for
	 * the job (a failed job is an EngineError with its code).
	 */
	transcriptFix(
		projectId: string,
		sequenceId: string,
		req: TranscriptFixRequest,
		opts: { wait?: boolean; signal?: AbortSignal } = {},
	) {
		return this.call('transcriptFix', {
			params: { projectId, sequenceId },
			body: req,
			...(opts.wait ? { query: { wait: '1' as const } } : {}),
			...(opts.signal ? { signal: opts.signal } : {}),
		});
	}
	/** Style Check (spec 15 EA-013) of a sequence against a recipe's targets. */
	styleCheck(projectId: string, req: StyleCheckRequest, signal?: AbortSignal) {
		return this.call('styleCheck', { params: { projectId }, body: req, ...(signal ? { signal } : {}) });
	}
	/** Proposal features of a project: Review groups, producers, whether agents may accept (spec 15 EA-001). */
	proposalFeatures(projectId: string) {
		return this.call('proposalFeatures', { params: { projectId } });
	}
	registerMedia(req: MediaRegisterRequest) {
		return this.call('mediaRegister', { body: req });
	}
	createUpload(req: UploadCreateRequest) {
		return this.call('uploadCreate', { body: req });
	}
	appendUpload(
		uploadId: string,
		offset: number,
		chunk: Blob | ArrayBuffer | Uint8Array,
		signal?: AbortSignal,
	) {
		return this.call('uploadAppend', { params: { uploadId }, query: { offset }, body: chunk, signal });
	}
	completeUpload(uploadId: string) {
		return this.call('uploadComplete', { params: { uploadId } });
	}
	abortUpload(uploadId: string) {
		return this.call('uploadAbort', { params: { uploadId } });
	}
	mediaStatus(mediaKey: string) {
		return this.call('mediaStatus', { params: { mediaKey } });
	}
	/** The status of many media in one request (at most MEDIA_STATUS_BATCH_MAX keys). */
	mediaStatusBatch(mediaKeys: string[]) {
		return this.call('mediaStatusBatch', { body: { mediaKeys } });
	}
	requestDerivatives(mediaKey: string, kinds: DerivativeKind[]) {
		return this.call('mediaDerivatives', { params: { mediaKey }, body: { kinds } });
	}
	listJobs(query: JobListQuery = {}) {
		return this.call('jobsList', { query });
	}
	getJob(jobId: string) {
		return this.call('jobGet', { params: { jobId } });
	}
	cancelJob(jobId: string) {
		return this.call('jobCancel', { params: { jobId } });
	}
	retryJob(jobId: string) {
		return this.call('jobRetry', { params: { jobId } });
	}
	planExport(req: ExportPlanRequest) {
		return this.call('exportPlan', { body: req });
	}
	startExport(req: ExportStartRequest): Promise<EngineJob> {
		return this.call('exportStart', { body: req });
	}
	/** Loudness / peaks / activity analysis job (`wait` answers the finished job). */
	analyzeAudio(req: AudioAnalyzeRequest, wait = false): Promise<EngineJob> {
		return this.call('audioAnalyze', { body: req, ...(wait ? { query: { wait: '1' as const } } : {}) });
	}
	/** A music remix plan for a clip's content range (synchronous). */
	remixPlan(req: RemixPlanRequest): Promise<RemixPlanResult> {
		return this.call('audioRemixPlan', { body: req });
	}
	/**
	 * Essential Sound Auto Tag: starts an `audio-classify` job (`POST /api/audio/classify`, spec 12 P6-R3) classifying
	 * clips or media as dialogue / music / SFX / ambience; result `AudioClassifyResult`. `wait` answers when it ends.
	 */
	classifyAudio(
		req: AudioClassifyRequest,
		opts: { wait?: boolean; signal?: AbortSignal } = {},
	): Promise<EngineJob> {
		return this.call('audioClassify', {
			body: req,
			...(opts.wait ? { query: { wait: '1' as const } } : {}),
			...(opts.signal ? { signal: opts.signal } : {}),
		});
	}
	/** Tempo, beats and downbeats of a media's audio range (`POST /api/audio/beats`; cached per file and range). */
	audioBeats(req: BeatsRequest, signal?: AbortSignal): Promise<BeatsResult> {
		return this.call('audioBeats', { body: req, ...(signal ? { signal } : {}) });
	}
	/** A loudness-normalised WAV version of a media (job; result LoudnessNormalizeResult). */
	normalizeMediaLoudness(mediaKey: string, req: LoudnessNormalizeRequest, wait = false): Promise<EngineJob> {
		return this.call('mediaLoudnessNormalize', {
			params: { key: mediaKey },
			body: req,
			...(wait ? { query: { wait: '1' as const } } : {}),
		});
	}

	/**
	 * spec 18 AF-OPS-001: a derivation op on a media (job `derive`, result DeriveResult; commit it with `media.derive`).
	 * Refusals (`NO_AUDIO`, `UNSUPPORTED_RATE`, `OUT_OF_RANGE`…) reject with that code; `wait` answers the finished job.
	 */
	deriveMedia(mediaKey: string, req: DeriveRequest, opts: { wait?: boolean } = {}): Promise<EngineJob> {
		return this.call('mediaDerive', {
			params: { key: mediaKey },
			body: req,
			...(opts.wait ? { query: { wait: '1' as const } } : {}),
		});
	}

	/** The interpreted picture of a media (display / proxy / master of a pixel variant); queues it when missing. */
	requestMediaVariant(mediaKey: string, req: MediaVariantRequest) {
		return this.call('mediaVariant', { params: { mediaKey }, body: req });
	}
	/** Numbered stills → one media (job `image-sequence`, result RegisteredMedia). */
	importImageSequence(req: ImageSequenceRequest, wait = false): Promise<EngineJob> {
		return this.call('importsImageSequence', {
			body: req,
			...(wait ? { query: { wait: '1' as const } } : {}),
		});
	}
	detectImageSequence(path: string) {
		return this.call('importsImageSequenceDetect', { body: { path } });
	}
	/** The layers of a PSD extracted and registered (job `layers`, result LayeredExtractResult). */
	extractLayers(mediaKey: string, projectId?: string, wait = false, merge?: number[]): Promise<EngineJob> {
		return this.call('importsLayers', {
			body: { mediaKey, ...(projectId ? { projectId } : {}), ...(merge ? { merge } : {}) },
			...(wait ? { query: { wait: '1' as const } } : {}),
		});
	}
	vectorPages(mediaKey: string) {
		return this.call('importsVectorPages', { params: { mediaKey } });
	}
	exportLottie(req: LottieExportRequest) {
		return this.call('importsLottieExport', { body: req });
	}
	/**
	 * Uploads one frame of an image sequence (purpose `sequence-frame`): the upload is not registered as media, it is
	 * consumed by `importImageSequence({uploadIds})`. Returns the upload id.
	 */
	async uploadSequenceFrame(
		blob: Blob,
		opts: UploadOptions & {
			projectId: string;
			fileName?: string;
		},
	): Promise<string> {
		const fileName = opts.fileName ?? this.blobName(blob) ?? 'frame.bin';
		const session = await this.createUpload({
			projectId: opts.projectId,
			fileName,
			byteSize: blob.size,
			mimeType: blob.type || 'application/octet-stream',
			purpose: 'sequence-frame',
		});
		try {
			await this.uploadChunks(blob, session, opts);
		} catch (error) {
			await this.abortFailedUpload(session.uploadId, error);
			throw error;
		}
		return session.uploadId;
	}
	/**
	 * Spec 14 TC-001: a `voice-analysis` job for one audio stream of a media (default: its first audio stream; result
	 * `VoiceAnalysisJobResult`). Finishes at once when the analysis is cached.
	 */
	analyzeVoice(mediaKey: string, req: VoiceAnalyzeRequest = {}, wait = false): Promise<EngineJob> {
		return this.call('voiceAnalyze', {
			params: { key: mediaKey },
			body: req,
			...(wait ? { query: { wait: '1' as const } } : {}),
		});
	}
	/**
	 * The cached voice analysis of a stream, decoded and validated (`decodeVoiceAnalysis`). Throws EngineError
	 * `VOICE_ANALYSIS_NOT_FOUND` (404) when there is none yet — run `analyzeVoice` — and `INVALID_RESPONSE` for a file
	 * that does not validate.
	 */
	async getVoiceAnalysis(
		mediaKey: string,
		streamIndex?: number,
		signal?: AbortSignal,
	): Promise<VoiceAnalysis> {
		const path = buildPath(ROUTES.voiceAnalysisGet.path, { key: mediaKey });
		const res = await this.fetchResponse(
			this.url(path, streamIndex === undefined ? undefined : { streamIndex }),
			{ headers: this.authorizationHeaders(), signal, credentials: 'include' },
		);
		if (!res.ok) {
			let json: unknown = null;
			try {
				json = JSON.parse(await res.text());
			} catch {
				json = null;
			}
			const shape = ErrorShapeSchema.safeParse(json);
			if (shape.success) throw EngineError.fromShape(shape.data, res.status);
			throw new EngineError(res.status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR', `HTTP ${res.status}`, {
				status: res.status,
				retryable: res.status >= 500,
			});
		}
		const len = Number(res.headers.get('content-length') ?? '0');
		if (len > VOICE_ANALYSIS_MAX_FILE_BYTES)
			throw new EngineError('INVALID_RESPONSE', 'Voice analysis file too large', { status: res.status });
		const r = decodeVoiceAnalysis(new Uint8Array(await res.arrayBuffer()));
		if (!r.ok)
			throw new EngineError('INVALID_RESPONSE', `Invalid voice analysis from the engine: ${r.error}`, {
				status: res.status,
			});
		return r.analysis;
	}
	/**
	 * Spec 14: a `cleanup-analysis` job — voice analyses of the sequence's speech media (cached or computed), the
	 * detector and the planner (result `CleanupAnalysisJobResult`; the full analysis via `getCleanupAnalysis`).
	 */
	analyzeCleanup(req: CleanupAnalyzeRequest, wait = false): Promise<EngineJob> {
		return this.call('cleanupAnalyze', { body: req, ...(wait ? { query: { wait: '1' as const } } : {}) });
	}
	/** The analysis of a finished `cleanup-analysis` job (validated); EngineError `CLEANUP_ANALYSIS_NOT_FOUND` once evicted. */
	getCleanupAnalysis(analysisId: string): Promise<CleanupAnalysisFile> {
		return this.call('cleanupAnalysisGet', { params: { analysisId } });
	}
	/** Scene Edit Detection of a media range (job; result SceneDetectResult). */
	detectScenes(req: SceneDetectRequest, wait = false): Promise<EngineJob> {
		return this.call('scenesDetect', { body: req, ...(wait ? { query: { wait: '1' as const } } : {}) });
	}
	requestStill(req: StillRequest): Promise<EngineJob> {
		return this.call('stills', { body: req });
	}

	/** Which segment hashes have render preview files (video / audio) in a preview format. */
	previewStatus(req: PreviewStatusRequest): Promise<PreviewStatus> {
		return this.call('previewStatus', { body: req });
	}
	/** Sequence ▸ Render…: a `preview` job, or `{job: null}` when every segment is rendered already. */
	renderPreviews(
		req: PreviewRenderRequest,
		wait = false,
	): Promise<EngineJob | { job: null; existing: number }> {
		return this.call('previewRender', {
			body: req,
			...(wait ? { query: { wait: '1' as const } } : {}),
		});
	}
	/** Delete Render Files (`{all: true}`) / Delete Render Files In to Out (`{hashes}`). */
	deletePreviews(req: PreviewDeleteRequest): Promise<PreviewDeleteResult> {
		return this.call('previewDelete', { body: req });
	}
	/** Lumetri Scopes of a rendered frame as numbers. */
	gradingScopes(req: GradingScopesRequest, signal?: AbortSignal) {
		return this.call('gradingScopes', { body: req, ...(signal ? { signal } : {}) });
	}
	/** Colour Match of a clip to a reference frame (Lumetri params to apply). */
	gradingMatch(req: ColorMatchRequest, signal?: AbortSignal) {
		return this.call('gradingMatch', { body: req, ...(signal ? { signal } : {}) });
	}
	/** Basic Correction ▸ Auto of a clip (Lumetri params to apply). */
	gradingAutoTone(req: AutoToneRequest, signal?: AbortSignal) {
		return this.call('gradingAutoTone', { body: req, ...(signal ? { signal } : {}) });
	}
	listFonts() {
		return this.call('fontsList');
	}
	/** wp fonts: the user font library (every installed face, limits, repairs made on open). */
	fontLibrary() {
		return this.call('fontLibraryList');
	}
	/** wp fonts: installs a font file (TTF, OTF, TTC, WOFF, WOFF2) into the user font library. */
	installFont(file: Blob | ArrayBuffer | Uint8Array, fileName?: string, signal?: AbortSignal) {
		const name = fileName ?? (file instanceof Blob ? this.blobName(file) : undefined);
		return this.call('fontInstall', {
			body: file,
			...(name ? { query: { fileName: name.slice(0, 255) } } : {}),
			...(signal ? { signal } : {}),
		});
	}
	/** wp fonts: installs a font file from the engine's machine (local mode). */
	installFontPath(path: string) {
		return this.call('fontInstallPath', { body: { path } });
	}
	removeFont(fontId: string) {
		return this.call('fontDelete', { params: { fontId } });
	}
	/** wp fonts: the saved projects that use a library face. */
	fontUsage(fontId: string) {
		return this.call('fontUsage', { params: { fontId } });
	}
	/** Spec 17 SC-070: the personal speech glossary (entries, read-only state, repairs made on open). */
	listGlossary() {
		return this.call('glossaryList');
	}
	getGlossaryEntry(entryId: string) {
		return this.call('glossaryGet', { params: { entryId } });
	}
	/** Adds an entry, or merges its spellings into the entry with the same `to` and `lang` (idempotent). */
	saveGlossaryEntry(req: GlossarySaveRequest) {
		return this.call('glossarySave', { body: req });
	}
	/** SC-071 "Remember": add or merge like `saveGlossaryEntry`, and count one more teaching. */
	rememberGlossaryEntry(req: GlossarySaveRequest) {
		return this.call('glossaryRemember', { body: req });
	}
	updateGlossaryEntry(entryId: string, patch: GlossaryUpdateRequest) {
		return this.call('glossaryUpdate', { params: { entryId }, body: patch });
	}
	/** Deletes an entry (an agent's request waits for the user's approval in an editor window). */
	removeGlossaryEntry(entryId: string) {
		return this.call('glossaryDelete', { params: { entryId } });
	}
	/** Merges a glossary file (an export, or a list of `{from, to, lang?}`) into the glossary. */
	importGlossary(file: GlossaryImportRequest['file']) {
		return this.call('glossaryImport', { body: { file } });
	}
	/** The whole glossary as an importable `jasper-speech-glossary` file. */
	exportGlossary() {
		return this.call('glossaryExport');
	}
	mgTemplates() {
		return this.call('mgTemplates');
	}
	mgRender(req: MgRenderRequest): Promise<EngineJob> {
		return this.call('mgRender', { body: req });
	}
	agentSchema() {
		return this.call('agentSchema');
	}
	agentQuery(req: AgentQueryRequest) {
		return this.call('agentQuery', { body: req });
	}
	agentTx(req: AgentTxRequest) {
		return this.call('agentTx', { body: req });
	}
	agentOpenProject(req: AgentOpenProjectRequest) {
		return this.call('agentOpenProject', { body: req });
	}
	/** Live-UI automation of an open editor window. */
	agentUi(req: AgentUiRequest, signal?: AbortSignal) {
		return this.call('agentUi', { body: req, signal });
	}
	agentMcpInfo() {
		return this.call('agentMcpInfo');
	}

	/**
	 * GETs an engine-relative URL (e.g. a still's `/renders/<jobId>/output`) as bytes with the client's
	 * auth. Throws EngineError on HTTP errors.
	 */
	async fetchBytes(path: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string }> {
		const url = /^https?:/.test(path) ? path : this.url(path);
		const res = await this.fetchResponse(url, {
			headers: this.authorizationHeaders(),
			signal,
			credentials: 'include',
		});
		if (!res.ok)
			throw new EngineError(
				res.status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR',
				`HTTP ${res.status} for ${path}`,
				{
					status: res.status,
				},
			);
		return {
			bytes: new Uint8Array(await res.arrayBuffer()),
			contentType: res.headers.get('content-type') ?? 'application/octet-stream',
		};
	}

	/** Same-origin media URL (ARCHITECTURE §8, S04:MS-001). */
	mediaUrl(mediaKey: string, variant: MediaVariant = 'original'): string {
		const k = encodeURIComponent(mediaKey);
		if (variant === 'original') return this.url(`/media/${k}`);
		if (variant === 'poster') return this.url(`/media/${k}/poster.jpg`);
		if (variant === 'sprite.json') return this.url(`/media/${k}/sprite.json`);
		if (variant === 'peaks.json') return this.url(`/media/${k}/peaks.json`);
		if (variant === 'playback-audio.json') return this.url(`/media/${k}/playback-audio.json`);
		if ('proxy' in variant) return this.url(`/media/${k}/proxy/${variant.proxy}`);
		if ('sprite' in variant) return this.url(`/media/${k}/sprite/${variant.sprite}.jpg`);
		return this.url(`/media/${k}/peaks/${variant.peaks}.bin`);
	}
	renderOutputUrl(jobId: string): string {
		return this.url(buildPath(ROUTES.renderOutput.path, { jobId }));
	}
	/** Download URL of a file of a finished interchange export. */
	interchangeOutputUrl(jobId: string, name: string, download = false): string {
		return this.url(
			buildPath(ROUTES.interchangeOutput.path, { jobId, name }),
			download ? { download: 1 } : undefined,
		);
	}
	/** Download URL of an export's sidecar caption file. */
	renderCaptionFileUrl(jobId: string, name: string): string {
		return this.url(buildPath(ROUTES.renderCaptionFile.path, { jobId, name }));
	}
	/** Download URL of an export's sound credits sidecar (`result.credits.name`). */
	renderCreditsFileUrl(jobId: string, name: string): string {
		return this.url(buildPath(ROUTES.renderCreditsFile.path, { jobId, name }));
	}
	mgFileUrl(key: string, file: string): string {
		return this.url(buildPath(ROUTES.mgFile.path, { key, file }));
	}
	eventsUrl(opts: { since?: number | null; projectId?: string } = {}): string {
		return this.url('/events', { since: opts.since ?? undefined, projectId: opts.projectId });
	}
	agentWsUrl(): string {
		const base =
			this.baseUrl || (typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1:47900');
		return `${base.replace(/^http/, 'ws')}/agent`;
	}

	/** Opens the NDJSON event stream; reconnects with 1 s → 30 s backoff and resumes with `since`. */
	openEvents(opts: { since?: number | null; projectId?: string }, handlers: EventHandlers): EventStream {
		return openEventStream(
			this.fetchImpl,
			(since) => this.eventsUrl({ since, projectId: opts.projectId }),
			handlers,
			{
				since: opts.since ?? null,
				headers: this.authorizationHeaders(),
			},
		);
	}

	/**
	 * Resumable chunked upload (S04:IN-005): create → PUT chunks with byte offsets → complete. Offset
	 * mismatches (409) resume from the engine's offset; aborting deletes the upload session.
	 */
	async uploadFile(
		blob: Blob,
		opts: UploadOptions & {
			projectId: string;
			fileName?: string;
			mimeType?: string;
			clientFingerprint?: string;
		},
	): Promise<RegisteredMedia> {
		const fileName = opts.fileName ?? this.blobName(blob) ?? 'upload.bin';
		const session = await this.createUpload({
			projectId: opts.projectId,
			fileName,
			byteSize: blob.size,
			mimeType: opts.mimeType ?? (blob.type || 'application/octet-stream'),
			...(opts.clientFingerprint ? { clientFingerprint: opts.clientFingerprint } : {}),
		});
		try {
			await this.uploadChunks(blob, session, opts);
			return await this.completeUpload(session.uploadId);
		} catch (error) {
			if (opts.signal?.aborted) await this.abortFailedUpload(session.uploadId, error);
			throw error;
		}
	}

	async uploadChunks(blob: Blob, session: UploadCreateResponse, opts: UploadOptions = {}): Promise<void> {
		let offset = session.offset;
		let conflicts = 0;
		const validateOffset = (value: number) => {
			if (!Number.isSafeInteger(value) || value < 0 || value > blob.size)
				throw new EngineError('INVALID_RESPONSE', 'Upload offset is outside the file', {
					detail: { offset: value, size: blob.size },
				});
		};
		if (!Number.isSafeInteger(session.chunkSize) || session.chunkSize <= 0)
			throw new EngineError('INVALID_RESPONSE', 'Upload chunk size must be a positive integer');
		validateOffset(offset);
		opts.onProgress?.({ loaded: offset, total: blob.size });
		while (offset < blob.size) {
			opts.signal?.throwIfAborted();
			const end = Math.min(blob.size, offset + session.chunkSize);
			try {
				const response = await this.appendUpload(
					session.uploadId,
					offset,
					blob.slice(offset, end),
					opts.signal,
				);
				validateOffset(response.offset);
				if (response.offset !== end)
					throw new EngineError(
						'INVALID_RESPONSE',
						'Upload acknowledgement does not match the submitted chunk',
						{
							detail: { offset: response.offset, expectedOffset: end },
						},
					);
				offset = response.offset;
			} catch (error) {
				const mismatch =
					error instanceof EngineError && error.code === 'UPLOAD_OFFSET_MISMATCH'
						? UploadOffsetMismatchSchema.safeParse(error.detail)
						: null;
				if (!mismatch?.success || ++conflicts > 5) throw error;
				validateOffset(mismatch.data.expectedOffset);
				offset = mismatch.data.expectedOffset;
			}
			opts.onProgress?.({ loaded: offset, total: blob.size });
		}
	}

	private blobName(blob: Blob): string | undefined {
		return 'name' in blob && typeof blob.name === 'string' ? blob.name : undefined;
	}

	private async abortFailedUpload(uploadId: string, originalError: unknown): Promise<void> {
		try {
			await this.abortUpload(uploadId);
		} catch (cleanupError) {
			throw new AggregateError(
				[originalError, cleanupError],
				'Upload failed and its session could not be removed',
			);
		}
	}

	private async fetchResponse(url: string, init: RequestInit): Promise<Response> {
		try {
			return await this.fetchImpl(url, init);
		} catch (error) {
			if (init.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
			throw new EngineError(
				'NETWORK',
				`Engine not reachable: ${error instanceof Error ? error.message : String(error)}`,
				{
					retryable: true,
				},
			);
		}
	}
}
