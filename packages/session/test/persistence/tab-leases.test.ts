import { createCounterIdSource, defaultRegistries } from '@jasper/project';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createTabLeaseRegistry,
	EditorSession,
	EngineProjectStore,
	readOnlyReason,
	type TabLeaseRegistry,
} from '../../src/index.ts';
import { FakeEngine } from './fake-engine.ts';

const ctx = () => ({
	ids: createCounterIdSource(1),
	now: () => '2026-09-30T10:00:00.000Z',
	registries: defaultRegistries(),
});

/** sessionStorage of one tab (copyable, as Chrome's "Duplicate tab" does). */
class MemStorage {
	map = new Map<string, string>();
	getItem(k: string) {
		return this.map.get(k) ?? null;
	}
	setItem(k: string, v: string) {
		this.map.set(k, v);
	}
	clone() {
		const c = new MemStorage();
		c.map = new Map(this.map);
		return c;
	}
}

/** A BroadcastChannel hub: a message reaches every other channel of the hub (never the sender). */
class Hub {
	channels = new Set<FakeChannel>();
	open() {
		const c = new FakeChannel(this);
		this.channels.add(c);
		return c;
	}
}
class FakeChannel {
	listeners = new Set<(e: { data: unknown }) => void>();
	constructor(private hub: Hub) {}
	postMessage(data: unknown) {
		for (const c of this.hub.channels)
			if (c !== this)
				queueMicrotask(() => {
					for (const l of c.listeners) l({ data: structuredClone(data) });
				});
	}
	addEventListener(_t: 'message', l: (e: { data: unknown }) => void) {
		this.listeners.add(l);
	}
	removeEventListener(_t: 'message', l: (e: { data: unknown }) => void) {
		this.listeners.delete(l);
	}
	close() {
		this.hub.channels.delete(this);
	}
}

function setup() {
	const engine = new FakeEngine();
	const projectId = engine.seed('Film');
	const hub = new Hub();
	/** One page: a store with its own registry over the tab's storage and a fresh channel. */
	const page = (storage: MemStorage) => {
		const channel = hub.open();
		const tabLeases = createTabLeaseRegistry({ storage, channel, probeMs: 30 });
		const store = new EngineProjectStore(engine.client(), { tabLeases });
		return { store, tabLeases, channel };
	};
	const open = (store: EngineProjectStore, sessionId: string) =>
		EditorSession.open({ store, projectId, ctx: ctx(), sessionId });
	return { engine, projectId, hub, page, open };
}

/** The page goes away and its keepalive DELETE never reaches the engine (the race this fixes). */
async function unloadDroppingRelease(engine: FakeEngine) {
	engine.failures.push({ match: /^DELETE .*\/lease\//, status: 0, network: true });
	window.dispatchEvent(new Event('pagehide'));
	await new Promise((r) => setTimeout(r, 0));
}

describe('tab lease memory (S01:PER-040, polish)', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('a reload reclaims the previous page lease at once when its pagehide release was lost', async () => {
		const { engine, projectId, page, open } = setup();
		vi.stubGlobal('fetch', engine.fetch);
		const tab = new MemStorage();
		const p1 = page(tab);
		const a = await open(p1.store, 'a');
		expect(a.getState().lease.status).toBe('held');
		await unloadDroppingRelease(engine);
		expect(engine.leases.get(projectId)?.sessionId).toBe('a'); // still held by the dead page
		p1.channel.close();

		const p2 = page(tab); // same tab, new page
		const t0 = Date.now();
		const b = await open(p2.store, 'b');
		expect(Date.now() - t0).toBeLessThan(2000);
		expect(b.getState().readOnly).toBe(false);
		expect(b.getState().lease.status).toBe('held');
		expect(engine.leases.get(projectId)?.sessionId).toBe('b');
		expect(
			engine.requests.some(
				(r) => r.path.endsWith('/lease') && (r.body as { takeOver?: boolean } | undefined)?.takeOver === true,
			),
		).toBe(true);
		await b.close();
		await a.close();
	});

	it('another tab stays read-only while the lease is held', async () => {
		const { engine, projectId, page, open } = setup();
		const p1 = page(new MemStorage());
		const a = await open(p1.store, 'a1');
		const p2 = page(new MemStorage());
		const b = await open(p2.store, 'b1');
		expect(b.getState().readOnly).toBe(true);
		expect(readOnlyReason(b.getState())).toBe('lease');
		expect(engine.leases.get(projectId)?.sessionId).toBe('a1');
		await b.close();
		await a.close();
	});

	it('a duplicated tab whose original is still open stays read-only and drops the inherited id', async () => {
		const { engine, projectId, page, open } = setup();
		const tab = new MemStorage();
		const p1 = page(tab);
		const a = await open(p1.store, 'a2');
		const dup = tab.clone(); // Duplicate tab copies sessionStorage
		expect(dup.getItem('jasper:tab-leases')).toContain('a2');
		const p2 = page(dup);
		const b = await open(p2.store, 'b2');
		expect(b.getState().readOnly).toBe(true);
		expect(engine.leases.get(projectId)?.sessionId).toBe('a2');
		expect(dup.getItem('jasper:tab-leases')).not.toContain('a2');
		expect(tab.getItem('jasper:tab-leases')).toContain('a2');
		await b.close();
		await a.close();
	});

	it('a lease held by an agent (or any session this tab never had) is never reclaimed', async () => {
		const { engine, projectId, page, open } = setup();
		const r = await engine.fetch(`/api/projects/${projectId}/lease`, {
			method: 'POST',
			body: JSON.stringify({ sessionId: 'agent-1' }),
		});
		expect(r.status).toBe(200);
		const p = page(new MemStorage());
		const b = await open(p.store, 'b3');
		expect(b.getState().readOnly).toBe(true);
		expect(engine.leases.get(projectId)?.sessionId).toBe('agent-1');
		await b.close();
	});

	it('a clean close forgets the lease, so the tab has nothing to reclaim later', async () => {
		const { engine, projectId, page, open } = setup();
		const tab = new MemStorage();
		const p1 = page(tab);
		const a = await open(p1.store, 'a4');
		expect(tab.getItem('jasper:tab-leases')).toContain('a4');
		await a.close();
		expect(engine.leases.has(projectId)).toBe(false);
		expect(tab.getItem('jasper:tab-leases')).not.toContain('a4');
	});

	it('the registry tolerates corrupt storage and a missing channel', async () => {
		const storage = new MemStorage();
		storage.setItem('jasper:tab-leases', '{not json');
		const r: TabLeaseRegistry = createTabLeaseRegistry({ storage, channel: null });
		expect(await r.isLeftover('p', 's')).toBe(false);
		r.remember('p', 's');
		expect(await r.isLeftover('p', 's')).toBe(false); // live in this page
		r.unload();
		expect(await r.isLeftover('p', 's')).toBe(true); // remembered, no live claim, no channel to ask
		storage.setItem('jasper:tab-leases', JSON.stringify(['array']));
		expect(await r.isLeftover('p', 's')).toBe(false);
	});
});
