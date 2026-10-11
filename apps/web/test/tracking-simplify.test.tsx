import { type Clip, type Keyframe, SolidClipSchema } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplyTrackingDialog } from '../src/tracking/ApplyTrackingDialog.tsx';
import { addTracker, commitTrackResult } from '../src/tracking/actions.ts';
import { SimplifyKeyframesDialog } from '../src/tracking/SimplifyKeyframesDialog.tsx';
import { clipHasDenseKeys } from '../src/tracking/simplify-actions.ts';
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
	const keys: Keyframe<number>[] = [0, 1, 2].map((time) => ({
		id: `key_${time}`,
		time,
		value: time,
		interpolation: 'linear',
		easeIn: { influence: 1 / 3, slope: 1 },
		easeOut: { influence: 1 / 3, slope: 1 },
	}));

	it.each([null, {}, { keyframes: null }, { keyframes: 'future' }])(
		'ignores preserved non-animation transform data %j when checking keyframe density',
		(future) => {
			const { session, target } = trackingSession();
			const base = SolidClipSchema.parse(seqOf(session).clips[target]);
			const clip = SolidClipSchema.parse({ ...base, transform: { ...base.transform, future } });
			expect(clip.transform.future).toEqual(future);
			expect(clipHasDenseKeys(clip)).toBe(false);
			const animated = SolidClipSchema.parse({
				...clip,
				transform: { ...clip.transform, rotation: { value: 0, keyframes: keys } },
			});
			expect(clipHasDenseKeys(animated)).toBe(true);
		},
	);

	it('counts preserved animation fields alongside recognized transform parameters', () => {
		const { session, target } = trackingSession();
		const base = SolidClipSchema.parse(seqOf(session).clips[target]);
		const clip = SolidClipSchema.parse({
			...base,
			transform: {
				...base.transform,
				rotation: { value: 0, keyframes: keys.slice(0, 2) },
				future: { value: 0, keyframes: keys.slice(2) },
			},
		});
		expect(clipHasDenseKeys(clip)).toBe(true);
	});

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
