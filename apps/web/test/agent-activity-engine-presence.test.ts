// Spec 18 AF-ACT-002: the editor polls GET /api/agent/presence while something shows agent presence; failures fall
// back to the editor's own inference (an empty engine list) without errors.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnginePresencePoller, PRESENCE_POLL_MS } from '../src/agent-activity/engine-presence.ts';

afterEach(() => vi.useRealTimers());

const flush = () => vi.advanceTimersByTimeAsync(0);
const reply = (names: string[]) => ({
	agents: names.map((name) => ({ name, lastSeenAt: '2026-11-01T00:00:00.000Z' })),
	windowSec: 900,
});

describe('EnginePresencePoller', () => {
	it('polls only while subscribed, at PRESENCE_POLL_MS', async () => {
		vi.useFakeTimers();
		const fetch = vi.fn(async () => reply(['claude-code']));
		const poller = new EnginePresencePoller(fetch);
		expect(fetch).not.toHaveBeenCalled();
		const seen: number[] = [];
		const off = poller.subscribe(() => seen.push(poller.getSnapshot().length));
		await flush();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(poller.getSnapshot().map((a) => a.name)).toEqual(['claude-code']);
		expect(seen).toEqual([1]);
		await vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS);
		expect(fetch).toHaveBeenCalledTimes(2);
		// unchanged lists do not notify
		expect(seen).toEqual([1]);
		const off2 = poller.subscribe(() => {});
		off();
		await vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS);
		expect(fetch).toHaveBeenCalledTimes(3);
		off2();
		await vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS * 3);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it('a failed or malformed answer empties the list quietly and polling goes on', async () => {
		vi.useFakeTimers();
		const error = vi.spyOn(console, 'error');
		let n = 0;
		const fetch = vi.fn(async () => {
			n++;
			if (n === 2) throw new Error('offline');
			if (n === 3) return { agents: 'nope' };
			return reply(['codex']);
		});
		const poller = new EnginePresencePoller(fetch);
		const off = poller.subscribe(() => {});
		await flush();
		expect(poller.getSnapshot()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS);
		expect(poller.getSnapshot()).toEqual([]);
		await vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS);
		expect(poller.getSnapshot()).toEqual([]);
		await vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS);
		expect(poller.getSnapshot().map((a) => a.name)).toEqual(['codex']);
		expect(error).not.toHaveBeenCalled();
		off();
	});

	it('an answer that arrives after the last subscriber left is dropped', async () => {
		vi.useFakeTimers();
		let resolve: (v: unknown) => void = () => {};
		const poller = new EnginePresencePoller(() => new Promise((r) => (resolve = r)));
		const off = poller.subscribe(() => {});
		off();
		resolve(reply(['late']));
		await flush();
		expect(poller.getSnapshot()).toEqual([]);
	});
});
