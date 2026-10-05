// Live tracking progress on the timeline strips (S09:TRU-005, TRK-010): engine `tracking.progress` events grow the
// strip over the frames tracked so far (merged over the committed samples, gaps filled with the lower neighbour),
// redraws are throttled (≤ 10 Hz), nothing reaches the document or History, and the committed result replaces the
// live span when the job ends. Also: the strips use the timeline's own trim edge-zone helper (no copy).
import { FLICKS_PER_SECOND, type Quad, type TrackerSamples } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAllCommands } from '../src/commands/index.ts';
import { TimelinePanel } from '../src/panels/timeline/TimelinePanel.tsx';
import { ShellRuntimeProvider } from '../src/shell/context.tsx';
import { EngineProvider } from '../src/state/engine.tsx';
import { addTracker, commitTrackResult, handleEngineEvent, startTrack } from '../src/tracking/actions.ts';
import { liveSamples, recordLiveProgress } from '../src/tracking/live.ts';
import { registerTrackingUi } from '../src/tracking/register.ts';
import { patchRunning, trackingStore } from '../src/tracking/store.ts';
import {
	type FakeEngine,
	fakeEngine,
	labels,
	planarResult,
	seqOf,
	trackingSession,
} from './tracking-helpers.tsx';

const F30 = FLICKS_PER_SECOND / 30;
const REF: Quad = [
	[700, 300],
	[1300, 320],
	[1280, 700],
	[690, 680],
];

beforeAll(() => {
	registerAllCommands();
	registerTrackingUi();
});
beforeEach(() => {
	trackingStore.setState(trackingStore.getInitialState(), true);
});
afterEach(() => {
	cleanup();
	if (vi.isFakeTimers()) vi.runAllTimers();
	vi.useRealTimers();
});

const committed = (first: number, n: number, c = 0.9): TrackerSamples => ({
	start: first * F30,
	step: F30,
	stride: 8,
	data: new Array(n * 8).fill(1),
	confidence: new Array(n).fill(c),
});

describe('liveSamples', () => {
	it('merges the received frames over the committed samples and fills gaps with the lower neighbour', () => {
		vi.useFakeTimers();
		const base = committed(0, 10);
		for (const [frame, confidence] of [
			[8, 0.95],
			[12, 0.6],
			[15, 0.3],
		] as const)
			recordLiveProgress('tkr_a', { jobId: 'job1', frame, confidence, step: F30, stride: 8 });
		const s = liveSamples('tkr_a', base)!;
		expect(s.start).toBe(0);
		expect(s.confidence).toHaveLength(16);
		expect(s.data).toHaveLength(16 * 8);
		expect(s.confidence.slice(0, 8)).toEqual(new Array(8).fill(0.9)); // committed, untouched
		expect(s.confidence[8]).toBe(0.95);
		expect(s.confidence.slice(9, 12)).toEqual([0.6, 0.6, 0.6]); // gap 9–11: min(0.95, 0.6)
		expect(s.confidence.slice(13, 15)).toEqual([0.3, 0.3]);
		expect(s.confidence[15]).toBe(0.3);
		// A new job must not inherit confidence from the previous job.
		recordLiveProgress('tkr_a', { jobId: 'job2', frame: 40, confidence: 1, step: F30, stride: 8 });
		expect(liveSamples('tkr_a', null)!.start).toBe(40 * F30);
	});

	it('throttles redraw notifications', () => {
		vi.useFakeTimers();
		const seen: number[] = [];
		const off = trackingStore.subscribe((s) => seen.push(s.liveVersion.tkr_a ?? 0));
		for (let f = 0; f < 50; f++)
			recordLiveProgress('tkr_a', { jobId: 'j', frame: f, confidence: 0.9, step: F30, stride: 8 });
		expect(seen).toEqual([]);
		vi.advanceTimersByTime(100);
		expect(seen).toEqual([1]);
		off();
	});
});

function mount(session: EditorSession, engine: FakeEngine) {
	render(
		<EngineProvider client={engine}>
			<SessionProvider session={session}>
				<ShellRuntimeProvider session={session}>
					<TimelinePanel instanceId="timeline-1" visible />
				</ShellRuntimeProvider>
			</SessionProvider>
		</EngineProvider>,
	);
}

describe('timeline strip during a track job', () => {
	it('grows with progress events, stays out of History, and is replaced by the committed result', async () => {
		const { session, plate } = trackingSession();
		const engine = fakeEngine();
		const id = addTracker(session, plate, 'planar');
		mount(session, engine);
		// Not tracked yet: no strip.
		expect(document.querySelector(`[data-tracker-strip="${id}"]`)).toBeNull();
		await act(async () => void (await startTrack(session, engine, id, 'forward')));
		const jobId = [...engine.jobs.keys()][0]!;
		const doc = session.getState().document;
		const historyBefore = labels(session);
		vi.useFakeTimers();
		const progress = (frame: number, confidence: number) =>
			handleEngineEvent(session, engine, {
				id: frame,
				createdAt: '2026-10-01T10:00:00.000Z',
				type: 'tracking.progress',
				payload: {
					jobId,
					trackerId: id,
					mediaKey: 'mk_plate',
					frame,
					data: [1, 2, 3, 4, 5, 6, 7, 8],
					confidence,
					done: frame + 1,
					total: 60,
				},
			} as never);
		act(() => {
			for (let f = 0; f <= 20; f += 4) progress(f, f === 12 ? 0 : 0.9);
			vi.advanceTimersByTime(100);
		});
		const el = document.querySelector(`[data-tracker-strip="${id}"]`) as HTMLElement;
		expect(el).not.toBeNull();
		expect(el.hasAttribute('data-live')).toBe(true);
		const live = liveSamples(id, null)!;
		expect(live.confidence).toHaveLength(21);
		expect(live.confidence[12]).toBe(0);
		// Live progress never touches the document or History.
		expect(session.getState().document).toBe(doc);
		expect(labels(session)).toEqual(historyBefore);
		vi.useRealTimers();
		// The job ends: the committed samples replace the live span.
		await act(async () => {
			commitTrackResult(session, id, { step: F30, merge: 'replace' }, planarResult(0, 60, REF, id));
			patchRunning(id, null);
			await new Promise((r) => setTimeout(r, 200));
		});
		const after = document.querySelector(`[data-tracker-strip="${id}"]`) as HTMLElement;
		expect(after.hasAttribute('data-live')).toBe(false);
		const tracker = seqOf(session).clips[plate] as { trackers: { samples: TrackerSamples }[] };
		expect(liveSamples(id, tracker.trackers[0]!.samples)).toBe(tracker.trackers[0]!.samples);
		expect(labels(session).at(-1)).toBe('Track');
	});
});
