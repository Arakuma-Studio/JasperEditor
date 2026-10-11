import type { EngineJob, RegisteredMedia } from '@jasper/api';
import { EngineClient } from '@jasper/engine-client';
import { mgRegistry } from '@jasper/mg-templates';
import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
} from '@jasper/project';
import { EditorSession, MemoryProjectStore } from '@jasper/session';

export function registered(
	name: string,
	opts: {
		key?: string;
		fingerprint?: string;
		width?: number;
		height?: number;
		fps?: { num: number; den: number };
		seconds?: number;
		kind?: RegisteredMedia['kind'];
		path?: string;
	} = {},
): RegisteredMedia {
	const kind = opts.kind ?? 'video';
	const streams: RegisteredMedia['probe']['streams'] = [];
	if (kind === 'video' || kind === 'image')
		streams.push({
			index: 0,
			type: 'video',
			codec: kind === 'image' ? 'png' : 'h264',
			width: opts.width ?? 1920,
			height: opts.height ?? 1080,
			pixelAspect: { num: 1, den: 1 },
			frameRate: opts.fps ?? { num: 30, den: 1 },
			pixelFormat: 'yuv420p',
			bitDepth: 8,
			color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
			browserDecodable: true,
		});
	if (kind === 'video' || kind === 'audio')
		streams.push({
			index: 1,
			type: 'audio',
			codec: 'aac',
			sampleRate: 48000,
			channels: 2,
			channelLayout: 'stereo',
		});
	return {
		mediaKey: opts.key ?? `mk_${name.replace(/\W/g, '')}0000`,
		fingerprint: opts.fingerprint ?? `q1:${name}`,
		originalName: name,
		sizeBytes: 1000,
		container: 'mov,mp4',
		kind,
		probe: {
			durationFlicks: kind === 'image' ? null : (opts.seconds ?? 10) * FLICKS_PER_SECOND,
			startTimecode: null,
			streams,
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: opts.path ? [{ type: 'path', path: opts.path, relativeToProject: null }] : [],
		browserPlayable: 'yes',
	};
}

export type Handler = (req: {
	method: string;
	path: string;
	query: URLSearchParams;
	body: unknown;
}) => { status?: number; body: unknown } | undefined;

/** Fake engine: route handlers tried in order; unknown routes answer 501 NOT_IMPLEMENTED. */
export class ScriptedEngine {
	requests: { method: string; path: string; body: unknown; headers: Record<string, string> }[] = [];
	handlers: Handler[] = [];
	uploads = new Map<string, { name: string; size: number; offset: number }>();
	/** RegisteredMedia returned for uploaded file names. */
	media = new Map<string, RegisteredMedia>();
	jobs: EngineJob[] = [];

	constructor() {
		this.handlers.push((r) => {
			if (r.path === '/health') return { body: { ok: true, version: '0.1.0', apiVersion: 1 } };
			if (r.method === 'POST' && r.path === '/api/uploads') {
				const b = r.body as { fileName: string; byteSize: number };
				const id = `up_${this.uploads.size + 1}`;
				this.uploads.set(id, { name: b.fileName, size: b.byteSize, offset: 0 });
				return { body: { uploadId: id, chunkSize: 4, offset: 0 } };
			}
			let m = r.path.match(/^\/api\/uploads\/([^/]+)$/);
			if (m && r.method === 'PUT') {
				const u = this.uploads.get(m[1]!)!;
				u.offset = Math.min(u.size, Number(r.query.get('offset')) + 4);
				return { body: { offset: u.offset } };
			}
			m = r.path.match(/^\/api\/uploads\/([^/]+)\/complete$/);
			if (m) {
				const u = this.uploads.get(m[1]!)!;
				const reg = this.media.get(u.name);
				if (!reg)
					return {
						status: 415,
						body: { code: 'UNSUPPORTED_MEDIA', message: `${u.name} has no streams`, retryable: false },
					};
				return { body: reg };
			}
			if (r.path === '/api/jobs') return { body: { jobs: this.jobs } };
			return undefined;
		});
	}

	on(h: Handler): this {
		this.handlers.unshift(h);
		return this;
	}

	fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
		const u = new URL(url, 'http://engine.test');
		const method = (init.method ?? 'GET').toUpperCase();
		let body: unknown;
		if (typeof init.body === 'string') body = JSON.parse(init.body);
		this.requests.push({
			method,
			path: u.pathname,
			body,
			headers: (init.headers ?? {}) as Record<string, string>,
		});
		for (const h of this.handlers) {
			const res = h({ method, path: u.pathname, query: u.searchParams, body });
			if (res)
				return new Response(JSON.stringify(res.body), {
					status: res.status ?? 200,
					headers: { 'content-type': 'application/json', 'x-jasper-api': '1' },
				});
		}
		return new Response(JSON.stringify({ code: 'NOT_IMPLEMENTED', message: 'later', retryable: false }), {
			status: 501,
			headers: { 'x-jasper-api': '1' },
		});
	};

	client(): EngineClient {
		return new EngineClient({ fetch: this.fetch as unknown as typeof fetch });
	}
}

export async function memorySession(opts: { preset?: string } = {}) {
	const ids = createCounterIdSource(1);
	const store = new MemoryProjectStore({ ids, now: () => '2026-09-30T10:00:00.000Z' });
	const doc = createEmptyProject({ ids, name: 'Film', preset: opts.preset ?? 'hd-1080p-30' });
	store.put(doc);
	const session = await EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx: { ids, now: () => '2026-09-30T10:00:00.000Z', registries: defaultRegistries(mgRegistry) },
		sessionId: 'test',
	});
	return { session, store, ids };
}
