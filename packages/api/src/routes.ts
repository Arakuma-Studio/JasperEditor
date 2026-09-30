// The complete M1 route table (ARCHITECTURE §9.2). One entry per route: method, path template,
// request schemas and response kind. The engine validates with it and @jasper/engine-client
// builds one typed method per entry.
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
import { EngineCapabilitiesSchema, HealthSchema, LicensesResponseSchema } from './capabilities.ts';
import {
	ExportPlanRequestSchema,
	ExportStartRequestSchema,
	RenderPlanSchema,
	StillRequestSchema,
} from './exports.ts';
import { FontCatalogSchema } from './fonts.ts';
import { EngineJobSchema, JobListQuerySchema, JobListResponseSchema } from './jobs.ts';
import {
	DerivativesRequestSchema,
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
	VersionListResponseSchema,
} from './projects.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type RouteOwner = 'WP-2F' | 'WP-2G' | 'WP-2H' | 'wp-mcp';

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

const r = <T extends RouteDef>(d: T) => d;
const JobQueued = EngineJobSchema;
const JobsResponse = z.object({ jobs: z.array(EngineJobSchema) });

export const ROUTES = {
	health: r({ method: 'GET', path: '/health', response: HealthSchema, public: true, owner: 'WP-2F' }),
	capabilities: r({
		method: 'GET',
		path: '/api/capabilities',
		response: EngineCapabilitiesSchema,
		owner: 'WP-2F',
	}),
	/** Third-party licenses for the About dialog (D-13: FFmpeg license text + source link). */
	licenses: r({
		method: 'GET',
		path: '/api/licenses',
		response: LicensesResponseSchema,
		owner: 'WP-2F',
	}),
	events: r({
		method: 'GET',
		path: '/events',
		query: z.object({ since: z.string().optional(), projectId: z.string().optional() }),
		response: 'ndjson',
		owner: 'WP-2F',
	}),

	projectsList: r({
		method: 'GET',
		path: '/api/projects',
		response: ProjectListResponseSchema,
		owner: 'WP-2F',
	}),
	projectsCreate: r({
		method: 'POST',
		path: '/api/projects',
		body: ProjectCreateRequestSchema,
		response: ProjectCreateResponseSchema,
		owner: 'WP-2F',
	}),
	projectGet: r({
		method: 'GET',
		path: '/api/projects/:projectId',
		response: ProjectGetResponseSchema,
		owner: 'WP-2F',
	}),
	projectPut: r({
		method: 'PUT',
		path: '/api/projects/:projectId',
		body: EnvelopeSchema,
		headers: ['if-match'],
		response: ProjectPutResponseSchema,
		owner: 'WP-2F',
	}),
	projectPutView: r({
		method: 'PUT',
		path: '/api/projects/:projectId/view',
		body: ProjectViewSchema,
		response: OkSchema,
		owner: 'WP-2F',
	}),
	projectVersions: r({
		method: 'GET',
		path: '/api/projects/:projectId/versions',
		response: VersionListResponseSchema,
		owner: 'WP-2F',
	}),
	projectDelete: r({
		method: 'DELETE',
		path: '/api/projects/:projectId',
		response: OkSchema,
		owner: 'WP-2F',
	}),
	leaseAcquire: r({
		method: 'POST',
		path: '/api/projects/:projectId/lease',
		body: LeaseRequestSchema,
		response: LeaseSchema,
		owner: 'WP-2F',
	}),
	leaseHeartbeat: r({
		method: 'POST',
		path: '/api/projects/:projectId/lease/:leaseId/heartbeat',
		response: LeaseSchema,
		owner: 'WP-2F',
	}),
	leaseRelease: r({
		method: 'DELETE',
		path: '/api/projects/:projectId/lease/:leaseId',
		response: OkSchema,
		owner: 'WP-2F',
	}),

	mediaRegister: r({
		method: 'POST',
		path: '/api/media/register',
		body: MediaRegisterRequestSchema,
		response: MediaRegisterResponseSchema,
		owner: 'WP-2F',
	}),
	uploadCreate: r({
		method: 'POST',
		path: '/api/uploads',
		body: UploadCreateRequestSchema,
		response: UploadCreateResponseSchema,
		owner: 'WP-2F',
	}),
	uploadAppend: r({
		method: 'PUT',
		path: '/api/uploads/:uploadId',
		query: z.object({ offset: z.string().regex(/^\d+$/) }),
		body: 'binary',
		response: UploadAppendResponseSchema,
		owner: 'WP-2F',
	}),
	uploadComplete: r({
		method: 'POST',
		path: '/api/uploads/:uploadId/complete',
		response: RegisteredMediaSchema,
		owner: 'WP-2F',
	}),
	uploadAbort: r({ method: 'DELETE', path: '/api/uploads/:uploadId', response: OkSchema, owner: 'WP-2F' }),
	mediaStatus: r({
		method: 'GET',
		path: '/api/media/:mediaKey',
		response: MediaStatusSchema,
		owner: 'WP-2F',
	}),
	mediaDerivatives: r({
		method: 'POST',
		path: '/api/media/:mediaKey/derivatives',
		body: DerivativesRequestSchema,
		response: JobsResponse,
		owner: 'WP-2F',
	}),
	mediaFile: r({ method: 'GET', path: '/media/:mediaKey', response: 'binary', owner: 'WP-2F' }),
	mediaProxy: r({ method: 'GET', path: '/media/:mediaKey/proxy/:tier', response: 'binary', owner: 'WP-2F' }),
	mediaPoster: r({ method: 'GET', path: '/media/:mediaKey/poster.jpg', response: 'binary', owner: 'WP-2F' }),
	mediaSpriteIndex: r({
		method: 'GET',
		path: '/media/:mediaKey/sprite.json',
		response: 'binary',
		owner: 'WP-2F',
	}),
	mediaSpriteSheet: r({
		method: 'GET',
		path: '/media/:mediaKey/sprite/:sheet',
		response: 'binary',
		owner: 'WP-2F',
	}),
	mediaPeaksHeader: r({
		method: 'GET',
		path: '/media/:mediaKey/peaks.json',
		response: 'binary',
		owner: 'WP-2F',
	}),
	mediaPeaksStream: r({
		method: 'GET',
		path: '/media/:mediaKey/peaks/:stream',
		response: 'binary',
		owner: 'WP-2F',
	}),

	jobsList: r({
		method: 'GET',
		path: '/api/jobs',
		query: JobListQuerySchema,
		response: JobListResponseSchema,
		owner: 'WP-2F',
	}),
	jobGet: r({ method: 'GET', path: '/api/jobs/:jobId', response: EngineJobSchema, owner: 'WP-2F' }),
	jobCancel: r({
		method: 'POST',
		path: '/api/jobs/:jobId/cancel',
		response: EngineJobSchema,
		owner: 'WP-2F',
	}),
	jobRetry: r({ method: 'POST', path: '/api/jobs/:jobId/retry', response: EngineJobSchema, owner: 'WP-2F' }),

	exportPlan: r({
		method: 'POST',
		path: '/api/exports/plan',
		body: ExportPlanRequestSchema,
		response: RenderPlanSchema,
		owner: 'WP-2F',
	}),
	exportStart: r({
		method: 'POST',
		path: '/api/exports',
		body: ExportStartRequestSchema,
		response: JobQueued,
		owner: 'WP-2F',
	}),
	renderOutput: r({ method: 'GET', path: '/renders/:jobId/output', response: 'binary', owner: 'WP-2F' }),
	stills: r({
		method: 'POST',
		path: '/api/stills',
		body: StillRequestSchema,
		response: JobQueued,
		owner: 'WP-2F',
	}),

	fontsList: r({ method: 'GET', path: '/api/fonts', response: FontCatalogSchema, owner: 'WP-2F' }),
	fontFile: r({ method: 'GET', path: '/fonts/*', response: 'binary', owner: 'WP-2F' }),

	mgTemplates: r({
		method: 'GET',
		path: '/api/motion-graphics/templates',
		response: MgTemplatesResponseSchema,
		owner: 'WP-2G',
	}),
	mgRender: r({
		method: 'POST',
		path: '/api/motion-graphics/render',
		body: MgRenderRequestSchema,
		response: JobQueued,
		owner: 'WP-2G',
	}),
	mgFile: r({ method: 'GET', path: '/mg/:key/:file', response: 'binary', owner: 'WP-2G' }),

	agentSchema: r({
		method: 'GET',
		path: '/api/agent/schema',
		response: AgentSchemaResponseSchema,
		owner: 'WP-2H',
	}),
	agentQuery: r({
		method: 'POST',
		path: '/api/agent/query',
		body: AgentQueryRequestSchema,
		response: AgentQueryResponseSchema,
		owner: 'WP-2H',
	}),
	agentTx: r({
		method: 'POST',
		path: '/api/agent/tx',
		body: AgentTxRequestSchema,
		response: AgentTxResponseSchema,
		owner: 'WP-2H',
	}),
	agentWs: r({ method: 'GET', path: '/agent', response: 'websocket', owner: 'WP-2H' }),
	agentOpenProject: r({
		method: 'POST',
		path: '/api/agent/open-project',
		body: AgentOpenProjectRequestSchema,
		response: AgentOpenProjectResponseSchema,
		owner: 'wp-mcp',
	}),
	agentMcpInfo: r({
		method: 'GET',
		path: '/api/agent/mcp-info',
		response: AgentMcpInfoSchema,
		owner: 'wp-mcp',
	}),
	/** MCP Streamable HTTP endpoint (same tools as the `jasper-mcp` stdio server). */
	mcp: r({ method: 'POST', path: '/mcp', response: 'binary', owner: 'wp-mcp' }),
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
