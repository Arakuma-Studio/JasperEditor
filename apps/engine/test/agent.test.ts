import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvelopeJson } from '@jasper/api';
import { AgentMcpInfoSchema } from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	makeEnvelope,
	type TransactionResult,
} from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import {
	type AgentProjectStore,
	AgentService,
	type AgentSocket,
	type SaveOutcome,
} from '../src/agent/index.ts';
import { findMcpEntry } from '../src/agent/mcp-entry.ts';
import { createServer, engineConfig } from '../src/index.ts';

const H = { host: '127.0.0.1:47900' };
const apps: FastifyInstance[] = [];
const services: AgentService[] = [];
afterEach(async () => {
	for (const a of apps.splice(0)) await a.close();
	for (const s of services.splice(0)) s.close();
	vi.useRealTimers();
});

function seedProject(projectFile: (id: string) => string) {
	const ids = createCounterIdSource(3);
	const doc = createEmptyProject({ ids, name: 'Agent test', preset: 'hd-1080p-30' });
	const file = projectFile(doc.projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	const envelope = makeEnvelope(doc, { revision: 0, savedAt: '2026-09-30T00:00:00.000Z', platform: 'test' });
	writeFileSync(file, JSON.stringify(envelope));
	return { projectId: doc.projectId, seqId: Object.keys(doc.sequences)[0]!, file };
}

async function makeEngine(token: string | null = null) {
	const appdir = mkdtempSync(join(tmpdir(), 'jasper-agent-'));
	const config = engineConfig({ appdir, port: 47900, dev: true, token, webDir: null, env: {} });
	const app = await createServer(config);
	apps.push(app);
	await app.ready();
	const events: { type: string; payload: unknown; projectId?: string }[] = [];
	let delivered = () => {};
	app.jasper.services.events = {
		publish: (type: string, payload: unknown, projectId?: string) => {
			events.push({ type, payload, projectId });
			delivered();
		},
	};
	const project = seedProject(appdirPaths(appdir).projectFile);
	return {
		app,
		events,
		...project,
		async event(type: string) {
			while (!events.some((e) => e.type === type))
				await new Promise<void>((resolve) => {
					delivered = resolve;
				});
			return events.find((e) => e.type === type)!;
		},
	};
}

const tx = (commands: unknown[], extra: Record<string, unknown> = {}) => ({
	label: 'Test',
	origin: { agent: 'test-agent' },
	commands,
	...extra,
});

async function postTx(app: FastifyInstance, projectId: string, transaction: unknown) {
	const r = await app.inject({
		method: 'POST',
		url: '/api/agent/tx',
		headers: H,
		payload: { projectId, transaction },
	});
	expect(r.statusCode).toBe(200);
	return r.json() as { result: TransactionResult; appliedBy: 'session' | 'headless' };
}

function inbox(ws: WebSocket) {
	const queue: Record<string, unknown>[] = [];
	const waiters: ((m: Record<string, unknown>) => void)[] = [];
	ws.on('message', (d) => {
		const m = JSON.parse(String(d)) as Record<string, unknown>;
		const w = waiters.shift();
		if (w) w(m);
		else queue.push(m);
	});
	return {
		next(): Promise<Record<string, unknown>> {
			const m = queue.shift();
			return m ? Promise.resolve(m) : new Promise((r) => waiters.push(r));
		},
		async until(pred: (m: Record<string, unknown>) => boolean) {
			for (;;) {
				const m = await this.next();
				if (pred(m)) return m;
			}
		},
	};
}

async function connectSession(app: FastifyInstance, projectId: string) {
	const ws = await app.injectWS('/agent', { headers: H });
	const box = inbox(ws);
	ws.send(JSON.stringify({ type: 'hello', projectId, sessionId: 'ses_test', leaseId: 'lease_1' }));
	expect(await box.next()).toMatchObject({ type: 'welcome' });
	return { ws, box };
}

describe('GET /api/agent/schema (S01:AGT-002)', () => {
	it('describes commands, queries, addressing, approvals and error codes', async () => {
		const { app } = await makeEngine();
		const r = await app.inject({ method: 'GET', url: '/api/agent/schema', headers: H });
		expect(r.statusCode).toBe(200);
		const s = r.json();
		expect(s.protocol).toBe('jasper.tx/1');
		expect(s.commands['marker.add'].schema).toBeTruthy();
		expect(Object.keys(s.queries)).toContain('sequence.summary');
		expect(s.errorCodes).toContain('E_APPROVAL_TIMEOUT');
		expect(s.approvals.commands).toContain('track.remove');
		expect(s.presets.length).toBeGreaterThan(0);
	});
});

describe('POST /api/agent/open-project (jasper-mcp open_project_in_editor)', () => {
	it('publishes editor.openProject globally and reports listening editors; 404 for unknown projects', async () => {
		const { app, events, projectId } = await makeEngine();
		const r = await app.inject({
			method: 'POST',
			url: '/api/agent/open-project',
			headers: H,
			payload: { projectId },
		});
		expect(r.statusCode).toBe(200);
		expect(r.json()).toMatchObject({ projectId, path: `/project/${projectId}`, live: false });
		expect(typeof r.json().editors).toBe('number');
		expect(events).toContainEqual({
			type: 'editor.openProject',
			payload: { projectId },
			projectId: undefined,
		});
		const missing = await app.inject({
			method: 'POST',
			url: '/api/agent/open-project',
			headers: H,
			payload: { projectId: 'prj_nope' },
		});
		expect(missing.statusCode).toBe(404);
		expect(missing.json()).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
	});
});

describe('GET /api/agent/mcp-info (Help ▸ Connect an AI Agent…)', () => {
	it('reports the HTTP endpoint and the stdio bundle path, never the token', async () => {
		const token = 'secret-mcp-info-token';
		const { app } = await makeEngine(token);
		const r = await app.inject({
			method: 'GET',
			url: '/api/agent/mcp-info',
			headers: { ...H, authorization: `Bearer ${token}` },
		});
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(AgentMcpInfoSchema.safeParse(body).success).toBe(true);
		expect(body.httpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
		expect(JSON.stringify(body)).not.toContain(token);
	});

	it('finds the bundle in a checkout and in packaged resources; JASPER_MCP_ENTRY overrides', () => {
		const root = mkdtempSync(join(tmpdir(), 'jasper-mcp-entry-'));
		try {
			mkdirSync(join(root, 'apps/engine/dist'), { recursive: true });
			mkdirSync(join(root, 'apps/engine/src/agent'), { recursive: true });
			expect(findMcpEntry({}, join(root, 'apps/engine/dist'))).toBeNull();
			mkdirSync(join(root, 'apps/mcp/dist'), { recursive: true });
			const bundle = join(root, 'apps/mcp/dist/jasper-mcp.mjs');
			writeFileSync(bundle, '');
			expect(findMcpEntry({}, join(root, 'apps/engine/dist'))).toBe(bundle);
			expect(findMcpEntry({}, join(root, 'apps/engine/src/agent'))).toBe(bundle);
			mkdirSync(join(root, 'resources/engine'), { recursive: true });
			mkdirSync(join(root, 'resources/mcp'), { recursive: true });
			const packaged = join(root, 'resources/mcp/jasper-mcp.mjs');
			writeFileSync(packaged, '');
			expect(findMcpEntry({}, join(root, 'resources/engine'))).toBe(packaged);
			expect(findMcpEntry({ JASPER_MCP_ENTRY: packaged }, join(root, 'apps/engine/dist'))).toBe(packaged);
			expect(
				findMcpEntry({ JASPER_MCP_ENTRY: join(root, 'nope.mjs') }, join(root, 'apps/engine/dist')),
			).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('headless mode (S01:AGT-020)', () => {
	it('applies, saves a new revision and publishes doc.changed', async () => {
		const { app, events, projectId, file } = await makeEngine();
		const r = await postTx(
			app,
			projectId,
			tx([{ type: 'marker.add', frame: 30, name: 'Agent marker', markerType: 'agent-note' }]),
		);
		expect(r.appliedBy).toBe('headless');
		expect(r.result).toMatchObject({ ok: true, revision: 1 });
		const saved = JSON.parse(readFileSync(file, 'utf8'));
		expect(saved.revision).toBe(1);
		const seq = Object.values(saved.document.sequences)[0] as { markers: { name: string }[] };
		expect(seq.markers.map((m) => m.name)).toEqual(['Agent marker']);
		expect(events.find((e) => e.type === 'doc.changed')).toMatchObject({
			projectId,
			payload: { revision: 1, label: 'Agent: Test', origin: { agent: 'test-agent' } },
		});
		const q = await app.inject({
			method: 'POST',
			url: '/api/agent/query',
			headers: H,
			payload: { projectId, query: 'sequence.summary' },
		});
		expect(q.statusCode).toBe(200);
		expect(q.json()).toMatchObject({
			revision: 1,
			via: 'headless',
			result: { markers: [{ name: 'Agent marker' }] },
		});
	});

	it('rejects destructive transactions with E_APPROVAL_DENIED and unknown projects with 404', async () => {
		const { app, projectId } = await makeEngine();
		const r = await postTx(app, projectId, tx([{ type: 'track.remove', trackIds: ['V3'] }]));
		expect(r.result).toMatchObject({ ok: false, errors: [{ code: 'E_APPROVAL_DENIED' }] });
		const nf = await app.inject({
			method: 'POST',
			url: '/api/agent/tx',
			headers: H,
			payload: { projectId: 'prj_missing', transaction: tx([]) },
		});
		expect(nf.statusCode).toBe(404);
		expect(nf.json()).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
		const sel = await app.inject({
			method: 'POST',
			url: '/api/agent/query',
			headers: H,
			payload: { projectId, query: 'selection.get' },
		});
		expect(sel.statusCode).toBe(409);
		expect(sel.json()).toMatchObject({ code: 'NO_SESSION' });
	});

	it('rejects a stale expectedRevision touching a changed entity and fast-forwards otherwise (S01 AC-11)', async () => {
		const { app, projectId } = await makeEngine();
		const a = await postTx(
			app,
			projectId,
			tx([{ type: 'marker.add', frame: 10, name: 'M', markerType: 'comment', ref: '$m' }]),
		);
		expect(a.result.ok).toBe(true);
		const markerId = a.result.ok ? a.result.refs.$m! : '';
		const b = await postTx(
			app,
			projectId,
			tx([{ type: 'marker.update', markerId, name: 'M2' }], { expectedRevision: 1 }),
		);
		expect(b.result).toMatchObject({ ok: true, revision: 2 });
		const stale = await postTx(
			app,
			projectId,
			tx([{ type: 'marker.update', markerId, name: 'M3' }], { expectedRevision: 1 }),
		);
		expect(stale.result).toMatchObject({
			ok: false,
			errors: [{ code: 'E_REVISION_MISMATCH', blocking: [markerId] }],
		});
		const ff = await postTx(
			app,
			projectId,
			tx([{ type: 'clip.addText', at: 0, duration: 30, track: 'V2', content: { text: 'FF' } }], {
				expectedRevision: 1,
			}),
		);
		expect(ff.result).toMatchObject({ ok: true, revision: 3 });
	});
});

describe('headless undo / redo (S01:UND-008 without an editor session)', () => {
	const markers = (file: string) =>
		(
			Object.values(JSON.parse(readFileSync(file, 'utf8')).document.sequences)[0] as {
				markers: { name: string }[];
			}
		).markers.map((m) => m.name);
	const undo = tx([{ type: 'history.undo' }]);
	const redo = tx([{ type: 'history.redo' }]);

	it("undoes and redoes the agent's own headless transactions as new saved revisions", async () => {
		const { app, events, projectId, file } = await makeEngine();
		await postTx(app, projectId, tx([{ type: 'marker.add', frame: 10, name: 'One' }]));
		const two = await postTx(app, projectId, tx([{ type: 'marker.add', frame: 20, name: 'Two', ref: '$m' }]));
		const markerId = two.result.ok ? two.result.refs.$m : '';
		expect(markers(file)).toEqual(['One', 'Two']);

		const u = await postTx(app, projectId, undo);
		expect(u).toMatchObject({
			appliedBy: 'headless',
			result: { ok: true, revision: 3, deleted: [markerId], results: [{ 'history.undo': 'Agent: Test' }] },
		});
		expect(markers(file)).toEqual(['One']);
		expect(JSON.parse(readFileSync(file, 'utf8')).revision).toBe(3);
		expect(events.at(-1)).toMatchObject({ type: 'doc.changed', payload: { revision: 3, isUndo: true } });
		expect((await postTx(app, projectId, undo)).result).toMatchObject({ ok: true, revision: 4 });
		expect(markers(file)).toEqual([]);

		expect((await postTx(app, projectId, redo)).result).toMatchObject({ ok: true, revision: 5 });
		expect((await postTx(app, projectId, redo)).result).toMatchObject({ ok: true, revision: 6 });
		expect(markers(file)).toEqual(['One', 'Two']);
	});

	it("refuses with nothing to undo, another agent's entry on top, or a change made since, and keeps the project", async () => {
		const { app, projectId, file } = await makeEngine();
		expect((await postTx(app, projectId, undo)).result).toMatchObject({
			ok: false,
			errors: [{ code: 'E_NOT_FOUND' }],
		});
		await postTx(app, projectId, tx([{ type: 'marker.add', frame: 10, name: 'Mine' }]));
		await postTx(app, projectId, {
			...tx([{ type: 'marker.add', frame: 20, name: 'Theirs' }]),
			origin: { agent: 'other-agent' },
		});
		expect((await postTx(app, projectId, undo)).result).toMatchObject({
			ok: false,
			errors: [{ code: 'E_NOT_OWNER' }],
		});
		expect(markers(file)).toEqual(['Mine', 'Theirs']);

		// Another writer (an editor that has since closed, a version restore) saves over the agent's last step.
		await postTx(app, projectId, tx([{ type: 'marker.add', frame: 30, name: 'Third' }]));
		const env = JSON.parse(readFileSync(file, 'utf8'));
		writeFileSync(
			file,
			JSON.stringify({ ...env, revision: env.revision + 1, document: { ...env.document, name: 'Renamed' } }),
		);
		const refused = await postTx(app, projectId, undo);
		expect(refused.result).toMatchObject({ ok: false, revision: 4, errors: [{ code: 'E_NOT_OWNER' }] });
		const after = JSON.parse(readFileSync(file, 'utf8'));
		expect([after.revision, after.document.name, markers(file)]).toEqual([
			4,
			'Renamed',
			['Mine', 'Theirs', 'Third'],
		]);
	});
});

describe('WS /agent relay (ARCHITECTURE §11)', () => {
	it('relays transactions and queries to the session that holds the lease and forwards its events', async () => {
		const { app, event, projectId } = await makeEngine();
		const { ws, box } = await connectSession(app, projectId);

		const pending = postTx(app, projectId, tx([{ type: 'marker.add', frame: 5, name: 'Live' }]));
		const req = await box.until((m) => m.type === 'request');
		expect(req).toMatchObject({
			kind: 'tx',
			payload: { transaction: { label: 'Test', origin: { agent: 'test-agent' } }, approved: false },
		});
		const result = {
			ok: true,
			revision: 8,
			refs: {},
			created: ['mrk_X'],
			changed: [],
			deleted: [],
			warnings: [],
			results: [null],
		};
		ws.send(JSON.stringify({ type: 'response', id: req.id, result }));
		expect(await pending).toEqual({ result, appliedBy: 'session' });

		const q = app.inject({
			method: 'POST',
			url: '/api/agent/query',
			headers: H,
			payload: { projectId, query: 'playhead.get' },
		});
		const qreq = await box.until((m) => m.type === 'request');
		expect(qreq).toMatchObject({ kind: 'query', payload: { query: 'playhead.get' } });
		ws.send(
			JSON.stringify({ type: 'response', id: qreq.id, result: { result: { frame: 12 }, revision: 8 } }),
		);
		expect((await q).json()).toEqual({ result: { frame: 12 }, revision: 8, via: 'session' });

		const qe = app.inject({
			method: 'POST',
			url: '/api/agent/query',
			headers: H,
			payload: { projectId, query: 'doc.get', args: { path: ['x'] } },
		});
		const qereq = await box.until((m) => m.type === 'request');
		ws.send(
			JSON.stringify({
				type: 'response',
				id: qereq.id,
				result: null,
				error: { code: 'E_NOT_FOUND', message: 'No such path' },
			}),
		);
		expect((await qe).statusCode).toBe(404);

		ws.send(
			JSON.stringify({
				type: 'event',
				event: 'doc.changed',
				payload: {
					revision: 9,
					label: 'Move',
					origin: 'user',
					created: [],
					changed: ['clp_A'],
					deleted: [],
					isUndo: false,
				},
			}),
		);
		expect(await event('doc.changed')).toMatchObject({
			projectId,
			payload: { revision: 9, projectId },
		});
		ws.terminate();
	});

	it('asks the session for approval; approve relays with approved:true, deny returns E_APPROVAL_DENIED', async () => {
		const { app, events, projectId } = await makeEngine();
		const { ws, box } = await connectSession(app, projectId);

		const denied = postTx(app, projectId, tx([{ type: 'track.remove', trackIds: ['V3'] }]));
		const ask = await box.until((m) => m.type === 'event' && m.event === 'agent.approval.requested');
		const approval = ask.payload as {
			approvalId: string;
			reasons: string[];
			summary: string;
			answerKey: string;
		};
		expect(approval.reasons[0]).toMatch(/track.remove/);
		// The engine event agents can read on /events names the request but never carries the answer key (AGT-2).
		const published = events.find((e) => e.type === 'agent.approval.requested');
		expect(published).toBeTruthy();
		expect(JSON.stringify(published)).not.toContain(approval.answerKey);
		ws.send(
			JSON.stringify({
				type: 'event',
				event: 'agent.approval.resolve',
				payload: { approvalId: approval.approvalId, decision: 'denied', answerKey: approval.answerKey },
			}),
		);
		expect((await denied).result).toMatchObject({ ok: false, errors: [{ code: 'E_APPROVAL_DENIED' }] });

		const approved = postTx(app, projectId, tx([{ type: 'track.remove', trackIds: ['V3'] }]));
		const ask2 = await box.until((m) => m.type === 'event' && m.event === 'agent.approval.requested');
		const card2 = ask2.payload as { approvalId: string; answerKey: string };
		ws.send(
			JSON.stringify({
				type: 'event',
				event: 'agent.approval.resolve',
				payload: { approvalId: card2.approvalId, decision: 'approved', answerKey: card2.answerKey },
			}),
		);
		const req = await box.until((m) => m.type === 'request');
		expect(req).toMatchObject({ kind: 'tx', payload: { approved: true } });
		const result = {
			ok: true,
			revision: 1,
			refs: {},
			created: [],
			changed: [],
			deleted: ['trk_X'],
			warnings: [],
			results: [null],
		};
		ws.send(JSON.stringify({ type: 'response', id: req.id, result }));
		expect((await approved).result).toEqual(result);
		expect(
			events
				.filter((e) => e.type === 'agent.approval.resolved')
				.map((e) => (e.payload as { decision: string }).decision),
		).toEqual(['denied', 'approved']);
		ws.terminate();
	});

	it('falls back to headless when the session disconnects before a request', async () => {
		const { app, projectId } = await makeEngine();
		const { ws } = await connectSession(app, projectId);
		const closed = once(ws, 'close');
		ws.close();
		await closed;
		const r = await postTx(app, projectId, tx([{ type: 'marker.add', frame: 1, name: 'after close' }]));
		expect(r).toMatchObject({ appliedBy: 'headless', result: { ok: true } });
	});
});

class FakeSocket extends EventEmitter implements AgentSocket {
	readyState = 1;
	sent: Record<string, unknown>[] = [];
	send(data: string) {
		const m = JSON.parse(data) as Record<string, unknown>;
		this.sent.push(m);
		this.emit('sent', m);
	}
	close() {
		this.readyState = 3;
		this.emit('close');
	}
	client(msg: unknown) {
		this.emit('message', Buffer.from(JSON.stringify(msg)));
	}
	nextSent(pred: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
		const hit = this.sent.find(pred);
		if (hit) return Promise.resolve(hit);
		return new Promise((resolve) => {
			const on = (m: Record<string, unknown>) => {
				if (pred(m)) {
					this.off('sent', on);
					resolve(m);
				}
			};
			this.on('sent', on);
		});
	}
}

class MemoryStore implements AgentProjectStore {
	envelopes = new Map<string, EnvelopeJson>();
	lease: { sessionId: string; leaseId: string; expiresAt: string } | null = null;
	async load(id: string) {
		const e = this.envelopes.get(id);
		return e ? { envelope: e, revision: e.revision } : null;
	}
	async save(id: string, envelope: EnvelopeJson, base: number): Promise<SaveOutcome> {
		const cur = this.envelopes.get(id);
		if (cur && cur.revision !== base) return { ok: false, conflict: true, revision: cur.revision };
		this.envelopes.set(id, envelope);
		return { ok: true, revision: envelope.revision };
	}
	leaseHolder() {
		return this.lease;
	}
}

/** A service with one connected editor window (`editor: false`: a connection that only holds the engine token). */
function makeService(opts: { approvalTimeoutMs?: number; relayTimeoutMs?: number; editor?: boolean } = {}) {
	const store = new MemoryStore();
	const doc = createEmptyProject({ ids: createCounterIdSource(9), name: 'Svc', preset: 'hd-1080p-30' });
	store.envelopes.set(doc.projectId, makeEnvelope(doc, { revision: 0, savedAt: 'x', platform: 'test' }));
	const service = new AgentService({
		engineVersion: 'test',
		store: () => store,
		registries: defaultRegistries(),
		heartbeatMs: 0,
		...(opts.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {}),
		...(opts.relayTimeoutMs !== undefined ? { relayTimeoutMs: opts.relayTimeoutMs } : {}),
	});
	services.push(service);
	const socket = new FakeSocket();
	service.handleSocket(socket, { editor: opts.editor ?? true });
	socket.client({ type: 'hello', projectId: doc.projectId, sessionId: 'ses_1', leaseId: 'lease_1' });
	return { service, store, socket, projectId: doc.projectId };
}

describe('AgentService timeouts', () => {
	it('returns E_APPROVAL_TIMEOUT when nobody answers the approval', async () => {
		vi.useFakeTimers();
		const { service, socket, projectId } = makeService({ approvalTimeoutMs: 40 });
		const pending = service.transact(projectId, tx([{ type: 'item.delete', itemIds: ['itm_X'] }]));
		await vi.advanceTimersByTimeAsync(40);
		const r = await pending;
		expect(r.result).toMatchObject({ ok: false, errors: [{ code: 'E_APPROVAL_TIMEOUT' }] });
		expect(
			socket.sent.some(
				(m) =>
					m.event === 'agent.approval.resolved' && (m.payload as { decision: string }).decision === 'timeout',
			),
		).toBe(true);
		expect(service.approvals.pending()).toEqual([]);
	});

	it('ignores approval answers from connections that never said hello', async () => {
		vi.useFakeTimers();
		const { service, socket, projectId } = makeService({ approvalTimeoutMs: 80 });
		const stranger = new FakeSocket();
		service.handleSocket(stranger, { editor: true });
		const p = service.transact(projectId, tx([{ type: 'item.delete', itemIds: ['itm_X'] }]));
		const ask = await socket.nextSent((m) => m.type === 'event' && m.event === 'agent.approval.requested');
		const { approvalId, answerKey } = ask.payload as { approvalId: string; answerKey: string };
		stranger.client({
			type: 'event',
			event: 'agent.approval.resolve',
			payload: { approvalId, decision: 'approved', answerKey },
		});
		await vi.advanceTimersByTimeAsync(80);
		expect((await p).result).toMatchObject({ ok: false, errors: [{ code: 'E_APPROVAL_TIMEOUT' }] });
	});

	it('returns E_NO_SESSION on a relay timeout while the lease is live, headless once it expired', async () => {
		vi.useFakeTimers();
		const { service, store, projectId } = makeService({ relayTimeoutMs: 30 });
		store.lease = {
			sessionId: 'ses_1',
			leaseId: 'lease_1',
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		};
		const liveRequest = service.transact(projectId, tx([{ type: 'marker.add', frame: 1, name: 'x' }]));
		await vi.advanceTimersByTimeAsync(30);
		const live = await liveRequest;
		expect(live).toMatchObject({
			appliedBy: 'session',
			result: { ok: false, errors: [{ code: 'E_NO_SESSION' }] },
		});
		store.lease = {
			sessionId: 'ses_1',
			leaseId: 'lease_1',
			expiresAt: new Date(Date.now() - 1).toISOString(),
		};
		const expiredRequest = service.transact(projectId, tx([{ type: 'marker.add', frame: 1, name: 'y' }]));
		await vi.advanceTimersByTimeAsync(30);
		const expired = await expiredRequest;
		expect(expired).toMatchObject({ appliedBy: 'headless', result: { ok: true, revision: 1 } });
	});

	it('rejects oversized transactions (limits)', async () => {
		const { service, projectId } = makeService();
		const big = await service.transact(
			projectId,
			tx(Array.from({ length: 5001 }, () => ({ type: 'marker.add', frame: 0 }))),
		);
		expect(big.result).toMatchObject({ ok: false, errors: [{ code: 'E_LIMIT' }] });
	});
});

describe('POST /api/agent/ui (mcp-cli live-UI automation)', () => {
	it('409 without an editor window; relays to the window and answers with which window replied', async () => {
		const { app, projectId } = await makeEngine();
		const post = (payload: unknown) =>
			app.inject({ method: 'POST', url: '/api/agent/ui', headers: H, payload: payload as never });
		const none = await post({ action: 'state' });
		expect(none.statusCode).toBe(409);
		expect(none.json()).toMatchObject({ code: 'NO_SESSION' });
		expect((await post({ action: 'nope' })).statusCode).toBe(400);

		const { ws, box } = await connectSession(app, projectId);
		const pending = post({ action: 'elements', args: { panel: 'timeline' } });
		const req = await box.until((m) => m.type === 'request');
		expect(req).toMatchObject({ kind: 'ui', payload: { action: 'elements', args: { panel: 'timeline' } } });
		ws.send(JSON.stringify({ type: 'response', id: req.id, result: { count: 0, elements: [] } }));
		const ok = await pending;
		expect(ok.statusCode).toBe(200);
		expect(ok.json()).toEqual({
			result: { count: 0, elements: [] },
			window: { projectId, sessionId: 'ses_test' },
		});
		const bad = post({ projectId, action: 'click', args: { id: 'nope' } });
		const breq = await box.until((m) => m.type === 'request');
		ws.send(
			JSON.stringify({
				type: 'response',
				id: breq.id,
				result: null,
				error: { code: 'E_NOT_FOUND', message: 'No element "nope"' },
			}),
		);
		const b = await bad;
		expect(b.statusCode).toBe(404);
		expect(b.json()).toMatchObject({ message: 'No element "nope"', detail: { code: 'E_NOT_FOUND' } });
		expect((await post({ projectId: 'prj_other', action: 'state' })).statusCode).toBe(409);
		ws.close();
	});
});
