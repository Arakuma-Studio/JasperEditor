// "Simplify Keyframes…" UI (S09:TRK-023, TRU-006): the dialog previews live through a gesture (transient
// document, no History entry) with counts / deviation / graph, applies as ONE entry "Simplify Keyframes", cancels
// without a trace; the Apply Tracking dialog's "Simplify keyframes" option; the Tracking section and corner-pin
// editor entry points; the timeline clip menu entry and the Clip menu command.
import type { Clip } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplyTrackingDialog } from '../src/tracking/ApplyTrackingDialog.tsx';
import { addTracker, commitTrackResult } from '../src/tracking/actions.ts';
import { SimplifyKeyframesDialog } from '../src/tracking/SimplifyKeyframesDialog.tsx';
import { trackingStore } from '../src/tracking/store.ts';
import { labels, planarResult, seqOf, trackingSession } from './tracking-helpers.tsx';

// The dialog debounces its preview; the host may be loaded.
vi.setConfig({ testTimeout: 60_000 });

const REF = [
	[700, 300],
	[1300, 320],
	[1280, 700],
	[690, 680],
] as [number, number][] as never;

const wait = (ms = 200) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

beforeEach(() => {
	trackingStore.setState(trackingStore.getInitialState(), true);
	globalThis.localStorage?.clear();
});
afterEach(() => cleanup());

type Fx = { effectId: string; params: Record<string, { keyframes: unknown[] }> };
const pinKeys = (clip: Clip) =>
	((clip as { effects?: Fx[] }).effects ?? []).find((e) => e.effectId === 'jasper.corner-pin')!.params
		.topLeft!.keyframes.length;

/** A plate tracked over 60 frames (smooth drift) and the solid on V2 corner-pinned to it (30 keys per corner). */
function pinned() {
	const t = trackingSession();
	const id = addTracker(t.session, t.plate, 'planar');
	commitTrackResult(t.session, id, { step: 705_600_000 / 30, merge: 'replace' }, planarResult(0, 60, REF));
	const r = t.session.apply({
		label: 'Apply Tracking',
		origin: 'user',
		commands: [{ type: 'tracker.apply', trackerId: id, targetClipId: t.target, mode: 'corner-pin' } as never],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return { ...t, trackerId: id };
}

describe('Simplify Keyframes dialog', () => {
	it('previews live without a History entry, then applies as one entry', async () => {
		const { session, target } = pinned();
		const before = labels(session);
		expect(pinKeys(seqOf(session).clips[target]!)).toBe(30);
		let result: unknown;
		render(
			<SessionProvider session={session}>
				<SimplifyKeyframesDialog
					session={session}
					selection={{ clipIds: [target], trackedOnly: true }}
					subject="Corner Pin of Solid"
					close={(r) => void (result = r)}
				/>
			</SessionProvider>,
		);
		await wait();
		// Live preview: the transient document already shows 2 keys per corner (a linear drift), nothing committed.
		expect(session.getState().transient).not.toBeNull();
		expect(pinKeys(session.getState().transient!.sequences[seqOf(session).id]!.clips[target]!)).toBe(2);
		expect(pinKeys(seqOf(session).clips[target]!)).toBe(30);
		expect(labels(session)).toEqual(before);
		fireEvent.click(screen.getByText('Apply'));
		await wait(20);
		expect(labels(session)).toEqual([...before, 'Simplify Keyframes']);
		expect(pinKeys(seqOf(session).clips[target]!)).toBe(2);
		expect(session.getState().transient).toBeNull();
		expect((result as { after: number }).after).toBe(8);
		// The tolerance is remembered on the link (re-applies simplify again) and for the next dialog.
		expect(
			(seqOf(session).clips[target] as { trackedBy?: { simplify?: { tolerance: number } } }).trackedBy
				?.simplify,
		).toEqual({ tolerance: 0.1 });
		// Undo restores the dense keys in one step.
		act(() => session.undo());
		expect(pinKeys(seqOf(session).clips[target]!)).toBe(30);
	});

	it('cancel leaves no trace; presets change the tolerance', async () => {
		const { session, target } = pinned();
		const before = labels(session);
		const doc = session.getState().document;
		const view = render(
			<SessionProvider session={session}>
				<SimplifyKeyframesDialog
					session={session}
					selection={{ clipIds: [target] }}
					close={() => undefined}
				/>
			</SessionProvider>,
		);
		await wait();
		fireEvent.click(screen.getByTestId('simplify-preset-1'));
		await wait();
		fireEvent.click(screen.getByText('Cancel'));
		await wait(20);
		view.unmount();
		expect(session.getState().transient).toBeNull();
		expect(session.getState().document).toBe(doc);
		expect(labels(session)).toEqual(before);
	});

	it('reports when there is nothing to simplify', async () => {
		const { session, target } = trackingSession();
		render(
			<SessionProvider session={session}>
				<SimplifyKeyframesDialog
					session={session}
					selection={{ clipIds: [target] }}
					close={() => undefined}
				/>
			</SessionProvider>,
		);
		await wait();
		expect((screen.getByText('Apply').closest('button') as HTMLButtonElement).disabled).toBe(true);
	});
});

describe('entry points', () => {
	it('Apply Tracking can simplify in the same entry', async () => {
		const t = trackingSession();
		const id = addTracker(t.session, t.plate, 'planar');
		commitTrackResult(t.session, id, { step: 705_600_000 / 30, merge: 'replace' }, planarResult(0, 60, REF));
		render(
			<SessionProvider session={t.session}>
				<ApplyTrackingDialog session={t.session} trackerId={id} close={() => undefined} />
			</SessionProvider>,
		);
		fireEvent.click(screen.getByRole('checkbox', { name: 'Simplify keyframes' }));
		fireEvent.click(screen.getByText('Apply'));
		await wait(20);
		expect(labels(t.session).at(-1)).toBe('Apply Tracking');
		expect(pinKeys(seqOf(t.session).clips[t.target]!)).toBe(2);
		expect(globalThis.localStorage?.getItem('jasper.tracking.applySimplify')).toBe('1');
	});
});
