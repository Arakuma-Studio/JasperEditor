// edit-ux: keyboard trim mode — Trim Edit / Select Nearest Edit Point, Toggle Trim Type, Trim Forward/Backward with
// counters, numeric entry, Extend Edit, dynamic J/K/L trimming committed as ONE undo step (FilmCraft trim_tests
// ported to our session gestures), Esc cancel, Play Around the Edit and Shift+D at edit points.
import { EngineClient } from '@jasper/engine-client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	type CommandCtx,
	createCommandContext,
	registerAllCommands,
	runCommand,
	type ToastRequest,
} from '../src/commands/index.ts';
import { registerTimelineInstance, type TimelineHandle } from '../src/panels/timeline/env.tsx';
import {
	activeDynamicTrim,
	DynamicTrim,
	dynamicShuttle,
	exitTrimMode,
	trimMode,
} from '../src/panels/timeline/state/trim-mode.ts';
import { setupTimeline, solid, videoAsset } from './timeline-helpers.ts';

const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });
beforeAll(() => registerAllCommands());

const offs: (() => void)[] = [];
afterEach(() => {
	for (const o of offs.splice(0)) o();
	exitTrimMode();
});

function harness() {
	const t = setupTimeline({ pxPerFrame: 4 });
	const toasts: ToastRequest[] = [];
	const ctx: CommandCtx = createCommandContext({
		engine,
		session: t.session,
		focus: { panel: 'timeline', instanceId: 'x' },
		toast: (r) => toasts.push(r),
	});
	const handle: TimelineHandle = {
		instanceId: 'x',
		controller: t.controller,
		ui: t.ui,
		sequenceId: () => t.seqId,
		cancelGesture: () => t.controller.cancel(),
	};
	offs.push(registerTimelineInstance(handle));
	const run = async (id: string, args?: unknown) => {
		const r = await runCommand(id, ctx, args);
		expect(r.ran, `${id}: ${r.reason}`).toBe(true);
	};
	// Two 100-frame solids that leave media-like handles: solids are unbounded, so trims are limited only by
	// neighbours and content time 0. The second starts 50 frames into its content (head handle).
	t.apply([solid(0, 100, 'V1'), solid(100, 150, 'V1')]);
	const second = t.clipsOn('V1')[1]!.id;
	t.apply([{ type: 'clip.trim', clipId: second, edge: 'in', deltaFrames: 50 }]);
	t.apply([{ type: 'clip.move', clipIds: [second], deltaFrames: -50 }]);
	expect(t.spans('V1')).toEqual([
		[0, 100],
		[100, 200],
	]);
	return { ...t, ctx, run, toasts, handle };
}

describe('trim mode commands', () => {
	it('Shift+T selects the nearest cut as a roll; Ctrl+T cycles Ripple → Roll → Trim', async () => {
		const h = harness();
		h.session.transport.seek(97);
		await h.run('timeline.trimEdit');
		const ep = h.ui.getState().editPoints;
		expect(ep).toHaveLength(1);
		expect(ep[0]).toMatchObject({ frame: 100, type: 'roll', side: 'out' });
		expect(trimMode.getState()).toMatchObject({ active: true, outShift: 0, inShift: 0 });
		// The playhead parks on the edit.
		expect(h.session.transport.getState().frame).toBe(100);
		await h.run('timeline.toggleTrimType');
		expect(h.ui.getState().editPoints[0]!.type).toBe('regular');
		await h.run('timeline.toggleTrimType');
		expect(h.ui.getState().editPoints[0]!.type).toBe('ripple');
		// Shift+T again in trim mode cycles too (Premiere).
		await h.run('timeline.trimEdit');
		expect(h.ui.getState().editPoints[0]!.type).toBe('roll');
	});

	it('trim keys move the edit, count the shift and coalesce into one History entry', async () => {
		const h = harness();
		h.session.transport.seek(100);
		await h.run('timeline.selectNearestEditRoll');
		const entries = h.history().length;
		await h.run('timeline.trimForward');
		await h.run('timeline.trimForwardMany');
		expect(h.spans('V1')).toEqual([
			[0, 106],
			[106, 200],
		]);
		expect(trimMode.getState()).toMatchObject({ outShift: 6, inShift: 6 });
		expect(h.ui.getState().editPoints[0]!.frame).toBe(106);
		expect(h.history().length).toBe(entries + 1);
		await h.run('timeline.trimByFrames', { frames: -10 });
		expect(h.spans('V1')[0]).toEqual([0, 96]);
		// Ripple In on the incoming clip: only the In counter moves.
		await h.run('timeline.selectNearestEditRippleIn');
		expect(trimMode.getState()).toMatchObject({ outShift: 0, inShift: 0 });
		await h.run('timeline.trimForward');
		expect(trimMode.getState()).toMatchObject({ outShift: 0, inShift: 1 });
		expect(h.spans('V1')).toEqual([
			[0, 96],
			[96, 199],
		]);
	});

	it('numeric entry via keypad +/− arms the Trim Monitor field; E extends the edit to the playhead', async () => {
		const h = harness();
		h.session.transport.seek(100);
		await h.run('timeline.selectNearestEditTrimOut');
		await h.run('timeline.trimNumericEntry', { sign: -1 });
		expect(trimMode.getState().numeric).toBe('-');
		h.session.transport.seek(80);
		await h.run('timeline.extendEditToPlayhead');
		expect(h.spans('V1')).toEqual([
			[0, 80],
			[100, 200],
		]);
		expect(h.history().at(-1)).toBe('Extend Edit');
	});

	it('without edit points the contextual trim keys fall through (disabled)', async () => {
		const h = harness();
		const r = await runCommand('timeline.trimBackMany', h.ctx);
		expect(r).toMatchObject({ ran: false, reason: 'disabled' });
	});

	it('Shift+D at the edit points applies the default transition at the cut', async () => {
		const h = harness();
		h.session.transport.seek(100);
		await h.run('timeline.selectNearestEditRoll');
		await h.run('timeline.applyDefaultTransitionsAtEditPoints');
		expect(Object.keys(h.seq().transitions)).toHaveLength(1);
	});
});

describe('dynamic trimming (FilmCraft trim_tests on a session gesture)', () => {
	function clockAt() {
		let now = 0;
		const raf = { request: () => 0, cancel: () => undefined };
		return { clock: () => now, set: (t: number) => (now = t), raf };
	}

	it('L rolls the edit live, K commits ONE undo step "Dynamic Rolling Edit"; undo restores', async () => {
		const h = harness();
		h.session.transport.seek(100);
		await h.run('timeline.selectNearestEditRoll');
		const c = clockAt();
		const entries = h.history().length;
		const d = dynamicShuttle(h.session, h.handle, h.seqId, 30, 1, false, { clock: c.clock, raf: c.raf })!;
		expect(d).toBeInstanceOf(DynamicTrim);
		c.set(0.5);
		d.tick();
		// Live: 15 frames in the drawn document, nothing committed, the playhead follows the edit.
		expect(h.session.getDrawn().sequences[h.seqId]!.clips[h.clipsOn('V1')[0]!.id]!.duration).toBe(115);
		expect(h.history().length).toBe(entries);
		expect(h.session.transport.getState().frame).toBe(115);
		expect(trimMode.getState()).toMatchObject({ outShift: 15, inShift: 15 });
		// L again doubles the speed.
		d.shuttle(1, false);
		c.set(1);
		d.tick();
		expect(trimMode.getState().dynamic).toMatchObject({ offset: 45, speed: 2 });
		const offset = d.commit();
		expect(offset).toBe(45);
		expect(h.spans('V1')).toEqual([
			[0, 145],
			[145, 200],
		]);
		expect(h.history().length).toBe(entries + 1);
		expect(h.history().at(-1)).toBe('Dynamic Rolling Edit');
		h.session.undo();
		expect(h.spans('V1')).toEqual([
			[0, 100],
			[100, 200],
		]);
	});

	it('J reverses; a ripple stops at a limit and holds; Esc cancels with nothing recorded', async () => {
		const h = harness();
		h.session.transport.seek(100);
		await h.run('timeline.selectNearestEditRippleOut');
		const c = clockAt();
		const entries = h.history().length;
		const d = dynamicShuttle(h.session, h.handle, h.seqId, 30, -1, false, { clock: c.clock, raf: c.raf })!;
		c.set(10);
		d.tick();
		// The outgoing clip can't get shorter than one frame.
		expect(trimMode.getState().dynamic).toMatchObject({ atLimit: true, speed: 0, offset: -99 });
		expect(h.session.getDrawn().sequences[h.seqId]!.clips[h.clipsOn('V1')[0]!.id]!.duration).toBe(1);
		// Esc (gesture.cancel) restores the edit and the counters, nothing in History.
		await h.run('gesture.cancel');
		expect(activeDynamicTrim()).toBeNull();
		expect(h.spans('V1')).toEqual([
			[0, 100],
			[100, 200],
		]);
		expect(h.history().length).toBe(entries);
		expect(trimMode.getState()).toMatchObject({ outShift: 0, inShift: 0 });
	});

	it('another command commits the dynamic trim first; slow (Shift+L) is quarter speed; K with no movement records nothing', async () => {
		const h = harness();
		h.session.transport.seek(100);
		await h.run('timeline.selectNearestEditRoll');
		const c = clockAt();
		const entries = h.history().length;
		const d = dynamicShuttle(h.session, h.handle, h.seqId, 30, 1, true, { clock: c.clock, raf: c.raf })!;
		c.set(2);
		d.tick();
		expect(trimMode.getState().dynamic).toMatchObject({ offset: 15, speed: 0.25 });
		await h.run('timeline.addMarker');
		expect(activeDynamicTrim()).toBeNull();
		expect(h.history().slice(entries)).toEqual(['Dynamic Rolling Edit', 'Add Marker']);
		const d2 = dynamicShuttle(h.session, h.handle, h.seqId, 30, 1, false, { clock: c.clock, raf: c.raf })!;
		expect(d2.commit()).toBe(0);
		expect(h.history().length).toBe(entries + 2);
	});

	it('J/K/L keys in trim mode drive the dynamic trim instead of the shuttle', async () => {
		const h = harness();
		h.session.transport.seek(100);
		await h.run('timeline.selectNearestEditRoll');
		await h.run('transport.shuttleForward');
		expect(activeDynamicTrim()).not.toBeNull();
		expect(h.session.transport.getState().playing).toBe(false);
		await h.run('transport.shuttleStop');
		expect(activeDynamicTrim()).toBeNull();
	});
});

describe('split edits through trim mode (J cut)', () => {
	it('a ripple trim of the clip before a J cut keeps the early sound with its picture', async () => {
		const h = harness();
		const m1 = (
			h.apply([{ type: 'media.register', asset: videoAsset(20) }]).results[0] as { mediaId: string }
		).mediaId;
		h.apply([
			{
				type: 'clip.place',
				source: { mediaId: m1 },
				at: 300,
				sourceRange: { in: { seconds: 1 }, out: { seconds: 3 } },
			},
			{
				type: 'clip.place',
				source: { mediaId: m1 },
				at: 360,
				tracks: { video: 'V1', audio: 'A2' },
				sourceRange: { in: { seconds: 5 }, out: { seconds: 7 } },
			},
		]);
		const sound = h.clipsOn('A2')[0]!;
		h.apply([{ type: 'clip.trim', clipId: sound.id, edge: 'in', deltaFrames: -12, linked: false }]);
		const s = h.seq();
		h.session.setView(h.seqId, {
			targeting: { video: [s.videoTracks[0]!.id], audio: [s.audioTracks[0]!.id] },
		});
		h.session.transport.seek(360);
		await h.run('timeline.selectNearestEditRippleOut');
		expect(h.ui.getState().editPoints.map((p) => p.frame)).toEqual([360, 360]);
		await h.run('timeline.trimForwardMany');
		expect(h.clipsOn('A2')[0]!.start).toBe(348 + 5);
		expect(h.clipsOn('V1').at(-1)!.start).toBe(365);
	});
});
