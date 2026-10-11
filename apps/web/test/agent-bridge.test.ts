import type { EngineClient } from '@jasper/engine-client';
import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type TransactionResult,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBridge } from '../src/agent-bridge/bridge.ts';

const bridges: AgentBridge[] = [];
afterEach(() => {
	for (const b of bridges.splice(0)) b.dispose();
	vi.unstubAllGlobals();
});

function makeSession() {
	const ids = createCounterIdSource(11);
	const doc = createEmptyProject({ ids, name: 'Bridge', preset: 'hd-1080p-30' });
	return new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => '2026-09-30T00:00:00.000Z', registries: defaultRegistries() },
	});
}

function makeBridge() {
	const session = makeSession();
	const bridge = new AgentBridge(session, null).start();
	bridges.push(bridge);
	return { session, bridge, api: bridge.api() };
}

const agentTx = (commands: unknown[]) => ({
	label: 'Add marker',
	origin: { agent: 'bot' },
	commands,
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('window.jasper transact (S01:AGT-003, UND-007)', () => {
	it('forces an agent origin even when the caller claims to be the user', async () => {
		const { api, session } = makeBridge();
		const result = await api.transact({
			label: 'Marker',
			origin: 'user',
			commands: [{ type: 'marker.add', frame: 3 }],
		});
		expect(result.ok).toBe(true);
		expect(session.getState().history.entries[0]!.origin).toEqual({ agent: 'in-page' });
	});
});

describe('history ownership (S01:UND-008)', () => {
	it('refuses to undo another agent’s top entry', async () => {
		const { api, session } = makeBridge();
		await api.transact(agentTx([{ type: 'marker.add', frame: 1 }]));
		const result = await api.transact({
			label: 'Undo',
			origin: { agent: 'intruder' },
			commands: [{ type: 'history.undo' }],
		});
		expect(result).toMatchObject({ ok: false, errors: [{ code: 'E_NOT_OWNER' }] });
		expect(session.getState().history.index).toBe(1);
	});
});

class FakeSocket {
	readyState = 0;
	onopen: ((ev: unknown) => void) | null = null;
	onclose: ((ev: unknown) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	sent: Record<string, unknown>[] = [];
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.readyState = 3;
		this.onclose?.({});
	}
	open() {
		this.readyState = 1;
		this.onopen?.({});
	}
	server(msg: unknown) {
		this.onmessage?.({ data: JSON.stringify(msg) });
	}
}

describe('WS /agent relay client (ARCHITECTURE §11)', () => {
	it('says hello, answers requests, forwards events and resolves engine approvals', async () => {
		const sockets: FakeSocket[] = [];
		vi.stubGlobal(
			'WebSocket',
			class extends FakeSocket {
				constructor() {
					super();
					sockets.push(this);
				}
			},
		);
		const session = makeSession();
		const engine = { agentWsUrl: () => 'ws://test/agent' } as EngineClient;
		const bridge = new AgentBridge(session, engine, { relay: true }).start();
		bridges.push(bridge);
		const ws = sockets[0]!;
		ws.open();
		expect(ws.sent[0]).toEqual({
			type: 'hello',
			projectId: session.projectId,
			sessionId: session.sessionId,
			leaseId: null,
		});
		expect(bridge.store.getState().relay).toBe('connected');

		ws.server({
			type: 'request',
			id: 'r1',
			kind: 'tx',
			payload: { transaction: agentTx([{ type: 'marker.add', frame: 7 }]), approved: false },
		});
		await tick();
		await tick();
		const resp = ws.sent.find((m) => m.type === 'response' && m.id === 'r1') as { result: TransactionResult };
		expect(resp.result).toMatchObject({ ok: true, revision: 1 });
		expect(ws.sent.some((m) => m.type === 'event' && m.event === 'doc.changed')).toBe(true);
		expect(bridge.store.getState().activity[0]).toMatchObject({ via: 'relay' });

		ws.server({ type: 'request', id: 'r2', kind: 'query', payload: { query: 'doc.revision' } });
		await tick();
		expect(ws.sent.find((m) => m.id === 'r2')).toMatchObject({
			result: { result: { revision: 1 }, revision: 1 },
		});
		ws.server({
			type: 'request',
			id: 'r3',
			kind: 'query',
			payload: { query: 'doc.get', args: { path: ['zzz'] } },
		});
		await tick();
		expect(ws.sent.find((m) => m.id === 'r3')).toMatchObject({ error: { code: 'E_NOT_FOUND' } });

		ws.server({
			type: 'event',
			event: 'agent.approval.requested',
			payload: {
				approvalId: 'apr_1',
				projectId: session.projectId,
				label: 'Delete',
				agent: 'cli',
				reasons: ['item.delete'],
				commandCount: 1,
				expiresAt: 'x',
				answerKey: 'key_for_this_window',
			},
		});
		expect(bridge.store.getState().approvals).toMatchObject([{ approvalId: 'apr_1', source: 'engine' }]);
		// The answer key must stay private to the bridge, outside the rendered store
		// and inaccessible through `window.jasper`.
		expect(JSON.stringify(bridge.store.getState())).not.toContain('key_for_this_window');
		expect(JSON.stringify(bridge.api())).not.toContain('key_for_this_window');
		expect(bridge.resolveApproval('apr_1', 'denied')).toBe(true);
		expect(ws.sent.at(-1)).toEqual({
			type: 'event',
			event: 'agent.approval.resolve',
			payload: { approvalId: 'apr_1', decision: 'denied', answerKey: 'key_for_this_window' },
		});
		expect(bridge.store.getState().approvals).toEqual([]);
		expect(bridge.resolveApproval('apr_1', 'approved')).toBe(false);

		// A request this window was given no key for cannot be answered from here: it is not shown.
		ws.server({
			type: 'event',
			event: 'agent.approval.requested',
			payload: {
				approvalId: 'apr_2',
				projectId: session.projectId,
				label: 'Delete',
				agent: 'cli',
				reasons: ['item.delete'],
				commandCount: 1,
				expiresAt: 'x',
			},
		});
		expect(bridge.store.getState().approvals).toEqual([]);
		expect(bridge.resolveApproval('apr_2', 'approved')).toBe(false);

		ws.close();
		expect(bridge.store.getState().relay).toBe('disconnected');
	});

	it('throttles playhead.changed to ≤ 10 Hz with a trailing update', async () => {
		const { bridge, session } = makeBridge();
		const frames: number[] = [];
		bridge.on('playhead.changed', (p) => frames.push((p as { frame: number }).frame));
		for (let f = 1; f <= 30; f++) session.transport.seek(f);
		expect(frames).toEqual([1]);
		await new Promise((r) => setTimeout(r, 130));
		expect(frames).toEqual([1, 30]);
	});
});
