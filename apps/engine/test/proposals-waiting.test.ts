// "<agent> is waiting for your review" (WP3.3b): the engine's inference from an agent polling a proposal.
import { describe, expect, it } from 'vitest';
import { ProposalWaitWatch, type Waiting } from '../src/proposals/waiting.ts';

function harness(opts: { maxEntries?: number } = {}) {
	let now = Date.parse('2026-10-16T10:00:00.000Z');
	const timers = new Map<number, { at: number; fn: () => void }>();
	let n = 0;
	const events: [string, string, Waiting | null][] = [];
	const w = new ProposalWaitWatch({
		publish: (pid, id, waiting) => events.push([pid, id, waiting]),
		now: () => now,
		setTimer: (fn, ms) => {
			timers.set(++n, { at: now + ms, fn });
			return n;
		},
		clearTimer: (h) => timers.delete(h as number),
		...opts,
	});
	const advance = (ms: number) => {
		now += ms;
		for (const [k, t] of [...timers]) {
			if (t.at <= now) {
				timers.delete(k);
				t.fn();
			}
		}
	};
	return { w, events, advance, timers };
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
		// proposals are followed separately
		w.poll('prj', 'prp_2', 'a');
		w.poll('prj2', 'prp_2', 'a');
		expect(w.waiting('prj', 'prp_2')).toBeNull();
	});

	it('follows a bounded number of proposals', () => {
		const { w, timers } = harness({ maxEntries: 3 });
		for (let i = 0; i < 10; i++) w.poll('prj', `prp_${i}`, 'a');
		expect(timers.size).toBe(3);
		w.poll('prj', 'prp_9', 'a');
		expect(w.waiting('prj', 'prp_9')?.agent).toBe('a');
		w.dispose();
		expect(timers.size).toBe(0);
	});
});
