import { createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutosaver, EditorSession, MemoryProjectStore } from '../../src/index.ts';

async function setup() {
	const ids = createCounterIdSource(1);
	const store = new MemoryProjectStore({ ids, now: () => '2026-09-30T10:00:00.000Z' });
	const doc = createEmptyProject({ ids, name: 'A', preset: 'hd-1080p-30' });
	store.put(doc);
	vi.spyOn(store, 'save');
	const session = await EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx: { ids, now: () => '2026-09-30T10:00:00.000Z', registries: defaultRegistries() },
		sessionId: 's1',
	});
	return { store, session };
}
const solid = (at: number) => ({
	type: 'clip.addSolid' as const,
	at,
	duration: 10,
	track: 'V1',
	color: [0, 1, 0, 1] as [number, number, number, number],
});

describe('autosave policy', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('off: the timer never saves; flush (Save) still does', async () => {
		const { store, session } = await setup();
		const a = createAutosaver(session, store, { policy: () => ({ enabled: false }) });
		expect(a.automatic).toBe(false);
		session.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(store.save).toHaveBeenCalledTimes(0);
		await a.flush();
		expect(store.save).toHaveBeenCalledTimes(1);
		a.dispose();
	});

	it('the longest wait follows the policy', async () => {
		const { store, session } = await setup();
		const a = createAutosaver(session, store, { policy: () => ({ enabled: true, maxIntervalMs: 3000 }) });
		for (let i = 0; i < 4; i++) {
			session.apply({ label: 'Add', origin: 'user', commands: [solid(i * 20)] });
			await vi.advanceTimersByTimeAsync(1000);
		}
		expect(store.save).toHaveBeenCalledTimes(1);
		a.dispose();
	});
});
