import { FLICKS_PER_SECOND, type Quad, type TrackerSamples } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAllCommands } from '../src/commands/index.ts';
import { revealSection, Section } from '../src/panels/properties/controls/Section.tsx';
import { TimelinePanel } from '../src/panels/timeline/TimelinePanel.tsx';
import { ShellRuntimeProvider } from '../src/shell/context.tsx';
import { EngineProvider } from '../src/state/engine.tsx';
import { addTracker, applyTracking, commitTrackResult } from '../src/tracking/actions.ts';
import { registerTrackingUi } from '../src/tracking/register.ts';
import { setActiveTracker, trackingStore } from '../src/tracking/store.ts';
import {
	confidenceClass,
	frameUnderPointer,
	sampleRangeOfFrames,
	stripRuns,
	trackedFrames,
} from '../src/tracking/timeline-strip.ts';
import { fakeEngine, planarResult, trackingSession } from './tracking-helpers.tsx';

const R30 = { num: 30, den: 1 };
const F30 = FLICKS_PER_SECOND / 30;

/** Samples on the 30 fps grid: source frames [first, first + n). */
function samples(first: number, n: number, conf: (i: number) => number = () => 0.9): TrackerSamples {
	return {
		start: first * F30,
		step: F30,
		stride: 2,
		data: new Array(n * 2).fill(0),
		confidence: Array.from({ length: n }, (_, i) => conf(i)),
	};
}

const timing = (
	o: Partial<{ start: number; duration: number; sourceIn: number; rate: number; reverse: boolean }>,
) => ({
	start: o.start ?? 0,
	duration: o.duration ?? 100,
	sourceIn: (o.sourceIn ?? 0) * F30,
	speed: { rate: o.rate ?? 1, reverse: o.reverse ?? false, maintainPitch: false },
});

describe('strip mapping (content time → clip frames)', () => {
	it('maps the tracked span through a sourceIn trim and clips it to the clip', () => {
		// Clip shows source frames 10…49; tracked source frames 20…49.
		expect(trackedFrames(timing({ duration: 40, sourceIn: 10 }), R30, samples(20, 30))).toEqual({
			first: 10,
			last: 39,
		});
		// Tracked 0…99 but the clip shows only 40 frames.
		expect(trackedFrames(timing({ duration: 40 }), R30, samples(0, 100))).toEqual({ first: 0, last: 39 });
		// Tracked span entirely after the clip's out point / before its in point.
		expect(trackedFrames(timing({ duration: 40 }), R30, samples(100, 10))).toBeNull();
		expect(trackedFrames(timing({ duration: 40, sourceIn: 50 }), R30, samples(0, 20))).toBeNull();
		expect(trackedFrames(timing({}), R30, null)).toBeNull();
	});

	it('respects speed and reverse', () => {
		// 200 %: clip frame j shows source frame 2j → tracked 0…59 covers frames 0…29.
		expect(trackedFrames(timing({ duration: 40, rate: 2 }), R30, samples(0, 60))).toEqual({
			first: 0,
			last: 29,
		});
		// 50 %: frame j shows source j/2 → tracked 10…19 covers frames 20…38.
		expect(trackedFrames(timing({ duration: 100, rate: 0.5 }), R30, samples(10, 10))).toEqual({
			first: 20,
			last: 38,
		});
		// Reversed 40-frame clip: forward index j is drawn at frame 39 − j.
		expect(trackedFrames(timing({ duration: 40, reverse: true }), R30, samples(10, 10))).toEqual({
			first: 20,
			last: 29,
		});
		// Reversed with a trim: forward j shows source 5 + j → j ∈ 5…14 → frames 39 − j.
		expect(trackedFrames(timing({ duration: 40, sourceIn: 5, reverse: true }), R30, samples(10, 10))).toEqual(
			{ first: 25, last: 34 },
		);
	});

	it('takes both neighbours of a fractional sample index (other media rates)', () => {
		// 25 fps sequence over 30 fps samples: frame 1 = 1/25 s = source 1.2.
		const s = samples(0, 30);
		expect(sampleRangeOfFrames(timing({}), { num: 25, den: 1 }, s, 1, 1)).toEqual({ lo: 1, hi: 2 });
		expect(sampleRangeOfFrames(timing({}), R30, s, 3, 3)).toEqual({ lo: 3, hi: 3 });
	});
});

describe('worst-of-column aggregation', () => {
	it('keeps a single lost frame among 1000 visible at low zoom', () => {
		const s = samples(0, 1000, (i) => (i === 537 ? 0 : 0.95));
		const clip = timing({ duration: 1000 });
		// 0.1 px per frame: the clip is 100 px wide, 10 frames per column.
		const runs = stripRuns({ clip, seqRate: R30, samples: s, clipX: 0, pxPerFrame: 0.1, x0: 0, x1: 100 });
		const lost = runs.filter((r) => r.cls === 'lost');
		expect(lost).toEqual([{ x0: 53, x1: 54, confidence: 0, cls: 'lost' }]);
		expect(runs[0]!.x0).toBe(0);
		expect(runs[runs.length - 1]!.x1).toBe(100);
		expect(runs.map((r) => r.cls)).toEqual(['good', 'lost', 'good']);
		expect(frameUnderPointer({ clip, seqRate: R30, samples: s, clipX: 0, pxPerFrame: 0.1 }, 53.5)).toEqual({
			frame: 537,
			confidence: 0,
		});
		const far = stripRuns({ clip, seqRate: R30, samples: s, clipX: 0, pxPerFrame: 0.01, x0: 0, x1: 10 });
		expect(far.filter((r) => r.cls === 'lost')).toHaveLength(1);
	});

	it('classifies confidence', () => {
		expect([1, 0.8, 0.79, 0.5, 0.49, 0.01, 0].map(confidenceClass)).toEqual([
			'good',
			'good',
			'fair',
			'fair',
			'poor',
			'poor',
			'lost',
		]);
	});
});

const REF: Quad = [
	[700, 300],
	[1300, 320],
	[1280, 700],
	[690, 680],
];

function mount(session: EditorSession) {
	const outerDown = vi.fn();
	const panel = (
		<div onPointerDown={outerDown}>
			<TimelinePanel instanceId="timeline-1" visible />
		</div>
	);
	render(
		<EngineProvider client={fakeEngine()}>
			<SessionProvider session={session}>
				<ShellRuntimeProvider session={session}>{panel}</ShellRuntimeProvider>
			</SessionProvider>
		</EngineProvider>,
	);
	return { outerDown };
}

/** A plate with one tracked planar tracker (frame 30 lost) and the solid above following it. */
function trackedSession(opts: { second?: boolean } = {}) {
	const t = trackingSession();
	const id = addTracker(t.session, t.plate, 'planar');
	const result = planarResult(0, 60, REF, id);
	result.confidence[30] = 0;
	commitTrackResult(t.session, id, { step: F30, merge: 'replace' }, result);
	applyTracking(t.session, id, t.target, 'corner-pin');
	const second = opts.second ? addTracker(t.session, t.plate, 'point') : null;
	t.session.select('timeline', [], 'replace');
	trackingStore.setState(trackingStore.getInitialState(), true);
	return { ...t, trackerId: id, second };
}

beforeAll(() => {
	registerAllCommands();
	registerTrackingUi();
});
beforeEach(() => trackingStore.setState(trackingStore.getInitialState(), true));
afterEach(() => cleanup());

describe('timeline glyphs (Timeline panel)', () => {
	it('removes the target link glyph when its tracker is removed', () => {
		const { session, target, trackerId } = trackedSession();
		mount(session);
		const link = screen.getByTestId('clip-tracked-link');
		expect(link.getAttribute('data-clip-id')).toBe(target);
		act(() => {
			const r = session.apply({
				label: 'Remove Tracker',
				origin: 'user',
				commands: [{ type: 'tracker.remove', trackerIds: [trackerId] } as never],
			});
			expect(r.ok).toBe(true);
		});
		expect(screen.queryByTestId('clip-tracked-link')).toBeNull();
	});

	it('clicking the badge selects the plate and cycles its active tracker', () => {
		const { session, plate, target, trackerId, second } = trackedSession({ second: true });
		session.select('timeline', [target], 'replace');
		mount(session);
		const badge = screen.getByTestId('clip-tracker-badge');
		fireEvent.pointerDown(badge, { button: 0, pointerId: 1 });
		fireEvent.pointerUp(badge, { button: 0, pointerId: 1 });
		fireEvent.click(badge, { detail: 1 });
		const sel = session.getState().selection.timeline;
		expect(sel.clips).toEqual([plate]);
		expect(sel.primaryClip).toBe(plate);
		expect(trackingStore.getState().activeTrackerId).toBe(trackerId);
		fireEvent.pointerDown(badge, { button: 0, pointerId: 1 });
		fireEvent.click(badge, { detail: 1 });
		expect(trackingStore.getState().activeTrackerId).toBe(second);
	});

	it('clicking the link glyph or a strip selects the plate and activates the tracker', () => {
		const { session, plate, trackerId } = trackedSession();
		mount(session);
		fireEvent.pointerDown(screen.getByTestId('clip-tracked-link'), { button: 0 });
		fireEvent.click(screen.getByTestId('clip-tracked-link'), { detail: 1 });
		expect(session.getState().selection.timeline.clips).toEqual([plate]);
		expect(trackingStore.getState().activeTrackerId).toBe(trackerId);

		act(() => {
			session.select('timeline', [], 'replace');
			setActiveTracker(null);
		});
		const strip = screen.getByTestId('clip-tracker-strip');
		fireEvent.pointerDown(strip, { button: 0 });
		fireEvent.click(strip, { detail: 1 });
		expect(session.getState().selection.timeline.clips).toEqual([plate]);
		expect(trackingStore.getState().activeTrackerId).toBe(trackerId);
	});

	it('stops the press from reaching the timeline with the Selection tool only', () => {
		const { session } = trackedSession();
		const { outerDown: outer } = mount(session);
		fireEvent.pointerDown(screen.getByTestId('clip-tracker-badge'), { button: 0 });
		expect(outer).not.toHaveBeenCalled();
		act(() => session.setToggles({ activeTool: 'razor' } as never));
		fireEvent.pointerDown(screen.getByTestId('clip-tracker-badge'), { button: 0 });
		expect(outer).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByTestId('clip-tracker-badge'), { detail: 1 });
		expect(trackingStore.getState().activeTrackerId).toBeNull();
	});
});

describe('Properties section reveal', () => {
	it('reveals closed sections immediately and when they mount after the request', () => {
		globalThis.localStorage?.removeItem('jasper.inspector.sections');
		const { unmount } = render(
			<Section id="properties.ext.test" title="Test" defaultOpen={false}>
				<div data-testid="section-body" />
			</Section>,
		);
		expect(screen.queryByTestId('section-body')).toBeNull();
		act(() => revealSection('properties.ext.test'));
		expect(screen.getByTestId('section-body')).toBeTruthy();
		unmount();
		revealSection('properties.ext.later');
		render(
			<Section id="properties.ext.later" title="Later" defaultOpen={false}>
				<div data-testid="later-body" />
			</Section>,
		);
		expect(screen.getByTestId('later-body')).toBeTruthy();
	});
});
