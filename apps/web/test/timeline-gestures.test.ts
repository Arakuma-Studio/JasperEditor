import { describe, expect, it } from 'vitest';
import { setupTimeline, solid, videoAsset } from './timeline-helpers.ts';

/** A video clip on `track` (footage: ripples on other tracks cut it; generated clips such as solids stay whole). */
function footage(
	t: { apply(c: unknown[]): { results: unknown[] } },
	at: number,
	frames: number,
	track: string,
) {
	const r = t.apply([{ type: 'media.register', asset: videoAsset(20) }]);
	const mediaId = (r.results[0] as { mediaId: string }).mediaId;
	t.apply([
		{
			type: 'clip.place',
			source: { mediaId },
			at,
			sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: frames } },
			tracks: { video: track },
		},
	]);
}

function withMovie(t: ReturnType<typeof setupTimeline>, at = 0, seconds = 20) {
	const r = t.apply([{ type: 'media.register', asset: videoAsset(seconds) }]);
	const mediaId = (r.results[0] as { mediaId: string }).mediaId;
	const p = t.apply([
		{
			type: 'clip.place',
			source: { mediaId },
			at,
			sourceRange: { in: { seconds: 2 }, out: { seconds: 6 } },
		},
	]);
	return (p.results[0] as { clipIds: string[] }).clipIds;
}

describe('move gestures (TL-480…491)', () => {
	it('rounds the pointer delta to frames and commits exactly one history entry', () => {
		const t = setupTimeline({ pxPerFrame: 10 });
		t.apply([solid(10, 20, 'V1')]);
		const before = t.history().length;
		// 10 px/frame: +73 px → +7 frames (snapping off so the raw rounding is visible).
		t.session.setToggles({ snapping: false });
		t.drag(t.x(20), t.rowY('V1'), t.x(20) + 73, t.rowY('V1'));
		expect(t.spans('V1')).toEqual([[17, 37]]);
		expect(t.history().length).toBe(before + 1);
	});

	it('AC-10d: Escape during a drag restores everything and creates no undo entry', () => {
		const t = setupTimeline();
		t.apply([solid(10, 20, 'V1')]);
		const before = t.history().length;
		const doc = t.session.getCommitted();
		t.drag(t.x(20), t.rowY('V1'), t.x(60), t.rowY('V1'), {}, false);
		expect(t.session.getDrawn()).not.toEqual(doc);
		expect(t.controller.cancel()).toBe(true);
		expect(t.session.getDrawn()).toEqual(doc);
		expect(t.history().length).toEqual(before);
		t.controller.pointerUp(t.pt(t.x(60), t.rowY('V1')));
		expect(t.history().length).toEqual(before);
	});

	it('AC-9a: a clip whose end comes within 8 px of the playhead snaps onto it and shows the indicator', () => {
		const t = setupTimeline({ pxPerFrame: 4 });
		t.apply([solid(0, 50, 'V1')]);
		t.session.transport.seek(200);
		// Raw move +148 frames puts the end at 198: 2 frames = 8 px from the playhead.
		t.drag(t.x(25), t.rowY('V1'), t.x(25) + 148 * 4, t.rowY('V1'), {}, false);
		expect(t.ui.getState().snapFrame).toBe(200);
		t.controller.pointerUp(t.pt(t.x(25) + 148 * 4, t.rowY('V1')));
		expect(t.spans('V1')).toEqual([[150, 200]]);
	});

	it('Ctrl at release performs an insert move (AC-10b through the gesture)', () => {
		const t = setupTimeline({ pxPerFrame: 1 });
		t.session.setToggles({ snapping: false });
		t.apply([solid(0, 400, 'V1'), solid(700, 60, 'V3')]);
		footage(t, 250, 200, 'V2');
		t.drag(t.x(710), t.rowY('V3'), t.x(310), t.rowY('V1'), { ctrl: true });
		expect(t.spans('V1')).toEqual([
			[0, 300],
			[300, 360],
			[360, 460],
		]);
		expect(t.spans('V2')).toEqual([
			[250, 300],
			[360, 510],
		]);
	});

	it('Alt drag duplicates with overwrite; the originals stay', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		t.session.setToggles({ snapping: false });
		t.apply([solid(0, 50, 'V1')]);
		t.drag(t.x(10), t.rowY('V1'), t.x(110), t.rowY('V1'), { alt: true });
		expect(t.spans('V1')).toEqual([
			[0, 50],
			[100, 150],
		]);
	});

	it('vertical moves change tracks within the kind; linked audio keeps its track (TL-486)', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		t.session.setToggles({ snapping: false });
		const [v, a] = withMovie(t, 0);
		t.drag(t.x(20), t.rowY('V1'), t.x(20), t.rowY('V2'));
		const s = t.seq();
		expect(s.clips[v!]!.trackId).toBe(s.videoTracks[1]!.id);
		expect(s.clips[a!]!.trackId).toBe(s.audioTracks[0]!.id);
	});

	it('Shift after the start constrains to the dominant axis (TL-488)', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		t.session.setToggles({ snapping: false });
		t.apply([solid(0, 50, 'V1')]);
		t.drag(t.x(10), t.rowY('V1'), t.x(10) + 100, t.rowY('V2') + 2, { shift: false }, false);
		t.controller.pointerMove(t.pt(t.x(10) + 100, t.rowY('V2') + 2, { shift: true }));
		t.controller.pointerUp(t.pt(t.x(10) + 100, t.rowY('V2') + 2, { shift: true }));
		expect(t.spans('V2')).toEqual([]);
		expect(t.spans('V1')).toEqual([[50, 100]]);
	});

	it('clips on locked tracks cannot be grabbed (TL-481)', () => {
		const t = setupTimeline();
		t.apply([solid(0, 50, 'V1'), { type: 'track.update', trackId: 'V1', patch: { locked: true } }]);
		expect(t.controller.pointerDown(t.pt(t.x(20), t.rowY('V1')))).toBe(false);
		expect(t.session.getState().selection.timeline.clips).toEqual([]);
	});
});

describe('selection and marquee (TL-400…406, AC-8a…c)', () => {
	it('clicking selects the link group; Alt selects one side; clicking empty space deselects', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		const [v, a] = withMovie(t, 0);
		t.controller.pointerDown(t.pt(t.x(30), t.rowY('V1')));
		t.controller.pointerUp(t.pt(t.x(30), t.rowY('V1')));
		expect(new Set(t.session.getState().selection.timeline.clips)).toEqual(new Set([v, a]));
		t.controller.pointerDown(t.pt(t.x(30), t.rowY('A1'), { alt: true }));
		t.controller.pointerUp(t.pt(t.x(30), t.rowY('A1'), { alt: true }));
		expect(t.session.getState().selection.timeline.clips).toEqual([a]);
		t.controller.pointerDown(t.pt(t.x(400), t.rowY('V1')));
		t.controller.pointerUp(t.pt(t.x(400), t.rowY('V1')));
		expect(t.session.getState().selection.timeline.clips).toEqual([]);
	});

	it('AC-8a: marquee over the video clip selects its linked audio; linked selection off selects only video', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		const [v, a] = withMovie(t, 50);
		const y0 = t.rowY('V1') - 10;
		t.drag(t.x(10), y0, t.x(80), t.rowY('V1'));
		expect(new Set(t.session.getState().selection.timeline.clips)).toEqual(new Set([v, a]));
		t.session.setToggles({ linkedSelection: false });
		t.session.select('timeline', [], 'replace');
		t.drag(t.x(10), y0, t.x(80), t.rowY('V1'));
		expect(t.session.getState().selection.timeline.clips).toEqual([v]);
	});

	it('AC-8b: Shift-marquee over a selected clip deselects it and keeps the rest', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		t.apply([solid(0, 20, 'V1'), solid(100, 20, 'V1')]);
		const [c1, c2] = t.clipsOn('V1');
		t.session.select('timeline', [c1!.id, c2!.id], 'replace');
		t.drag(t.x(95), t.rowY('V1') - 5, t.x(130), t.rowY('V1') + 5, { shift: true });
		expect(t.session.getState().selection.timeline.clips).toEqual([c1!.id]);
	});

	it('AC-8c and AC-7c: marquee selects 1 px clips but never clips on locked tracks', () => {
		const t = setupTimeline({ pxPerFrame: 0.5 });
		t.apply([
			solid(100, 1, 'V1'),
			solid(100, 30, 'V2'),
			{ type: 'track.update', trackId: 'V2', patch: { locked: true } },
		]);
		t.drag(t.x(60), t.rowY('V2'), t.x(160), t.rowY('V1') + 5);
		const sel = t.session.getState().selection.timeline.clips;
		expect(sel).toEqual([t.clipsOn('V1')[0]!.id]);
		t.controller.pointerDown(t.pt(t.x(110), t.rowY('V2')));
		t.controller.pointerUp(t.pt(t.x(110), t.rowY('V2')));
		expect(t.session.getState().selection.timeline.clips).not.toContain(t.clipsOn('V2')[0]!.id);
	});

	it('Escape during a marquee restores the previous selection', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		t.apply([solid(0, 20, 'V1'), solid(100, 20, 'V1')]);
		const [c1] = t.clipsOn('V1');
		t.session.select('timeline', [c1!.id], 'replace');
		t.drag(t.x(90), t.rowY('V1') - 5, t.x(130), t.rowY('V1') + 5, {}, false);
		expect(t.session.getState().selection.timeline.clips).not.toEqual([c1!.id]);
		t.controller.cancel();
		expect(t.session.getState().selection.timeline.clips).toEqual([c1!.id]);
	});

	it('clicking a gap selects it (TL-740)', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		t.apply([solid(0, 20, 'V1'), solid(100, 20, 'V1')]);
		t.controller.pointerDown(t.pt(t.x(50), t.rowY('V1')));
		t.controller.pointerUp(t.pt(t.x(50), t.rowY('V1')));
		expect(t.session.getState().selection.timeline.gaps).toEqual([
			{ trackId: t.seq().videoTracks[0]!.id, start: 20, end: 100 },
		]);
	});

	it('track select forward selects everything from the click on all unlocked tracks (TL-605)', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		t.apply([solid(0, 20, 'V1'), solid(100, 20, 'V1'), solid(50, 20, 'V2')]);
		t.session.setToggles({ activeTool: 'trackSelectForward' });
		t.controller.pointerDown(t.pt(t.x(40), t.rowY('V1')));
		t.controller.pointerUp(t.pt(t.x(40), t.rowY('V1')));
		expect(new Set(t.session.getState().selection.timeline.clips)).toEqual(
			new Set([t.clipsOn('V1')[1]!.id, t.clipsOn('V2')[0]!.id]),
		);
	});
});

describe('trim tools — one history entry each (TL-530…549, TL-610…632)', () => {
	it('regular trim stops at the neighbour and shows the limit indicator (AC-11b)', () => {
		const t = setupTimeline({ pxPerFrame: 4 });
		t.session.setToggles({ snapping: false });
		t.apply([solid(0, 100, 'V1'), solid(100, 50, 'V1')]);
		const n = t.history().length;
		t.drag(t.x(100) - 2, t.rowY('V1'), t.x(130), t.rowY('V1'), {}, false);
		expect(t.ui.getState().limit).not.toBeNull();
		t.controller.pointerUp(t.pt(t.x(130), t.rowY('V1')));
		expect(t.spans('V1')).toEqual([
			[0, 100],
			[100, 150],
		]);
		expect(t.history()).toHaveLength(n);
	});

	it('regular trim of the in edge by 10 frames', () => {
		const t = setupTimeline({ pxPerFrame: 4 });
		t.session.setToggles({ snapping: false });
		t.apply([solid(0, 100, 'V1')]);
		const n = t.history().length;
		t.drag(t.x(0) + 1, t.rowY('V1'), t.x(10) + 1, t.rowY('V1'));
		expect(t.spans('V1')).toEqual([[10, 100]]);
		expect(t.history()).toHaveLength(n + 1);
	});

	it('Ctrl-edge ripple trim and the Ripple tool (AC-11c path) create one entry', () => {
		const t = setupTimeline({ pxPerFrame: 4 });
		t.session.setToggles({ snapping: false });
		t.apply([solid(0, 100, 'V1'), solid(100, 50, 'V1'), solid(150, 30, 'V2')]);
		const n = t.history().length;
		t.drag(t.x(100) - 2, t.rowY('V1'), t.x(80) - 2, t.rowY('V1'), { ctrl: true });
		expect(t.spans('V1')).toEqual([
			[0, 80],
			[80, 130],
		]);
		expect(t.spans('V2')).toEqual([[130, 160]]);
		expect(t.history()).toHaveLength(n + 1);
		t.session.setToggles({ activeTool: 'ripple' });
		t.drag(t.x(80) - 2, t.rowY('V1'), t.x(90) - 2, t.rowY('V1'));
		expect(t.spans('V1')).toEqual([
			[0, 90],
			[90, 140],
		]);
		expect(t.history()).toHaveLength(n + 2);
	});

	it('AC-11c: ripple trim stops at the largest amount a sync-locked track allows', () => {
		const t = setupTimeline({ pxPerFrame: 4 });
		t.session.setToggles({ snapping: false, activeTool: 'ripple' });
		t.apply([solid(0, 100, 'V1'), solid(100, 50, 'V1')]);
		footage(t, 0, 90, 'V2');
		t.drag(t.x(100) - 2, t.rowY('V1'), t.x(70) - 2, t.rowY('V1'));
		expect(t.spans('V1')).toEqual([
			[0, 90],
			[90, 140],
		]);
	});

	it('rolling tool (N) moves the edit point', () => {
		const t = setupTimeline({ pxPerFrame: 4 });
		t.session.setToggles({ snapping: false, activeTool: 'rolling' });
		t.apply([solid(0, 100, 'V1'), solid(100, 50, 'V1')]);
		const n = t.history().length;
		t.drag(t.x(100) - 2, t.rowY('V1'), t.x(110) - 2, t.rowY('V1'));
		expect(t.spans('V1')).toEqual([
			[0, 110],
			[110, 150],
		]);
		expect(t.history()).toHaveLength(n + 1);
	});

	it('slip (Y) changes source time in one history entry', () => {
		const t = setupTimeline({ pxPerFrame: 4 });
		t.session.setToggles({ snapping: false });
		const [v] = withMovie(t, 0); // 2 s … 6 s of a 20 s movie
		const n = t.history().length;
		t.session.setToggles({ activeTool: 'slip' });
		t.drag(t.x(60), t.rowY('V1'), t.x(60) + 40, t.rowY('V1'), {}, false);
		t.controller.pointerUp(t.pt(t.x(60) + 40, t.rowY('V1')));
		expect(t.seq().clips[v!]!.sourceIn).toBe(50 * 23_520_000);
		expect(t.history()).toHaveLength(n + 1);
	});

	it('razor (C) click splits once; Shift splits all unlocked tracks; Alt ignores links', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		t.session.setToggles({ snapping: false, activeTool: 'razor' });
		const [v, a] = withMovie(t, 0);
		t.apply([solid(0, 200, 'V2')]);
		const n = t.history().length;
		t.controller.pointerDown(t.pt(t.x(40), t.rowY('V1')));
		t.controller.pointerUp(t.pt(t.x(40), t.rowY('V1')));
		expect(t.spans('V1')).toEqual([
			[0, 40],
			[40, 120],
		]);
		expect(t.spans('A1')).toEqual([
			[0, 40],
			[40, 120],
		]);
		expect(t.spans('V2')).toEqual([[0, 200]]);
		expect(t.history()).toHaveLength(n + 1);
		t.controller.pointerDown(t.pt(t.x(80), t.rowY('V2'), { shift: true }));
		t.controller.pointerUp(t.pt(t.x(80), t.rowY('V2'), { shift: true }));
		expect(t.spans('V2')).toEqual([
			[0, 80],
			[80, 200],
		]);
		t.controller.pointerDown(t.pt(t.x(20), t.rowY('A1'), { alt: true }));
		expect(t.spans('A1')).toHaveLength(4);
		expect(t.spans('V1')).toHaveLength(3);
		void v;
		void a;
	});

	it('razor snaps to the playhead even with snapping off (TL-620)', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		t.session.setToggles({ snapping: false, activeTool: 'razor' });
		t.apply([solid(0, 200, 'V1')]);
		t.session.transport.seek(50);
		t.controller.pointerDown(t.pt(t.x(52), t.rowY('V1')));
		expect(t.spans('V1')).toEqual([
			[0, 50],
			[50, 200],
		]);
	});

	it('rate stretch doubles the duration and halves the speed (AC-12d through the tool)', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		t.session.setToggles({ snapping: false, activeTool: 'rateStretch' });
		const [v] = withMovie(t, 0);
		t.drag(t.x(120) - 1, t.rowY('V1'), t.x(240) - 1, t.rowY('V1'));
		const c = t.seq().clips[v!]!;
		expect(c.duration).toBe(240);
		expect(c.speed.rate).toBe(0.5);
	});

	it('Escape cancels a trim with no entry', () => {
		const t = setupTimeline({ pxPerFrame: 4 });
		t.apply([solid(0, 100, 'V1')]);
		const n = t.history().length;
		t.drag(t.x(100) - 1, t.rowY('V1'), t.x(60), t.rowY('V1'), {}, false);
		t.controller.cancel();
		t.controller.pointerUp(t.pt(t.x(60), t.rowY('V1')));
		expect(t.spans('V1')).toEqual([[0, 100]]);
		expect(t.history()).toHaveLength(n);
	});
});

describe('viewport operations through the controller', () => {
	it('AC-3c: \\ then \\ returns to the exact prior zoom and scroll', () => {
		const t = setupTimeline({ pxPerFrame: 7.3, scrollFrame: 123.4 });
		t.apply([solid(0, 5000, 'V1')]);
		t.controller.toggleZoomToSequence();
		const v = t.session.getState().views[t.seqId]!;
		expect(v.pxPerFrame).toBeLessThan(1);
		t.controller.toggleZoomToSequence();
		const back = t.session.getState().views[t.seqId]!;
		expect([back.pxPerFrame, back.scrollFrame]).toEqual([7.3, 123.4]);
	});

	it('Alt+wheel zooms around the pointer', () => {
		const t = setupTimeline({ pxPerFrame: 2, scrollFrame: 100 });
		t.apply([solid(0, 5000, 'V1')]);
		const f = 100 + 500 / 2;
		for (let i = 0; i < 20; i++)
			t.controller.wheel({
				deltaX: 0,
				deltaY: i % 3 ? -60 : 80,
				deltaMode: 0,
				ctrlKey: false,
				altKey: true,
				shiftKey: false,
				x: 500,
				y: 100,
			});
		const v = t.session.getState().views[t.seqId]!;
		expect(Math.abs((f - v.scrollFrame) * v.pxPerFrame - 500)).toBeLessThan(1);
	});

	it('ruler scrubbing seeks with the floor rule and Shift snaps to markers (AC-9b)', () => {
		const t = setupTimeline({ pxPerFrame: 4 });
		t.apply([solid(0, 400, 'V1'), { type: 'marker.add', frame: 103 }]);
		t.session.setToggles({ snapping: false });
		expect(t.controller.scrubTo(4 * 100 + 3.9, false)).toBe(100);
		expect(t.controller.scrubTo(4 * 101, true)).toBe(103);
		expect(t.session.transport.getState().frame).toBe(103);
	});
});
