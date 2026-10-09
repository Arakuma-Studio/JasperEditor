// Workstream ui-perf: gesture frames for costly views, frozen background subtrees, idle invariant verification and the
// incremental serialisation of autosave / the recovery journal (docs/wp-notes/ui-perf.md).
import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	invariantStats,
	isVerifiedDocument,
	type ProjectDocument,
	setInvariantMode,
} from '@jasper/project';
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createGestureFrames, EditorSession, EngineProjectStore, MemoryProjectStore } from '../src/index.ts';
import { FreezeStoreUpdates, useStoreSelector } from '../src/react/index.ts';

const NOW = '2026-10-09T10:00:00.000Z';

async function openSession() {
	const ids = createCounterIdSource(1);
	const store = new MemoryProjectStore({ ids, now: () => NOW });
	const doc = createEmptyProject({ ids, name: 'P', preset: 'hd-1080p-30' });
	store.put(doc);
	const ctx = { ids, now: () => NOW, registries: defaultRegistries() };
	return EditorSession.open({ store, projectId: doc.projectId, ctx, sessionId: 's1' });
}

const solid = (at: number) => ({
	type: 'clip.addSolid' as const,
	at,
	duration: 30,
	track: 'V1',
	color: [1, 0, 0, 1] as [number, number, number, number],
});

/** Manual timers: time advances only when the test says so; renders cost what `cost` says. */
function manualTimers() {
	let now = 0;
	let cost = 0;
	const due: { at: number; fn: () => void; id: number }[] = [];
	let next = 1;
	return {
		timers: {
			now: () => now,
			setTimeout: (fn: () => void, ms: number) => {
				const id = next++;
				due.push({ at: now + ms, fn, id });
				return id;
			},
			clearTimeout: (h: unknown) => {
				const i = due.findIndex((d) => d.id === h);
				if (i >= 0) due.splice(i, 1);
			},
			afterRender: (fn: () => void) => {
				now += cost;
				fn();
			},
		},
		setCost: (ms: number) => {
			cost = ms;
		},
		advance(ms: number) {
			const end = now + ms;
			for (;;) {
				due.sort((a, b) => a.at - b.at);
				const d = due[0];
				if (!d || d.at > end) break;
				due.shift();
				now = Math.max(now, d.at);
				d.fn();
			}
			now = end;
		},
		pending: () => due.length,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('gesture frames (Program monitor throttle)', () => {
	it('publishes cheap gesture frames every time, throttles costly ones, and the commit at once', async () => {
		const s = await openSession();
		s.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		const clipId = Object.keys(Object.values(s.getCommitted().sequences)[0]!.clips)[0]!;
		const t = manualTimers();
		const frames = createGestureFrames(s.store, t.timers);
		const seen: ProjectDocument[] = [];
		frames.subscribe(() => seen.push(frames.getState()));
		expect(frames.getState()).toBe(s.getCommitted());

		const g = s.beginGesture('Move');
		// Cheap views (1 ms): every frame is published, each from its own task.
		t.setCost(1);
		for (let i = 1; i <= 5; i++) {
			g.update([{ type: 'clip.move', clipIds: [clipId], deltaFrames: i }]);
			expect(frames.getState()).not.toBe(s.getDrawn()); // not within the store notification
			t.advance(16);
			expect(frames.getState()).toBe(s.getDrawn());
		}
		expect(frames.stats().published).toBe(5);

		// Costly views (20 ms): at most one publish per 5 × 20 ms; the latest transient always wins.
		t.setCost(20);
		g.update([{ type: 'clip.move', clipIds: [clipId], deltaFrames: 6 }]);
		t.advance(16);
		const before = frames.stats().published;
		for (let i = 7; i <= 20; i++) {
			g.update([{ type: 'clip.move', clipIds: [clipId], deltaFrames: i }]);
			t.advance(16);
		}
		const published = frames.stats().published - before;
		expect(published).toBeGreaterThanOrEqual(1);
		expect(published).toBeLessThan(6);
		expect(frames.stats().skipped).toBeGreaterThan(0);
		t.advance(500);
		expect(frames.getState()).toBe(s.getDrawn());

		// Commit: published in the same notification as the session store, no timer left.
		g.update([{ type: 'clip.move', clipIds: [clipId], deltaFrames: 30 }]);
		g.commit();
		expect(frames.getState()).toBe(s.getCommitted());
		expect(t.pending()).toBe(0);
		expect(seen[seen.length - 1]).toBe(s.getCommitted());
		frames.dispose();
	});

	it('a cancelled gesture returns to the committed document at once', async () => {
		const s = await openSession();
		s.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		const clipId = Object.keys(Object.values(s.getCommitted().sequences)[0]!.clips)[0]!;
		const t = manualTimers();
		const frames = createGestureFrames(s.store, t.timers);
		const committed = s.getCommitted();
		const g = s.beginGesture('Move');
		g.update([{ type: 'clip.move', clipIds: [clipId], deltaFrames: 4 }]);
		g.cancel();
		expect(frames.getState()).toBe(committed);
		t.advance(100);
		expect(frames.getState()).toBe(committed);
		frames.dispose();
	});

	it('undo and edits outside gestures reach the views in the same notification', async () => {
		const s = await openSession();
		const t = manualTimers();
		const frames = createGestureFrames(s.store, t.timers);
		s.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		expect(frames.getState()).toBe(s.getCommitted());
		s.undo();
		expect(frames.getState()).toBe(s.getCommitted());
		frames.dispose();
	});
});

describe('FreezeStoreUpdates (panels in background tabs)', () => {
	it('keeps the last rendered value while frozen and catches up when unfrozen', () => {
		const store = createStore(() => ({ n: 1 }));
		let renders = 0;
		function View() {
			renders++;
			const n = useStoreSelector(store, (s) => s.n);
			return <span data-testid="v">{n}</span>;
		}
		const ui = (frozen: boolean) => (
			<FreezeStoreUpdates frozen={frozen}>
				<View />
			</FreezeStoreUpdates>
		);
		const r = render(ui(false));
		expect(r.getByTestId('v').textContent).toBe('1');
		r.rerender(ui(true));
		const rendersFrozen = renders;
		act(() => store.setState({ n: 2 }));
		act(() => store.setState({ n: 3 }));
		expect(renders).toBe(rendersFrozen);
		expect(r.getByTestId('v').textContent).toBe('1');
		r.rerender(ui(false));
		expect(r.getByTestId('v').textContent).toBe('3');
		act(() => store.setState({ n: 4 }));
		expect(r.getByTestId('v').textContent).toBe('4');
	});

	it('does not change a hook outside a frozen tree', () => {
		const store = createStore(() => ({ n: 1 }));
		const { result } = renderHook(() => useStoreSelector(store, (s) => s.n));
		act(() => store.setState({ n: 5 }));
		expect(result.current).toBe(5);
	});
});

describe('idle invariant verification', () => {
	it('verifies an opened document when idle, so the first edit is incremental', async () => {
		const idle: (() => void)[] = [];
		vi.stubGlobal('requestIdleCallback', (cb: () => void) => idle.push(cb));
		setInvariantMode('incremental');
		try {
			const s = await openSession();
			const opened = s.getCommitted();
			expect(isVerifiedDocument(opened, { effects: defaultRegistries().effects })).toBe(false);
			expect(idle.length).toBe(1);
			idle.shift()!();
			const ctxEffects = (s.ctx as { registries: { effects: unknown } }).registries.effects;
			expect(isVerifiedDocument(opened, { effects: ctxEffects as never })).toBe(true);
			invariantStats(true);
			expect(s.apply({ label: 'Add', origin: 'user', commands: [solid(0)] }).ok).toBe(true);
			const st = invariantStats();
			expect(st.incremental).toBe(1);
			expect(st.full).toBe(0);
		} finally {
			setInvariantMode('verify');
		}
	});

	it('does nothing without requestIdleCallback (Node, tests)', async () => {
		vi.stubGlobal('requestIdleCallback', undefined);
		const s = await openSession();
		expect(isVerifiedDocument(s.getCommitted())).toBe(false);
	});
});

describe('autosave and the journal send the same JSON, serialised incrementally', () => {
	it('PUTs exactly JSON.stringify(envelope) after edits', async () => {
		const bodies: string[] = [];
		const fetchImpl = (async (_url: string, init: RequestInit) => {
			bodies.push(String(init.body));
			return new Response(JSON.stringify({ revision: 2 }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}) as unknown as typeof fetch;
		const { EngineClient } = await import('@jasper/engine-client');
		const store = new EngineProjectStore(new EngineClient({ baseUrl: 'http://x', fetch: fetchImpl }));
		const s = await openSession();
		for (let i = 0; i < 4; i++) {
			s.apply({ label: 'Add', origin: 'user', commands: [solid(i * 40)] });
			const doc = s.getCommitted();
			await store.save(s.projectId, doc, { revision: i + 1, baseRevision: i });
			const sent = JSON.parse(bodies[bodies.length - 1]!) as { document: unknown; revision: number };
			expect(sent.revision).toBe(i + 1);
			expect(JSON.stringify(sent.document)).toBe(JSON.stringify(doc));
			// Byte-identical to the plain serialisation of the same envelope.
			const env = { ...sent, document: doc };
			expect(bodies[bodies.length - 1]).toBe(JSON.stringify(env));
		}
	});
});
