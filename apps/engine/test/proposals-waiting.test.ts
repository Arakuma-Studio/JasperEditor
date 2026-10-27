// "<agent> is waiting for your review" (WP3.3b): the engine's inference from an agent polling a proposal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProposalWaitWatch, type Waiting } from '../src/proposals/waiting.ts';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-10-16T10:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

function harness() {
	const events: [string, string, Waiting | null][] = [];
	const w = new ProposalWaitWatch({
		publish: (pid, id, waiting) => events.push([pid, id, waiting]),
	});
	return { w, events, advance: (ms: number) => vi.advanceTimersByTime(ms) };
}

describe('ProposalWaitWatch', () => {
	it('a poll every second is a wait from the first read; it ends 3.5 s after the last read', () => {
		const { w, events, advance } = harness();
		w.poll('prj', 'prp_1', 'claude');
		expect(w.waiting('prj', 'prp_1')).toBeNull();
		expect(events).toEqual([]);
		advance(1000);
		w.poll('prj', 'prp_1', 'claude');
		const since = '2026-10-16T10:00:00.000Z';
		expect(w.waiting('prj', 'prp_1')).toEqual({ agent: 'claude', since });
		expect(events).toEqual([['prj', 'prp_1', { agent: 'claude', since }]]);
		for (let i = 0; i < 5; i++) {
			advance(1000);
			w.poll('prj', 'prp_1', 'claude');
		}
		expect(events).toHaveLength(1); // announced once
		advance(3400);
		expect(w.waiting('prj', 'prp_1')).not.toBeNull();
		advance(200);
		expect(w.waiting('prj', 'prp_1')).toBeNull();
		expect(events.at(-1)).toEqual(['prj', 'prp_1', null]);
	});

	it('reads far apart are not a poll; another agent starts over; forget is silent', () => {
		const { w, events, advance } = harness();
		w.poll('prj', 'prp_1', 'a');
		advance(3000);
		w.poll('prj', 'prp_1', 'a');
		expect(w.waiting('prj', 'prp_1')).toBeNull();
		advance(1000);
		w.poll('prj', 'prp_1', 'a');
		expect(w.waiting('prj', 'prp_1')?.agent).toBe('a');
		advance(500);
		w.poll('prj', 'prp_1', 'b'); // a different agent: a's wait ends, b's first read
		expect(w.waiting('prj', 'prp_1')).toBeNull();
		expect(events.map((e) => e[2]?.agent ?? null)).toEqual(['a', null]);
		advance(500);
		w.poll('prj', 'prp_1', 'b');
		expect(w.waiting('prj', 'prp_1')?.agent).toBe('b');
		w.forget('prj', 'prp_1');
		advance(10_000);
		expect(events.map((e) => e[2]?.agent ?? null)).toEqual(['a', null, 'b']);
	});

	it('forgets the oldest wait beyond the 1,000-proposal bound and disposes without ghost announcements', () => {
		const { w, events, advance } = harness();
		w.poll('prj', 'prp_0', 'a');
		w.poll('prj', 'prp_0', 'a');
		for (let i = 1; i <= 1000; i++) w.poll('prj', `prp_${i}`, 'a');
		expect(w.waiting('prj', 'prp_0')).toBeNull();
		w.poll('prj', 'prp_1000', 'a');
		expect(w.waiting('prj', 'prp_1000')?.agent).toBe('a');
		w.dispose();
		expect(w.waiting('prj', 'prp_1000')).toBeNull();
		const before = [...events];
		advance(10_000);
		expect(events).toEqual(before);
	});
});
