// Cue Seam commands and the peak handle (spec 12 §2.7): Add Sound Cue at the playhead, Next / Previous Cue, Convert
// Markers to Cues / Cue to Marker, Clear Unfilled Cues, Show Cue Seam, Fill (Sound Library Fill mode); the peak
// handle's drag (moves the clip so its peak snaps to a cue) and Shift-drag (soundDesign.setPeak); cue selection is
// pruned when cues go away.
import { EngineClient } from '@jasper/engine-client';
import {
	type AudioClip,
	type ClipSfx,
	FLICKS_PER_SECOND,
	type MediaAsset,
	type Sequence,
} from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	type CommandCtx,
	createCommandContext,
	registerAllCommands,
	runCommand,
	type ToastRequest,
} from '../src/commands/index.ts';
import { cueFillTarget, requestCueFill } from '../src/sound/controller.ts';
import { cuesOf } from '../src/sound/cues/model.ts';
import { PeakHandle } from '../src/sound/cues/PeakHandle.tsx';
import { cueSeamShownFor } from '../src/sound/cues/seam.ts';
import { makeSession, videoAsset } from './timeline-helpers.ts';

const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });
beforeAll(() => registerAllCommands());
afterEach(() => {
	cleanup();
	requestCueFill(null);
});

function harness() {
	const { session, seqId } = makeSession();
	const toasts: ToastRequest[] = [];
	const ctx: CommandCtx = createCommandContext({
		engine,
		session,
		focus: { panel: 'timeline', instanceId: 'x' },
		toast: (r) => toasts.push(r),
	});
	const run = async (id: string, args?: unknown) => {
		const r = await runCommand(id, ctx, args);
		expect(r.ran, `${id}: ${r.reason}`).toBe(true);
	};
	const apply = (commands: unknown[]) => {
		const r = session.apply({
			label: 'setup',
			origin: 'user',
			sequenceId: seqId,
			commands: commands as never[],
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r;
	};
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	const cues = () => cuesOf(seq());
	const labels = () => session.getState().history.entries.map((e) => e.label);
	return { session, seqId, ctx, run, apply, seq, cues, labels, toasts };
}

describe('cue commands', () => {
	it('Add Sound Cue adds a manual support cue at the playhead, selects it; undo / redo', async () => {
		const h = harness();
		h.session.transport.seek(42);
		await h.run('sound.addCue');
		expect(h.cues()).toMatchObject([{ frame: 42, kind: 'manual', weight: 'support', source: 'user' }]);
		expect(h.session.getState().selection.cues).toEqual([h.cues()[0]!.id]);
		expect(h.labels().at(-1)).toBe('Add Sound Cue');
		// agents give a frame
		await h.run('sound.addCue', { frame: 7 });
		expect(h.cues().map((c) => c.frame)).toEqual([7, 42]);
		h.session.undo();
		h.session.undo();
		expect(h.cues()).toEqual([]);
		h.session.redo();
		expect(h.cues().map((c) => c.frame)).toEqual([42]);
	});

	it('Next / Previous Cue seek and select; disabled past the last cue', async () => {
		const h = harness();
		h.apply([
			{
				type: 'soundCue.add',
				cues: [10, 20, 30].map((frame) => ({ frame, kind: 'cut', weight: 'support', source: 'user' })),
			},
		]);
		h.session.transport.seek(15);
		await h.run('sound.nextCue');
		expect(h.session.transport.getState().frame).toBe(20);
		await h.run('sound.prevCue');
		expect(h.session.transport.getState().frame).toBe(10);
		expect(h.session.getState().selection.cues).toEqual([h.cues()[0]!.id]);
		h.session.transport.seek(30);
		const r = await runCommand('sound.nextCue', h.ctx);
		expect(r.ran).toBe(false);
	});

	it('Convert Markers to Cues takes sfx and selected markers; Convert Cue to Marker goes back', async () => {
		const h = harness();
		h.apply([
			{ type: 'marker.add', frame: 30, name: 'sfx: whoosh+hit' },
			{ type: 'marker.add', frame: 60, name: 'Door', ref: '$d' },
			{ type: 'marker.add', frame: 90, name: 'ignored' },
		]);
		const door = h.seq().markers.find((m) => m.name === 'Door')!.id;
		h.session.select('markers', [door], 'replace');
		await h.run('sound.convertMarkersToCues');
		expect(h.seq().markers.map((m) => m.name)).toEqual(['ignored']);
		expect(h.cues().map((c) => [c.frame, c.types ?? null, c.label ?? null, c.source])).toEqual([
			[30, ['whoosh', 'hit'], null, 'marker'],
			[60, null, 'Door', 'marker'],
		]);
		expect(h.labels().at(-1)).toBe('Convert Markers to Cues (2)');
		h.session.select('cues', [h.cues()[0]!.id], 'replace');
		await h.run('sound.convertCueToMarker');
		expect(
			h
				.seq()
				.markers.map((m) => [m.frame, m.name])
				.sort(),
		).toEqual([
			[30, 'sfx: whoosh+hit'],
			[90, 'ignored'],
		]);
		expect(h.cues().map((c) => c.frame)).toEqual([60]);
		h.session.undo();
		expect(h.cues()).toHaveLength(2);
	});

	it('Clear Unfilled Cues removes cues without clips (one step); Show Cue Seam toggles the view', async () => {
		const h = harness();
		h.apply([
			{
				type: 'soundCue.add',
				cues: [1, 2].map((frame) => ({ frame, kind: 'cut', weight: 'support', source: 'user' })),
			},
		]);
		expect(cueSeamShownFor(h.session, h.seqId)).toBe(true); // automatic: the sequence has cues
		await h.run('sound.clearUnfilledCues');
		expect(h.cues()).toEqual([]);
		expect(h.labels().at(-1)).toBe('Clear Unfilled Cues (2)');
		expect(cueSeamShownFor(h.session, h.seqId)).toBe(false);
		await h.run('sound.toggleCueSeam');
		expect(h.session.getState().views[h.seqId]!.cueSeam).toBe('on');
		expect(cueSeamShownFor(h.session, h.seqId)).toBe(true);
		await h.run('sound.toggleCueSeam');
		expect(h.session.getState().views[h.seqId]!.cueSeam).toBe('off');
	});

	it('Fill enters the Sound Library Fill mode with the cue and its types; an unknown cue is an error', async () => {
		const h = harness();
		h.apply([
			{
				type: 'soundCue.add',
				cues: [{ frame: 30, kind: 'land', weight: 'hero', source: 'user', types: ['hit', 'thump'] }],
			},
		]);
		const id = h.cues()[0]!.id;
		await runCommand('soundLibrary.fillCue', h.ctx, { cueId: id });
		expect(cueFillTarget()).toMatchObject({
			sequenceId: h.seqId,
			cueId: id,
			types: ['hit', 'thump'],
			label: 'Hero Land cue at 00:00:01:00',
		});
		expect(h.session.getState().selection.cues).toEqual([id]);
		const bad = await runCommand('soundLibrary.fillCue', h.ctx, { cueId: 'cue_0000000000000000' });
		expect(bad).toMatchObject({ ran: false, reason: 'error' });
		expect(bad.error).toMatchObject({
			message: expect.stringContaining('cue_0000000000000000'),
		});
		expect(cueFillTarget()?.cueId).toBe(id);
	});

	it('the cue selection is pruned when its cues are removed (undo brings the cue, not the selection)', () => {
		const h = harness();
		h.apply([{ type: 'soundCue.add', cues: [{ frame: 1, kind: 'cut', weight: 'support', source: 'user' }] }]);
		const id = h.cues()[0]!.id;
		h.session.select('cues', [id], 'replace');
		h.apply([{ type: 'soundCue.remove', cueIds: [id] }]);
		expect(h.session.getState().selection.cues).toEqual([]);
	});
});

describe('peak handle', () => {
	function withLibraryClip() {
		const h = harness();
		const asset = {
			...videoAsset(1, true),
			kind: 'audio',
			probe: { ...videoAsset(1, true).probe, streams: [videoAsset(1, true).probe.streams[1]!] },
			library: {
				soundId: 'snd_0123456789abcdef',
				title: 'Crunch',
				types: ['hit'],
				source: { type: 'starter' },
				license: 'CC0-1.0',
				author: 'Kenney',
				attribution: null,
				descriptors: {
					peakSec: 0.25,
					onsetSec: 0.2,
					headQuietSec: 0.2,
					durationSec: 1,
					octaveBandsDb: [-30, -25, -20, -18, -19, -24, -33],
					centroidHz: 1800,
					maxMomentaryLufs: -14,
				},
				leadSilenceSec: 0.05,
			},
		} as unknown as Omit<MediaAsset, 'id'>;
		const r = h.apply([{ type: 'media.register', asset }]);
		const mediaId = (r.results[0] as { mediaId: string }).mediaId;
		const p = h.apply([
			{ type: 'clip.place', source: { mediaId }, at: 30, tracks: { audio: 'A1' }, video: false, ref: '$c' },
			{ type: 'soundCue.add', cues: [{ frame: 50, kind: 'land', weight: 'hero', source: 'user' }] },
		]);
		const clipId = p.refs.$c!;
		const clip = () => h.seq().clips[clipId] as AudioClip & { sfx?: ClipSfx };
		const view = () => (
			<SessionProvider session={h.session}>
				<PeakHandle
					clip={clip()}
					x={0}
					w={clip().duration * 10}
					height={40}
					viewportWidth={1000}
					scrollFrame={0}
					pxPerFrame={10}
					rate={h.seq().settings.frameRate}
					selected={false}
					trackLocked={false}
				/>
			</SessionProvider>
		);
		const ui = render(view());
		return { ...h, clipId, clip, rerender: () => ui.rerender(view()) };
	}

	it('dragging the diamond moves the clip so the peak snaps to a cue (one undo step)', () => {
		const h = withLibraryClip();
		const handle = document.querySelector(`[data-peak-handle="${h.clipId}"]`) as HTMLElement;
		// peak at 37.5 → its frame 37; +12.4 frames → 49.4, snaps to the cue at 50 (threshold 0.8 frame at 10 px/frame)
		fireEvent.pointerDown(handle, { clientX: 100, button: 0, pointerId: 1 });
		fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 });
		fireEvent.pointerMove(handle, { clientX: 230, pointerId: 1 });
		fireEvent.pointerUp(handle, { clientX: 230, pointerId: 1 });
		expect(h.clip().start).toBe(43);
		expect(h.labels().at(-1)).toBe('Move Clip by Peak');
		act(() => h.session.undo());
		expect(h.clip().start).toBe(30);
	});

	it('Shift-dragging sets the peak override (soundDesign.setPeak); the clip stays', () => {
		const h = withLibraryClip();
		const handle = document.querySelector(`[data-peak-handle="${h.clipId}"]`) as HTMLElement;
		fireEvent.pointerDown(handle, { clientX: 100, button: 0, pointerId: 1, shiftKey: true });
		fireEvent.pointerMove(handle, { clientX: 130, pointerId: 1, shiftKey: true });
		fireEvent.pointerUp(handle, { clientX: 130, pointerId: 1 });
		expect(h.clip().start).toBe(30);
		// 3 frames later = 0.35 s into the media
		expect(h.clip().sfx?.placement).toEqual({
			align: 'peak',
			peakFlicks: Math.round(0.35 * FLICKS_PER_SECOND),
			errorFlicks: 0,
		});
		expect(h.labels().at(-1)).toBe('Set Peak');
		act(() => h.session.undo());
		expect(h.clip().sfx).toBeUndefined();
	});
});
