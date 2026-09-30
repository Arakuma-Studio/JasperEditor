// Typed engine client: one method per route of @jasper/api's ROUTES (ARCHITECTURE §9.2).
import {
	type AgentOpenProjectRequest,
	type AgentQueryRequest,
	type AgentTxRequest,
	API_HEADER,
	API_VERSION,
	buildPath,
	type DerivativeKind,
	type EngineJob,
	ErrorShapeSchema,
	type ExportPlanRequest,
	type ExportStartRequest,
	type JobListQuery,
	type MediaRegisterRequest,
	type MgRenderRequest,
	type ProjectCreateRequest,
	type ProjectViewJson,
	type RegisteredMedia,
	ROUTES,
	type RouteName,
	type RouteResponse,
	type StillRequest,
	UPLOAD_CHUNK_BYTES,
	type UploadCreateRequest,
	UploadOffsetMismatchSchema,
} from '@jasper/api';
import type { z } from 'zod';
import { EngineError } from './errors.ts';
import { type EventHandlers, type EventStream, type EventStreamOptions, openEventStream } from './events.ts';

export type EngineClientOptions = {
	/** '' = same origin (the SPA always uses relative URLs, ARCHITECTURE §4.1). */
	baseUrl?: string;
	fetch?: typeof fetch;
	/** Bearer token (Electron packaged mode uses the cookie instead). */
	token?: string;
};

type CallOptions = {
	params?: Record<string, string | number>;
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	headers?: Record<string, string>;
	signal?: AbortSignal;
};

export type MediaVariant =
	| 'original'
	| 'poster'
	| 'sprite.json'
	| 'peaks.json'
	| { proxy: '720' | '540' }
	| { sprite: number }
	| { peaks: number };

export type UploadProgress = { loaded: number; total: number };

export class EngineClient {
	readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;
	private readonly token?: string;

	constructor(opts: EngineClientOptions = {}) {
		this.baseUrl = (opts.baseUrl ?? '').replace(/\/$/, '');
		const f = opts.fetch ?? globalThis.fetch;
		if (!f) throw new Error('No fetch implementation available');
		this.fetchImpl = (input, init) => f(input, init);
		this.token = opts.token;
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

	private authHeaders(): Record<string, string> {
		return this.token ? { authorization: `Bearer ${this.token}` } : {};
	}

	/**
	 * Headers that authenticate a request made outside `call()` (e.g. keepalive requests during `pagehide`):
	 * `Authorization: Bearer <token>` in token mode, nothing when the session cookie is used.
	 */
	authorizationHeaders(): Record<string, string> {
		return this.authHeaders();
	}

	/** Low-level typed call by route name. */
	async call<N extends RouteName>(name: N, opts: CallOptions = {}): Promise<RouteResponse<N>> {
		const route = ROUTES[name];
		const path = buildPath(route.path, opts.params);
		const binary = 'body' in route && route.body === 'binary';
		const headers: Record<string, string> = {
			accept: 'application/json',
			...this.authHeaders(),
			...(opts.headers ?? {}),
		};
		let body: BodyInit | undefined;
		if (opts.body !== undefined) {
			if (binary) {
				headers['content-type'] = 'application/octet-stream';
				body = opts.body as BodyInit;
			} else {
				headers['content-type'] = 'application/json';
				body = JSON.stringify(opts.body);
			}
		}
		let res: Response;
		try {
			res = await this.fetchImpl(this.url(path, opts.query), {
				method: route.method,
				headers,
				body,
				signal: opts.signal,
				credentials: 'include',
			});
		} catch (e) {
			if ((e as { name?: string })?.name === 'AbortError') throw e;
			throw new EngineError('NETWORK', `Engine not reachable: ${(e as Error)?.message ?? e}`, {
				retryable: true,
			});
		}
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
		const schema = route.response as z.ZodType | string;
		if (typeof schema === 'string') return json as RouteResponse<N>;
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

	// ------------------------------------------------------------ one method per route

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
	putProject(projectId: string, envelope: unknown, baseRevision: number) {
		return this.call('projectPut', {
			params: { projectId },
			body: envelope,
			headers: { 'if-match': String(baseRevision) },
		});
	}
	putView(projectId: string, view: ProjectViewJson) {
		return this.call('projectPutView', { params: { projectId }, body: view });
	}
	listVersions(projectId: string) {
		return this.call('projectVersions', { params: { projectId } });
	}
	deleteProject(projectId: string) {
		return this.call('projectDelete', { params: { projectId } });
	}
	acquireLease(projectId: string, sessionId: string) {
		return this.call('leaseAcquire', { params: { projectId }, body: { sessionId } });
	}
	heartbeatLease(projectId: string, leaseId: string) {
		return this.call('leaseHeartbeat', { params: { projectId, leaseId } });
	}
	releaseLease(projectId: string, leaseId: string) {
		return this.call('leaseRelease', { params: { projectId, leaseId } });
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
	requestStill(req: StillRequest): Promise<EngineJob> {
		return this.call('stills', { body: req });
	}
	listFonts() {
		return this.call('fontsList');
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
	agentMcpInfo() {
		return this.call('agentMcpInfo');
	}

	/**
	 * GETs an engine-relative URL (e.g. a still's `/renders/<jobId>/output`) as bytes with the client's
	 * auth. Throws EngineError on HTTP errors.
	 */
	async fetchBytes(path: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string }> {
		const url = /^https?:/.test(path) ? path : this.url(path);
		let res: Response;
		try {
			res = await this.fetchImpl(url, { headers: this.authHeaders(), signal, credentials: 'include' });
		} catch (e) {
			if ((e as { name?: string })?.name === 'AbortError') throw e;
			throw new EngineError('NETWORK', `Engine not reachable: ${(e as Error)?.message ?? e}`, {
				retryable: true,
			});
		}
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

	// ------------------------------------------------------------ URLs for elements (<video>, <img>, fonts)

	/** Same-origin media URL (ARCHITECTURE §8, S04:MS-001). */
	mediaUrl(mediaKey: string, variant: MediaVariant = 'original'): string {
		const k = encodeURIComponent(mediaKey);
		if (variant === 'original') return this.url(`/media/${k}`);
		if (variant === 'poster') return this.url(`/media/${k}/poster.jpg`);
		if (variant === 'sprite.json') return this.url(`/media/${k}/sprite.json`);
		if (variant === 'peaks.json') return this.url(`/media/${k}/peaks.json`);
		if ('proxy' in variant) return this.url(`/media/${k}/proxy/${variant.proxy}`);
		if ('sprite' in variant) return this.url(`/media/${k}/sprite/${variant.sprite}.jpg`);
		return this.url(`/media/${k}/peaks/${variant.peaks}.bin`);
	}
	renderOutputUrl(jobId: string): string {
		return this.url(buildPath(ROUTES.renderOutput.path, { jobId }));
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

	// ------------------------------------------------------------ streams and uploads

	/** Opens the NDJSON event stream; reconnects with 1 s → 30 s backoff and resumes with `since`. */
	openEvents(
		opts: { since?: number | null; projectId?: string },
		handlers: EventHandlers,
		streamOpts: EventStreamOptions = {},
	): EventStream {
		return openEventStream(
			this.fetchImpl,
			(since) => this.eventsUrl({ since, projectId: opts.projectId }),
			handlers,
			{
				...streamOpts,
				since: opts.since ?? null,
				headers: this.authHeaders(),
			},
		);
	}

	/**
	 * Resumable chunked upload (S04:IN-005): create → PUT chunks with byte offsets → complete. Offset
	 * mismatches (409) resume from the engine's offset; aborting deletes the upload session.
	 */
	async uploadFile(
		blob: Blob,
		opts: {
			projectId: string;
			fileName?: string;
			mimeType?: string;
			clientFingerprint?: string;
			onProgress?(p: UploadProgress): void;
			signal?: AbortSignal;
		},
	): Promise<RegisteredMedia> {
		const fileName = opts.fileName ?? (blob as File).name ?? 'upload.bin';
		const session = await this.createUpload({
			projectId: opts.projectId,
			fileName,
			byteSize: blob.size,
			mimeType: opts.mimeType ?? (blob.type || 'application/octet-stream'),
			...(opts.clientFingerprint ? { clientFingerprint: opts.clientFingerprint } : {}),
		});
		const chunkSize = session.chunkSize || UPLOAD_CHUNK_BYTES;
		let offset = session.offset;
		opts.onProgress?.({ loaded: offset, total: blob.size });
		try {
			let guard = 0;
			while (offset < blob.size) {
				if (opts.signal?.aborted) throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError');
				const end = Math.min(blob.size, offset + chunkSize);
				try {
					const r = await this.appendUpload(session.uploadId, offset, blob.slice(offset, end), opts.signal);
					offset = r.offset;
				} catch (e) {
					const mismatch =
						e instanceof EngineError && e.code === 'UPLOAD_OFFSET_MISMATCH'
							? UploadOffsetMismatchSchema.safeParse(e.detail)
							: null;
					if (!mismatch?.success || ++guard > 5) throw e;
					offset = mismatch.data.expectedOffset;
				}
				opts.onProgress?.({ loaded: offset, total: blob.size });
			}
			return await this.completeUpload(session.uploadId);
		} catch (e) {
			if (opts.signal?.aborted) await this.abortUpload(session.uploadId).catch(() => undefined);
			throw e;
		}
	}
}
