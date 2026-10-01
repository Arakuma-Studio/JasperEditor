// Timeline tracker glyphs (S09:TRU-005): the strip mapping (content time → the plate's sequence frames with
// sourceIn trims, speed and reverse; span clipping), worst-of-column aggregation (one lost frame among 1000 stays
// visible at low zoom), and in the Timeline panel: the plate badge + strips, the target link glyph, clicking a
// glyph selects the plate / activates the tracker / focuses Properties and reveals the Tracking section, the
// press never reaches the timeline with the Selection tool, and seeking the transport re-renders nothing.
import {
	type ClipTracker,
	FLICKS_PER_SECOND,
	type Quad,
	type TrackerSamples,
	type VideoClip,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Profiler, useEffect } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAllCommands } from '../src/commands/index.ts';
import { clipDecorations } from '../src/extensions/index.ts';
import { revealSection, Section } from '../src/panels/properties/controls/Section.tsx';
import { setPrefs } from '../src/panels/timeline/state/prefs.ts';
import { TimelinePanel } from '../src/panels/timeline/TimelinePanel.tsx';
import { ShellRuntimeProvider, useShellRuntime } from '../src/shell/context.tsx';
import { EngineProvider } from '../src/state/engine.tsx';
import { addTracker, applyTracking, commitTrackResult } from '../src/tracking/actions.ts';
import { registerTrackingUi } from '../src/tracking/register.ts';
import { resetTrackingStore, setActiveTracker, trackingStore } from '../src/tracking/store.ts';
import {
	confidenceClass,
	confidenceIndex,
	frameUnderPointer,
	linkText,
	minConfidence,
	plateBadgeLines,
	sampleRangeOfFrames,
	stripRuns,
	trackedFrames,
} from '../src/tracking/timeline-strip.ts';
import { fakeEngine, planarResult, seqOf, trackingSession } from './tracking-helpers.tsx';

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
	it('range minimum matches a brute force scan', () => {
		const conf = Array.from({ length: 777 }, (_, i) => ((i * 7919) % 101) / 100);
		const s = samples(0, conf.length, (i) => conf[i]!);
		const index = confidenceIndex(s);
		expect(confidenceIndex(s)).toBe(index); // cached per samples object
		for (let k = 0; k < 300; k++) {
			const a = (k * 37) % conf.length;
			const b = Math.min(conf.length - 1, a + ((k * 13) % 200));
			expect(minConfidence(index, a, b)).toBeCloseTo(Math.min(...conf.slice(a, b + 1)), 6);
		}
	});

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
		// Hovering that column names the lost frame.
		expect(frameUnderPointer({ clip, seqRate: R30, samples: s, clipX: 0, pxPerFrame: 0.1 }, 53.5)).toEqual({
			frame: 537,
			confidence: 0,
		});
		// Even at 0.01 px per frame (100 frames per column) the lost column stays.
		const far = stripRuns({ clip, seqRate: R30, samples: s, clipX: 0, pxPerFrame: 0.01, x0: 0, x1: 10 });
		expect(far.filter((r) => r.cls === 'lost')).toHaveLength(1);
	});

	it('draws one cell per frame when zoomed in, only over the requested range and the tracked span', () => {
		const s = samples(10, 20, (i) => (i < 5 ? 0.3 : i < 10 ? 0.6 : 0.9));
		const clip = timing({ duration: 100 });
		const runs = stripRuns({ clip, seqRate: R30, samples: s, clipX: 50, pxPerFrame: 10, x0: 0, x1: 1000 });
		expect(runs).toEqual([
			{ x0: 150, x1: 200, confidence: 0.3, cls: 'poor' },
			{ x0: 200, x1: 250, confidence: 0.6, cls: 'fair' },
			{ x0: 250, x1: 350, confidence: 0.9, cls: 'good' },
		]);
		// Visible range only (one canvas tile).
		expect(
			stripRuns({ clip, seqRate: R30, samples: s, clipX: 50, pxPerFrame: 10, x0: 210, x1: 230 }),
		).toEqual([{ x0: 210, x1: 230, confidence: 0.6, cls: 'fair' }]);
		// Reversed: the lowest-confidence source frames end up at the right.
		const rev = stripRuns({
			clip: timing({ duration: 100, reverse: true }),
			seqRate: R30,
			samples: s,
			clipX: 0,
			pxPerFrame: 1,
			x0: 0,
			x1: 100,
		});
		expect(rev.map((r) => [r.x0, r.x1, r.cls])).toEqual([
			[70, 80, 'good'],
			[80, 85, 'fair'],
			[85, 90, 'poor'],
		]);
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

describe('tooltip texts', () => {
	it('lists trackers with span, samples, mean confidence, low and lost frames', () => {
		const t = (name: string, s: TrackerSamples | null, kind: 'planar' | 'point' = 'planar') =>
			({ id: name, name, kind, samples: s }) as Pick<ClipTracker, 'name' | 'kind' | 'samples'>;
		const clip = { ...timing({ start: 30, duration: 60 }), trackers: [] as ReturnType<typeof t>[] };
		clip.trackers = [
			t(
				'Screen',
				samples(0, 30, (i) => (i === 3 ? 0 : i < 6 ? 0.4 : 1)),
			),
			t('Dot', null, 'point'),
		];
		expect(plateBadgeLines(clip, R30)).toEqual([
			'2 trackers',
			'Screen (Planar) · 00:00:01:00–00:00:01:29 · 30 frames · mean 87% · 5 low · 1 lost',
			'Dot (Point) · Not tracked',
		]);
		expect(linkText({ trackerName: 'Screen', plateName: 'plate.mp4' }, 'corner-pin')).toBe(
			'Follows Screen on plate.mp4 · Corner Pin',
		);
		expect(linkText(null, 'transform')).toBe('Tracker removed');
	});
});

// ------------------------------------------------------------------ Timeline panel

const REF: Quad = [
	[700, 300],
	[1300, 320],
	[1280, 700],
	[690, 680],
];

function ShellSpy({ focusPanel }: { focusPanel: (kind: string) => void }) {
	const rt = useShellRuntime();
	useEffect(() => rt.services.register('shell', 'test', { focusPanel } as never), [rt, focusPanel]);
	return null;
}

function mount(session: EditorSession, onCommit?: () => void) {
	const focusPanel = vi.fn();
	const outerDown = vi.fn();
	const panel = (
		<div onPointerDown={outerDown}>
			<TimelinePanel instanceId="timeline-1" visible />
		</div>
	);
	render(
		<EngineProvider client={fakeEngine()}>
			<SessionProvider session={session}>
				<ShellRuntimeProvider session={session}>
					<ShellSpy focusPanel={focusPanel} />
					{onCommit ? (
						<Profiler id="timeline" onRender={onCommit}>
							{panel}
						</Profiler>
					) : (
						panel
					)}
				</ShellRuntimeProvider>
			</SessionProvider>
		</EngineProvider>,
	);
	return { focusPanel, outerDown };
}

/** A plate with one tracked planar tracker (frame 30 lost) and the solid above following it. */
function trackedSession(opts: { lostAt?: number; second?: boolean } = {}) {
	const t = trackingSession();
	const id = addTracker(t.session, t.plate, 'planar');
	const result = planarResult(0, 60, REF, id);
	result.confidence[opts.lostAt ?? 30] = 0;
	commitTrackResult(t.session, id, { step: F30, merge: 'replace' }, result);
	applyTracking(t.session, id, t.target, 'corner-pin');
	const second = opts.second ? addTracker(t.session, t.plate, 'point') : null;
	t.session.select('timeline', [], 'replace');
	resetTrackingStore();
	return { ...t, trackerId: id, second };
}

beforeAll(() => {
	registerAllCommands();
	registerTrackingUi();
});
beforeEach(() => resetTrackingStore());
afterEach(() => cleanup());

describe('timeline glyphs (Timeline panel)', () => {
	it('registers the plate and target decorations', () => {
		const { session, plate, target } = trackedSession();
		const seq = seqOf(session);
		const plateDeco = clipDecorations.get('tracking.plate')!;
		const targetDeco = clipDecorations.get('tracking.target')!;
		expect(plateDeco.appliesTo(seq.clips[plate]!)).toBe(true);
		expect(plateDeco.appliesTo(seq.clips[target]!)).toBe(false);
		expect(targetDeco.appliesTo(seq.clips[target]!)).toBe(true);
		expect(targetDeco.appliesTo(seq.clips[plate]!)).toBe(false);
	});

	it('shows the plate badge with its tooltip text and a strip per tracked tracker', () => {
		const { session, plate, trackerId } = trackedSession({ second: true });
		mount(session);
		const badge = screen.getByTestId('clip-tracker-badge');
		expect(badge.getAttribute('data-clip-id')).toBe(plate);
		const label = badge.getAttribute('aria-label')!;
		const tracker = (seqOf(session).clips[plate] as VideoClip).trackers![0]!;
		expect(label.split('\n')[0]).toBe('2 trackers');
		expect(label).toContain(`${tracker.name} (Planar) · 00:00:00:00–00:00:01:29 · 60 frames`);
		expect(label).toContain('1 lost');
		expect(label).toMatch(/\(Point\) · Not tracked/);
		expect(badge.textContent).toBe('2');
		// The point tracker has no samples: one strip only.
		const strips = screen.getAllByTestId('clip-tracker-strip');
		expect(strips.map((s) => s.getAttribute('data-tracker-id'))).toEqual([trackerId]);
	});

	it('shows the link glyph on the target and "Tracker removed" when the tracker is gone', () => {
		const { session, target, trackerId, plate } = trackedSession();
		mount(session);
		const link = screen.getByTestId('clip-tracked-link');
		expect(link.getAttribute('data-clip-id')).toBe(target);
		const tracker = (seqOf(session).clips[plate] as VideoClip).trackers![0]!;
		expect(link.getAttribute('aria-label')).toBe(`Follows ${tracker.name} on plate.mp4 · Corner Pin`);
		act(() => {
			const r = session.apply({
				label: 'Remove Tracker',
				origin: 'user',
				commands: [{ type: 'tracker.remove', trackerIds: [trackerId] } as never],
			});
			expect(r.ok).toBe(true);
		});
		// tracker.remove unlinks its targets: the glyph goes away.
		expect(screen.queryByTestId('clip-tracked-link')).toBeNull();
	});

	it('reads "Tracker removed" in a warning tone for a dangling link', () => {
		const t = trackedSession();
		const document = structuredClone(t.session.getCommitted());
		const target = document.sequences[t.seqId]!.clips[t.target] as { trackedBy?: { trackerId: string } };
		target.trackedBy!.trackerId = 'trk_missing';
		const session = new EditorSession({ projectId: document.projectId, document, ctx: t.session.ctx });
		mount(session);
		const link = screen.getByTestId('clip-tracked-link');
		expect(link.getAttribute('aria-label')).toBe('Tracker removed');
		expect(link.hasAttribute('data-tracker-missing')).toBe(true);
		expect(link.className).toContain('text-pr-warning');
	});

	it('clicking the badge selects the plate, activates its tracker and reveals Properties ▸ Tracking', () => {
		const { session, plate, target, trackerId, second } = trackedSession({ second: true });
		session.select('timeline', [target], 'replace');
		const { focusPanel } = mount(session);
		const badge = screen.getByTestId('clip-tracker-badge');
		const down = fireEvent.pointerDown(badge, { button: 0, pointerId: 1 });
		expect(down).toBe(true);
		fireEvent.pointerUp(badge, { button: 0, pointerId: 1 });
		fireEvent.click(badge, { detail: 1 });
		const sel = session.getState().selection.timeline;
		expect(sel.clips).toEqual([plate]);
		expect(sel.primaryClip).toBe(plate);
		expect(trackingStore.getState().activeTrackerId).toBe(trackerId);
		expect(focusPanel).toHaveBeenCalledWith('properties');
		// Again on the selected plate: cycles to the next tracker.
		fireEvent.pointerDown(badge, { button: 0, pointerId: 1 });
		fireEvent.click(badge, { detail: 1 });
		expect(trackingStore.getState().activeTrackerId).toBe(second);
	});

	it('clicking the link glyph or a strip selects the plate and activates the tracker', () => {
		const { session, plate, trackerId } = trackedSession();
		const { focusPanel } = mount(session);
		fireEvent.pointerDown(screen.getByTestId('clip-tracked-link'), { button: 0 });
		fireEvent.click(screen.getByTestId('clip-tracked-link'), { detail: 1 });
		expect(session.getState().selection.timeline.clips).toEqual([plate]);
		expect(trackingStore.getState().activeTrackerId).toBe(trackerId);
		expect(focusPanel).toHaveBeenCalledWith('properties');

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
		// …and a pointer click with another tool does not activate the tracker.
		fireEvent.click(screen.getByTestId('clip-tracker-badge'), { detail: 1 });
		expect(trackingStore.getState().activeTrackerId).toBeNull();
	});

	it('keeps the strip out of the trim edge zones and shows the frame under the pointer', async () => {
		const { session, trackerId } = trackedSession({ lostAt: 0 });
		mount(session);
		const strip = screen.getByTestId('clip-tracker-strip');
		const left = Number.parseFloat(strip.style.left);
		const width = Number.parseFloat(strip.style.width);
		const clipEl = strip.parentElement!.closest('[data-clip-id]') as HTMLElement;
		const clipW = Number.parseFloat(clipEl.style.width);
		const zone = Math.min(8, Math.max(3, clipW / 4));
		expect(left).toBeCloseTo(zone, 3);
		expect(left + width).toBeCloseTo(clipW - zone, 3);
		// happy-dom rects are at 0: clientX = px from the button's left. The px under x = 0 is past the edge zone.
		vi.useFakeTimers();
		try {
			fireEvent.pointerMove(strip, { clientX: 0, pointerType: 'mouse' });
			act(() => void vi.advanceTimersByTime(500));
		} finally {
			vi.useRealTimers();
		}
		const tip = await screen.findByTestId('clip-tracker-strip-tip');
		const tracker = (seqOf(session).clips[strip.getAttribute('data-clip-id')!] as VideoClip).trackers!.find(
			(t) => t.id === trackerId,
		)!;
		expect(tip.textContent).toMatch(new RegExp(`^${tracker.name} · 00:00:00:\\d\\d · 90% OK$`));
		fireEvent.pointerLeave(strip);
		expect(screen.queryByTestId('clip-tracker-strip-tip')).toBeNull();
	});

	it('marks the active tracker strip and does not re-render on transport seeks', async () => {
		const { session, trackerId } = trackedSession();
		let commits = 0;
		mount(session, () => commits++);
		expect(document.querySelector(`[data-tracker-strip="${trackerId}"]`)?.hasAttribute('data-active')).toBe(
			false,
		);
		act(() => setActiveTracker(trackerId));
		expect(document.querySelector(`[data-tracker-strip="${trackerId}"]`)?.hasAttribute('data-active')).toBe(
			true,
		);
		const before = commits;
		await act(async () => {
			for (let i = 1; i <= 50; i++) session.transport.seek(i);
		});
		expect(commits).toBe(before);
	});

	it('shows badges with clip names hidden', () => {
		const { session } = trackedSession();
		setPrefs({ showVideoNames: false });
		try {
			mount(session);
			expect(screen.getByTestId('clip-tracker-badge')).toBeTruthy();
			expect(screen.getByTestId('clip-tracked-link')).toBeTruthy();
		} finally {
			setPrefs({ showVideoNames: true });
		}
	});
});

describe('Properties section reveal', () => {
	it('opens a closed section, scrolls it into view, and serves a section mounting just after the call', () => {
		const scroll = vi.fn();
		const proto = HTMLElement.prototype as { scrollIntoView?: unknown };
		const orig = proto.scrollIntoView;
		proto.scrollIntoView = scroll;
		try {
			globalThis.localStorage?.removeItem('jasper.inspector.sections');
			const { unmount } = render(
				<Section id="properties.ext.test" title="Test" defaultOpen={false}>
					<div data-testid="section-body" />
				</Section>,
			);
			expect(screen.queryByTestId('section-body')).toBeNull();
			act(() => revealSection('properties.ext.test'));
			expect(screen.getByTestId('section-body')).toBeTruthy();
			expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
			unmount();
			// Persisted open, and a reveal for a section not mounted yet is taken on mount.
			revealSection('properties.ext.later');
			scroll.mockClear();
			render(
				<Section id="properties.ext.later" title="Later" defaultOpen={false}>
					<div data-testid="later-body" />
				</Section>,
			);
			expect(screen.getByTestId('later-body')).toBeTruthy();
			expect(scroll).toHaveBeenCalledTimes(1);
		} finally {
			proto.scrollIntoView = orig;
		}
	});
});
