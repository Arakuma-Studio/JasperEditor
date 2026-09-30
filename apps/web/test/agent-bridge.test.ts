// In-page agent bridge (WP-2H, ARCHITECTURE §11): transactions through the session, approvals, history
// ownership, fast-forward, relay protocol and event forwarding.
import {
	createEmptyProject,
	createSeededIdSource,
	defaultRegistries,
	type TransactionResult,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentBridge } from '../src/agent-bridge/bridge.ts';
import type { RelaySocket } from '../src/agent-bridge/relay-client.ts';

const bridges: AgentBridge[] = [];
afterEach(() => {
	for (const b of bridges.splice(0)) b.dispose();
});

function makeSession() {
	const ids = createSeededIdSource(11);
	const doc = createEmptyProject({ ids, name: 'Bridge', preset: 'hd-1080p-30' });
	return new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => '2026-09-30T00:00:00.000Z', registries: defaultRegistries() },
	});
}

function makeBridge(opts: ConstructorParameters<typeof AgentBridge>[2] = {}) {
	const session = makeSession();
	const bridge = new AgentBridge(session, null, opts).start();
	bridges.push(bridge);
	return { session, bridge, api: bridge.api() };
}

const agentTx = (commands: unknown[], extra: Record<string, unknown> = {}) => ({
	label: 'Add marker',
	origin: { agent: 'bot' },
	commands,
	...extra,
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('window.jasper transact (S01:AGT-003, UND-007)', () => {
	it('applies through the session as one "Agent: …" entry and records activity', async () => {
		const { session, bridge, api } = makeBridge();
		const r = await api.transact(
			agentTx([{ type: 'marker.add', frame: 12, name: 'Hi', markerType: 'agent-note' }]),
		);
		expect(r).toMatchObject({ ok: true, revision: 1 });
		const h = session.getState().history;
		expect(h.entries.map((e) => e.label)).toEqual(['Agent: Add marker']);
		const [entry] = bridge.store.getState().activity;
		expect(entry).toMatchObject({
			label: 'Add marker',
			agent: 'bot',
			ok: true,
			via: 'in-page',
			summary: 'marker.add',
		});
		expect(bridge.isTopOfHistory(entry!)).toBe(true);
		session.apply({
			label: 'User marker',
			origin: 'user',
			commands: [{ type: 'marker.add', frame: 1 }] as never,
		});
		expect(bridge.isTopOfHistory(entry!)).toBe(false);
	});

	it('forces an agent origin, resolves mediaByName errors and reports them', async () => {
		const { api, session } = makeBridge();
		const r = await api.transact({
			label: 'x',
			origin: 'user',
			commands: [{ type: 'clip.place', source: { mediaByName: 'nope.mov' }, at: 0 }],
		});
		expect(r).toMatchObject({ ok: false, errors: [{ code: 'E_NOT_FOUND', commandIndex: 0 }] });
		await api.transact({ label: 'y', origin: 'user', commands: [{ type: 'marker.add', frame: 3 }] });
		expect(session.getState().history.entries[0]!.origin).toEqual({ agent: 'in-page' });
	});

	it('answers queries with session state', async () => {
		const { api, session } = makeBridge();
		session.transport.seek(45);
		const ph = (await api.query('playhead.get')) as { frame: number; timecode: string };
		expect(ph).toMatchObject({ frame: 45, timecode: '00:00:01:15' });
		const summary = (await api.query('sequence.summary')) as { tracks: unknown[] };
		expect(summary.tracks).toHaveLength(6);
		expect(await api.query('selection.get')).toHaveProperty('selection.timeline.clips', []);
		await expect(api.query('nope')).rejects.toThrow(/Unknown query/);
		expect(api.schema()).toHaveProperty('queries.validate');
	});
});

describe('approvals (S01:AGT-011)', () => {
	it('destructive transactions wait for Approve / Deny in the Agent panel', async () => {
		const { bridge, api, session } = makeBridge();
		const p = api.transact(agentTx([{ type: 'track.remove', trackIds: ['V3'] }], { label: 'Remove V3' }));
		await tick();
		const [card] = bridge.store.getState().approvals;
		expect(card).toMatchObject({
			label: 'Remove V3',
			agent: 'bot',
			source: 'local',
			summary: 'track.remove',
		});
		bridge.resolveApproval(card!.approvalId, 'approved');
		expect(await p).toMatchObject({ ok: true });
		expect(Object.values(session.getCommitted().sequences)[0]!.videoTracks).toHaveLength(2);

		const d = api.transact(agentTx([{ type: 'track.remove', trackIds: ['V2'] }]));
		await tick();
		bridge.resolveApproval(bridge.store.getState().approvals[0]!.approvalId, 'denied');
		expect(await d).toMatchObject({ ok: false, errors: [{ code: 'E_APPROVAL_DENIED' }] });
		expect(bridge.store.getState().approvals).toEqual([]);
	});

	it('times out with E_APPROVAL_TIMEOUT and approveAll approves every card', async () => {
		const { bridge, api } = makeBridge({ approvalTimeoutMs: 20 });
		const r = await api.transact(agentTx([{ type: 'item.delete', itemIds: ['itm_X'], force: true }]));
		expect(r).toMatchObject({ ok: false, errors: [{ code: 'E_APPROVAL_TIMEOUT' }] });
		const a = api.transact(agentTx([{ type: 'track.remove', trackIds: ['V3'] }]));
		const b = api.transact(agentTx([{ type: 'track.remove', trackIds: ['A3'] }]));
		await tick();
		expect(bridge.approveAll()).toBe(2);
		expect((await a).ok && (await b).ok).toBe(true);
	});
});

describe('history ownership and concurrency (S01:UND-008, AGT-010)', () => {
	it('agents undo only their own top entry', async () => {
		const { api, session } = makeBridge();
		await api.transact(agentTx([{ type: 'marker.add', frame: 1 }]));
		const own = await api.transact({
			label: 'Undo',
			origin: { agent: 'bot' },
			commands: [{ type: 'history.undo' }],
		});
		expect(own).toMatchObject({ ok: true, results: [{ 'history.undo': 'Agent: Add marker' }] });
		await api.transact({ label: 'redo', origin: { agent: 'bot' }, commands: [{ type: 'history.redo' }] });
		const other = await api.transact({
			label: 'Undo',
			origin: { agent: 'intruder' },
			commands: [{ type: 'history.undo' }],
		});
		expect(other).toMatchObject({ ok: false, errors: [{ code: 'E_NOT_OWNER' }] });
		expect(session.getState().history.index).toBe(1);
	});

	it('rejects a stale revision touching a clip the user moved, fast-forwards otherwise (S01 AC-11)', async () => {
		const { api, session } = makeBridge();
		const add = (await api.transact(
			agentTx([
				{ type: 'clip.addText', ref: '$t', at: 0, duration: 30, track: 'V1', content: { text: 'A' } },
			]),
		)) as Extract<TransactionResult, { ok: true }>;
		const clipId = add.refs.$t!;
		const seen = session.revision;
		session.apply({
			label: 'Move',
			origin: 'user',
			commands: [{ type: 'clip.move', clipIds: [clipId], deltaFrames: 10 }] as never,
		});
		const stale = await api.transact(
			agentTx([{ type: 'clip.update', clipId, patch: { name: 'late' } }], { expectedRevision: seen }),
		);
		expect(stale).toMatchObject({ ok: false, errors: [{ code: 'E_REVISION_MISMATCH', blocking: [clipId] }] });
		const ff = await api.transact(agentTx([{ type: 'marker.add', frame: 99 }], { expectedRevision: seen }));
		expect(ff.ok).toBe(true);
	});
});

// ---------------------------------------------------------------- relay

class FakeSocket implements RelaySocket {
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
		const { bridge, session } = makeBridge({
			relay: true,
			relayUrl: 'ws://test/agent',
			socketFactory: () => {
				const s = new FakeSocket();
				sockets.push(s);
				return s;
			},
		});
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
			},
		});
		expect(bridge.store.getState().approvals).toMatchObject([{ approvalId: 'apr_1', source: 'engine' }]);
		expect(bridge.resolveApproval('apr_1', 'denied')).toBe(true);
		expect(ws.sent.at(-1)).toEqual({
			type: 'event',
			event: 'agent.approval.resolve',
			payload: { approvalId: 'apr_1', decision: 'denied' },
		});
		expect(bridge.store.getState().approvals).toEqual([]);

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
