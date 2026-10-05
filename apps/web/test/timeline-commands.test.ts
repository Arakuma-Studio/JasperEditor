// Timeline UI commands (S02:TL-903) against a real session: targeting, playhead trims, In/Out,
// lift/extract, markers, selection, nudges. Acceptance: AC-8c, AC-11d, AC-13a, AC-13b, AC-13d,
// AC-15a/b, AC-16b.
import { EngineClient } from '@jasper/engine-client';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	type CommandCtx,
	createCommandContext,
	registerAllCommands,
	runCommand,
	type ToastRequest,
} from '../src/commands/index.ts';
import { setupTimeline, solid, videoAsset } from './timeline-helpers.ts';

const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });

beforeAll(() => registerAllCommands());

function harness(opts: Parameters<typeof setupTimeline>[0] = {}) {
	const t = setupTimeline(opts);
	const toasts: ToastRequest[] = [];
	const ctx: CommandCtx = createCommandContext({
		engine,
		session: t.session,
		focus: { panel: 'timeline', instanceId: 'x' },
		toast: (r) => toasts.push(r),
	});
	const run = async (id: string) => {
		const r = await runCommand(id, ctx);
		expect(r.ran, `${id}: ${r.reason}`).toBe(true);
	};
	const target = (labels: string[]) => {
		const s = t.seq();
		const ids = (k: 'V' | 'A') =>
			labels
				.filter((l) => l[0] === k)
				.map((l) => (k === 'V' ? s.videoTracks : s.audioTracks)[Number(l.slice(1)) - 1]!.id);
		t.session.setView(t.seqId, { targeting: { video: ids('V'), audio: ids('A') } });
	};
	const movie = (at: number) => {
		const r = t.apply([{ type: 'media.register', asset: videoAsset(20) }]);
		const mediaId = (r.results[0] as { mediaId: string }).mediaId;
		const p = t.apply([
			{
				type: 'clip.place',
				source: { mediaId },
				at,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 10 } },
			},
		]);
		return (p.results[0] as { clipIds: string[] }).clipIds;
	};
	return { ...t, ctx, run, toasts, target, movie };
}

describe('Add Edit and targeting (TL-680, AC-13a)', () => {
	it('AC-13a: with V1 and A1 targeted, Ctrl+K at 240 splits only V1/A1 clips crossing 240', async () => {
		const h = harness();
		h.movie(0);
		h.apply([solid(0, 400, 'V2')]);
		h.target(['V1', 'A1']);
		h.session.transport.seek(240);
		await h.run('timeline.addEdit');
		expect(h.spans('V1')).toEqual([
			[0, 240],
			[240, 300],
		]);
		expect(h.spans('A1')).toEqual([
			[0, 240],
			[240, 300],
		]);
		expect(h.spans('V2')).toEqual([[0, 400]]);
	});

	it('with a selection only the selected clips crossing the playhead split; Ctrl+Shift+K splits all', async () => {
		const h = harness();
		h.apply([solid(0, 400, 'V1'), solid(0, 400, 'V2')]);
		h.session.select('timeline', [h.clipsOn('V2')[0]!.id], 'replace');
		h.session.transport.seek(100);
		await h.run('timeline.addEdit');
		expect(h.spans('V1')).toEqual([[0, 400]]);
		expect(h.spans('V2')).toEqual([
			[0, 100],
			[100, 400],
		]);
		h.session.transport.seek(200);
		await h.run('timeline.addEditAllTracks');
		expect(h.spans('V1')).toEqual([
			[0, 200],
			[200, 400],
		]);
		expect(h.spans('V2')).toEqual([
			[0, 100],
			[100, 200],
			[200, 400],
		]);
	});
});

describe('Delete, ripple delete, gaps (TL-681/682/741, AC-13b, AC-16b)', () => {
	it('AC-13b: ripple delete with content on a sync-locked track is refused with a message naming the track', async () => {
		const h = harness();
		h.apply([solid(0, 100, 'V1'), solid(100, 100, 'V1'), solid(20, 30, 'V2')]);
		h.session.select('timeline', [h.clipsOn('V1')[0]!.id], 'replace');
		await h.run('timeline.rippleDelete');
		expect(h.spans('V1')).toHaveLength(2);
		expect(h.toasts.at(-1)?.detail).toContain('V2');
		h.apply([{ type: 'track.update', trackId: 'V2', patch: { syncLock: false } }]);
		await h.run('timeline.rippleDelete');
		expect(h.spans('V1')).toEqual([[0, 100]]);
	});

	it('AC-16b: ripple-deleting a 30-frame clip before a marker moves it 30 frames left', async () => {
		const h = harness();
		h.apply([solid(0, 30, 'V1'), solid(30, 100, 'V1'), { type: 'marker.add', frame: 90 }]);
		h.session.select('timeline', [h.clipsOn('V1')[0]!.id], 'replace');
		await h.run('timeline.rippleDelete');
		expect(h.seq().markers[0]!.frame).toBe(60);
		h.session.setToggles({ rippleMarkers: false });
		h.session.select('timeline', [h.clipsOn('V1')[0]!.id], 'replace');
		await h.run('timeline.rippleDelete');
		expect(h.seq().markers[0]!.frame).toBe(60);
	});

	it('Delete with a gap selected closes the gap; Delete with clips leaves gaps', async () => {
		const h = harness();
		h.apply([solid(0, 50, 'V1'), solid(100, 50, 'V1')]);
		const trackId = h.seq().videoTracks[0]!.id;
		h.session.selectGaps([{ trackId, start: 50, end: 100 }]);
		await h.run('timeline.clear');
		expect(h.spans('V1')).toEqual([
			[0, 50],
			[50, 100],
		]);
		h.session.select('timeline', [h.clipsOn('V1')[0]!.id], 'replace');
		await h.run('timeline.clear');
		expect(h.spans('V1')).toEqual([[50, 100]]);
	});

	it('edit.clear (global Delete / Edit ▸ Clear) routes to the focused panel', async () => {
		const h = harness();
		h.apply([solid(0, 50, 'V1')]);
		h.session.select('timeline', [h.clipsOn('V1')[0]!.id], 'replace');
		await h.run('edit.clear');
		expect(h.spans('V1')).toEqual([]);
		const other = createCommandContext({
			engine,
			session: h.session,
			focus: { panel: 'info', instanceId: 'i' },
			toast: () => undefined,
		});
		expect((await runCommand('edit.clear', other)).ran).toBe(false);
	});
});

describe('playhead trims (TL-549, AC-11d)', () => {
	it('AC-11d: Q removes the head, closes the gap, moves the playhead to the old start; undo restores exactly', async () => {
		const h = harness();
		h.apply([solid(0, 100, 'V1'), solid(100, 100, 'V1')]);
		const before = h.session.getCommitted();
		h.session.transport.seek(130);
		await h.run('timeline.rippleTrimPrevToPlayhead');
		expect(h.spans('V1')).toEqual([
			[0, 100],
			[100, 170],
		]);
		expect(h.session.transport.getState().frame).toBe(100);
		h.session.undo();
		expect(h.session.getCommitted()).toEqual(before);
	});

	it('W ripple-removes [playhead, end); Alt+Q / Alt+W leave gaps', async () => {
		const h = harness();
		h.apply([solid(0, 100, 'V1'), solid(100, 100, 'V1')]);
		h.session.transport.seek(40);
		await h.run('timeline.rippleTrimNextToPlayhead');
		expect(h.spans('V1')).toEqual([
			[0, 40],
			[40, 140],
		]);
		h.session.transport.seek(60);
		await h.run('timeline.trimPrevToPlayhead');
		expect(h.spans('V1')).toEqual([
			[0, 40],
			[60, 140],
		]);
		h.session.transport.seek(100);
		await h.run('timeline.trimNextToPlayhead');
		expect(h.spans('V1')).toEqual([
			[0, 40],
			[60, 100],
		]);
	});

	it('linked partners follow once; nothing under the playhead is a hinted no-op', async () => {
		const h = harness();
		h.movie(0);
		h.session.transport.seek(30);
		await h.run('timeline.rippleTrimPrevToPlayhead');
		expect(h.spans('V1')).toEqual([[0, 270]]);
		expect(h.spans('A1')).toEqual([[0, 270]]);
		h.session.transport.seek(5000);
		const before = h.session.getCommitted();
		const entries = h.history().length;
		await h.run('timeline.rippleTrimPrevToPlayhead');
		expect(h.session.getCommitted()).toEqual(before);
		expect(h.history()).toHaveLength(entries);
	});

	it('E extends the selected edit point to the playhead with its trim type', async () => {
		const h = harness({ pxPerFrame: 4 });
		h.apply([solid(0, 100, 'V1'), solid(100, 100, 'V1')]);
		// Select the edit point by clicking the edge (TL-547), switch to roll with Shift+T.
		h.controller.pointerDown(h.pt(h.x(100) - 1, h.rowY('V1')));
		h.controller.pointerUp(h.pt(h.x(100) - 1, h.rowY('V1')));
		const handle = {
			instanceId: 'x',
			controller: h.controller,
			ui: h.ui,
			sequenceId: () => h.seqId,
			cancelGesture: () => h.controller.cancel(),
		};
		const { registerTimelineInstance } = await import('../src/panels/timeline/env.tsx');
		const off = registerTimelineInstance(handle);
		await h.run('timeline.cycleTrimType');
		expect(h.ui.getState().editPoints[0]!.type).toBe('roll');
		h.session.transport.seek(120);
		await h.run('timeline.extendEditToPlayhead');
		expect(h.spans('V1')).toEqual([
			[0, 120],
			[120, 200],
		]);
		await h.run('timeline.trimBack');
		expect(h.spans('V1')).toEqual([
			[0, 119],
			[119, 200],
		]);
		off();
	});
});

describe('In/Out, lift and extract (TL-690…766, AC-13d, AC-15a/b)', () => {
	it('AC-15a/b: I at 100 and O at 199 give a 100-frame range; undo after O restores the previous Out', async () => {
		const h = harness();
		h.session.transport.seek(100);
		await h.run('timeline.markIn');
		h.session.transport.seek(199);
		await h.run('timeline.markOut');
		expect([h.seq().inPoint, h.seq().outPoint]).toEqual([100, 200]);
		h.session.transport.seek(250);
		await h.run('timeline.markOut');
		expect(h.seq().outPoint).toBe(251);
		h.session.undo();
		expect(h.seq().outPoint).toBe(200);
		// Marking In after Out clears Out (TL-760).
		h.session.transport.seek(300);
		await h.run('timeline.markIn');
		expect([h.seq().inPoint, h.seq().outPoint]).toEqual([300, null]);
	});

	it('AC-13d: Extract with In=100 Out=199 removes exactly 100 frames and clears In/Out', async () => {
		const h = harness();
		h.apply([solid(0, 300, 'V1'), solid(50, 300, 'V2'), { type: 'sequence.setInOut', in: 100, out: 200 }]);
		h.target(['V1']);
		await h.run('timeline.extract');
		expect(h.spans('V1')).toEqual([
			[0, 100],
			[100, 200],
		]);
		expect(h.spans('V2')).toEqual([
			[50, 100],
			[100, 250],
		]);
		expect([h.seq().inPoint, h.seq().outPoint]).toEqual([null, null]);
		expect(h.session.transport.getState().frame).toBe(100);
	});

	it('Lift without In/Out is a hinted no-op', async () => {
		const h = harness();
		h.apply([solid(0, 300, 'V1')]);
		const before = h.session.getCommitted();
		const entries = h.history().length;
		await h.run('timeline.lift');
		expect(h.session.getCommitted()).toEqual(before);
		expect(h.history()).toHaveLength(entries);
	});

	it('Mark Clip and Mark Selection', async () => {
		const h = harness();
		h.apply([solid(10, 50, 'V1'), solid(100, 20, 'V1')]);
		h.session.transport.seek(20);
		await h.run('timeline.markClip');
		expect([h.seq().inPoint, h.seq().outPoint]).toEqual([10, 60]);
		h.session.select(
			'timeline',
			h.clipsOn('V1').map((c) => c.id),
			'replace',
		);
		await h.run('timeline.markSelection');
		expect([h.seq().inPoint, h.seq().outPoint]).toEqual([10, 120]);
	});
});

describe('selection, nudge, markers, navigation', () => {
	it('AC-8c: Ctrl+A never selects clips on locked tracks', async () => {
		const h = harness();
		h.apply([
			solid(0, 50, 'V1'),
			solid(0, 50, 'V2'),
			{ type: 'track.update', trackId: 'V2', patch: { locked: true } },
		]);
		await h.run('timeline.selectAll');
		expect(h.session.getState().selection.timeline.clips).toEqual([h.clipsOn('V1')[0]!.id]);
	});

	it('nudges coalesce into one history entry and clamp at frame 0', async () => {
		const h = harness();
		h.apply([solid(3, 50, 'V1')]);
		h.session.select('timeline', [h.clipsOn('V1')[0]!.id], 'replace');
		const n = h.history().length;
		await h.run('timeline.nudgeRight');
		await h.run('timeline.nudgeRightMany');
		expect(h.spans('V1')).toEqual([[9, 59]]);
		expect(h.history()).toHaveLength(n + 1);
		for (let i = 0; i < 4; i++) await h.run('timeline.nudgeLeftMany');
		expect(h.spans('V1')).toEqual([[0, 50]]);
	});

	it('D selects the clip at the playhead on targeted tracks', async () => {
		const h = harness();
		h.apply([solid(0, 50, 'V1'), solid(0, 50, 'V2')]);
		h.target(['V2']);
		h.session.transport.seek(10);
		await h.run('timeline.selectClipAtPlayhead');
		expect(h.session.getState().selection.timeline.clips).toEqual([h.clipsOn('V2')[0]!.id]);
	});

	it('markers: M adds at the playhead; Shift+M / Ctrl+Shift+M navigate', async () => {
		const h = harness();
		h.apply([solid(0, 500, 'V1')]);
		for (const f of [30, 90]) {
			h.session.transport.seek(f);
			await h.run('timeline.addMarker');
		}
		expect(h.seq().markers.map((m) => m.frame)).toEqual([30, 90]);
		h.session.transport.seek(0);
		await h.run('timeline.nextMarker');
		expect(h.session.transport.getState().frame).toBe(30);
		await h.run('timeline.nextMarker');
		expect(h.session.transport.getState().frame).toBe(90);
		await h.run('timeline.prevMarker');
		expect(h.session.transport.getState().frame).toBe(30);
		await h.run('timeline.clearMarker');
		expect(h.seq().markers.map((m) => m.frame)).toEqual([90]);
	});

	it('gesture.cancel with nothing active deselects', async () => {
		const h = harness();
		h.apply([solid(0, 50, 'V1')]);
		h.session.select('timeline', [h.clipsOn('V1')[0]!.id], 'replace');
		await h.run('gesture.cancel');
		expect(h.session.getState().selection.timeline.clips).toEqual([]);
	});
});
