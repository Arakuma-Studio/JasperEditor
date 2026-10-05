import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	type MediaAsset,
} from '@jasper/project';
import { defaultMediaRuntime, EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { monitorStores } from '../src/panels/program/monitor-store.ts';
import { ProgramMonitor } from '../src/panels/program/ProgramMonitor.tsx';
import { playerDurationFrames, resolveMediaHandle } from '../src/panels/program/render-doc.ts';
import { TransformOverlay } from '../src/panels/program/TransformOverlay.tsx';

function makeSession() {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'M', preset: 'hd-1080p-30' });
	const ctx = { ids, now: () => 't', registries: defaultRegistries() };
	const { document } = applyTransaction(
		doc,
		{
			label: 'setup',
			origin: 'user',
			commands: [
				{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [0, 0, 1, 1] },
				{
					type: 'clip.addText',
					at: 0,
					duration: 60,
					track: 'V2',
					content: { text: 'Title' },
					box: { autoSize: 'none', width: 400, height: 200 },
				},
			],
		},
		{ ...ctx, revision: 0 },
	);
	const session = new EditorSession({ projectId: document.projectId, document, ctx });
	const seqId = session.getState().activeSequenceId!;
	const text = Object.values(session.getCommitted().sequences[seqId]!.clips).find((c) => c.kind === 'text')!;
	return { session, seqId, textId: text.id };
}

const snapshot = (session: EditorSession, seqId: string) =>
	buildRenderSnapshot(session.getDrawn(), seqId, { resolveMedia: () => null, resolveFont: () => null });

function position(session: EditorSession, seqId: string, id: string): number[] {
	return (
		session.getCommitted().sequences[seqId]!.clips[id] as unknown as {
			transform: { position: { value: number[] } };
		}
	).transform.position.value;
}

afterEach(() => cleanup());

describe('Program monitor', () => {
	it('shows the active sequence timecode and duration', () => {
		const { session } = makeSession();
		const { getByTestId } = render(
			<SessionProvider session={session}>
				<ProgramMonitor instanceId="program-1" visible />
			</SessionProvider>,
		);
		expect(getByTestId('program-timecode').textContent).toBe('00:00:00:00');
		act(() => session.transport.seek(45));
		expect(getByTestId('program-timecode').textContent).toBe('00:00:01:15');
		expect(getByTestId('program-duration').textContent).toBe('00:00:02:00');
	});

	it('makes one undo step per move / rotate drag and undo restores the exact values (AC-XF-3)', async () => {
		const { session, seqId, textId } = makeSession();
		monitorStores.program.setState({ snapInMonitor: false });
		session.select('timeline', [textId]);
		const view = { scale: 0.5, x: 0, y: 0 };
		const ui = (doc = snapshot(session, seqId)) => (
			<TransformOverlay
				session={session}
				doc={doc}
				view={view}
				viewport={{ width: 960, height: 540 }}
				transport={session.transport}
				monitor={monitorStores.program.getState()}
				onPan={() => {}}
			/>
		);
		const { getByTestId, rerender } = render(ui());
		expect(getByTestId('overlay-selection').getAttribute('data-clip-id')).toBe(textId);
		const svg = getByTestId('program-overlay');
		const before = session.getState().history.entries.length;
		// move: drag the layer body 50 screen px right = 100 sequence px
		// (the anchor crosshair sits at the center, so grab the body off-center)
		fireEvent.pointerDown(svg, { clientX: 430, clientY: 250, button: 0, pointerId: 1 });
		fireEvent.pointerMove(svg, { clientX: 450, clientY: 250, pointerId: 1 });
		fireEvent.pointerMove(svg, { clientX: 480, clientY: 250, pointerId: 1 });
		fireEvent.pointerUp(svg, { clientX: 480, clientY: 250, pointerId: 1 });
		expect(position(session, seqId, textId)).toEqual([1060, 540]);
		expect(session.getState().history.entries.length).toBe(before + 1);
		rerender(ui());
		// rotate: grab 10 px outside the top-right corner and sweep around the anchor
		fireEvent.pointerDown(svg, { clientX: 638, clientY: 212, button: 0, pointerId: 2 });
		fireEvent.pointerMove(svg, { clientX: 530, clientY: 200, pointerId: 2 });
		fireEvent.pointerUp(svg, { clientX: 530, clientY: 200, pointerId: 2 });
		const rotated = session.getCommitted().sequences[seqId]!.clips[textId] as unknown as {
			transform: { rotation: { value: number } };
		};
		expect(rotated.transform.rotation.value).not.toBe(0);
		expect(session.getState().history.entries.length).toBe(before + 2);
		session.undo();
		const undone = session.getCommitted().sequences[seqId]!.clips[textId] as unknown as {
			transform: { rotation: { value: number } };
		};
		expect(undone.transform.rotation.value).toBe(0);
		session.undo();
		expect(position(session, seqId, textId)).toEqual([960, 540]);
	});

	it('Esc cancels a drag without a history entry', async () => {
		const { session, seqId, textId } = makeSession();
		session.select('timeline', [textId]);
		const { getByTestId } = render(
			<TransformOverlay
				session={session}
				doc={snapshot(session, seqId)}
				view={{ scale: 0.5, x: 0, y: 0 }}
				viewport={{ width: 960, height: 540 }}
				transport={session.transport}
				monitor={monitorStores.program.getState()}
				onPan={() => {}}
			/>,
		);
		const svg = getByTestId('program-overlay');
		const before = session.getState().history.entries.length;
		fireEvent.pointerDown(svg, { clientX: 430, clientY: 250, button: 0, pointerId: 1 });
		fireEvent.pointerMove(svg, { clientX: 560, clientY: 300, pointerId: 1 });
		await waitFor(() => expect(session.getDrawn()).not.toEqual(session.getCommitted()));
		fireEvent.keyDown(window, { key: 'Escape' });
		fireEvent.pointerUp(svg, { clientX: 560, clientY: 300, pointerId: 1 });
		expect(session.getState().history.entries.length).toEqual(before);
		expect(position(session, seqId, textId)).toEqual([960, 540]);
		expect(session.getState().transient).toBeNull();
	});

	it('Type tool click creates a text clip at the playhead and selects it (XF-060)', () => {
		const { session, seqId } = makeSession();
		session.setToggles({ activeTool: 'type' });
		session.transport.seek(20);
		const { getByTestId } = render(
			<TransformOverlay
				session={session}
				doc={snapshot(session, seqId)}
				view={{ scale: 0.5, x: 0, y: 0 }}
				viewport={{ width: 960, height: 540 }}
				transport={session.transport}
				monitor={monitorStores.program.getState()}
				onPan={() => {}}
			/>,
		);
		fireEvent.pointerDown(getByTestId('program-overlay'), {
			clientX: 100,
			clientY: 50,
			button: 0,
			pointerId: 1,
		});
		const created = session.getState().selection.timeline.clips[0]!;
		const clip = session.getCommitted().sequences[seqId]!.clips[created]!;
		expect(clip.kind).toBe('text');
		expect(clip.start).toBe(20);
		expect(position(session, seqId, created)).toEqual([200, 100]);
		expect(session.getState().toggles.activeTool).toBe('selection');
	});
});

describe('media resolution for the Player (ARCHITECTURE §8)', () => {
	const asset = {
		id: 'med_1',
		kind: 'video',
		locators: [{ type: 'engine-store', engineId: 'e', key: 'mk_1' }],
		probe: {
			durationFlicks: 5 * FLICKS_PER_SECOND,
			rotationDegrees: 90,
			streams: [{ type: 'video', width: 1920, height: 1080 }, { type: 'audio' }],
		},
	} as unknown as MediaAsset;

	it('uses /media/<key>, the proxy when ready, upright size, offline → null', () => {
		const h = resolveMediaHandle(asset, undefined)!;
		expect(h).toMatchObject({
			url: '/media/mk_1',
			proxyUrl: null,
			width: 1080,
			height: 1920,
			hasAudio: true,
		});
		const ready = {
			...defaultMediaRuntime(),
			availability: 'online' as const,
			proxy: { state: 'ready' as const, progress: 1 },
		};
		expect(resolveMediaHandle(asset, ready, { proxyTier: '540' })!.proxyUrl).toBe('/media/mk_1/proxy/540');
		expect(resolveMediaHandle(asset, { ...ready, availability: 'offline' })).toBeNull();
	});

	it('sizes the Player to end + 1 frame, or 10 s when empty', () => {
		const { session, seqId } = makeSession();
		expect(playerDurationFrames(session.getCommitted(), seqId)).toBe(61);
		const ids = createCounterIdSource(1);
		const empty = createEmptyProject({ ids, name: 'E', preset: 'hd-1080p-25' });
		expect(playerDurationFrames(empty, Object.keys(empty.sequences)[0]!)).toBe(250);
	});
});
