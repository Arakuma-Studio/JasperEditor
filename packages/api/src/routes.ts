import { EffectPresetFolderSchema, EffectPresetSchema } from '@jasper/project';
import { z } from 'zod';
import {
	AgentMcpInfoSchema,
	AgentOpenProjectRequestSchema,
	AgentOpenProjectResponseSchema,
	AgentQueryRequestSchema,
	AgentQueryResponseSchema,
	AgentSchemaResponseSchema,
	AgentTxRequestSchema,
	AgentTxResponseSchema,
	AgentUiRequestSchema,
	AgentUiResponseSchema,
} from './agent.ts';
import { AudioAnalyzeRequestSchema, LoudnessNormalizeRequestSchema } from './audio.ts';
import {
	AudioClassifyRequestSchema,
	BeatsRequestSchema,
	BeatsResultSchema,
	RemixPlanRequestSchema,
	RemixPlanResultSchema,
} from './audio-fx.ts';
import {
	CacheCleanRequestSchema,
	CacheGcReportSchema,
	CacheLocationCheckSchema,
	CacheLocationRequestSchema,
	CacheMoveRequestSchema,
	CacheSettingsSchema,
	CacheUsageSchema,
} from './cache.ts';
import { CamTrackSolveRequestSchema } from './camtrack.ts';
import { EngineCapabilitiesSchema, HealthSchema, LicensesResponseSchema } from './capabilities.ts';
import { CaptionFileReadRequestSchema, CaptionFileReadResponseSchema } from './captions.ts';
import {
	EffectPresetCreateRequestSchema,
	EffectPresetDeleteResponseSchema,
	EffectPresetFolderCreateRequestSchema,
	EffectPresetFolderUpdateRequestSchema,
	EffectPresetImportRequestSchema,
	EffectPresetImportResponseSchema,
	EffectPresetLibraryResponseSchema,
	EffectPresetUpdateRequestSchema,
} from './effect-presets.ts';
import {
	ExportPlanRequestSchema,
	ExportStartRequestSchema,
	RenderPlanSchema,
	StillRequestSchema,
} from './exports.ts';
import {
	FontCatalogSchema,
	FontDeleteResponseSchema,
	FontInstallPathRequestSchema,
	FontInstallResponseSchema,
	FontLibraryResponseSchema,
	FontUsageResponseSchema,
} from './fonts.ts';
import {
	EngineGapsInfoSchema,
	EngineGapsSettingsSchema,
	MediaJobRequestSchema,
	MediaLocationSchema,
	MediaOpenRequestSchema,
	MediaOpenResponseSchema,
	ProjectManagerEstimateSchema,
	ProjectManagerRequestSchema,
	ReframeRequestSchema,
	ScratchCheckRequestSchema,
	ScratchCheckSchema,
	ScratchInfoSchema,
	WarpAnalysisRequestSchema,
} from './gaps.ts';
import {
	AutoToneRequestSchema,
	AutoToneResponseSchema,
	ColorMatchRequestSchema,
	ColorMatchResponseSchema,
	GradingScopesRequestSchema,
	GradingScopesResponseSchema,
} from './grading.ts';
import {
	ImageSequenceDetectRequestSchema,
	ImageSequenceDetectResponseSchema,
	ImageSequenceRequestSchema,
	LayeredExtractRequestSchema,
	LottieExportRequestSchema,
	LottieExportResultSchema,
	MediaVariantRequestSchema,
	MediaVariantStatusSchema,
	VectorPagesResponseSchema,
} from './imports.ts';
import {
	AssetRelinkRequestSchema,
	AssetRelinkResponseSchema,
	InterchangeExportRequestSchema,
	InterchangeImportRequestSchema,
	InterchangeImportResponseSchema,
	InterchangePrerenderPlanRequestSchema,
	InterchangePrerenderPlanResponseSchema,
	RelinkScanRequestSchema,
	RelinkScanResultSchema,
} from './interchange.ts';
import { EngineJobSchema, JobListQuerySchema, JobListResponseSchema } from './jobs.ts';
import { LayerBakePreviewRequestSchema } from './layer-bake.ts';
import { MaskTraceRequestSchema, MaskTraceResponseSchema } from './masks.ts';
import {
	DerivativesRequestSchema,
	MediaDiscardResponseSchema,
	MediaRegisterRequestSchema,
	MediaRegisterResponseSchema,
	MediaStatusBatchRequestSchema,
	MediaStatusBatchResponseSchema,
	MediaStatusSchema,
	RegisteredMediaSchema,
	UploadAppendResponseSchema,
	UploadCreateRequestSchema,
	UploadCreateResponseSchema,
} from './media.ts';
import {
	BrowseInfoSchema,
	BrowseListQuerySchema,
	BrowseListSchema,
	BrowsePathQuerySchema,
	BrowseRootsSchema,
	BrowseThumbnailQuerySchema,
} from './media-browser.ts';
import { MgRenderRequestSchema, MgTemplatesResponseSchema } from './mg.ts';
import {
	MgBundleImportRequestSchema,
	MgBundleRebuildRequestSchema,
	MgBundleScaffoldRequestSchema,
	MgPrerenderRequestSchema,
	MgPrerenderResultSchema,
	MgTextMeasureRequestSchema,
	MgTextMeasureResultSchema,
} from './mg-bundles.ts';
import {
	PreviewDeleteRequestSchema,
	PreviewDeleteResultSchema,
	PreviewRenderNothingSchema,
	PreviewRenderRequestSchema,
	PreviewStatusRequestSchema,
	PreviewStatusSchema,
} from './previews.ts';
import {
	ProcessingModelsResponseSchema,
	ProcessingSettingsSchema,
	ProcessRequestSchema,
	RemoteProbeResultSchema,
} from './processing.ts';
import {
	EnvelopeSchema,
	LeaseRequestSchema,
	LeaseSchema,
	OkSchema,
	ProjectCreateRequestSchema,
	ProjectCreateResponseSchema,
	ProjectGetResponseSchema,
	ProjectListResponseSchema,
	ProjectPutResponseSchema,
	ProjectViewSchema,
	RecoveryGetResponseSchema,
	RecoveryListResponseSchema,
	RecoveryPutRequestSchema,
	RecoveryPutResponseSchema,
	VersionGetResponseSchema,
	VersionListResponseSchema,
	VersionRestoreRequestSchema,
	VersionRestoreResponseSchema,
} from './projects.ts';
import {
	ProposalAcceptRequestSchema,
	ProposalAcceptResponseSchema,
	ProposalCreateRequestSchema,
	ProposalCreateResponseSchema,
	ProposalDecisionResponseSchema,
	ProposalDeleteResponseSchema,
	ProposalFeaturesResponseSchema,
	ProposalGetQuerySchema,
	ProposalListResponseSchema,
	ProposalMarkAppliedRequestSchema,
	ProposalNoteRequestSchema,
	ProposalRefreshRequestSchema,
	ProposalRefreshResponseSchema,
	ProposalRejectRequestSchema,
	ProposalReopenRequestSchema,
	ProposalResponseSchema,
	ProposalSelectRequestSchema,
} from './proposals.ts';
import {
	RotoSegmentRequestSchema,
	RotoStoreInfoSchema,
	RotoTraceRequestSchema,
	RotoTraceResponseSchema,
	VisionModelsResponseSchema,
} from './roto.ts';
import { SceneDetectRequestSchema } from './scenes.ts';
import {
	SoundBedsPlanSchema,
	SoundBedsRequestSchema,
	SoundRoomTonePlanSchema,
	SoundRoomToneRequestSchema,
} from './sound-beds.ts';
import {
	SoundCheckLastRequestSchema,
	SoundCheckLastResponseSchema,
	SoundCheckRequestSchema,
	SoundVisualRequestSchema,
	SoundVisualResponseSchema,
} from './sound-check.ts';
import {
	MotionAnalysisRequestSchema,
	SfxRebalanceRequestSchema,
	SoundCuesRequestSchema,
	SoundCuesResponseSchema,
	SoundDeliveryRequestSchema,
	SoundDesignPlanRequestSchema,
	SoundListenRequestSchema,
	SoundPeakRequestSchema,
	SoundPeakResponseSchema,
} from './sound-design.ts';
import {
	SoundProfileBuildRequestSchema,
	SoundProfileDeleteResponseSchema,
	SoundProfileImportRequestSchema,
	SoundProfileRenameRequestSchema,
	SoundProfileSchema,
	SoundProfileSummarySchema,
	SoundProfilesResponseSchema,
} from './sound-profile.ts';
import {
	SoundEmbedRequestSchema,
	SoundMatchRequestSchema,
	SoundMatchResponseSchema,
	SoundMomentRequestSchema,
	SoundSemanticModelDeleteResponseSchema,
	SoundSemanticModelsResponseSchema,
	SoundSemanticStatusSchema,
} from './sound-semantic.ts';
import {
	RegisterSoundRequestSchema,
	RegisterSoundResponseSchema,
	SoundEntrySchema,
	SoundIndexRequestSchema,
	SoundLibraryStatusSchema,
	SoundPackRemoveResponseSchema,
	SoundPacksResponseSchema,
	SoundRootsPutRequestSchema,
	SoundRootsPutResponseSchema,
	SoundRootsResponseSchema,
	SoundSearchQuerySchema,
	SoundSearchResponseSchema,
	SoundVisualSchema,
} from './sounds.ts';
import {
	SpeechModelDeleteResponseSchema,
	SpeechModelsResponseSchema,
	TranscribeMediaRequestSchema,
	TranscribeSequenceRequestSchema,
} from './speech.ts';
import { SyncAudioRequestSchema, SyncAudioResponseSchema } from './sync.ts';
import { TrackRequestSchema } from './tracking.ts';
import { VoiceAnalysisQuerySchema, VoiceAnalyzeRequestSchema } from './voice.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type RouteDef = {
	method: HttpMethod;
	path: string;
	/** Query-string schema (values are strings on the wire). */
	query?: z.ZodType;
	/** JSON body schema, or 'binary' for application/octet-stream bodies. */
	body?: z.ZodType | 'binary';
	/** JSON response schema, or a non-JSON response kind. */
	response: z.ZodType | 'binary' | 'ndjson' | 'websocket';
	/** Request headers the route relies on. */
	headers?: readonly string[];
	public?: boolean;
};

export const ROUTES = {
	health: { method: 'GET', path: '/health', response: HealthSchema, public: true },
	capabilities: {
		method: 'GET',
		path: '/api/capabilities',
		response: EngineCapabilitiesSchema,
	},
	/** Third-party licenses for the About dialog (D-13: FFmpeg license text + source link). */
	licenses: {
		method: 'GET',
		path: '/api/licenses',
		response: LicensesResponseSchema,
	},
	events: {
		method: 'GET',
		path: '/events',
		query: z.object({ since: z.string().optional(), projectId: z.string().optional() }),
		response: 'ndjson',
	},

	projectsList: {
		method: 'GET',
		path: '/api/projects',
		response: ProjectListResponseSchema,
	},
	projectsCreate: {
		method: 'POST',
		path: '/api/projects',
		body: ProjectCreateRequestSchema,
		response: ProjectCreateResponseSchema,
	},
	projectGet: {
		method: 'GET',
		path: '/api/projects/:projectId',
		response: ProjectGetResponseSchema,
	},
	projectPut: {
		method: 'PUT',
		path: '/api/projects/:projectId',
		body: EnvelopeSchema,
		headers: ['if-match'],
		response: ProjectPutResponseSchema,
	},
	projectPutView: {
		method: 'PUT',
		path: '/api/projects/:projectId/view',
		body: ProjectViewSchema,
		response: OkSchema,
	},
	projectVersions: {
		method: 'GET',
		path: '/api/projects/:projectId/versions',
		response: VersionListResponseSchema,
	},
	projectVersionGet: {
		method: 'GET',
		path: '/api/projects/:projectId/versions/:versionId',
		response: VersionGetResponseSchema,
	},
	projectVersionRestore: {
		method: 'POST',
		path: '/api/projects/:projectId/versions/:versionId/restore',
		body: VersionRestoreRequestSchema,
		response: VersionRestoreResponseSchema,
	},
	projectRecoveryList: {
		method: 'GET',
		path: '/api/projects/:projectId/recovery',
		response: RecoveryListResponseSchema,
	},
	projectRecoveryGet: {
		method: 'GET',
		path: '/api/projects/:projectId/recovery/:sessionId',
		response: RecoveryGetResponseSchema,
	},
	projectRecoveryPut: {
		method: 'PUT',
		path: '/api/projects/:projectId/recovery/:sessionId',
		body: RecoveryPutRequestSchema,
		response: RecoveryPutResponseSchema,
	},
	projectRecoveryDelete: {
		method: 'DELETE',
		path: '/api/projects/:projectId/recovery/:sessionId',
		query: z.object({ leaseId: z.string().optional() }),
		response: OkSchema,
	},
	projectDelete: {
		method: 'DELETE',
		path: '/api/projects/:projectId',
		response: OkSchema,
	},
	leaseAcquire: {
		method: 'POST',
		path: '/api/projects/:projectId/lease',
		body: LeaseRequestSchema,
		response: LeaseSchema,
	},
	leaseHeartbeat: {
		method: 'POST',
		path: '/api/projects/:projectId/lease/:leaseId/heartbeat',
		response: LeaseSchema,
	},
	leaseRelease: {
		method: 'DELETE',
		path: '/api/projects/:projectId/lease/:leaseId',
		response: OkSchema,
	},

	mediaRegister: {
		method: 'POST',
		path: '/api/media/register',
		body: MediaRegisterRequestSchema,
		response: MediaRegisterResponseSchema,
	},
	uploadCreate: {
		method: 'POST',
		path: '/api/uploads',
		body: UploadCreateRequestSchema,
		response: UploadCreateResponseSchema,
	},
	uploadAppend: {
		method: 'PUT',
		path: '/api/uploads/:uploadId',
		query: z.object({ offset: z.string().regex(/^\d+$/) }),
		body: 'binary',
		response: UploadAppendResponseSchema,
	},
	uploadComplete: {
		method: 'POST',
		path: '/api/uploads/:uploadId/complete',
		response: RegisteredMediaSchema,
	},
	uploadAbort: { method: 'DELETE', path: '/api/uploads/:uploadId', response: OkSchema },
	mediaStatus: {
		method: 'GET',
		path: '/api/media/:mediaKey',
		response: MediaStatusSchema,
	},
	/** The status of many media in one request (project open). */
	mediaStatusBatch: {
		method: 'POST',
		path: '/api/media/status',
		body: MediaStatusBatchRequestSchema,
		response: MediaStatusBatchResponseSchema,
	},
	/** Discard an uncommitted upload (Replace Footage cancelled). */
	mediaDiscard: {
		method: 'DELETE',
		path: '/api/media/:mediaKey',
		response: MediaDiscardResponseSchema,
	},
	mediaDerivatives: {
		method: 'POST',
		path: '/api/media/:mediaKey/derivatives',
		body: DerivativesRequestSchema,
		response: JobListResponseSchema,
	},
	mediaFile: { method: 'GET', path: '/media/:mediaKey', response: 'binary' },
	mediaProxy: { method: 'GET', path: '/media/:mediaKey/proxy/:tier', response: 'binary' },
	mediaPoster: { method: 'GET', path: '/media/:mediaKey/poster.jpg', response: 'binary' },
	mediaSpriteIndex: {
		method: 'GET',
		path: '/media/:mediaKey/sprite.json',
		response: 'binary',
	},
	mediaSpriteSheet: {
		method: 'GET',
		path: '/media/:mediaKey/sprite/:sheet',
		response: 'binary',
	},
	mediaPeaksHeader: {
		method: 'GET',
		path: '/media/:mediaKey/peaks.json',
		response: 'binary',
	},
	mediaPeaksStream: {
		method: 'GET',
		path: '/media/:mediaKey/peaks/:stream',
		response: 'binary',
	},

	jobsList: {
		method: 'GET',
		path: '/api/jobs',
		query: JobListQuerySchema,
		response: JobListResponseSchema,
	},
	jobGet: { method: 'GET', path: '/api/jobs/:jobId', response: EngineJobSchema },
	jobCancel: {
		method: 'POST',
		path: '/api/jobs/:jobId/cancel',
		response: EngineJobSchema,
	},
	jobRetry: { method: 'POST', path: '/api/jobs/:jobId/retry', response: EngineJobSchema },

	exportPlan: {
		method: 'POST',
		path: '/api/exports/plan',
		body: ExportPlanRequestSchema,
		response: RenderPlanSchema,
	},
	exportStart: {
		method: 'POST',
		path: '/api/exports',
		body: ExportStartRequestSchema,
		response: EngineJobSchema,
	},
	renderOutput: { method: 'GET', path: '/renders/:jobId/output', response: 'binary' },
	/** A sidecar caption file of a finished export (`result.captions.sidecars[].name`). */
	renderCaptionFile: {
		method: 'GET',
		path: '/renders/:jobId/captions/:name',
		response: 'binary',
	},
	/** The sound credits sidecar of a finished export (`result.credits.name`, spec 12 §2.11). */
	renderCreditsFile: {
		method: 'GET',
		path: '/renders/:jobId/credits/:name',
		response: 'binary',
	},
	stills: {
		method: 'POST',
		path: '/api/stills',
		body: StillRequestSchema,
		response: EngineJobSchema,
	},
	/** Which segment hashes have render preview files. */
	previewStatus: {
		method: 'POST',
		path: '/api/previews/status',
		body: PreviewStatusRequestSchema,
		response: PreviewStatusSchema,
	},
	/** Render Effects In to Out / Render In to Out / Render Selection / Render Audio (job `preview`). */
	previewRender: {
		method: 'POST',
		path: '/api/previews/render',
		body: PreviewRenderRequestSchema,
		query: z.object({ wait: z.literal('1').optional() }),
		response: z.union([EngineJobSchema, PreviewRenderNothingSchema]),
	},
	/** Delete Render Files (all) / Delete Render Files In to Out (hashes). */
	previewDelete: {
		method: 'POST',
		path: '/api/previews/delete',
		body: PreviewDeleteRequestSchema,
		response: PreviewDeleteResultSchema,
	},
	/** Engine performance counters (process, event loop, host load, jobs, render throughput, previews). */
	perfStats: {
		method: 'GET',
		path: '/api/perf',
		response: z.record(z.string(), z.unknown()),
	},
	/** A preview file (`<hash>.mp4|webm|wav`), byte ranges, immutable. */
	previewFile: {
		method: 'GET',
		path: '/renders/previews/:format/:name',
		response: 'binary',
	},

	fontsList: { method: 'GET', path: '/api/fonts', response: FontCatalogSchema },
	fontFile: { method: 'GET', path: '/fonts/*', response: 'binary' },
	/** wp fonts: the user font library (shared by every project). */
	fontLibraryList: { method: 'GET', path: '/api/fonts/library', response: FontLibraryResponseSchema },
	/** Installs the font file sent as the body (TTF, OTF, TTC, WOFF, WOFF2; `fileName` names it). */
	fontInstall: {
		method: 'POST',
		path: '/api/fonts/library',
		query: z.object({ fileName: z.string().max(255).optional() }),
		body: 'binary',
		response: FontInstallResponseSchema,
	},
	/** Installs a font file from the engine's machine (local mode only). */
	fontInstallPath: {
		method: 'POST',
		path: '/api/fonts/library/install-path',
		body: FontInstallPathRequestSchema,
		response: FontInstallResponseSchema,
	},
	/** Removes a face (an agent's request needs the user's approval in the editor). */
	fontDelete: { method: 'DELETE', path: '/api/fonts/library/:fontId', response: FontDeleteResponseSchema },
	/** Saved projects that use the face. */
	fontUsage: { method: 'GET', path: '/api/fonts/library/:fontId/usage', response: FontUsageResponseSchema },

	mgTemplates: {
		method: 'GET',
		path: '/api/motion-graphics/templates',
		response: MgTemplatesResponseSchema,
	},
	mgRender: {
		method: 'POST',
		path: '/api/motion-graphics/render',
		body: MgRenderRequestSchema,
		response: EngineJobSchema,
	},
	mgFile: { method: 'GET', path: '/mg/:key/:file', response: 'binary' },

	agentSchema: {
		method: 'GET',
		path: '/api/agent/schema',
		response: AgentSchemaResponseSchema,
	},
	agentQuery: {
		method: 'POST',
		path: '/api/agent/query',
		body: AgentQueryRequestSchema,
		response: AgentQueryResponseSchema,
	},
	agentTx: {
		method: 'POST',
		path: '/api/agent/tx',
		body: AgentTxRequestSchema,
		response: AgentTxResponseSchema,
	},
	agentWs: { method: 'GET', path: '/agent', response: 'websocket' },
	agentOpenProject: {
		method: 'POST',
		path: '/api/agent/open-project',
		body: AgentOpenProjectRequestSchema,
		response: AgentOpenProjectResponseSchema,
	},
	agentMcpInfo: {
		method: 'GET',
		path: '/api/agent/mcp-info',
		response: AgentMcpInfoSchema,
	},
	/** Live-UI automation of an open editor window (mcp-cli): elements, input, screenshots, coordinate mapping. */
	agentUi: {
		method: 'POST',
		path: '/api/agent/ui',
		body: AgentUiRequestSchema,
		response: AgentUiResponseSchema,
	},
	/** MCP Streamable HTTP endpoint (same tools as the `jasper-mcp` stdio server). */
	mcp: { method: 'POST', path: '/mcp', response: 'binary' },

	mediaProcess: {
		method: 'POST',
		path: '/api/media/:key/process',
		body: ProcessRequestSchema,
		response: EngineJobSchema,
	},
	processingModels: {
		method: 'GET',
		path: '/api/processing/models',
		response: ProcessingModelsResponseSchema,
	},
	processingModelInstall: {
		method: 'POST',
		path: '/api/processing/models/:modelId/install',
		response: EngineJobSchema,
	},
	processingSettingsGet: {
		method: 'GET',
		path: '/api/settings/processing',
		response: ProcessingSettingsSchema,
	},
	processingSettingsPut: {
		method: 'PUT',
		path: '/api/settings/processing',
		body: ProcessingSettingsSchema,
		response: ProcessingSettingsSchema,
	},
	processingRemoteProbe: {
		method: 'POST',
		path: '/api/processing/remote/probe',
		response: RemoteProbeResultSchema,
	},
	processingRemoteSetup: {
		method: 'POST',
		path: '/api/processing/remote/setup',
		response: EngineJobSchema,
	},
	mgBundleImport: {
		method: 'POST',
		path: '/api/mg-bundles/import',
		body: MgBundleImportRequestSchema,
		response: RegisteredMediaSchema,
	},
	mgBundleRebuild: {
		method: 'POST',
		path: '/api/mg-bundles/:key/rebuild',
		body: MgBundleRebuildRequestSchema,
		response: EngineJobSchema,
	},
	/** PNG poster of one composition of a bundle at its `thumbnailFrame` (rendered once, cached). */
	mgBundlePoster: {
		method: 'GET',
		path: '/api/mg-bundles/:key/poster/:compositionId',
		response: 'binary',
	},
	/** P1 (S08:MGC-015): new composition project from the template, imported with watch. */
	mgBundleScaffold: {
		method: 'POST',
		path: '/api/mg-bundles/scaffold',
		body: MgBundleScaffoldRequestSchema,
		response: RegisteredMediaSchema,
	},
	mgBundlePrerender: {
		method: 'POST',
		path: '/api/mg-bundles/prerender',
		body: MgPrerenderRequestSchema,
		response: EngineJobSchema,
	},
	mgBundlePrerenderGet: {
		method: 'GET',
		path: '/api/mg-bundles/prerender/:renderKey',
		response: MgPrerenderResultSchema,
	},
	/** Wp-m3-mgtext (S08:MGC-037): text layout of a composition, measured in the engine's headless browser. */
	mgBundleMeasureTexts: {
		method: 'POST',
		path: '/api/mg-bundles/measure-texts',
		body: MgTextMeasureRequestSchema,
		response: MgTextMeasureResultSchema,
	},
	/** Static files of an imported bundle (the Remotion serve URL; the preview frame host loads it). */
	mgBundleFiles: { method: 'GET', path: '/mg/bundles/:key/*', response: 'binary' },
	/** Auto-trace a media frame into mask paths. */
	masksTrace: {
		method: 'POST',
		path: '/api/masks/trace',
		body: MaskTraceRequestSchema,
		response: MaskTraceResponseSchema,
	},
	trackingTrack: {
		method: 'POST',
		path: '/api/tracking/track',
		body: TrackRequestSchema,
		response: EngineJobSchema,
	},
	/** Scene Edit Detection of a media range (job kind `scene-detect`, `?wait=1` = finished job). */
	scenesDetect: {
		method: 'POST',
		path: '/api/scenes/detect',
		body: SceneDetectRequestSchema,
		query: z.object({ wait: z.enum(['1']).optional() }),
		response: EngineJobSchema,
	},

	/** Interpreted picture of a media (display PNG / proxy / master of a pixel variant); queues its job. */
	mediaVariant: {
		method: 'POST',
		path: '/api/media/:mediaKey/variants',
		body: MediaVariantRequestSchema,
		response: MediaVariantStatusSchema,
	},
	/** Numbered stills → one clip (job `image-sequence`; `?wait=1` = the finished job, result RegisteredMedia). */
	importsImageSequence: {
		method: 'POST',
		path: '/api/imports/image-sequence',
		body: ImageSequenceRequestSchema,
		query: z.object({ wait: z.enum(['1']).optional() }),
		response: EngineJobSchema,
	},
	/** The sequence a frame on the engine host belongs to (local mode). */
	importsImageSequenceDetect: {
		method: 'POST',
		path: '/api/imports/image-sequence/detect',
		body: ImageSequenceDetectRequestSchema,
		response: ImageSequenceDetectResponseSchema,
	},
	/** Every layer of a PSD extracted and registered (job `layers`; result LayeredExtractResult). */
	importsLayers: {
		method: 'POST',
		path: '/api/imports/layers',
		body: LayeredExtractRequestSchema,
		query: z.object({ wait: z.enum(['1']).optional() }),
		response: EngineJobSchema,
	},
	/** Pages of a PDF / Illustrator media. */
	importsVectorPages: {
		method: 'GET',
		path: '/api/imports/vector/:mediaKey',
		response: VectorPagesResponseSchema,
	},
	/** A sequence as a Lottie document (`.json` / `.lottie`) with the warnings of what Lottie cannot carry. */
	importsLottieExport: {
		method: 'POST',
		path: '/api/imports/lottie/export',
		body: LottieExportRequestSchema,
		response: LottieExportResultSchema,
	},
	/** Offsets of recordings of one event by their audio (two-pass GCC-PHAT). */
	syncAudio: {
		method: 'POST',
		path: '/api/sync/audio',
		body: SyncAudioRequestSchema,
		response: SyncAudioResponseSchema,
	},

	/** Graded VP9-alpha preview of one DOM layer (S11:LBK-010). */
	layerBakePreview: {
		method: 'POST',
		path: '/api/layer-bake/preview',
		body: LayerBakePreviewRequestSchema,
		response: EngineJobSchema,
	},
	/**
	 * Cached bake files (`master.mov`, `still.png`, `preview.webm`; `graded.png?n=<frame>` = frame n of the graded PNG
	 * sequence); signable for renders.
	 */
	layerBakeFiles: {
		method: 'GET',
		path: '/mg/layers/:key/:file',
		response: 'binary',
	},

	audioAnalyze: {
		method: 'POST',
		path: '/api/audio/analyze',
		body: AudioAnalyzeRequestSchema,
		query: z.object({ wait: z.enum(['1']).optional() }),
		response: EngineJobSchema,
	},
	mediaLoudnessNormalize: {
		method: 'POST',
		path: '/api/media/:key/loudness-normalize',
		body: LoudnessNormalizeRequestSchema,
		query: z.object({ wait: z.enum(['1']).optional() }),
		response: EngineJobSchema,
	},

	audioRemixPlan: {
		method: 'POST',
		path: '/api/audio/remix-plan',
		body: RemixPlanRequestSchema,
		response: RemixPlanResultSchema,
	},
	/** Tempo, beats and downbeats of a media's audio range (Sound Design beat cues; cached per file and range). */
	audioBeats: {
		method: 'POST',
		path: '/api/audio/beats',
		body: BeatsRequestSchema,
		response: BeatsResultSchema,
	},
	/**
	 * Essential Sound Auto Tag (spec 12 P6-R3): an `audio-classify` job classifying clips (over the media range each
	 * plays) or media as dialogue, music, SFX or ambience; cached per file and range. Result `AudioClassifyResult`.
	 */
	audioClassify: {
		method: 'POST',
		path: '/api/audio/classify',
		body: AudioClassifyRequestSchema,
		/** `wait=1`: answer when the job ends (the finished job; a failed job is a 422 with its code). */
		query: z.object({ wait: z.enum(['1']).optional() }),
		response: EngineJobSchema,
	},

	speechModels: {
		method: 'GET',
		path: '/api/speech/models',
		response: SpeechModelsResponseSchema,
	},
	/** Downloads and verifies a speech model: the processing catalogue's `model-download` job. */
	speechModelInstall: {
		method: 'POST',
		path: '/api/speech/models/:modelId/install',
		response: EngineJobSchema,
	},
	speechModelDelete: {
		method: 'DELETE',
		path: '/api/speech/models/:modelId',
		response: SpeechModelDeleteResponseSchema,
	},
	/** A `transcription` job for one audio stream of a media (result: `TranscriptionResult`, media time). */
	mediaTranscribe: {
		method: 'POST',
		path: '/api/media/:key/transcribe',
		body: TranscribeMediaRequestSchema,
		response: EngineJobSchema,
	},
	/** Spec 14 TC-001: a `voice-analysis` job for one audio stream of a media (result `VoiceAnalysisJobResult`). */
	voiceAnalyze: {
		method: 'POST',
		path: '/api/media/:key/voice-analysis',
		body: VoiceAnalyzeRequestSchema,
		query: z.object({ wait: z.enum(['1']).optional() }),
		response: EngineJobSchema,
	},
	/** The cached voice analysis file of a stream (`decodeVoiceAnalysis`); 404 `VOICE_ANALYSIS_NOT_FOUND` when none. */
	voiceAnalysisGet: {
		method: 'GET',
		path: '/api/media/:key/voice-analysis',
		query: VoiceAnalysisQuerySchema,
		response: 'binary',
	},
	/** A `transcription` job for the mixed audio of a sequence (result in sequence time). */
	speechTranscribeSequence: {
		method: 'POST',
		path: '/api/speech/transcribe-sequence',
		body: TranscribeSequenceRequestSchema,
		response: EngineJobSchema,
	},

	rotoModels: {
		method: 'GET',
		path: '/api/roto/models',
		response: VisionModelsResponseSchema,
	},
	/** Downloads and verifies a segmentation / face model: the processing catalogue's `model-download` job. */
	rotoModelInstall: {
		method: 'POST',
		path: '/api/roto/models/:modelId/install',
		response: EngineJobSchema,
	},
	rotoModelDelete: {
		method: 'DELETE',
		path: '/api/roto/models/:modelId',
		response: z.object({ modelId: z.string(), freedBytes: z.number() }),
	},
	/** A `roto` job: segmentation + propagation of a roto object, or face tracking (result: `RotoSegmentResult`). */
	rotoSegment: {
		method: 'POST',
		path: '/api/roto/segment',
		body: RotoSegmentRequestSchema,
		query: z.object({ wait: z.enum(['1']).optional() }),
		response: EngineJobSchema,
	},
	rotoSet: {
		method: 'GET',
		path: '/api/roto/sets/:key',
		response: RotoStoreInfoSchema,
	},
	/** Auto-traces frames of a matte set into normalised mask paths (Convert to Masks). */
	rotoTrace: {
		method: 'POST',
		path: '/api/roto/trace',
		body: RotoTraceRequestSchema,
		response: RotoTraceResponseSchema,
	},
	/** Frame `n` of a matte set (8-bit grey PNG); signable for renders. */
	rotoMatteFrame: {
		method: 'GET',
		path: '/mg/roto/:key',
		response: 'binary',
	},

	/** A `camtrack` job: feature tracking + camera solve of a span of a video (result: `CamTrackResult`). */
	camtrackSolve: {
		method: 'POST',
		path: '/api/camtrack/solve',
		body: CamTrackSolveRequestSchema,
		query: z.object({ wait: z.enum(['1']).optional() }),
		response: EngineJobSchema,
	},

	/** Usage per cache kind, budgets, last cleaning (Preferences ▸ Media Cache, MCP get_cache_usage). */
	cacheUsage: { method: 'GET', path: '/api/cache', response: CacheUsageSchema },
	/** "Clean Unused" / "Clean All (not in use)" / one automatic pass; answers when the pass is done. */
	cacheClean: {
		method: 'POST',
		path: '/api/cache/clean',
		body: CacheCleanRequestSchema,
		response: CacheGcReportSchema,
	},
	cacheSettingsGet: {
		method: 'GET',
		path: '/api/cache/settings',
		response: CacheSettingsSchema,
	},
	/** Validates a cache folder: writable, free space for a move, same disk (S04:CA-021). Local mode only. */
	cacheLocationCheck: {
		method: 'POST',
		path: '/api/cache/location/check',
		body: CacheLocationRequestSchema,
		response: CacheLocationCheckSchema,
	},
	/** Moves the cache (or starts a fresh one) to a folder: a `cache-move` job. Local mode only. */
	cacheLocationSet: {
		method: 'POST',
		path: '/api/cache/location',
		body: CacheMoveRequestSchema,
		response: EngineJobSchema,
	},
	cacheSettingsPut: {
		method: 'PUT',
		path: '/api/cache/settings',
		body: CacheSettingsSchema,
		response: CacheSettingsSchema,
	},

	effectPresetsList: {
		method: 'GET',
		path: '/api/effect-presets',
		response: EffectPresetLibraryResponseSchema,
	},
	/** Save Preset…: assigns the id and timestamps, answers the stored preset. */
	effectPresetCreate: {
		method: 'POST',
		path: '/api/effect-presets',
		body: EffectPresetCreateRequestSchema,
		response: EffectPresetSchema,
	},
	effectPresetUpdate: {
		method: 'PUT',
		path: '/api/effect-presets/:presetId',
		body: EffectPresetUpdateRequestSchema,
		response: EffectPresetSchema,
	},
	effectPresetDelete: {
		method: 'DELETE',
		path: '/api/effect-presets/:presetId',
		response: EffectPresetDeleteResponseSchema,
	},
	effectPresetFolderCreate: {
		method: 'POST',
		path: '/api/effect-presets/folders',
		body: EffectPresetFolderCreateRequestSchema,
		response: EffectPresetFolderSchema,
	},
	effectPresetFolderUpdate: {
		method: 'PUT',
		path: '/api/effect-presets/folders/:folderId',
		body: EffectPresetFolderUpdateRequestSchema,
		response: EffectPresetFolderSchema,
	},
	/** Deletes a bin with everything inside it. */
	effectPresetFolderDelete: {
		method: 'DELETE',
		path: '/api/effect-presets/folders/:folderId',
		response: EffectPresetDeleteResponseSchema,
	},
	effectPresetsImport: {
		method: 'POST',
		path: '/api/effect-presets/import',
		body: EffectPresetImportRequestSchema,
		response: EffectPresetImportResponseSchema,
	},

	/** Reads a timeline document (FCP7 XML, FCPXML, OTIO, EDL, AAF, OMF, ALE) into a `project.importTimeline` fragment. */
	interchangeImport: {
		method: 'POST',
		path: '/api/interchange/import',
		body: InterchangeImportRequestSchema,
		response: InterchangeImportResponseSchema,
	},
	/** The clips an export would pre-render (ProRes 4444 with alpha) for a format and mode. */
	interchangePrerenderPlan: {
		method: 'POST',
		path: '/api/interchange/prerender-plan',
		body: InterchangePrerenderPlanRequestSchema,
		response: InterchangePrerenderPlanResponseSchema,
	},
	/** Exports a sequence as a timeline document (job `interchange-export`, result `InterchangeExportResult`). */
	interchangeExport: {
		method: 'POST',
		path: '/api/interchange/export',
		body: InterchangeExportRequestSchema,
		response: EngineJobSchema,
	},
	/** A file of a finished interchange export (`result.files[].name`). */
	interchangeOutput: {
		method: 'GET',
		path: '/renders/:jobId/interchange/:name',
		response: 'binary',
	},
	/** S04:AS-011: registers a replacement file and compares it with the asset (fingerprint, duration, …). */
	assetRelink: {
		method: 'POST',
		path: '/api/assets/:assetId/relink',
		body: AssetRelinkRequestSchema,
		response: AssetRelinkResponseSchema,
	},
	/**
	 * S04:AS-011: finds offline assets — last known paths, Relink others automatically from located files (`anchors`)
	 * and a folder search (job `relink-scan`, result `RelinkScanSummary`).
	 */
	relinkScan: {
		method: 'POST',
		path: '/api/projects/:projectId/relink-scan',
		body: RelinkScanRequestSchema,
		response: EngineJobSchema,
	},
	/** The full `RelinkScanResult` of a finished `relink-scan` job. */
	relinkScanResult: {
		method: 'GET',
		path: '/api/projects/:projectId/relink-scan/:jobId',
		response: RelinkScanResultSchema,
	},
	/** Reads a caption or transcript file by path (local engines only; caption extensions, ≤ 64 MB). */
	captionFileRead: {
		method: 'POST',
		path: '/api/captions/read',
		body: CaptionFileReadRequestSchema,
		response: CaptionFileReadResponseSchema,
	},

	gradingScopes: {
		method: 'POST',
		path: '/api/grading/scopes',
		body: GradingScopesRequestSchema,
		response: GradingScopesResponseSchema,
	},
	gradingMatch: {
		method: 'POST',
		path: '/api/grading/match',
		body: ColorMatchRequestSchema,
		response: ColorMatchResponseSchema,
	},
	gradingAutoTone: {
		method: 'POST',
		path: '/api/grading/auto-tone',
		body: AutoToneRequestSchema,
		response: AutoToneResponseSchema,
	},

	browseRoots: { method: 'GET', path: '/api/browse/roots', response: BrowseRootsSchema },
	browseList: {
		method: 'GET',
		path: '/api/browse/list',
		query: BrowseListQuerySchema,
		response: BrowseListSchema,
	},
	browseInfo: {
		method: 'GET',
		path: '/api/browse/info',
		query: BrowsePathQuerySchema,
		response: BrowseInfoSchema,
	},
	browseThumbnail: {
		method: 'GET',
		path: '/api/browse/thumbnail',
		query: BrowseThumbnailQuerySchema,
		response: 'binary',
	},
	browseFile: {
		method: 'GET',
		path: '/api/browse/file',
		query: BrowsePathQuerySchema,
		response: 'binary',
		headers: ['range'],
	},

	mediaLocation: {
		method: 'GET',
		path: '/api/media/:mediaKey/location',
		response: MediaLocationSchema,
	},
	mediaOpen: {
		method: 'POST',
		path: '/api/media/:mediaKey/open',
		body: MediaOpenRequestSchema,
		response: MediaOpenResponseSchema,
	},

	projectScratch: {
		method: 'GET',
		path: '/api/projects/:projectId/scratch',
		response: ScratchInfoSchema,
	},
	scratchCheck: {
		method: 'POST',
		path: '/api/scratch/check',
		body: ScratchCheckRequestSchema,
		response: ScratchCheckSchema,
	},

	gapsSettingsGet: {
		method: 'GET',
		path: '/api/settings/gaps',
		response: EngineGapsInfoSchema,
	},
	gapsSettingsPut: {
		method: 'PUT',
		path: '/api/settings/gaps',
		body: EngineGapsSettingsSchema.partial(),
		response: EngineGapsInfoSchema,
	},

	projectManagerPlan: {
		method: 'POST',
		path: '/api/project-manager/plan',
		body: ProjectManagerRequestSchema,
		response: ProjectManagerEstimateSchema,
	},
	projectManagerStart: {
		method: 'POST',
		path: '/api/project-manager',
		body: ProjectManagerRequestSchema,
		response: EngineJobSchema,
	},

	mediaJobs: {
		method: 'POST',
		path: '/api/media-jobs',
		body: MediaJobRequestSchema,
		response: EngineJobSchema,
	},

	warpAnalysis: {
		method: 'POST',
		path: '/api/warp-analysis',
		body: WarpAnalysisRequestSchema,
		response: EngineJobSchema,
	},

	reframeAnalysis: {
		method: 'POST',
		path: '/api/reframe',
		body: ReframeRequestSchema,
		response: EngineJobSchema,
	},

	/** Sound library (spec 12 §2.1, §2.8): search with facets, one sound, its bytes and visual data. */
	soundsSearch: {
		method: 'GET',
		path: '/api/sounds',
		query: SoundSearchQuerySchema,
		response: SoundSearchResponseSchema,
	},
	soundsStatus: { method: 'GET', path: '/api/sounds/status', response: SoundLibraryStatusSchema },
	soundGet: { method: 'GET', path: '/api/sounds/:soundId', response: SoundEntrySchema },
	/** The sound's audio file (audio MIME types only, `nosniff`, Range). */
	soundAudio: { method: 'GET', path: '/api/sounds/:soundId/audio', response: 'binary', headers: ['range'] },
	soundVisual: { method: 'GET', path: '/api/sounds/:soundId/visual', response: SoundVisualSchema },
	/** Registers the sound's file as media for a project; the client commits `media.register` with `library`. */
	soundRegister: {
		method: 'POST',
		path: '/api/sounds/:soundId/register',
		body: RegisterSoundRequestSchema,
		response: RegisterSoundResponseSchema,
	},
	/** (Re)index the library: a `sound-index` job (incremental unless `full`). */
	soundIndex: {
		method: 'POST',
		path: '/api/sounds/index',
		body: SoundIndexRequestSchema,
		response: EngineJobSchema,
	},
	/**
	 * Downloadable sound packs (spec 12 §2.8, P6-R1): the catalogue with what is installed, a `sound-pack-install` job
	 * (202; download, sha256 check, extraction of the listed files, then a `sound-index` job), and removal (an agent's
	 * removal asks the user first).
	 */
	soundPacks: { method: 'GET', path: '/api/sounds/packs', response: SoundPacksResponseSchema },
	soundPackInstall: {
		method: 'POST',
		path: '/api/sounds/packs/:packId/install',
		response: EngineJobSchema,
	},
	soundPackRemove: {
		method: 'DELETE',
		path: '/api/sounds/packs/:packId',
		response: SoundPackRemoveResponseSchema,
	},
	/**
	 * Describe-it search (spec 12 P6-E14, WP-E9): status, the optional audio-text model (install: the processing
	 * catalogue's `model-download` job, open to agents like other model installs; removal asks an agent's user first),
	 * the `sound-embed` job (embeddings of every sound and take, incremental, cancellable) and Find Moment (a
	 * `sound-moment` job: the best windows of a recording for a description).
	 */
	soundSemanticStatus: { method: 'GET', path: '/api/sounds/semantic', response: SoundSemanticStatusSchema },
	soundSemanticModels: {
		method: 'GET',
		path: '/api/sounds/semantic/models',
		response: SoundSemanticModelsResponseSchema,
	},
	soundSemanticModelInstall: {
		method: 'POST',
		path: '/api/sounds/semantic/models/:modelId/install',
		response: EngineJobSchema,
	},
	soundSemanticModelDelete: {
		method: 'DELETE',
		path: '/api/sounds/semantic/models/:modelId',
		response: SoundSemanticModelDeleteResponseSchema,
	},
	soundEmbed: {
		method: 'POST',
		path: '/api/sounds/semantic/embed',
		body: SoundEmbedRequestSchema,
		response: EngineJobSchema,
	},
	/** How well a sound matches a description and realistic alternatives (z, verdict, softmax share). */
	soundMatch: {
		method: 'POST',
		path: '/api/sounds/:soundId/match',
		body: SoundMatchRequestSchema,
		response: SoundMatchResponseSchema,
	},
	soundMoments: {
		method: 'POST',
		path: '/api/sounds/:soundId/moments',
		body: SoundMomentRequestSchema,
		/** `wait=1`: answer when the job ends (the finished job; a failed job is a 422 with its code). */
		query: z.object({ wait: z.enum(['1']).optional() }),
		response: EngineJobSchema,
	},
	/** User sound folders (local mode only). Adding, removing or relicensing one asks an agent's user first. */
	soundRootsGet: { method: 'GET', path: '/api/sounds/roots', response: SoundRootsResponseSchema },
	soundRootsPut: {
		method: 'PUT',
		path: '/api/sounds/roots',
		body: SoundRootsPutRequestSchema,
		response: SoundRootsPutResponseSchema,
	},
	/**
	 * Sound design (spec 12 §2.8): cue suggestions derived from the edit (`deriveCues` with the engine's template
	 * registry), for an inline envelope or a project's live document. Nothing is stored.
	 */
	soundDesignCues: {
		method: 'POST',
		path: '/api/sound-design/cues',
		body: SoundCuesRequestSchema,
		response: SoundCuesResponseSchema,
	},
	/**
	 * Detect Peak (spec 12 §2.7, the clip menu's action for project audio): the peak of an audio clip's sound within the
	 * part of its media it uses (≤ 120 s), measured on the live document. Nothing is stored.
	 */
	soundDesignPeak: {
		method: 'POST',
		path: '/api/sound-design/peak',
		body: SoundPeakRequestSchema,
		response: SoundPeakResponseSchema,
	},
	/**
	 * Sound design plan (spec 12 §2.8, P3-R3): a `sound-design` job (202) whose result (`SoundDesignPlanResult`) names the
	 * proposal it stored: cues → rank → register → place, deterministic by seed. Nothing is applied.
	 */
	soundDesignPlan: {
		method: 'POST',
		path: '/api/sound-design/plan',
		body: SoundDesignPlanRequestSchema,
		response: EngineJobSchema,
	},
	/**
	 * Rebalance SFX levels (spec 12 §2.4, §2.10; P4-R2): a `sound-design` job (202) that renders the bed per cue cluster,
	 * measures each sound effect alone and solves their gains with the masking solver; the result reports per clip the
	 * gain, target and achieved lift, what limited it and why, and either applies them as one undoable transaction
	 * ("Rebalance SFX Levels", `mode: 'apply'`) or stores a proposal (`mode: 'propose'`, the default).
	 */
	soundDesignRebalance: {
		method: 'POST',
		path: '/api/sound-design/rebalance',
		body: SfxRebalanceRequestSchema,
		response: EngineJobSchema,
	},
	/**
	 * Delivery preset (spec 12 §2.4, P4-R4): a `sound-design` job (202) that measures the clips, the ducking triggers and
	 * the resulting mix and applies (`mode: 'apply'`, ONE transaction "Apply Delivery Preset") or proposes (the default)
	 * Mix loudness normalisation, Auto-Match by type, ducking and solved sound-effect gains.
	 */
	soundDesignDelivery: {
		method: 'POST',
		path: '/api/sound-design/delivery',
		body: SoundDeliveryRequestSchema,
		response: EngineJobSchema,
	},
	/**
	 * Sound Check (spec 12 §2.6, P5-R1): a `sound-check` job (202) that renders the delivered mix and its stems, measures
	 * them and returns `SoundCheckResult` (findings with fixes, listen-here moments, per-event table, verdict);
	 * `store: true` also writes the summary into the sequence (`soundDesign.setCheck`). With `proposalId` (spec 12 §4
	 * P6-E5) it checks the proposal's preview document instead and adds `proposal` (what it fixes and introduces, per
	 * item); nothing is committed and the summary is kept on the proposal (`report.check`). 404 `PROPOSAL_NOT_FOUND`,
	 * 404 `NOT_FOUND` (an unknown item).
	 */
	soundDesignCheck: {
		method: 'POST',
		path: '/api/sound-design/check',
		body: SoundCheckRequestSchema,
		response: EngineJobSchema,
	},
	/**
	 * The last full Sound Check report of a sequence (kept per sequence across engine restarts, bounded), with whether
	 * it is stale against the live document (Phase 5 verification). 404 `SOUND_CHECK_NOT_FOUND` when there is none.
	 */
	soundDesignCheckLast: {
		method: 'POST',
		path: '/api/sound-design/check/last',
		body: SoundCheckLastRequestSchema,
		response: SoundCheckLastResponseSchema,
	},
	/**
	 * Pixel motion analysis (spec 12 §2.8, P6-R2): a `motion-analysis` job (202) rendering the sequence's picture small
	 * through the export planner and measuring its motion per frame; result `MotionAnalysisResult` (curve + events),
	 * cached by the picture's fingerprint.
	 */
	soundDesignMotion: {
		method: 'POST',
		path: '/api/sound-design/motion',
		body: MotionAnalysisRequestSchema,
		response: EngineJobSchema,
	},
	/**
	 * Sound Check visual data (spec 12 §2.6, P5-R2): 10 ms loudness curves of the mix and its stems, the mix waveform,
	 * cue ticks, the motion curve and a check job's findings over a range of at most 120 s.
	 */
	soundDesignVisual: {
		method: 'POST',
		path: '/api/sound-design/visual',
		body: SoundVisualRequestSchema,
		response: SoundVisualResponseSchema,
	},
	/**
	 * Listening transcript (spec 12 §4 P6-E6): a `sound-listen` job (202) that renders the mix and every clip of a range
	 * (≤ 10 min) and returns `SoundListenResult` — events attributed to their clips and cues, sections, silences, the
	 * picture events with the sound that answers them and the chance level of each sync share, and the text lines.
	 */
	soundDesignListen: {
		method: 'POST',
		path: '/api/sound-design/listen',
		body: SoundListenRequestSchema,
		response: EngineJobSchema,
	},
	/**
	 * Ambience beds (spec 12 §4 P6-E12): the plan of a bed per scene — the scenes, each recording's measured clean window
	 * and loop points, the ONE transaction that lays it (`soundDesign.layBed`) — without changing anything.
	 */
	soundDesignBedsPlan: {
		method: 'POST',
		path: '/api/sound-design/beds/plan',
		body: SoundBedsRequestSchema,
		response: SoundBedsPlanSchema,
	},
	/** Ambience beds: a `sound-design` job (202) whose result (`SoundBedsResult`) is a proposal or one applied edit. */
	soundDesignBeds: {
		method: 'POST',
		path: '/api/sound-design/beds',
		body: SoundBedsRequestSchema,
		response: EngineJobSchema,
	},
	/**
	 * Room tone (spec 12 §4 P6-E12): the plan of a fill of the holes between dialogue clips — the gaps, the dialogue's
	 * noise floor, the room tones ranked by spectral distance to it, the transaction — without changing anything.
	 */
	soundDesignRoomTonePlan: {
		method: 'POST',
		path: '/api/sound-design/room-tone/plan',
		body: SoundRoomToneRequestSchema,
		response: SoundRoomTonePlanSchema,
	},
	/** Room tone: a `sound-design` job (202) whose result (`SoundRoomToneResult`) is a proposal or one applied edit. */
	soundDesignRoomTone: {
		method: 'POST',
		path: '/api/sound-design/room-tone',
		body: SoundRoomToneRequestSchema,
		response: EngineJobSchema,
	},
	/**
	 * Reference sound profiles (spec 12 §4 P6-E8): the per-user library (`<appdir>/sounds/profiles`), a `sound-profile`
	 * job (202) that measures 1–20 references and stores the profile, rename, delete (an agent's request asks the user)
	 * and import of a profile file (`soundProfileGet`'s body is the file Export saves).
	 */
	soundProfiles: { method: 'GET', path: '/api/sound-design/profiles', response: SoundProfilesResponseSchema },
	soundProfileGet: {
		method: 'GET',
		path: '/api/sound-design/profiles/:profileId',
		response: SoundProfileSchema,
	},
	soundProfileBuild: {
		method: 'POST',
		path: '/api/sound-design/profiles',
		body: SoundProfileBuildRequestSchema,
		response: EngineJobSchema,
	},
	soundProfileRename: {
		method: 'PUT',
		path: '/api/sound-design/profiles/:profileId/name',
		body: SoundProfileRenameRequestSchema,
		response: SoundProfileSummarySchema,
	},
	soundProfileDelete: {
		method: 'DELETE',
		path: '/api/sound-design/profiles/:profileId',
		response: SoundProfileDeleteResponseSchema,
	},
	soundProfileImport: {
		method: 'POST',
		path: '/api/sound-design/profiles/import',
		body: SoundProfileImportRequestSchema,
		response: SoundProfileSummarySchema,
	},
	/**
	 * Proposals (spec 12 §2.5, §2.8): reviewable sets of edits stored per project. Accept composes ONE transaction
	 * (live to the open editor or headless); an agent may accept only where the feature's policy allows it
	 * (sound design: the sequence's `agentsMayApply`), otherwise `403 APPROVAL_REQUIRED`.
	 */
	proposalsList: {
		method: 'GET',
		path: '/api/projects/:projectId/proposals',
		response: ProposalListResponseSchema,
	},
	proposalCreate: {
		method: 'POST',
		path: '/api/projects/:projectId/proposals',
		body: ProposalCreateRequestSchema,
		response: ProposalCreateResponseSchema,
	},
	proposalGet: {
		method: 'GET',
		path: '/api/projects/:projectId/proposals/:proposalId',
		query: ProposalGetQuerySchema,
		response: ProposalResponseSchema,
	},
	proposalAccept: {
		method: 'POST',
		path: '/api/projects/:projectId/proposals/:proposalId/accept',
		body: ProposalAcceptRequestSchema,
		response: ProposalAcceptResponseSchema,
	},
	proposalReject: {
		method: 'POST',
		path: '/api/projects/:projectId/proposals/:proposalId/reject',
		body: ProposalRejectRequestSchema,
		response: ProposalDecisionResponseSchema,
	},
	proposalReopen: {
		method: 'POST',
		path: '/api/projects/:projectId/proposals/:proposalId/reopen',
		body: ProposalReopenRequestSchema,
		response: ProposalDecisionResponseSchema,
	},
	proposalNote: {
		method: 'POST',
		path: '/api/projects/:projectId/proposals/:proposalId/note',
		body: ProposalNoteRequestSchema,
		response: ProposalDecisionResponseSchema,
	},
	proposalSelect: {
		method: 'POST',
		path: '/api/projects/:projectId/proposals/:proposalId/select',
		body: ProposalSelectRequestSchema,
		response: ProposalDecisionResponseSchema,
	},
	proposalMarkApplied: {
		method: 'POST',
		path: '/api/projects/:projectId/proposals/:proposalId/applied',
		body: ProposalMarkAppliedRequestSchema,
		response: ProposalDecisionResponseSchema,
	},
	proposalDelete: {
		method: 'DELETE',
		path: '/api/projects/:projectId/proposals/:proposalId',
		response: ProposalDeleteResponseSchema,
	},
	/** Spec 15 EA-003 "Refresh proposal": the feature's producer re-plans stale items (nothing is applied). */
	proposalRefresh: {
		method: 'POST',
		path: '/api/projects/:projectId/proposals/:proposalId/refresh',
		body: ProposalRefreshRequestSchema,
		response: ProposalRefreshResponseSchema,
	},
	/** Spec 15 EA-001: the proposal features, their Review groups and whether agents may accept them here. */
	proposalFeatures: {
		method: 'GET',
		path: '/api/projects/:projectId/proposal-features',
		response: ProposalFeaturesResponseSchema,
	},
} as const satisfies Record<string, RouteDef>;

export type RouteName = keyof typeof ROUTES;

/** Top-level path prefixes the engine owns (never served the SPA fallback). */
export const ENGINE_PATH_PREFIXES = [
	'/api',
	'/events',
	'/media',
	'/mg',
	'/renders',
	'/agent',
	'/fonts',
	'/health',
	'/mcp',
	'/pair',
] as const;

export function isEnginePath(pathname: string): boolean {
	return ENGINE_PATH_PREFIXES.some(
		(p) => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(`${p}?`),
	);
}

/** Fills `:param` placeholders (URI-encoded). Throws when a parameter is missing. */
export function buildPath(template: string, params: Record<string, string | number> = {}): string {
	return template.replace(/:([A-Za-z]+)/g, (_, name: string) => {
		const v = params[name];
		if (v === undefined) throw new Error(`Missing path parameter ${name} for ${template}`);
		return encodeURIComponent(String(v));
	});
}

export type RouteResponse<N extends RouteName> = (typeof ROUTES)[N]['response'] extends z.ZodType
	? z.infer<(typeof ROUTES)[N]['response']>
	: never;
