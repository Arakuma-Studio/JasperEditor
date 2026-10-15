import { createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { EditorSession, gestureFrames, MemoryProjectStore } from '../src/index.ts';
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

afterEach(() => vi.useRealTimers());

describe('gesture frames (Program monitor throttle)', () => {
	it('a cancelled gesture returns to the committed document at once', async () => {
		const s = await openSession();
		s.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		const clipId = Object.keys(Object.values(s.getCommitted().sequences)[0]!.clips)[0]!;
		vi.useFakeTimers();
		const frames = gestureFrames(s.store);
		const committed = s.getCommitted();
		const g = s.beginGesture('Move');
		g.update([{ type: 'clip.move', clipIds: [clipId], deltaFrames: 4 }]);
		await vi.advanceTimersByTimeAsync(0);
		expect(Object.values(frames.getState().sequences)[0]!.clips[clipId]!.start).toBe(4);
		g.cancel();
		expect(frames.getState()).toBe(committed);
		await vi.advanceTimersByTimeAsync(100);
		expect(frames.getState()).toBe(committed);
		frames.dispose();
	});

	it('undo and edits outside gestures reach the views in the same notification', async () => {
		const s = await openSession();
		const frames = gestureFrames(s.store);
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
		function View() {
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
		act(() => store.setState({ n: 2 }));
		act(() => store.setState({ n: 3 }));
		expect(r.getByTestId('v').textContent).toBe('1');
		r.rerender(ui(false));
		expect(r.getByTestId('v').textContent).toBe('3');
		act(() => store.setState({ n: 4 }));
		expect(r.getByTestId('v').textContent).toBe('4');
	});
});
