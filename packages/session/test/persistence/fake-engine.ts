// A tiny in-memory emulation of the engine project/lease routes (ARCHITECTURE §9.2) behind a fake fetch,
// so EngineProjectStore is tested through the real EngineClient (URL building, If-Match, error shapes).
import {
	type EnvelopeJson,
	EnvelopeSchema,
	LeaseRequestSchema,
	ProjectCreateRequestSchema,
} from '@jasper/api';
import { EngineClient } from '@jasper/engine-client';
import { createCounterIdSource, createEmptyProject, makeEnvelope } from '@jasper/project';

type Stored = { envelope: EnvelopeJson; view: unknown; revision: number };
type LeaseRec = { leaseId: string; sessionId: string; expiresAt: number };

export type FakeRequest = {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: unknown;
	keepalive?: boolean;
};

export class FakeEngine {
	projects = new Map<string, Stored>();
	leases = new Map<string, LeaseRec>();
	/** Crash-recovery journals: `<projectId>/<sessionId>` → the last accepted PUT body. */
	journals = new Map<string, unknown>();
	requests: FakeRequest[] = [];
	/** Fail the next request matching `method path` with this status/body (one shot). */
	failures: { match: RegExp; status: number; body?: unknown; network?: boolean }[] = [];
	private ids = createCounterIdSource(900);
	private leaseSeq = 0;
	nowMs = Date.parse('2026-09-30T10:00:00.000Z');

	seed(name = 'P'): string {
		const doc = createEmptyProject({ ids: this.ids, name, preset: 'hd-1080p-30' });
		this.projects.set(doc.projectId, {
			envelope: makeEnvelope(doc, {
				revision: 0,
				savedAt: new Date(this.nowMs).toISOString(),
				platform: 'fake',
			}),
			view: null,
			revision: 0,
		});
		return doc.projectId;
	}

	client(): EngineClient {
		return new EngineClient({ fetch: this.fetch });
	}

	fetch: typeof fetch = async (input, init = {}) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const method = (init.method ?? 'GET').toUpperCase();
		const path = url.split('?')[0]!;
		const headers = Object.fromEntries(new Headers(init.headers).entries());
		const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
		this.requests.push({ method, path, headers, body, keepalive: init.keepalive });
		const fi = this.failures.findIndex((f) => f.match.test(`${method} ${path}`));
		if (fi >= 0) {
			const f = this.failures.splice(fi, 1)[0]!;
			if (f.network) throw new TypeError('fetch failed');
			return this.json(f.body ?? { code: 'INTERNAL', message: 'boom', retryable: true }, f.status);
		}
		return this.route(method, path, headers, body);
	};

	private json(b: unknown, status = 200): Response {
		return new Response(JSON.stringify(b), {
			status,
			headers: { 'content-type': 'application/json', 'x-jasper-api': '1' },
		});
	}
	private err(status: number, code: string, detail?: unknown): Response {
		return this.json({ code, message: code, retryable: false, ...(detail ? { detail } : {}) }, status);
	}

	private route(method: string, path: string, headers: Record<string, string>, body: unknown): Response {
		let m: RegExpMatchArray | null;
		if (method === 'POST' && path === '/api/projects') {
			const request = ProjectCreateRequestSchema.parse(body);
			const doc = createEmptyProject({ ids: this.ids, name: request.name, preset: request.preset });
			this.projects.set(doc.projectId, {
				envelope: makeEnvelope(doc, { revision: 0, savedAt: 'x', platform: 'fake' }),
				view: null,
				revision: 0,
			});
			return this.json({ projectId: doc.projectId });
		}
		if ((m = path.match(/^\/api\/projects\/([^/]+)$/))) {
			const id = decodeURIComponent(m[1]!);
			const p = this.projects.get(id);
			if (!p) return this.err(404, 'PROJECT_NOT_FOUND');
			if (method === 'GET') return this.json({ envelope: p.envelope, view: p.view, revision: p.revision });
			if (method === 'PUT') {
				const base = Number(headers['if-match']);
				if (base !== p.revision) return this.err(409, 'REVISION_CONFLICT', { revision: p.revision });
				p.envelope = EnvelopeSchema.parse(body);
				p.revision = Math.max(p.revision + 1, p.envelope.revision);
				return this.json({ revision: p.revision });
			}
		}

		if ((m = path.match(/^\/api\/projects\/([^/]+)\/lease$/)) && method === 'POST') {
			const id = decodeURIComponent(m[1]!);
			const cur = this.leases.get(id);
			const request = LeaseRequestSchema.parse(body);
			if (cur && cur.sessionId !== request.sessionId && cur.expiresAt > this.nowMs && !request.takeOver)
				return this.err(409, 'LEASE_HELD', {
					holderSessionId: cur.sessionId,
					expiresAt: new Date(cur.expiresAt).toISOString(),
				});
			const rec = {
				leaseId: `lease_${++this.leaseSeq}`,
				sessionId: request.sessionId,
				expiresAt: this.nowMs + 30_000,
			};
			this.leases.set(id, rec);
			return this.json(this.leaseJson(id, rec));
		}
		if ((m = path.match(/^\/api\/projects\/([^/]+)\/lease\/([^/]+)\/heartbeat$/)) && method === 'POST') {
			const id = decodeURIComponent(m[1]!);
			const cur = this.leases.get(id);
			if (!cur || cur.leaseId !== m[2]) return this.err(404, 'LEASE_NOT_FOUND');
			cur.expiresAt = this.nowMs + 30_000;
			return this.json(this.leaseJson(id, cur));
		}
		if ((m = path.match(/^\/api\/projects\/([^/]+)\/lease\/([^/]+)$/)) && method === 'DELETE') {
			const id = decodeURIComponent(m[1]!);
			const cur = this.leases.get(id);
			if (!cur || cur.leaseId !== m[2]) return this.err(404, 'LEASE_NOT_FOUND');
			this.leases.delete(id);
			return this.json({ ok: true });
		}
		if ((m = path.match(/^\/api\/projects\/([^/]+)\/recovery\/([^/]+)$/)) && method === 'PUT') {
			// Like the engine: only the session holding the lease, under its current id, writes its journal.
			const id = decodeURIComponent(m[1]!);
			const cur = this.leases.get(id);
			if (!cur || cur.leaseId !== (body as { leaseId?: string }).leaseId)
				return this.err(404, 'LEASE_NOT_FOUND');
			if (cur.sessionId !== m[2]) return this.err(409, 'LEASE_HELD');
			this.journals.set(`${id}/${m[2]}`, body);
			return this.json({ ok: true, savedAt: new Date(this.nowMs).toISOString() });
		}
		if ((m = path.match(/^\/api\/projects\/([^/]+)\/recovery\/([^/]+)$/)) && method === 'DELETE') {
			this.journals.delete(`${decodeURIComponent(m[1]!)}/${m[2]}`);
			return this.json({ ok: true });
		}
		return this.err(501, 'NOT_IMPLEMENTED');
	}

	private leaseJson(projectId: string, r: LeaseRec) {
		return {
			leaseId: r.leaseId,
			projectId,
			sessionId: r.sessionId,
			acquiredAt: new Date(this.nowMs).toISOString(),
			expiresAt: new Date(r.expiresAt).toISOString(),
			heartbeatMs: 10_000,
		};
	}
}
