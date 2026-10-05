// Properties ▸ Tracking section, the Apply Tracking dialog and the corner-pin Effect Controls editor (S09:TRU-001,
// TRU-004) with a fake engine behind <EngineProvider>: add → Track Forward (progress, "Track") → Apply (one entry)
// → "Driven by tracker" with Re-apply / Unlink, and the non-convex warning.
import type { Clip, EffectInstance, EffectSpec } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApplyTrackingDialog } from '../src/tracking/ApplyTrackingDialog.tsx';
import { addTracker, applyTracking, commitTrackResult } from '../src/tracking/actions.ts';
import { CornerPinEditor } from '../src/tracking/CornerPinEditor.tsx';
import { trackingStore } from '../src/tracking/store.ts';
import { labels, planarResult, seqOf, trackingSession } from './tracking-helpers.tsx';

const REF = [
	[700, 300],
	[1300, 320],
	[1280, 700],
	[690, 680],
] as [number, number][] as never;

beforeEach(() => trackingStore.setState(trackingStore.getInitialState(), true));
afterEach(() => cleanup());

describe('Apply Tracking dialog', () => {
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
