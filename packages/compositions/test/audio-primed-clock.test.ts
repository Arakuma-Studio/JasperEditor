// The primed start's picture wait (sound-design Phase 0 close-out, fixed in Phase 2 verification B): Remotion 4.0.499's
// `waitUntilActuallyResumed`, replayed against `PrimedStartClock`, must start the picture once the program's first
// sample is at the output — never earlier — whenever the other calls of `getOutputTimestamp` come.
//
// Chrome starts the audio clock before the main thread sees the `running` state (measured in the e2e: `currentTime`
// 21–85 ms past the resume time while `state` still read `suspended`). The old shim took its offset from the last
// call made while the state read `suspended`, so such a call cut the wait short or removed it (the picture led the
// program by up to the read-ahead: −48 ms measured with a 41.6 ms wait).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type OutputTimestamp, PrimedStartClock } from '../src/audio/primed-clock.ts';

type World = {
	/** Context time the suspended context resumes at (its frozen time). */
	startAt: number;
	/** Wall seconds after Remotion's start reading when the audio clock starts. */
	clockStart: number;
	/** Output latency (s): the output's context time trails `currentTime` by it. */
	latency: number;
	/** Wall seconds after the clock starts until the output timestamp is valid (Chrome answers stale / `{t, 0}`). */
	validAfter: number;
	/** Remotion's poll interval (an animation frame), s. */
	poll: number;
	/** Wall times (s) of other callers (the serial wrapper's stamps, a test's sampling). */
	stray: number[];
};

const PERF0 = 50_000;

function contextAt(w: World, wall: number): { currentTime: number; native: OutputTimestamp } {
	const ran = Math.max(0, wall - w.clockStart);
	const currentTime = w.startAt + ran;
	if (wall < w.clockStart)
		return { currentTime, native: { contextTime: w.startAt - 0.05, performanceTime: 1234 } };
	if (ran < w.validAfter) return { currentTime, native: { contextTime: currentTime, performanceTime: 0 } };
	return {
		currentTime,
		native: { contextTime: currentTime - w.latency, performanceTime: PERF0 + wall * 1000 },
	};
}

/**
 * Remotion 4.0.499 `waitUntilActuallyResumed` (remotion/dist/esm/index.mjs) against the clock: the output context
 * time at which it resolves (the picture starts), or null if it never does within 2 s.
 */
function pictureStart(clock: PrimedStartClock, w: World): number | null {
	const call = (wall: number) => {
		const c = contextAt(w, wall);
		return { c, o: clock.report(c.native, c.currentTime) };
	};
	const events: { wall: number; remotion: boolean }[] = [];
	for (let t = w.poll; t < 2; t += w.poll) events.push({ wall: t, remotion: true });
	for (const t of w.stray) events.push({ wall: t, remotion: false });
	events.sort((a, b) => a.wall - b.wall || Number(a.remotion) - Number(b.remotion));
	const first = call(0);
	const startCurrentTime = first.c.currentTime;
	const startPerf = first.o.performanceTime;
	for (const e of events) {
		const { c, o } = call(e.wall);
		if (!e.remotion) continue;
		if (
			startPerf !== undefined &&
			o.performanceTime !== undefined &&
			o.performanceTime > startPerf &&
			o.contextTime !== undefined &&
			o.contextTime > startCurrentTime
		)
			return c.native.performanceTime ? (c.native.contextTime ?? null) : null;
	}
	return null;
}

const world = (o: Partial<World> = {}): World => ({
	startAt: 3.4133,
	clockStart: 0.004,
	latency: 0.064,
	validAfter: 0.02,
	poll: 0.016,
	stray: [],
	...o,
});

describe('PrimedStartClock (the picture waits for the primed program)', () => {
	const WAIT = 0.0416;

	it('the e2e trace: a call 85 ms into the resume, while Chrome still said suspended, does not cut the wait', () => {
		const clock = new PrimedStartClock();
		const w = world({ clockStart: 0.002, stray: [0.087], validAfter: 0.06 });
		clock.arm(w.startAt, WAIT);
		const at = pictureStart(clock, w);
		expect(at).not.toBeNull();
		expect(at!).toBeGreaterThanOrEqual(w.startAt + WAIT);
		expect(at! - (w.startAt + WAIT)).toBeLessThan(w.poll + 1e-9);
	});

	it('Remotion reading after the clock started (21 ms) still waits until the program is at the output', () => {
		const clock = new PrimedStartClock();
		const w = world({ clockStart: -0.021 });
		clock.arm(w.startAt, WAIT);
		const at = pictureStart(clock, w);
		expect(at!).toBeGreaterThanOrEqual(w.startAt + WAIT);
		expect(at! - (w.startAt + WAIT)).toBeLessThan(w.poll + 1e-9);
	});

	it('Chrome’s transient {currentTime, 0} past the end does not end the wait early', () => {
		const clock = new PrimedStartClock();
		// the clock runs 60 ms before a valid timestamp: the transient values are already past the end
		const w = world({ validAfter: 0.06, latency: 0.08 });
		clock.arm(w.startAt, WAIT);
		const at = pictureStart(clock, w);
		expect(at!).toBeGreaterThanOrEqual(w.startAt + WAIT);
	});

	it('property: never before the program reaches the output, at most one poll after, whatever else calls', () => {
		fc.assert(
			fc.property(
				fc.record({
					startAt: fc.double({ min: 0, max: 1e4, noNaN: true }),
					wait: fc.double({ min: 0.001, max: 0.5, noNaN: true }),
					clockStart: fc.double({ min: -0.03, max: 0.12, noNaN: true }),
					latency: fc.double({ min: 0, max: 0.2, noNaN: true }),
					validAfter: fc.double({ min: 0, max: 0.1, noNaN: true }),
					poll: fc.double({ min: 0.004, max: 0.05, noNaN: true }),
					stray: fc.array(fc.double({ min: 0, max: 0.6, noNaN: true }), { maxLength: 8 }),
				}),
				(r) => {
					const clock = new PrimedStartClock();
					clock.arm(r.startAt, r.wait);
					const w: World = { ...r };
					const at = pictureStart(clock, w);
					expect(at).not.toBeNull();
					const end = r.startAt + r.wait;
					expect(at!).toBeGreaterThanOrEqual(end - 1e-9);
					// a late start reading (the clock already ran) or the first valid reading may delay it further
					const late = Math.max(0, -r.clockStart) + r.validAfter + r.latency;
					expect(at! - end).toBeLessThanOrEqual(r.poll + late + 1e-6);
				},
			),
			{ numRuns: 300 },
		);
	});

	it('a stall during the wait: the resume after it waits only for what is left', () => {
		const clock = new PrimedStartClock();
		clock.arm(10, 0.2);
		// Remotion's first start reading, then 50 ms of running output that does not reach the end
		clock.report({ contextTime: 9.95, performanceTime: 1000 }, 10);
		expect(clock.report({ contextTime: 10.0, performanceTime: 1050 }, 10.05).contextTime).toBeCloseTo(9.8, 9);
		// stalled (suspended at 10.05), resumed: the new start reading counts
		clock.rearm();
		const start = clock.report({ contextTime: 9.99, performanceTime: 2000 }, 10.05);
		expect(start.contextTime).toBeCloseTo(9.99 - 0.15, 9);
		// Remotion compares with currentTime 10.05: passes once the output is at 10.2
		expect(clock.report({ contextTime: 10.19, performanceTime: 2200 }, 10.25).contextTime!).toBeLessThan(
			10.05,
		);
		expect(clock.report({ contextTime: 10.2, performanceTime: 2210 }, 10.26).contextTime).toBe(10.2);
		expect(clock.active).toBe(false);
	});

	it('no wait: timestamps pass through; clear() ends a wait', () => {
		const clock = new PrimedStartClock();
		const t = { contextTime: 1, performanceTime: 2 };
		expect(clock.report(t, 1)).toBe(t);
		clock.arm(5, 0);
		expect(clock.active).toBe(false);
		clock.arm(5, Number.NaN);
		expect(clock.active).toBe(false);
		clock.arm(5, 0.1);
		expect(clock.active).toBe(true);
		expect(clock.endTime).toBeCloseTo(5.1, 12);
		clock.clear();
		expect(clock.report(t, 5)).toBe(t);
	});
});
