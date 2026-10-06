// Engine route contracts: method, path template, request schemas and response kind.
// Shared by engine validation and typed calls in @jasper/engine-client.
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
} from './agent.ts';
import {
	CacheCleanRequestSchema,
	CacheGcReportSchema,
	CacheLocationCheckSchema,
	CacheLocationRequestSchema,
	CacheMoveRequestSchema,
	CacheSettingsSchema,
	CacheUsageSchema,
} from './cache.ts';
import { EngineCapabilitiesSchema, HealthSchema, LicensesResponseSchema } from './capabilities.ts';
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
import { FontCatalogSchema } from './fonts.ts';
import { EngineJobSchema, JobListQuerySchema, JobListResponseSchema } from './jobs.ts';
import { LayerBakePreviewRequestSchema } from './layer-bake.ts';
import {
	DerivativesRequestSchema,
	MediaDiscardResponseSchema,
	MediaRegisterRequestSchema,
	MediaRegisterResponseSchema,
	MediaStatusSchema,
	RegisteredMediaSchema,
	UploadAppendResponseSchema,
	UploadCreateRequestSchema,
	UploadCreateResponseSchema,
} from './media.ts';
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
import { TrackRequestSchema } from './tracking.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type RouteOwner =
	| 'WP-2F'
	| 'WP-2G'
	| 'WP-2H'
	| 'wp-mcp'
	| 'wp-m2-color'
	| 'wp-m2-process'
	| 'wp-m2-mg'
	| 'wp-m2-track'
	// M2 animation (ARCHITECTURE §20, S11 §10)
	| 'wp-m2-layer-bake'
	// M3
	| 'wp-m3-cachegc'
	| 'wp-m3-presets'
	// parity program: versions and crash recovery (D-39)
	| 'process';

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
	owner: RouteOwner;
};

export const ROUTES = {
	health: { method: 'GET', path: '/health', response: HealthSchema, public: true, owner: 'WP-2F' },
	capabilities: {
		method: 'GET',
		path: '/api/capabilities',
		response: EngineCapabilitiesSchema,
		owner: 'WP-2F',
	},
	/** Third-party licenses for the About dialog (D-13: FFmpeg license text + source link). */
	licenses: {
		method: 'GET',
		path: '/api/licenses',
		response: LicensesResponseSchema,
		owner: 'WP-2F',
	},
	events: {
		method: 'GET',
		path: '/events',
		query: z.object({ since: z.string().optional(), projectId: z.string().optional() }),
		response: 'ndjson',
		owner: 'WP-2F',
	},

	projectsList: {
		method: 'GET',
		path: '/api/projects',
		response: ProjectListResponseSchema,
		owner: 'WP-2F',
	},
	projectsCreate: {
		method: 'POST',
		path: '/api/projects',
		body: ProjectCreateRequestSchema,
		response: ProjectCreateResponseSchema,
		owner: 'WP-2F',
	},
	projectGet: {
		method: 'GET',
		path: '/api/projects/:projectId',
		response: ProjectGetResponseSchema,
		owner: 'WP-2F',
	},
	projectPut: {
		method: 'PUT',
		path: '/api/projects/:projectId',
		body: EnvelopeSchema,
		headers: ['if-match'],
		response: ProjectPutResponseSchema,
		owner: 'WP-2F',
	},
	projectPutView: {
		method: 'PUT',
		path: '/api/projects/:projectId/view',
		body: ProjectViewSchema,
		response: OkSchema,
		owner: 'WP-2F',
	},
	projectVersions: {
		method: 'GET',
		path: '/api/projects/:projectId/versions',
		response: VersionListResponseSchema,
		owner: 'WP-2F',
	},
	projectVersionGet: {
		method: 'GET',
		path: '/api/projects/:projectId/versions/:versionId',
		response: VersionGetResponseSchema,
		owner: 'process',
	},
	projectVersionRestore: {
		method: 'POST',
		path: '/api/projects/:projectId/versions/:versionId/restore',
		body: VersionRestoreRequestSchema,
		response: VersionRestoreResponseSchema,
		owner: 'process',
	},
	projectRecoveryList: {
		method: 'GET',
		path: '/api/projects/:projectId/recovery',
		response: RecoveryListResponseSchema,
		owner: 'process',
	},
	projectRecoveryGet: {
		method: 'GET',
		path: '/api/projects/:projectId/recovery/:sessionId',
		response: RecoveryGetResponseSchema,
		owner: 'process',
	},
	projectRecoveryPut: {
		method: 'PUT',
		path: '/api/projects/:projectId/recovery/:sessionId',
		body: RecoveryPutRequestSchema,
		response: RecoveryPutResponseSchema,
		owner: 'process',
	},
	projectRecoveryDelete: {
		method: 'DELETE',
		path: '/api/projects/:projectId/recovery/:sessionId',
		query: z.object({ leaseId: z.string().optional() }),
		response: OkSchema,
		owner: 'process',
	},
	projectDelete: {
		method: 'DELETE',
		path: '/api/projects/:projectId',
		response: OkSchema,
		owner: 'WP-2F',
	},
	leaseAcquire: {
		method: 'POST',
		path: '/api/projects/:projectId/lease',
		body: LeaseRequestSchema,
		response: LeaseSchema,
		owner: 'WP-2F',
	},
	leaseHeartbeat: {
		method: 'POST',
		path: '/api/projects/:projectId/lease/:leaseId/heartbeat',
		response: LeaseSchema,
		owner: 'WP-2F',
	},
	leaseRelease: {
		method: 'DELETE',
		path: '/api/projects/:projectId/lease/:leaseId',
		response: OkSchema,
		owner: 'WP-2F',
	},

	mediaRegister: {
		method: 'POST',
		path: '/api/media/register',
		body: MediaRegisterRequestSchema,
		response: MediaRegisterResponseSchema,
		owner: 'WP-2F',
	},
	uploadCreate: {
		method: 'POST',
		path: '/api/uploads',
		body: UploadCreateRequestSchema,
		response: UploadCreateResponseSchema,
		owner: 'WP-2F',
	},
	uploadAppend: {
		method: 'PUT',
		path: '/api/uploads/:uploadId',
		query: z.object({ offset: z.string().regex(/^\d+$/) }),
		body: 'binary',
		response: UploadAppendResponseSchema,
		owner: 'WP-2F',
	},
	uploadComplete: {
		method: 'POST',
		path: '/api/uploads/:uploadId/complete',
		response: RegisteredMediaSchema,
		owner: 'WP-2F',
	},
	uploadAbort: { method: 'DELETE', path: '/api/uploads/:uploadId', response: OkSchema, owner: 'WP-2F' },
	mediaStatus: {
		method: 'GET',
		path: '/api/media/:mediaKey',
		response: MediaStatusSchema,
		owner: 'WP-2F',
	},
	/** M3 (wp-m3-inpoint, S07:PRC-018): discard an uncommitted upload (Replace Footage cancelled). */
	mediaDiscard: {
		method: 'DELETE',
		path: '/api/media/:mediaKey',
		response: MediaDiscardResponseSchema,
		owner: 'wp-m2-process',
	},
	mediaDerivatives: {
		method: 'POST',
		path: '/api/media/:mediaKey/derivatives',
		body: DerivativesRequestSchema,
		response: JobListResponseSchema,
		owner: 'WP-2F',
	},
	mediaFile: { method: 'GET', path: '/media/:mediaKey', response: 'binary', owner: 'WP-2F' },
	mediaProxy: { method: 'GET', path: '/media/:mediaKey/proxy/:tier', response: 'binary', owner: 'WP-2F' },
	mediaPoster: { method: 'GET', path: '/media/:mediaKey/poster.jpg', response: 'binary', owner: 'WP-2F' },
	mediaSpriteIndex: {
		method: 'GET',
		path: '/media/:mediaKey/sprite.json',
		response: 'binary',
		owner: 'WP-2F',
	},
	mediaSpriteSheet: {
		method: 'GET',
		path: '/media/:mediaKey/sprite/:sheet',
		response: 'binary',
		owner: 'WP-2F',
	},
	mediaPeaksHeader: {
		method: 'GET',
		path: '/media/:mediaKey/peaks.json',
		response: 'binary',
		owner: 'WP-2F',
	},
	mediaPeaksStream: {
		method: 'GET',
		path: '/media/:mediaKey/peaks/:stream',
		response: 'binary',
		owner: 'WP-2F',
	},

	jobsList: {
		method: 'GET',
		path: '/api/jobs',
		query: JobListQuerySchema,
		response: JobListResponseSchema,
		owner: 'WP-2F',
	},
	jobGet: { method: 'GET', path: '/api/jobs/:jobId', response: EngineJobSchema, owner: 'WP-2F' },
	jobCancel: {
		method: 'POST',
		path: '/api/jobs/:jobId/cancel',
		response: EngineJobSchema,
		owner: 'WP-2F',
	},
	jobRetry: { method: 'POST', path: '/api/jobs/:jobId/retry', response: EngineJobSchema, owner: 'WP-2F' },

	exportPlan: {
		method: 'POST',
		path: '/api/exports/plan',
		body: ExportPlanRequestSchema,
		response: RenderPlanSchema,
		owner: 'WP-2F',
	},
	exportStart: {
		method: 'POST',
		path: '/api/exports',
		body: ExportStartRequestSchema,
		response: EngineJobSchema,
		owner: 'WP-2F',
	},
	renderOutput: { method: 'GET', path: '/renders/:jobId/output', response: 'binary', owner: 'WP-2F' },
	stills: {
		method: 'POST',
		path: '/api/stills',
		body: StillRequestSchema,
		response: EngineJobSchema,
		owner: 'WP-2F',
	},

	fontsList: { method: 'GET', path: '/api/fonts', response: FontCatalogSchema, owner: 'WP-2F' },
	fontFile: { method: 'GET', path: '/fonts/*', response: 'binary', owner: 'WP-2F' },

	mgTemplates: {
		method: 'GET',
		path: '/api/motion-graphics/templates',
		response: MgTemplatesResponseSchema,
		owner: 'WP-2G',
	},
	mgRender: {
		method: 'POST',
		path: '/api/motion-graphics/render',
		body: MgRenderRequestSchema,
		response: EngineJobSchema,
		owner: 'WP-2G',
	},
	mgFile: { method: 'GET', path: '/mg/:key/:file', response: 'binary', owner: 'WP-2G' },

	agentSchema: {
		method: 'GET',
		path: '/api/agent/schema',
		response: AgentSchemaResponseSchema,
		owner: 'WP-2H',
	},
	agentQuery: {
		method: 'POST',
		path: '/api/agent/query',
		body: AgentQueryRequestSchema,
		response: AgentQueryResponseSchema,
		owner: 'WP-2H',
	},
	agentTx: {
		method: 'POST',
		path: '/api/agent/tx',
		body: AgentTxRequestSchema,
		response: AgentTxResponseSchema,
		owner: 'WP-2H',
	},
	agentWs: { method: 'GET', path: '/agent', response: 'websocket', owner: 'WP-2H' },
	agentOpenProject: {
		method: 'POST',
		path: '/api/agent/open-project',
		body: AgentOpenProjectRequestSchema,
		response: AgentOpenProjectResponseSchema,
		owner: 'wp-mcp',
	},
	agentMcpInfo: {
		method: 'GET',
		path: '/api/agent/mcp-info',
		response: AgentMcpInfoSchema,
		owner: 'wp-mcp',
	},
	/** MCP Streamable HTTP endpoint (same tools as the `jasper-mcp` stdio server). */
	mcp: { method: 'POST', path: '/mcp', response: 'binary', owner: 'wp-mcp' },

	// ---- M2 (ARCHITECTURE §19.7). Colour needs no routes of its own: LUTs are media (`.cube` → kind `lut`).
	mediaProcess: {
		method: 'POST',
		path: '/api/media/:key/process',
		body: ProcessRequestSchema,
		response: EngineJobSchema,
		owner: 'wp-m2-process',
	},
	processingModels: {
		method: 'GET',
		path: '/api/processing/models',
		response: ProcessingModelsResponseSchema,
		owner: 'wp-m2-process',
	},
	processingModelInstall: {
		method: 'POST',
		path: '/api/processing/models/:modelId/install',
		response: EngineJobSchema,
		owner: 'wp-m2-process',
	},
	processingSettingsGet: {
		method: 'GET',
		path: '/api/settings/processing',
		response: ProcessingSettingsSchema,
		owner: 'wp-m2-process',
	},
	processingSettingsPut: {
		method: 'PUT',
		path: '/api/settings/processing',
		body: ProcessingSettingsSchema,
		response: ProcessingSettingsSchema,
		owner: 'wp-m2-process',
	},
	processingRemoteProbe: {
		method: 'POST',
		path: '/api/processing/remote/probe',
		response: RemoteProbeResultSchema,
		owner: 'wp-m2-process',
	},
	processingRemoteSetup: {
		method: 'POST',
		path: '/api/processing/remote/setup',
		response: EngineJobSchema,
		owner: 'wp-m2-process',
	},
	mgBundleImport: {
		method: 'POST',
		path: '/api/mg-bundles/import',
		body: MgBundleImportRequestSchema,
		response: RegisteredMediaSchema,
		owner: 'wp-m2-mg',
	},
	mgBundleRebuild: {
		method: 'POST',
		path: '/api/mg-bundles/:key/rebuild',
		body: MgBundleRebuildRequestSchema,
		response: EngineJobSchema,
		owner: 'wp-m2-mg',
	},
	/** PNG poster of one composition of a bundle at its `thumbnailFrame` (rendered once, cached). */
	mgBundlePoster: {
		method: 'GET',
		path: '/api/mg-bundles/:key/poster/:compositionId',
		response: 'binary',
		owner: 'wp-m2-mg',
	},
	/** P1 (S08:MGC-015): new composition project from the template, imported with watch. */
	mgBundleScaffold: {
		method: 'POST',
		path: '/api/mg-bundles/scaffold',
		body: MgBundleScaffoldRequestSchema,
		response: RegisteredMediaSchema,
		owner: 'wp-m2-mg',
	},
	mgBundlePrerender: {
		method: 'POST',
		path: '/api/mg-bundles/prerender',
		body: MgPrerenderRequestSchema,
		response: EngineJobSchema,
		owner: 'wp-m2-mg',
	},
	mgBundlePrerenderGet: {
		method: 'GET',
		path: '/api/mg-bundles/prerender/:renderKey',
		response: MgPrerenderResultSchema,
		owner: 'wp-m2-mg',
	},
	/** wp-m3-mgtext (S08:MGC-037): text layout of a composition, measured in the engine's headless browser. */
	mgBundleMeasureTexts: {
		method: 'POST',
		path: '/api/mg-bundles/measure-texts',
		body: MgTextMeasureRequestSchema,
		response: MgTextMeasureResultSchema,
		owner: 'wp-m2-mg',
	},
	/** Static files of an imported bundle (the Remotion serve URL; the preview frame host loads it). */
	mgBundleFiles: { method: 'GET', path: '/mg/bundles/:key/*', response: 'binary', owner: 'wp-m2-mg' },
	trackingTrack: {
		method: 'POST',
		path: '/api/tracking/track',
		body: TrackRequestSchema,
		response: EngineJobSchema,
		owner: 'wp-m2-track',
	},
	// ---- M2 animation (ARCHITECTURE §20.5)
	/** Graded VP9-alpha preview of one DOM layer (S11:LBK-010). */
	layerBakePreview: {
		method: 'POST',
		path: '/api/layer-bake/preview',
		body: LayerBakePreviewRequestSchema,
		response: EngineJobSchema,
		owner: 'wp-m2-layer-bake',
	},
	/**
	 * Cached bake files (`master.mov`, `still.png`, `preview.webm`; `graded.png?n=<frame>` = frame n of the graded PNG
	 * sequence); signable for renders.
	 */
	layerBakeFiles: {
		method: 'GET',
		path: '/mg/layers/:key/:file',
		response: 'binary',
		owner: 'wp-m2-layer-bake',
	},
	// ---- M3 media cache (S04 §7.5 CA-010…CA-019)
	/** Usage per cache kind, budgets, last cleaning (Preferences ▸ Media Cache, MCP get_cache_usage). */
	cacheUsage: { method: 'GET', path: '/api/cache', response: CacheUsageSchema, owner: 'wp-m3-cachegc' },
	/** "Clean Unused" / "Clean All (not in use)" / one automatic pass; answers when the pass is done. */
	cacheClean: {
		method: 'POST',
		path: '/api/cache/clean',
		body: CacheCleanRequestSchema,
		response: CacheGcReportSchema,
		owner: 'wp-m3-cachegc',
	},
	cacheSettingsGet: {
		method: 'GET',
		path: '/api/cache/settings',
		response: CacheSettingsSchema,
		owner: 'wp-m3-cachegc',
	},
	/** Validates a cache folder: writable, free space for a move, same disk (S04:CA-021). Local mode only. */
	cacheLocationCheck: {
		method: 'POST',
		path: '/api/cache/location/check',
		body: CacheLocationRequestSchema,
		response: CacheLocationCheckSchema,
		owner: 'wp-m3-cachegc',
	},
	/** Moves the cache (or starts a fresh one) to a folder: a `cache-move` job. Local mode only. */
	cacheLocationSet: {
		method: 'POST',
		path: '/api/cache/location',
		body: CacheMoveRequestSchema,
		response: EngineJobSchema,
		owner: 'wp-m3-cachegc',
	},
	cacheSettingsPut: {
		method: 'PUT',
		path: '/api/cache/settings',
		body: CacheSettingsSchema,
		response: CacheSettingsSchema,
		owner: 'wp-m3-cachegc',
	},
	// ---- M3 effect presets (S03:FX-030, AGT-020): the user library (built-ins ship in @jasper/project)
	effectPresetsList: {
		method: 'GET',
		path: '/api/effect-presets',
		response: EffectPresetLibraryResponseSchema,
		owner: 'wp-m3-presets',
	},
	/** Save Preset…: assigns the id and timestamps, answers the stored preset. */
	effectPresetCreate: {
		method: 'POST',
		path: '/api/effect-presets',
		body: EffectPresetCreateRequestSchema,
		response: EffectPresetSchema,
		owner: 'wp-m3-presets',
	},
	effectPresetUpdate: {
		method: 'PUT',
		path: '/api/effect-presets/:presetId',
		body: EffectPresetUpdateRequestSchema,
		response: EffectPresetSchema,
		owner: 'wp-m3-presets',
	},
	effectPresetDelete: {
		method: 'DELETE',
		path: '/api/effect-presets/:presetId',
		response: EffectPresetDeleteResponseSchema,
		owner: 'wp-m3-presets',
	},
	effectPresetFolderCreate: {
		method: 'POST',
		path: '/api/effect-presets/folders',
		body: EffectPresetFolderCreateRequestSchema,
		response: EffectPresetFolderSchema,
		owner: 'wp-m3-presets',
	},
	effectPresetFolderUpdate: {
		method: 'PUT',
		path: '/api/effect-presets/folders/:folderId',
		body: EffectPresetFolderUpdateRequestSchema,
		response: EffectPresetFolderSchema,
		owner: 'wp-m3-presets',
	},
	/** Deletes a bin with everything inside it. */
	effectPresetFolderDelete: {
		method: 'DELETE',
		path: '/api/effect-presets/folders/:folderId',
		response: EffectPresetDeleteResponseSchema,
		owner: 'wp-m3-presets',
	},
	effectPresetsImport: {
		method: 'POST',
		path: '/api/effect-presets/import',
		body: EffectPresetImportRequestSchema,
		response: EffectPresetImportResponseSchema,
		owner: 'wp-m3-presets',
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
