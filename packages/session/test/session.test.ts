import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
} from '@jasper/project';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutosaver, EditorSession, MemoryProjectStore, TransportStore } from '../src/index.ts';

function setup() {
	const ids = createCounterIdSource(1);
	const store = new MemoryProjectStore({ ids, now: () => '2026-09-30T10:00:00.000Z' });
	const doc = createEmptyProject({ ids, name: 'S', preset: 'hd-1080p-30' });
	store.put(doc);
	const ctx = { ids, now: () => '2026-09-30T10:00:00.000Z', registries: defaultRegistries() };
	return {
		ids,
		store,
		doc,
		ctx,
		open: (sessionId = 's1') => EditorSession.open({ store, projectId: doc.projectId, ctx, sessionId }),
	};
}

const solid = (at: number, track = 'V1') => ({
	type: 'clip.addSolid' as const,
	at,
	duration: 30,
	track,
	color: [1, 0, 0, 1] as [number, number, number, number],
});
const clipIds = (doc: ProjectDocument) =>
	Object.values(Object.values(doc.sequences)[0]!.clips).map((c) => c.id);

describe('EditorSession history (S01 §17)', () => {
	it('AC-12: undo right after opening and one change returns to the opened state; redo reapplies; selection restored', async () => {
		const { open } = setup();
		const s = await open();
		s.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		const opened = s.getCommitted();
		const [id] = clipIds(opened);
		s.select('timeline', [id!]);
		const selBefore = s.getState().selection;
		s.apply({
			label: 'Move Clip',
			origin: 'user',
			commands: [{ type: 'clip.move', clipIds: [id!], deltaFrames: 10 }],
		});
		s.select('timeline', []);
		const after = s.getCommitted();
		expect(s.getState().history.entries.map((e) => e.label)).toEqual(['Add', 'Move Clip']);
		expect(s.undo().ok).toBe(true);
		expect(s.getCommitted()).toBe(opened);
		expect(s.getState().selection.timeline.clips).toEqual(selBefore.timeline.clips);
		expect(s.getState().selection.timeline.primaryClip).toBe(id);
		expect(s.redo().ok).toBe(true);
		expect(s.getCommitted()).toBe(after);
		expect(s.getState().selection.timeline.clips).toEqual([id]);
		expect(s.undo().ok && s.undo().ok).toBe(true);
		expect(clipIds(s.getCommitted())).toEqual([]);
		expect(s.undo().ok).toBe(false);
	});

	it('a new commit after undo discards the redo stack (UND-005)', async () => {
		const s = await setup().open();
		s.apply({ label: 'A', origin: 'user', commands: [solid(0)] });
		s.apply({ label: 'B', origin: 'user', commands: [solid(100)] });
		s.undo();
		expect(s.getState().history.canRedo).toBe(true);
		s.apply({ label: 'C', origin: 'user', commands: [solid(200)] });
		expect(s.getState().history.canRedo).toBe(false);
		expect(s.getState().history.entries.map((e) => e.label)).toEqual(['A', 'C']);
		expect(s.redo().ok).toBe(false);
	});

	it('labels agent entries "Agent: …" and lets agents undo only their own top entry (UND-007/008)', async () => {
		const s = await setup().open();
		const flashes: string[][] = [];
		s.on('agent.flash', (e) => flashes.push(e.clipIds));
		s.apply({ label: 'Add title', origin: { agent: 'bot' }, commands: [solid(0)] });
		expect(s.getState().history.entries[0]!.label).toBe('Agent: Add title');
		expect(flashes).toHaveLength(1);
		s.apply({ label: 'User edit', origin: 'user', commands: [solid(100)] });
		expect(s.undo({ agent: 'bot' })).toEqual({ ok: false, code: 'E_NOT_OWNER' });
		s.undo();
		expect(s.undo({ agent: 'bot' }).ok).toBe(true);
	});

	it('coalesces repeated nudges with the same key within 750 ms (UND-006)', async () => {
		let now = 1000;
		const { store, doc, ctx } = setup();
		const s = new EditorSession({
			projectId: doc.projectId,
			document: (await store.open(doc.projectId)).document,
			ctx,
			clock: () => now,
		});
		s.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		const [id] = clipIds(s.getCommitted());
		const nudge = () =>
			s.apply({
				label: 'Nudge',
				origin: 'user',
				coalesceKey: `nudge:${id}`,
				commands: [{ type: 'clip.move', clipIds: [id!], deltaFrames: 1 }],
			});
		nudge();
		now += 300;
		nudge();
		now += 300;
		nudge();
		expect(s.getState().history.entries.map((e) => e.label)).toEqual(['Add', 'Nudge']);
		now += 2000;
		nudge();
		expect(s.getState().history.entries.map((e) => e.label)).toEqual(['Add', 'Nudge', 'Nudge']);
		s.undo();
		s.undo();
		expect(Object.values(Object.values(s.getCommitted().sequences)[0]!.clips)[0]!.start).toBe(0);
	});

	it('refuses writes in read-only sessions and when the lease is held elsewhere (PER-040)', async () => {
		const { open } = setup();
		const a = await open('a');
		const b = await open('b');
		expect(a.getState().lease.status).toBe('held');
		expect(b.getState().readOnly).toBe(true);
		const r = b.apply({ label: 'x', origin: 'user', commands: [solid(0)] });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0]!.code).toBe('E_NOT_OWNER');
		await a.close();
	});
});

describe('gestures (S01:SES-006, AC-13)', () => {
	afterEach(() => vi.useRealTimers());

	it('AC-13: 120 pointer moves make exactly one undo entry and no autosave during the drag', async () => {
		vi.useFakeTimers();
		const { open, store } = setup();
		const s = await open();
		const autosave = createAutosaver(s, store);
		s.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		await vi.advanceTimersByTimeAsync(2000);
		expect(store.saveCount).toBe(1);
		const [id] = clipIds(s.getCommitted());
		const base = s.getCommitted();
		const g = s.beginGesture('Move Clip');
		for (let i = 1; i <= 120; i++) {
			const r = g.update([{ type: 'clip.move', clipIds: [id!], deltaFrames: i }]);
			expect(r.ok).toBe(true);
			expect(s.getCommitted()).toBe(base);
			expect(Object.values(Object.values(s.getDrawn().sequences)[0]!.clips)[0]!.start).toBe(i);
			await vi.advanceTimersByTimeAsync(50);
		}
		expect(store.saveCount).toBe(1);
		g.commit();
		expect(s.getState().transient).toBeNull();
		expect(s.getState().history.entries.map((e) => e.label)).toEqual(['Add', 'Move Clip']);
		expect(Object.values(Object.values(s.getCommitted().sequences)[0]!.clips)[0]!.start).toBe(120);
		await vi.advanceTimersByTimeAsync(1600);
		expect(store.saveCount).toBe(2);
		autosave.dispose();
	});

	it('AC-13: Esc (cancel) during a drag leaves no entry and restores the drawn document', async () => {
		const s = await setup().open();
		s.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		const [id] = clipIds(s.getCommitted());
		const committed = s.getCommitted();
		const g = s.beginGesture('Move Clip');
		g.update([{ type: 'clip.move', clipIds: [id!], deltaFrames: 40 }]);
		expect(s.getDrawn()).not.toBe(committed);
		g.cancel();
		expect(s.getDrawn()).toBe(committed);
		expect(s.getState().history.entries).toHaveLength(1);
		expect(g.active).toBe(false);
	});

	it('queues agent transactions during a gesture and applies them after it ends (SES-006)', async () => {
		const s = await setup().open();
		s.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		const [id] = clipIds(s.getCommitted());
		const g = s.beginGesture('Trim');
		g.update([{ type: 'clip.trim', clipId: id!, edge: 'out', deltaFrames: -10 }]);
		expect(s.apply({ label: 'direct', origin: { agent: 'bot' }, commands: [solid(200)] }).ok).toBe(false);
		let resolved = false;
		const pending = s
			.submit({ label: 'Add marker', origin: { agent: 'bot' }, commands: [{ type: 'marker.add', frame: 5 }] })
			.then((r) => {
				resolved = true;
				return r;
			});
		await Promise.resolve();
		expect(resolved).toBe(false);
		expect(Object.values(s.getCommitted().sequences)[0]!.markers).toHaveLength(0);
		g.commit();
		const r = await pending;
		expect(r.ok).toBe(true);
		expect(s.getState().history.entries.map((e) => e.label)).toEqual(['Add', 'Trim', 'Agent: Add marker']);
		expect(Object.values(Object.values(s.getCommitted().sequences)[0]!.clips)[0]!.duration).toBe(20);
	});

	it('a gesture without updates commits nothing', async () => {
		const s = await setup().open();
		const g = s.beginGesture('Nothing');
		expect(g.commit()).toBeNull();
		expect(s.getState().history.entries).toHaveLength(0);
		expect(() => g.update([])).toThrow();
	});
});

describe('selection, views, runtime, transport', () => {
	it('linked selection expands to link partners and drops deleted ids (SEL-002/004)', async () => {
		const { open, store, doc } = setup();
		const s = await open();
		const asset = {
			kind: 'video',
			fingerprint: 'q1:aa',
			originalName: 'a.mp4',
			sizeBytes: 1,
			container: 'mov,mp4',
			probe: {
				durationFlicks: 705_600_000 * 2,
				startTimecode: null,
				rotationDegrees: 0,
				hasAlpha: false,
				variableFrameRate: false,
				streams: [
					{
						index: 0,
						type: 'video',
						codec: 'h264',
						width: 1920,
						height: 1080,
						pixelAspect: { num: 1, den: 1 },
						frameRate: { num: 30, den: 1 },
						pixelFormat: 'yuv420p',
						bitDepth: 8,
						color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
						browserDecodable: true,
					},
					{ index: 1, type: 'audio', codec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo' },
				],
			},
			locators: [],
		};
		const r = s.apply({
			label: 'Import',
			origin: 'user',
			commands: [
				{ type: 'media.register', asset, ref: '$m' } as never,
				{ type: 'clip.place', source: { mediaId: '$m' }, at: 0 },
			],
		});
		expect(r.ok).toBe(true);
		const ids = clipIds(s.getCommitted());
		s.select('timeline', [ids[0]!]);
		expect(s.getState().selection.timeline.clips.sort()).toEqual([...ids].sort());
		s.select('timeline', [ids[0]!], 'replace', { linked: false });
		expect(s.getState().selection.timeline.clips).toEqual([ids[0]]);
		s.apply({ label: 'Clear', origin: 'user', commands: [{ type: 'clip.lift', clipIds: [ids[0]!] }] });
		expect(s.getState().selection.timeline.clips).toEqual([]);
		s.setView(Object.keys(doc.sequences)[0]!, { pxPerFrame: 7 });
		expect(s.viewRecord().views[Object.keys(doc.sequences)[0]!]).toMatchObject({ pxPerFrame: 7 });
		s.setMediaRuntime('med_x', { availability: 'online', playbackUrl: '/media/mk_1' });
		expect(s.getState().media.med_x!.proxy.state).toBe('none');
		expect(store.saveCount).toBe(0);
	});

	it('TransportStore drives an attached player and notifies listeners', () => {
		const t = new TransportStore();
		const player = { seekTo: vi.fn(), play: vi.fn(), pause: vi.fn(), setPlaybackRate: vi.fn() };
		const seen: number[] = [];
		t.subscribe((s, p) => {
			if (s.frame !== p.frame) seen.push(s.frame);
		});
		t.attachPlayer(player);
		t.seek(10);
		expect(player.seekTo).toHaveBeenLastCalledWith(10);
		t.play(2);
		expect(player.setPlaybackRate).toHaveBeenCalledWith(2);
		t.reportFrame(11);
		t.seek(12); // playing: the Player is the clock, no seekTo
		expect(player.seekTo).toHaveBeenCalledTimes(2);
		t.pause();
		t.step(-20);
		expect(t.getState().frame).toBe(0);
		expect(seen).toEqual([10, 11, 12, 0]);
	});
});

describe('selectAfter (S01:SEL-006/008, wp-clipboard)', () => {
	it('selects the result of a transaction and records it as the history "after" selection', async () => {
		const { open } = setup();
		const s = await open();
		s.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		const [first] = clipIds(s.getCommitted());
		s.select('timeline', [first!]);
		const r = s.apply({
			label: 'Paste',
			origin: 'user',
			commands: [solid(100, 'V2')],
			selectAfter: (res) => ({ timeline: res.created.filter((id) => id.startsWith('clp_')) }),
		});
		expect(r.ok).toBe(true);
		const pasted = clipIds(s.getCommitted()).filter((id) => id !== first);
		expect(s.getState().selection.timeline).toMatchObject({ clips: pasted, primaryClip: pasted[0] });
		s.undo();
		expect(s.getState().selection.timeline.clips).toEqual([first]);
		s.redo();
		expect(s.getState().selection.timeline.clips).toEqual(pasted);
	});
});
