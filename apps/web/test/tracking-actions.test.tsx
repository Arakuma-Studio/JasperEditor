import { buildRenderSnapshot, type ClipTracker, type Quad } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	addTracker,
	applyTracking,
	commitTrackResult,
	handleEngineEvent,
	startTrack,
	stopTrack,
} from '../src/tracking/actions.ts';
import { setOptions, trackingStore } from '../src/tracking/store.ts';
import { TrackingOverlay } from '../src/tracking/TrackingOverlay.tsx';
import { fakeEngine, labels, planarResult, seqOf, trackingSession } from './tracking-helpers.tsx';

const REF: Quad = [
	[700, 300],
	[1300, 320],
	[1280, 700],
	[690, 680],
];

const trackerOf = (session: ReturnType<typeof trackingSession>['session'], plate: string, id: string) =>
	(seqOf(session).clips[plate] as { trackers?: ClipTracker[] }).trackers!.find((t) => t.id === id)!;

const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(() => trackingStore.setState(trackingStore.getInitialState(), true));
afterEach(() => cleanup());

describe('tracking actions', () => {
	it('runs Track Forward: request body, live progress, one "Track" entry with the samples', async () => {
		const { session, plate } = trackingSession();
		const engine = fakeEngine();
		const id = addTracker(session, plate, 'planar');
		const jobId = await startTrack(session, engine, id, 'forward');
		expect(jobId).toBeTruthy();
		const body = engine.calls[0]!.body;
		expect(engine.calls[0]!.name).toBe('trackingTrack');
		expect(body).toMatchObject({
			mediaKey: 'mk_plate',
			kind: 'planar',
			trackerId: id,
			direction: 'forward',
			quality: 'balanced',
			range: { startFrame: 0, endFrame: 60 },
			options: { features: 'inside', refineEdges: true },
		});
		expect(body.projectId).toBe(session.projectId);
		handleEngineEvent(session, engine, {
			id: 1,
			createdAt: 'x',
			type: 'tracking.progress',
			payload: {
				jobId,
				trackerId: id,
				mediaKey: 'mk_plate',
				frame: 12,
				data: REF.flat(),
				confidence: 0.7,
				done: 12,
				total: 60,
			},
		});
		const run = trackingStore.getState().running[id]!;
		expect(run.progress).toMatchObject({ done: 12, total: 60, confidence: 0.7 });
		expect(run.trail).toHaveLength(1);
		expect(session.transport.getState().frame).toBe(12);
		expect(labels(session)).toEqual(['Add Planar Tracker']);
		const job = engine.finish(jobId!, planarResult(0, 60, REF, id));
		handleEngineEvent(session, engine, { id: 2, createdAt: 'x', type: 'job.finished', payload: job });
		handleEngineEvent(session, engine, { id: 3, createdAt: 'x', type: 'job.finished', payload: job });
		await tick();
		expect(labels(session)).toEqual(['Add Planar Tracker', 'Track']);
		const t = trackerOf(session, plate, id);
		expect(t.samples?.data).toHaveLength(60 * 8);
		expect(t.samples?.start).toBe(0);
		expect(trackingStore.getState().running[id]).toBeUndefined();
	});

	it('passes the planar options and quality', async () => {
		const { session, plate } = trackingSession();
		const engine = fakeEngine();
		const id = addTracker(session, plate, 'planar');
		setOptions(id, 'planar', { quality: 'best', surroundings: true, refineEdges: false });
		await startTrack(session, engine, id, 'both');
		expect(engine.calls[0]!.body).toMatchObject({
			quality: 'best',
			direction: 'both',
			options: { features: 'surroundings', refineEdges: false },
		});
	});

	it('re-tracks from here and re-applies to the linked target inside the same "Track" entry', async () => {
		const { session, plate, target } = trackingSession();
		const engine = fakeEngine();
		const id = addTracker(session, plate, 'planar');
		commitTrackResult(session, id, { step: 705_600_000 / 30, merge: 'replace' }, planarResult(0, 60, REF));
		applyTracking(session, id, target, 'corner-pin');
		expect(labels(session)).toEqual(['Add Planar Tracker', 'Track', 'Apply Tracking']);
		const pinKeys = () => {
			const fx = (
				seqOf(session).clips[target] as {
					effects: {
						effectId: string;
						params: Record<string, { keyframes: { time: number; value: number[] }[] }>;
					}[];
				}
			).effects.find((e) => e.effectId === 'jasper.corner-pin')!;
			return fx.params.topLeft!.keyframes;
		};
		expect(pinKeys()).toHaveLength(30);
		const before = pinKeys().map((k) => k.value[0]);
		session.transport.seek(20);
		const jobId = await startTrack(session, engine, id, 'from-here');
		expect(engine.calls[0]!.body).toMatchObject({
			direction: 'forward',
			range: { startFrame: 20, endFrame: 60 },
		});
		const shifted = planarResult(20, 40, REF.map((p) => [p[0] + 100, p[1]]) as Quad);
		const job = engine.finish(jobId!, shifted);
		handleEngineEvent(session, engine, { id: 1, createdAt: 'x', type: 'job.finished', payload: job });
		await tick();
		expect(labels(session)).toEqual(['Add Planar Tracker', 'Track', 'Apply Tracking', 'Track']);
		const after = pinKeys().map((k) => k.value[0]);
		expect(after).toHaveLength(30);
		expect(after.slice(0, 20)).toEqual(before.slice(0, 20));
		expect(after[25]! - before[25]!).toBeCloseTo(100 / 1920, 6);
		session.undo();
		expect(pinKeys().map((k) => k.value[0])).toEqual(before);
	});

	it('stops a job without committing', async () => {
		const { session, plate } = trackingSession();
		const engine = fakeEngine();
		const id = addTracker(session, plate, 'planar');
		const jobId = await startTrack(session, engine, id, 'forward');
		await stopTrack(engine, id);
		expect(engine.cancelled).toEqual([jobId]);
		expect(trackingStore.getState().running[id]).toBeUndefined();
		handleEngineEvent(session, engine, {
			id: 1,
			createdAt: 'x',
			type: 'job.finished',
			payload: engine.finish(jobId!, planarResult(0, 60, REF)),
		});
		await tick();
		expect(labels(session)).toEqual(['Add Planar Tracker']);
	});

	it('reports engine errors on the tracker', async () => {
		const { session, plate } = trackingSession();
		const engine = fakeEngine();
		const id = addTracker(session, plate, 'planar');
		engine.next = 'not-implemented';
		await expect(startTrack(session, engine, id, 'forward')).rejects.toThrow(/not available/);
		expect(trackingStore.getState().errors[id]).toMatch(/not available/);
		engine.next = 'queue';
		const jobId = await startTrack(session, engine, id, 'forward');
		handleEngineEvent(session, engine, {
			id: 1,
			createdAt: 'x',
			type: 'job.finished',
			payload: engine.finish(jobId!, null, 'failed'),
		});
		await tick();
		expect(trackingStore.getState().errors[id]).toBe('Lost the surface');
		expect(labels(session)).toEqual(['Add Planar Tracker']);
	});

	it('finishes by polling when no event arrives', async () => {
		const { session, plate } = trackingSession();
		const engine = fakeEngine();
		const id = addTracker(session, plate, 'planar');
		const jobId = await startTrack(session, engine, id, 'forward');
		engine.finish(jobId!, planarResult(0, 60, REF));
		await act(async () => void (await new Promise((r) => setTimeout(r, 900))));
		expect(labels(session)).toEqual(['Add Planar Tracker', 'Track']);
	});
});

describe('tracking overlay', () => {
	function mount(session: ReturnType<typeof trackingSession>['session'], seqId: string) {
		const doc = buildRenderSnapshot(session.getDrawn(), seqId, {
			resolveMedia: () => null,
			resolveFont: () => null,
		});
		const view = { scale: 0.5, x: 0, y: 0 };
		const utils = render(
			<SessionProvider session={session}>
				<TrackingOverlay
					session={session}
					doc={doc}
					view={view}
					viewport={{ width: 960, height: 540 }}
					transport={session.transport}
					monitor={{}}
				/>
			</SessionProvider>,
		);
		return utils;
	}

	async function drag(el: Element, from: [number, number], to: [number, number]) {
		fireEvent.pointerDown(el, { button: 0, clientX: from[0], clientY: from[1], pointerId: 1 });
		for (let i = 1; i <= 3; i++) {
			const x = from[0] + ((to[0] - from[0]) * i) / 3;
			const y = from[1] + ((to[1] - from[1]) * i) / 3;
			fireEvent.pointerMove(window, { clientX: x, clientY: y, pointerId: 1 });
			await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
		}
		fireEvent.pointerUp(window, { clientX: to[0], clientY: to[1], pointerId: 1 });
	}

	it('drags an edge (two corners) and the body (all corners), one entry each', async () => {
		const { session, plate, seqId } = trackingSession();
		const id = addTracker(session, plate, 'planar');
		session.select('timeline', [plate], 'replace', { linked: false });
		const { getByTestId } = mount(session, seqId);
		await drag(getByTestId('tracker-edge-0'), [480, 162], [480, 152]);
		let t = trackerOf(session, plate, id);
		expect(t.reference.corners!.map((p) => p[1])).toEqual([304, 304, 756, 756]);
		await drag(getByTestId('tracker-body'), [480, 270], [490, 270]);
		t = trackerOf(session, plate, id);
		expect(t.reference.corners!.map((p) => p[0])).toEqual([596, 1364, 1364, 596]);
		expect(labels(session)).toEqual(['Add Planar Tracker', 'Adjust Tracker', 'Adjust Tracker']);
	});
});
