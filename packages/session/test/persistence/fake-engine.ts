// A tiny in-memory emulation of the engine project/lease routes (ARCHITECTURE §9.2) behind a fake fetch,
// so EngineProjectStore is tested through the real EngineClient (URL building, If-Match, error shapes).
import { EngineClient } from '@jasper/engine-client';
import { createCounterIdSource, createEmptyProject, makeEnvelope } from '@jasper/project';

type Stored = { envelope: Record<string, unknown>; view: unknown; revision: number; versions: number };
type LeaseRec = { leaseId: string; sessionId: string; expiresAt: number };

export type FakeRequest = { method: string; path: string; headers: Record<string, string>; body: unknown };

export class FakeEngine {
	projects = new Map<string, Stored>();
	leases = new Map<string, LeaseRec>();
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
			versions: 0,
		});
		return doc.projectId;
	}

	client(): EngineClient {
		return new EngineClient({ fetch: this.fetch as unknown as typeof fetch });
	}

	fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
		const method = (init.method ?? 'GET').toUpperCase();
		const path = url.split('?')[0]!;
		const headers = (init.headers ?? {}) as Record<string, string>;
		const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
		this.requests.push({ method, path, headers, body });
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

	private route(method: string, path: string, headers: Record<string, string>, body: any): Response {
		let m: RegExpMatchArray | null;
		if (method === 'GET' && path === '/api/projects') {
			return this.json({
				projects: [...this.projects.entries()].map(([id, p]) => ({
					projectId: id,
					name: (p.envelope.document as { name: string }).name,
					modifiedAt: p.envelope.savedAt,
					thumbnail: null,
					schemaVersion: 1,
					sizeBytes: 10,
					revision: p.revision,
				})),
			});
		}
		if (method === 'POST' && path === '/api/projects') {
			const doc = createEmptyProject({ ids: this.ids, name: body.name, preset: body.preset });
			this.projects.set(doc.projectId, {
				envelope: makeEnvelope(doc, { revision: 0, savedAt: 'x', platform: 'fake' }),
				view: null,
				revision: 0,
				versions: 0,
			});
			return this.json({ projectId: doc.projectId });
		}
		if ((m = path.match(/^\/api\/projects\/([^/]+)$/))) {
			const id = decodeURIComponent(m[1]!);
			const p = this.projects.get(id);
			if (!p) return this.err(404, 'PROJECT_NOT_FOUND');
			if (method === 'GET') return this.json({ envelope: p.envelope, view: p.view, revision: p.revision });
			if (method === 'DELETE') {
				this.projects.delete(id);
				return this.json({ ok: true });
			}
			if (method === 'PUT') {
				const base = Number(headers['if-match']);
				if (base !== p.revision) return this.err(409, 'REVISION_CONFLICT', { revision: p.revision });
				p.envelope = body;
				p.revision = Math.max(p.revision + 1, Number(body.revision) || 0);
				p.versions++;
				return this.json({ revision: p.revision });
			}
		}
		if ((m = path.match(/^\/api\/projects\/([^/]+)\/view$/)) && method === 'PUT') {
			this.projects.get(decodeURIComponent(m[1]!))!.view = body;
			return this.json({ ok: true });
		}
		if ((m = path.match(/^\/api\/projects\/([^/]+)\/versions$/))) {
			return this.json({ versions: [] });
		}
		if ((m = path.match(/^\/api\/projects\/([^/]+)\/lease$/)) && method === 'POST') {
			const id = decodeURIComponent(m[1]!);
			const cur = this.leases.get(id);
			if (cur && cur.sessionId !== body.sessionId && cur.expiresAt > this.nowMs && !body.takeOver)
				return this.err(409, 'LEASE_HELD', {
					holderSessionId: cur.sessionId,
					expiresAt: new Date(cur.expiresAt).toISOString(),
				});
			const rec = {
				leaseId: `lease_${++this.leaseSeq}`,
				sessionId: body.sessionId,
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
