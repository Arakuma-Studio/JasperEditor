// S10 §8 tests 1–3 and 6: timeline transition geometry and hit-testing, gesture → command mapping through
// the TimelineController, drop resolution with handle feedback, and the Ctrl+D family.

import { EngineClient } from '@jasper/engine-client';
import { type Sequence, transitionSpec } from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCommandContext, registerAllCommands, runCommand } from '../src/commands/index.ts';
import { resetTransitionDefaults, setDefaultTransition } from '../src/panels/effects/transition-prefs.ts';
import { hitTest } from '../src/panels/timeline/model/hit.ts';
import {
	bodyDragAlignment,
	dropCommand,
	edgeDrag,
	hitTransition,
	nearestEditPoint,
	resolveTransitionDrop,
	transitionIndex,
	transitionRect,
} from '../src/panels/timeline/model/transitions.ts';
import { setupTimeline, videoAsset } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());

type T = ReturnType<typeof setupTimeline>;

/**
 * Two adjacent video clips with linked audio, cut at frame 120: A = media 2 s…6 s (tail handle 420 frames),
 * B = media `bIn` s…`bIn`+4 s (head handle `bIn`·30 frames).
 */
function cut(t: T, bIn = 2) {
	const reg = (s: number) =>
		(t.apply([{ type: 'media.register', asset: videoAsset(s) }]).results[0] as { mediaId: string }).mediaId;
	const a = reg(20);
	const b = reg(20);
	const r = t.apply([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 0,
			sourceRange: { in: { seconds: 2 }, out: { seconds: 6 } },
		},
		{
			type: 'clip.place',
			source: { mediaId: b },
			at: 120,
			sourceRange: { in: { seconds: bIn }, out: { seconds: bIn + 4 } },
		},
	]);
	const [va, aa] = (r.results[0] as { clipIds: string[] }).clipIds as [string, string];
	const [vb, ab] = (r.results[1] as { clipIds: string[] }).clipIds as [string, string];
	return { va, aa, vb, ab };
}

function addAt(t: T, cmd: Record<string, unknown>) {
	const r = t.apply([{ type: 'transition.add', effectId: 'jasper.cross-dissolve', ref: '$t', ...cmd }]);
	return r.refs.$t!;
}

const seqOf = (t: T) => t.seq() as Sequence;
const index = (t: T) => transitionIndex(seqOf(t), t.session.getCommitted().media);
const geomOf = (t: T, id: string) => [...index(t).values()].flat().find((g) => g.t.id === id)!;
const v1 = (t: T) => t.geometry().layout.video.rows.find((r) => r.index === 0)!;

describe('geometry (S10 §8 test 1, TUI-001/003)', () => {
	it('spans for every alignment, one- and two-sided, and px rects at several zoom levels', () => {
		const t = setupTimeline({ pxPerFrame: 10 });
		const { va, vb } = cut(t);
		const centre = addAt(t, { trackId: 'V1', at: 120, duration: 12 });
		expect(geomOf(t, centre)).toMatchObject({ cut: 120, start: 114, end: 126, oneSided: null });
		t.apply([{ type: 'transition.update', transitionId: centre, alignment: 'start-at-cut' }]);
		expect(geomOf(t, centre)).toMatchObject({ start: 120, end: 132 });
		t.apply([{ type: 'transition.update', transitionId: centre, alignment: 'end-at-cut' }]);
		expect(geomOf(t, centre)).toMatchObject({ start: 108, end: 120 });
		const fadeIn = addAt(t, { clipId: va, edge: 'in', duration: 10 });
		const fadeOut = addAt(t, { clipId: vb, edge: 'out', duration: 15 });
		expect(geomOf(t, fadeIn)).toMatchObject({ start: 0, end: 10, oneSided: 'in', cut: 0 });
		expect(geomOf(t, fadeOut)).toMatchObject({ start: 225, end: 240, oneSided: 'out', cut: 240 });
		for (const pxPerFrame of [0.1, 1, 10, 48]) {
			const v = { scrollFrame: 100, pxPerFrame, width: 1000 };
			const r = transitionRect(geomOf(t, centre), v, 48);
			expect(r.x).toBeCloseTo((108 - 100) * pxPerFrame, 9);
			expect(r.w).toBeCloseTo(12 * pxPerFrame, 9);
			expect(r.top).toBe(14); // below the name strip
			expect(r.top + r.height).toBeLessThanOrEqual(48 - 1 - 2); // inset 2 px above the row bottom
		}
	});

	it('marks the side whose media handle is used up with a cap (TUI-003)', () => {
		const t = setupTimeline();
		cut(t, 0.5); // B has 15 frames before its in-point
		const id = addAt(t, { trackId: 'V1', at: 120, duration: 30 });
		const g = geomOf(t, id);
		expect(g.handles.head).toBe(15);
		expect(g).toMatchObject({ start: 105, end: 135, capStart: true, capEnd: false });
	});

	it('is cached on the transitions record identity and stable across unrelated state', () => {
		const t = setupTimeline();
		cut(t);
		addAt(t, { trackId: 'V1', at: 120, duration: 12 });
		const a = index(t);
		t.session.transport.seek(50);
		expect(index(t)).toBe(a);
	});

	it('hit priority: transition edge → body → clip edge → clip body; tiny transitions stay selectable', () => {
		const t = setupTimeline({ pxPerFrame: 10 });
		const { vb } = cut(t);
		const id = addAt(t, { trackId: 'V1', at: 120, duration: 20 }); // 110…130
		const { layout, viewport } = t.geometry();
		const row = v1(t);
		const y = row.y + 20; // inside the transition band
		const idx = index(t);
		const at = (x: number) => hitTest(seqOf(t), layout, viewport, x, y, idx);
		const h1 = at(t.x(110) + 1);
		expect(h1.kind === 'transition' && h1.transition.zone).toBe('start');
		const h2 = at(t.x(130) - 1);
		expect(h2.kind === 'transition' && h2.transition.zone).toBe('end');
		const h3 = at(t.x(120));
		expect(h3.kind === 'transition' && h3.transition.zone).toBe('body');
		if (h3.kind === 'transition') expect(h3.under.kind).toBe('clip');
		expect(at(t.x(150)).kind).toBe('clip');
		// Above the band (the name strip) the clip edge stays reachable (TUI-010).
		const top = hitTest(seqOf(t), layout, viewport, t.x(120) + 1, row.y + 3, idx);
		expect(top.kind === 'clip' && top.clip.id === vb && top.zone).toBe('in');
		// At 0.1 px/frame a 20-frame transition is 2 px wide: the 3 px minimum hit width keeps it selectable.
		const v = { scrollFrame: 0, pxPerFrame: 0.1, width: 1000 };
		const tiny = hitTransition(idx, row, v, 12.9, 20);
		expect(tiny?.geom.t.id).toBe(id);
		expect(tiny?.zone).toBe('body');
	});
});

describe('gesture → command mapping (S10 §8 test 2, TUI-012…015)', () => {
	it('pure mapping: centred symmetric, Alt asymmetric to at-cut, at-cut and fades', () => {
		const g = { cut: 100, start: 94, end: 106, oneSided: null, t: { alignment: 'center' as const } };
		expect(edgeDrag(g, 'end', 110, false)).toEqual({ duration: 20, alignment: 'center' });
		expect(edgeDrag(g, 'start', 90, false)).toEqual({ duration: 20, alignment: 'center' });
		expect(edgeDrag(g, 'start', 100, true)).toEqual({ duration: 6, alignment: 'start-at-cut' });
		expect(edgeDrag(g, 'end', 99, true)).toEqual({ duration: 6, alignment: 'end-at-cut' });
		expect(edgeDrag(g, 'end', 103, true)).toEqual({ duration: 6, alignment: 'center' }); // snaps back
		const s = { cut: 100, start: 100, end: 112, oneSided: null, t: { alignment: 'start-at-cut' as const } };
		expect(edgeDrag(s, 'end', 130, false)).toEqual({ duration: 30, alignment: 'start-at-cut' });
		const e = { cut: 100, start: 88, end: 100, oneSided: null, t: { alignment: 'end-at-cut' as const } };
		expect(edgeDrag(e, 'start', 70, false)).toEqual({ duration: 30, alignment: 'end-at-cut' });
		const fin = {
			cut: 0,
			start: 0,
			end: 10,
			oneSided: 'in' as const,
			t: { alignment: 'start-at-cut' as const },
		};
		expect(edgeDrag(fin, 'end', 25, false).duration).toBe(25);
		const fout = {
			cut: 50,
			start: 40,
			end: 50,
			oneSided: 'out' as const,
			t: { alignment: 'end-at-cut' as const },
		};
		expect(edgeDrag(fout, 'start', 45, false).duration).toBe(5);
		expect(bodyDragAlignment({ cut: 100, start: 94, end: 106 }, 0)).toBe('center');
		expect(bodyDragAlignment({ cut: 100, start: 94, end: 106 }, 5)).toBe('start-at-cut');
		expect(bodyDragAlignment({ cut: 100, start: 94, end: 106 }, -4)).toBe('end-at-cut');
		expect(bodyDragAlignment({ cut: 100, start: 94, end: 106 }, 2)).toBe('center');
	});

	it('edge drag of a centred dissolve: symmetric, one "Transition Duration" entry', () => {
		const t = setupTimeline({ pxPerFrame: 10 });
		t.session.setToggles({ snapping: false });
		cut(t);
		const id = addAt(t, { trackId: 'V1', at: 120, duration: 20 });
		const before = t.history().length;
		const y = v1(t).y + 20;
		t.drag(t.x(130) - 1, y, t.x(135) - 1, y);
		expect(seqOf(t).transitions[id]).toMatchObject({ duration: 30, alignment: 'center' });
		expect(t.history().length).toBe(before + 1);
		expect(t.history().at(-1)).toBe('Transition Duration');
		expect(t.session.getState().selection.timeline.transitions).toEqual([id]);
	});

	it('Alt-dragging the start edge onto the cut makes it start-at-cut', () => {
		const t = setupTimeline({ pxPerFrame: 10 });
		t.session.setToggles({ snapping: false });
		cut(t);
		const id = addAt(t, { trackId: 'V1', at: 120, duration: 20 });
		const y = v1(t).y + 20;
		t.drag(t.x(110) + 1, y, t.x(121) + 1, y, { alt: true });
		expect(seqOf(t).transitions[id]).toMatchObject({ duration: 10, alignment: 'start-at-cut' });
	});

	it('clamps to the media handles live with fitTransitionDuration and says so', () => {
		const t = setupTimeline({ pxPerFrame: 10 });
		t.session.setToggles({ snapping: false });
		cut(t, 0.5); // 15 frames before B's in-point
		const id = addAt(t, { trackId: 'V1', at: 120, duration: 20 });
		const y = v1(t).y + 20;
		t.drag(t.x(130) - 1, y, t.x(150), y, {}, false);
		const tip = t.ui.getState().tooltip!.lines;
		expect(tip[0]).toBe('Duration 00:00:01:01 (31)');
		expect(tip).toContain('Limited by media handles');
		expect(t.ui.getState().transitionGhost?.missing.length).toBeGreaterThan(0);
		t.controller.pointerUp(t.pt(t.x(150), y));
		expect(seqOf(t).transitions[id]!.duration).toBe(31);
		expect(t.ui.getState().transitionGhost).toBeNull();
	});

	it('snaps the dragged edge to the playhead', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		cut(t);
		const id = addAt(t, { trackId: 'V1', at: 120, duration: 10, alignment: 'start-at-cut' }); // 120…130
		t.session.transport.seek(140);
		const y = v1(t).y + 20;
		t.drag(t.x(130) - 1, y, t.x(137) - 1, y, {}, false); // raw 137: 6 px from the playhead
		expect(t.ui.getState().snapFrame).toBe(140);
		t.controller.pointerUp(t.pt(t.x(137) - 1, y));
		expect(seqOf(t).transitions[id]!.duration).toBe(20);
	});

	it('body drag snaps the alignment (one "Transition Alignment" entry); Esc cancels with none', () => {
		const t = setupTimeline({ pxPerFrame: 10 });
		cut(t);
		const id = addAt(t, { trackId: 'V1', at: 120, duration: 20 });
		const y = v1(t).y + 20;
		const before = t.history().length;
		t.drag(t.x(120), y, t.x(128), y);
		expect(seqOf(t).transitions[id]).toMatchObject({ alignment: 'start-at-cut', duration: 20 });
		expect(t.history().slice(before)).toEqual(['Transition Alignment']);
		const doc = t.session.getCommitted();
		t.drag(t.x(130), y, t.x(110), y, {}, false);
		expect(t.session.getDrawn()).not.toBe(doc);
		expect(t.controller.cancel()).toBe(true);
		expect(t.session.getDrawn()).toBe(doc);
		t.controller.pointerUp(t.pt(t.x(110), y));
		expect(t.history().length).toBe(before + 1);
		// A drag that ends where it started records nothing.
		t.drag(t.x(130), y, t.x(131), y);
		expect(t.history().length).toBe(before + 1);
	});

	it('click selects (clearing clips), Shift toggles; selecting a clip clears transitions', () => {
		const t = setupTimeline({ pxPerFrame: 10 });
		const { va } = cut(t);
		const id = addAt(t, { trackId: 'V1', at: 120, duration: 20 });
		const fade = addAt(t, { clipId: va, edge: 'in', duration: 10 });
		const y = v1(t).y + 20;
		t.session.select('timeline', [va], 'replace');
		t.drag(t.x(120), y, t.x(120), y);
		expect(t.session.getState().selection.timeline).toMatchObject({ clips: [], transitions: [id] });
		t.drag(t.x(5), y, t.x(5), y, { shift: true });
		expect(t.session.getState().selection.timeline.transitions).toEqual([id, fade]);
		t.drag(t.x(60), y, t.x(60), y);
		expect(t.session.getState().selection.timeline.transitions).toEqual([]);
	});

	it('Delete removes the selected transitions in one entry; with none selected it clears clips as before', async () => {
		const t = setupTimeline({ pxPerFrame: 10 });
		const { va } = cut(t);
		const id = addAt(t, { trackId: 'V1', at: 120, duration: 20 });
		const fade = addAt(t, { clipId: va, edge: 'in', duration: 10 });
		t.session.select('transitions', [id, fade], 'replace');
		const ctx = createCommandContext({ engine: new EngineClient({ baseUrl: '' }), session: t.session });
		const before = t.history().length;
		await runCommand('timeline.clear', ctx);
		expect(seqOf(t).transitions).toEqual({});
		expect(t.history().slice(before)).toEqual(['Clear Transitions']);
		t.session.undo();
		expect(Object.keys(seqOf(t).transitions).sort()).toEqual([id, fade].sort());
		t.session.select('transitions', [], 'replace');
		t.session.select('timeline', [va], 'replace', { linked: false });
		await runCommand('timeline.clear', ctx);
		expect(seqOf(t).clips[va]).toBeUndefined();
	});
});

describe('drop resolution (S10 §8 test 3, TUI-021…024)', () => {
	const drop = (
		t: T,
		x: number,
		effectId = 'jasper.cross-dissolve',
		wanted = 30,
		kind: 'video' | 'audio' = 'video',
	) => {
		const seq = seqOf(t);
		const trackId = (kind === 'video' ? seq.videoTracks : seq.audioTracks)[0]!.id;
		return resolveTransitionDrop({
			seq,
			media: t.session.getCommitted().media,
			trackId,
			trackKind: kind,
			spec: transitionSpec(effectId)!,
			v: t.geometry().viewport,
			x,
			over: null,
			wanted,
		});
	};

	it('maps the ±12 px band around a cut in thirds and free edges to fades', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		const { va, vb } = cut(t);
		const x = t.x(120);
		expect(drop(t, x - 10)).toMatchObject({ kind: 'add', cut: 120, alignment: 'end-at-cut', oneSided: null });
		expect(drop(t, x)).toMatchObject({ alignment: 'center' });
		expect(drop(t, x + 2)).toMatchObject({ alignment: 'center' });
		expect(drop(t, x + 10)).toMatchObject({ alignment: 'start-at-cut' });
		const head = drop(t, t.x(0) + 5);
		expect(head).toMatchObject({ cut: 0, oneSided: 'in' });
		const tail = drop(t, t.x(240) - 3);
		expect(tail).toMatchObject({ cut: 240, oneSided: 'out' });
		// Elsewhere on a clip: its nearer edge (over the incoming clip → start-at-cut at its head).
		expect(drop(t, t.x(140))).toMatchObject({ cut: 120, alignment: 'start-at-cut' });
		expect(drop(t, t.x(100))).toMatchObject({ cut: 120, alignment: 'end-at-cut' });
		expect(drop(t, t.x(30))).toMatchObject({ cut: 0, oneSided: 'in' });
		// Commands.
		expect(dropCommand(drop(t, x)!, 'jasper.cross-dissolve')).toEqual({
			type: 'transition.add',
			trackId: seqOf(t).videoTracks[0]!.id,
			at: 120,
			effectId: 'jasper.cross-dissolve',
			alignment: 'center',
			duration: 30,
		});
		expect(dropCommand(head!, 'jasper.dip-to-black')).toMatchObject({ clipId: va, edge: 'in' });
		expect(dropCommand(tail!, 'jasper.dip-to-black')).toMatchObject({ clipId: vb, edge: 'out' });
		// Wrong medium: no target.
		expect(drop(t, x, 'jasper.constant-power')).toBeNull();
		expect(drop(t, x, 'jasper.constant-power', 30, 'audio')).toMatchObject({ cut: 120, oneSided: null });
	});

	it('reports handle availability and refuses when nothing fits', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		cut(t, 0.5); // 15 frames before B
		const d = drop(t, t.x(120) - 10); // end-at-cut, 30 wanted: all before the cut
		if (d?.kind !== 'add') throw new Error('expected an add target');
		expect(d.feedback.fittedDuration).toBe(15);
		expect(d.feedback.fitted).toEqual({ start: 105, end: 120 });
		expect(d.feedback.bands).toEqual([{ start: 105, end: 120 }]);
		expect(d.feedback.missing).toEqual([{ start: 90, end: 105 }]);
		expect(d.refused).toBeNull();
		// No handles at all → refused with the model's explanation.
		const t2 = setupTimeline({ pxPerFrame: 2 });
		cut(t2, 0);
		const r = drop(t2, t2.x(120) - 10);
		expect(r?.refused).toMatch(/incoming clip 30 before its in-point/);
		// A centred dip to black needs no handles.
		expect(drop(t2, t2.x(120), 'jasper.dip-to-black')?.refused).toBeNull();
	});

	it('an existing transition under the pointer is replaced (same medium)', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		cut(t);
		const id = addAt(t, { trackId: 'V1', at: 120, duration: 20 });
		const g = geomOf(t, id);
		const seq = seqOf(t);
		const target = resolveTransitionDrop({
			seq,
			media: t.session.getCommitted().media,
			trackId: seq.videoTracks[0]!.id,
			trackKind: 'video',
			spec: transitionSpec('jasper.dip-to-black')!,
			v: t.geometry().viewport,
			x: t.x(120),
			over: g,
			wanted: 30,
		});
		expect(target).toMatchObject({ kind: 'replace', refused: null });
		expect(dropCommand(target!, 'jasper.dip-to-black')).toEqual({
			type: 'transition.update',
			transitionId: id,
			effectId: 'jasper.dip-to-black',
		});
	});
});

describe('keyboard: Ctrl+D family (S10 §8 test 6, TUI-030)', () => {
	const ctxOf = (t: T) =>
		createCommandContext({ engine: new EngineClient({ baseUrl: '' }), session: t.session });
	const kinds = (t: T) => {
		const seq = seqOf(t);
		return Object.values(seq.transitions).map((x) => ({
			video: seq.videoTracks.some((v) => v.id === x.trackId),
			two: !!x.outgoingClipId && !!x.incomingClipId,
			effectId: x.effectId,
		}));
	};

	it('Ctrl+D with two clips selected: edges of both, two-sided at the cut, one entry', async () => {
		resetTransitionDefaults();
		const t = setupTimeline();
		const { va, vb } = cut(t);
		t.session.select('timeline', [va, vb], 'replace'); // linked selection adds the audio
		const before = t.history().length;
		await runCommand('timeline.applyDefaultVideoTransition', ctxOf(t));
		expect(t.history().slice(before)).toEqual(['Apply Video Transition']);
		const k = kinds(t);
		expect(k).toHaveLength(3);
		expect(k.every((x) => x.video && x.effectId === 'jasper.cross-dissolve')).toBe(true);
		expect(k.filter((x) => x.two)).toHaveLength(1);
	});

	it('Ctrl+Shift+D adds audio transitions with the default audio transition; Shift+D both', async () => {
		resetTransitionDefaults();
		const t = setupTimeline();
		const { va, vb } = cut(t);
		t.session.select('timeline', [va, vb], 'replace');
		const before = t.history().length;
		await runCommand('timeline.applyDefaultAudioTransition', ctxOf(t));
		expect(t.history().slice(before)).toEqual(['Apply Audio Transition']);
		expect(kinds(t).every((x) => !x.video && x.effectId === 'jasper.constant-power')).toBe(true);
		expect(kinds(t)).toHaveLength(3); // fade in, crossfade at the cut, fade out
		t.session.undo();
		setDefaultTransition('jasper.dip-to-black');
		await runCommand('timeline.applyDefaultTransitionsToSelection', ctxOf(t));
		expect(t.history().slice(before)).toEqual(['Apply Default Transitions']);
		expect(kinds(t)).toHaveLength(6);
		expect(
			kinds(t)
				.filter((x) => x.video)
				.every((x) => x.effectId === 'jasper.dip-to-black'),
		).toBe(true);
		resetTransitionDefaults();
	});

	it('Ctrl+D without a selection: the edit point nearest the playhead on the targeted video tracks', async () => {
		resetTransitionDefaults();
		const t = setupTimeline();
		cut(t);
		t.session.select('timeline', [], 'replace');
		t.session.transport.seek(115);
		const before = t.history().length;
		await runCommand('timeline.applyDefaultVideoTransition', ctxOf(t));
		expect(t.history().slice(before)).toEqual(['Apply Video Transition']);
		const [x] = Object.values(seqOf(t).transitions);
		expect(Object.keys(seqOf(t).transitions)).toHaveLength(1);
		expect(x).toMatchObject({ alignment: 'center', duration: 30 });
		expect(nearestEditPoint(seqOf(t), seqOf(t).videoTracks[0]!.id, 115)).toMatchObject({
			cut: 120,
			edge: 'in',
		});
		// Shift+D needs a selection: nothing happens without one.
		await runCommand('timeline.applyDefaultTransitionsToSelection', ctxOf(t));
		expect(t.history().length).toBe(before + 1);
	});
});
