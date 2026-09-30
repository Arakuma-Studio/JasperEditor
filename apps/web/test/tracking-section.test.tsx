// Properties ▸ Tracking section, the Apply Tracking dialog and the corner-pin Effect Controls editor (S09:TRU-001,
// TRU-004) with a fake engine behind <EngineProvider>: add → Track Forward (progress, "Track") → Apply (one entry)
// → "Driven by tracker" with Re-apply / Unlink, and the non-convex warning.
import type { Clip, EffectInstance, EffectSpec } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	clipMenuExtensions,
	clipSections,
	effectEditorFor,
	programOverlays,
} from '../src/extensions/index.ts';
import { EngineProvider } from '../src/state/engine.tsx';
import { ApplyTrackingDialog } from '../src/tracking/ApplyTrackingDialog.tsx';
import { addTracker, applyTracking, commitTrackResult } from '../src/tracking/actions.ts';
import { CornerPinEditor } from '../src/tracking/CornerPinEditor.tsx';
import { registerTrackingUi } from '../src/tracking/register.ts';
import { resetTrackingStore, trackingStore } from '../src/tracking/store.ts';
import { TrackingSection } from '../src/tracking/TrackingSection.tsx';
import {
	type FakeEngine,
	fakeEngine,
	labels,
	planarResult,
	seqOf,
	trackingSession,
} from './tracking-helpers.tsx';

const REF = [
	[700, 300],
	[1300, 320],
	[1280, 700],
	[690, 680],
] as [number, number][] as never;

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 10))));

beforeEach(() => resetTrackingStore());
afterEach(() => cleanup());

function Section({
	session,
	engine,
	clipId,
}: {
	session: EditorSession;
	engine: FakeEngine;
	clipId: string;
}) {
	const seq = seqOf(session);
	return (
		<EngineProvider client={engine}>
			<SessionProvider session={session}>
				<TrackingSection session={session} clips={[seq.clips[clipId]!]} frame={0} sequenceId={seq.id} />
			</SessionProvider>
		</EngineProvider>
	);
}

describe('registration', () => {
	it('registers the section, overlay, corner-pin editor and clip menu entries', () => {
		registerTrackingUi();
		expect(clipSections.get('tracking')?.title).toBe('Tracking');
		expect(programOverlays.get('tracking')).toBeTruthy();
		expect(effectEditorFor('jasper.corner-pin')?.component).toBe(CornerPinEditor);
		const { session, plate, target } = trackingSession();
		const seq = seqOf(session);
		const menu = clipMenuExtensions.get('tracking')!;
		expect(
			menu
				.items({ session, clip: seq.clips[plate]!, selection: [] })
				.map((i) => i.kind === 'submenu' && i.label),
		).toEqual(['Track']);
		expect(menu.items({ session, clip: seq.clips[target]!, selection: [] })).toEqual([]);
		addTracker(session, plate, 'planar');
		const items = menu.items({ session, clip: seqOf(session).clips[target]!, selection: [] });
		expect(items[0]).toMatchObject({ kind: 'submenu', label: 'Apply Tracking' });
		expect(clipSections.get('tracking')!.appliesTo([seq.clips[target]!])).toBe(false);
	});
});

describe('Tracking section', () => {
	it('adds a planar tracker, tracks forward with live progress and lists the result', async () => {
		const { session, plate } = trackingSession();
		const engine = fakeEngine();
		const { rerender } = render(<Section session={session} engine={engine} clipId={plate} />);
		await flush();
		expect(screen.getByText(/No trackers/)).toBeTruthy();
		fireEvent.click(screen.getByTestId('tracking-add-planar'));
		expect(labels(session)).toEqual(['Add Planar Tracker']);
		rerender(<Section session={session} engine={engine} clipId={plate} />);
		const id = trackingStore.getState().activeTrackerId!;
		expect(screen.getByTestId(`tracker-row-${id}`).textContent).toContain('Planar Tracker 1');
		expect(screen.getByTestId(`tracker-span-${id}`).textContent).toBe('Not tracked');
		expect(screen.getByTestId('tracker-controls')).toBeTruthy();
		// Snap to edges is on by default for planar trackers
		expect((screen.getByLabelText('Snap to edges') as HTMLInputElement).checked).toBe(true);
		fireEvent.click(screen.getByTestId('track-forward'));
		await flush();
		expect(engine.calls).toHaveLength(1);
		const jobId = [...engine.jobs.keys()][0]!;
		act(() =>
			engine.emit({
				type: 'tracking.progress',
				payload: {
					jobId,
					trackerId: id,
					mediaKey: 'mk_plate',
					frame: 30,
					data: [1, 2, 3, 4, 5, 6, 7, 8],
					confidence: 0.9,
					done: 30,
					total: 60,
				},
			}),
		);
		expect(screen.getByTestId('tracking-progress').textContent).toContain('30/60');
		expect(screen.getByTestId('track-forward').getAttribute('aria-disabled')).toBe('true');
		const job = engine.finish(jobId, planarResult(0, 60, REF, id));
		act(() => engine.emit({ type: 'job.finished', payload: job }));
		await flush();
		rerender(<Section session={session} engine={engine} clipId={plate} />);
		expect(labels(session)).toEqual(['Add Planar Tracker', 'Track']);
		expect(screen.getByTestId(`tracker-span-${id}`).textContent).toBe('0:00–1:29');
		expect(screen.getByTestId(`tracker-confidence-${id}`).textContent).toBe('90%');
		expect(screen.queryByTestId('tracking-progress')).toBeNull();
	});

	it('shows engine errors and removes a tracker', async () => {
		const { session, plate } = trackingSession();
		const engine = fakeEngine();
		engine.next = 'not-implemented';
		addTracker(session, plate, 'planar');
		const { rerender } = render(<Section session={session} engine={engine} clipId={plate} />);
		await flush();
		fireEvent.click(screen.getByTestId('track-forward'));
		await flush();
		expect(screen.getByTestId('tracking-error').textContent).toMatch(/not available/);
		fireEvent.click(screen.getByTestId('tracking-remove'));
		rerender(<Section session={session} engine={engine} clipId={plate} />);
		expect(labels(session)).toEqual(['Add Planar Tracker', 'Remove Tracker']);
		expect(screen.getByText(/No trackers/)).toBeTruthy();
	});
});

describe('Apply Tracking dialog', () => {
	it('lists clips above the plate and applies a corner pin as one entry', async () => {
		const { session, plate, target } = trackingSession();
		const id = addTracker(session, plate, 'planar');
		commitTrackResult(session, id, { step: 705_600_000 / 30, merge: 'replace' }, planarResult(0, 60, REF));
		let closed = false;
		render(
			<SessionProvider session={session}>
				<ApplyTrackingDialog session={session} trackerId={id} close={() => void (closed = true)} />
			</SessionProvider>,
		);
		expect(screen.getByTestId(`tracking-target-${target}`)).toBeTruthy();
		const pin = screen.getByTestId('tracking-mode-corner-pin').querySelector('input')!;
		expect(pin.checked).toBe(true);
		fireEvent.click(screen.getByText('Apply'));
		await flush();
		expect(closed).toBe(true);
		expect(labels(session)).toEqual(['Add Planar Tracker', 'Track', 'Apply Tracking']);
		expect((seqOf(session).clips[target] as { trackedBy?: { trackerId: string } }).trackedBy?.trackerId).toBe(
			id,
		);
	});

	it('offers only Position for point trackers', () => {
		const { session, plate } = trackingSession();
		const id = addTracker(session, plate, 'point');
		render(
			<SessionProvider session={session}>
				<ApplyTrackingDialog session={session} trackerId={id} close={() => undefined} />
			</SessionProvider>,
		);
		expect(screen.getByTestId('tracking-mode-corner-pin').querySelector('input')!.disabled).toBe(true);
		expect(screen.getByTestId('tracking-mode-position').querySelector('input')!.checked).toBe(true);
	});
});

describe('Corner pin editor', () => {
	function mountEditor(session: EditorSession, clipId: string) {
		const seq = seqOf(session);
		const clip = seq.clips[clipId] as Clip & { effects: EffectInstance[] };
		const fx = clip.effects.find((e) => e.effectId === 'jasper.corner-pin')!;
		const effect = session.ctx.registries.effects.get('jasper.corner-pin') as EffectSpec;
		return render(
			<SessionProvider session={session}>
				<CornerPinEditor
					session={session}
					clip={clip}
					fx={fx}
					effect={effect}
					frame={0}
					sequenceId={seq.id}
					host="effectControls"
				/>
			</SessionProvider>,
		);
	}

	it('shows the driving tracker with Re-apply and Unlink (one entry each)', () => {
		const { session, plate, target } = trackingSession();
		const id = addTracker(session, plate, 'planar');
		commitTrackResult(session, id, { step: 705_600_000 / 30, merge: 'replace' }, planarResult(0, 60, REF));
		applyTracking(session, id, target, 'corner-pin');
		const { unmount } = mountEditor(session, target);
		expect(screen.getByTestId('corner-pin-driven').textContent).toContain('Planar Tracker 1');
		fireEvent.click(screen.getByTestId('corner-pin-reapply'));
		expect(labels(session).at(-1)).toBe('Apply Tracking');
		fireEvent.click(screen.getByTestId('corner-pin-unlink'));
		expect(labels(session).at(-1)).toBe('Unlink Tracking');
		expect((seqOf(session).clips[target] as { trackedBy?: unknown }).trackedBy).toBeUndefined();
		unmount();
		mountEditor(session, target);
		expect(screen.queryByTestId('corner-pin-driven')).toBeNull();
		// keyframes stay after unlinking
		const fx = (seqOf(session).clips[target] as Clip & { effects: EffectInstance[] }).effects.find(
			(e) => e.effectId === 'jasper.corner-pin',
		)!;
		expect((fx.params.topLeft as { keyframes: unknown[] }).keyframes.length).toBe(30);
	});

	it('toggles the Program-monitor handles and warns about a non-convex pin', () => {
		const { session, target } = trackingSession();
		session.select('timeline', [target]);
		const r = session.apply({
			label: 'Add',
			origin: 'user',
			commands: [
				{ type: 'effect.add', effectId: 'jasper.corner-pin', target: { clipId: target }, ref: '$pin' },
				// bow tie: TL (0,0) → TR (1,1) → BR (1,0) → BL (0,1)
				{ type: 'param.set', target: ['effect', '$pin', 'topRight'], value: [1, 1] },
				{ type: 'param.set', target: ['effect', '$pin', 'bottomRight'], value: [1, 0] },
			] as never,
		});
		expect(r.ok).toBe(true);
		mountEditor(session, target);
		expect(screen.getByTestId('corner-pin-nonconvex')).toBeTruthy();
		fireEvent.click(screen.getByTestId('corner-pin-handles-toggle'));
		expect(trackingStore.getState().cornerPinTool).toBe(true);
	});
});
