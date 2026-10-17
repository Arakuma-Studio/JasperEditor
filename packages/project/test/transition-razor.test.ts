// WP6.5a carry-over: razoring (Add Edit, Razor tool) inside a transition's span. It used to fail with E_INVARIANT
// (INV-010 "longer than clip"): the part of the clip that keeps the transition is shorter than the transition.
// Premiere adds the edit and shortens the transition to what the clip part still has (helpx "Transitions overview":
// "If a transition contains trimmed frames, but not enough to fill the transition duration, Premiere Pro adjusts the
// duration to match the frames"); the transition stays on its edit with its alignment.
import { describe, expect, it } from 'vitest';
import { checkInvariants, type Transition, transitionSpan } from '../src/index.ts';
import { Harness } from './helpers.ts';

/** Two 10 s linked video + audio clips cut at frame 100 with handles on both sides (media 30…130 and 60…160). */
function twoLinked() {
	const h = new Harness();
	const a = h.registerVideo();
	const b = h.registerVideo();
	const r = h.ok([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 0,
			sourceRange: { in: { sourceFrames: 30 }, out: { sourceFrames: 130 } },
		},
		{
			type: 'clip.place',
			source: { mediaId: b },
			at: 100,
			sourceRange: { in: { sourceFrames: 60 }, out: { sourceFrames: 160 } },
		},
	]);
	expect(r.ok).toBe(true);
	const at = (track: string, frame: number) => h.clips(track).find((c) => c.start === frame)!.id;
	return { h, va: at('V1', 0), vb: at('V1', 100), aa: at('A1', 0), ab: at('A1', 100) };
}
const transitions = (h: Harness) => Object.values(h.seq.transitions) as Transition[];
const onTrack = (h: Harness, label: 'V1' | 'A1') => {
	const id = (label === 'V1' ? h.seq.videoTracks[0] : h.seq.audioTracks[0])!.id;
	return transitions(h).filter((t) => t.trackId === id);
};

function withCrossfades(alignment: Transition['alignment'] = 'center') {
	const s = twoLinked();
	s.h.ok([
		{
			type: 'transition.add',
			at: 100,
			trackId: 'V1',
			effectId: 'jasper.cross-dissolve',
			duration: 30,
			alignment,
		},
		{
			type: 'transition.add',
			at: 100,
			trackId: 'A1',
			effectId: 'jasper.constant-power',
			duration: 30,
			alignment,
		},
	]);
	expect(transitions(s.h).map((t) => [t.duration, !!t.outgoingClipId && !!t.incomingClipId])).toEqual([
		[30, true],
		[30, true],
	]);
	return s;
}

describe('razor inside a transition (WP6.5a item 1)', () => {
	it('Add Edit on the incoming clip inside a centred video + audio crossfade shortens both transitions', () => {
		const { h, vb, ab } = withCrossfades();
		const before = h.doc;
		// span 85…115; frame 105 is inside it, on the incoming clips (linked: video and audio split together).
		const r = h.tx([{ type: 'clip.split', at: 105, clipIds: [vb] }]);
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		if (!r.ok) return;
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(h.spans('V1')).toEqual([
			[0, 100],
			[100, 105],
			[105, 200],
		]);
		expect(h.spans('A1')).toEqual(h.spans('V1'));
		for (const label of ['V1', 'A1'] as const) {
			const [t] = onTrack(h, label);
			expect(t, label).toBeDefined();
			// still on the same edit, as long as the 5-frame part it reaches into
			expect(t!.incomingClipId).toBe(label === 'V1' ? vb : ab);
			expect(t!.duration).toBe(5);
			expect(t!.alignment).toBe('center');
		}
		expect(r.warnings.filter((w) => w.code === 'W_TRANSITION_SHORTENED')).toHaveLength(2);
		// undo restores the document before (untouched); redo gives the same edit
		const beforeSeq = Object.values(before.sequences)[0]!;
		expect(Object.values(beforeSeq.transitions).map((t) => t.duration)).toEqual([30, 30]);
		expect(Object.keys(beforeSeq.clips)).toHaveLength(4);
		const redo = withCrossfades();
		const r2 = redo.h.tx([{ type: 'clip.split', at: 105, clipIds: [redo.vb] }]);
		expect(r2.ok).toBe(true);
		expect(redo.h.seq.transitions).toEqual(h.seq.transitions);
		expect(redo.h.spans('V1')).toEqual(h.spans('V1'));
		expect(redo.h.spans('A1')).toEqual(h.spans('A1'));
	});

	it('Add Edit on the outgoing clip inside the span moves the transition to the right part and fits it', () => {
		const { h, va, aa } = withCrossfades();
		const r = h.tx([{ type: 'clip.split', at: 92, clipIds: [va] }]);
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		expect(checkInvariants(h.doc)).toEqual([]);
		for (const label of ['V1', 'A1'] as const) {
			const right = h.clips(label).find((c) => c.start === 92)!;
			const [t] = onTrack(h, label);
			expect(t!.outgoingClipId).toBe(right.id);
			expect(t!.outgoingClipId).not.toBe(label === 'V1' ? va : aa);
			expect(t!.duration).toBe(8);
			const span = transitionSpan(100, t!.duration, t!.alignment);
			expect(span.start).toBeGreaterThanOrEqual(92);
		}
	});

	it('Add Edit to All Tracks and the Razor on one side (linked: false) inside the span', () => {
		for (const at of [86, 99, 101, 114]) {
			const all = withCrossfades();
			const r = all.h.tx([{ type: 'clip.split', at, scope: 'all-unlocked' }]);
			expect(r.ok, `${at}: ${JSON.stringify(!r.ok && r.errors)}`).toBe(true);
			expect(checkInvariants(all.h.doc), `${at}`).toEqual([]);
			expect(transitions(all.h)).toHaveLength(2);
			const part = Math.min(Math.abs(at - 100), 30);
			for (const t of transitions(all.h)) expect(t.duration).toBeLessThanOrEqual(part);
		}
		const one = withCrossfades();
		const r = one.h.tx([{ type: 'clip.split', at: 110, clipIds: [one.ab], linked: false }]);
		expect(r.ok).toBe(true);
		expect(checkInvariants(one.h.doc)).toEqual([]);
		expect(onTrack(one.h, 'A1')[0]!.duration).toBe(10);
		expect(onTrack(one.h, 'V1')[0]!.duration).toBe(30); // the video was not cut
	});

	it('works for start-at-cut / end-at-cut alignments, dip to black and fades at a clip edge', () => {
		for (const alignment of ['start-at-cut', 'end-at-cut'] as const) {
			const s = withCrossfades(alignment);
			const at = alignment === 'start-at-cut' ? 110 : 90;
			const r = s.h.tx([{ type: 'clip.split', at, scope: 'all-unlocked' }]);
			expect(r.ok, alignment).toBe(true);
			expect(checkInvariants(s.h.doc), alignment).toEqual([]);
			for (const t of transitions(s.h)) {
				expect(t.duration).toBe(10);
				expect(t.alignment).toBe(alignment);
			}
		}
		const dip = twoLinked();
		dip.h.ok([
			{ type: 'transition.add', at: 100, trackId: 'V1', effectId: 'jasper.dip-to-black', duration: 30 },
		]);
		expect(dip.h.tx([{ type: 'clip.split', at: 103, clipIds: [dip.vb], linked: false }]).ok).toBe(true);
		expect(checkInvariants(dip.h.doc)).toEqual([]);
		expect(transitions(dip.h)[0]!.duration).toBe(3);

		const fades = twoLinked();
		fades.h.ok([
			{ type: 'transition.add', clipId: fades.va, edge: 'in', effectId: 'jasper.cross-dissolve', duration: 30 },
			{ type: 'transition.add', clipId: fades.vb, edge: 'out', effectId: 'jasper.cross-dissolve', duration: 30 },
		]);
		expect(fades.h.tx([{ type: 'clip.split', at: 12, scope: 'all-unlocked' }]).ok).toBe(true);
		expect(fades.h.tx([{ type: 'clip.split', at: 190, scope: 'all-unlocked' }]).ok).toBe(true);
		expect(checkInvariants(fades.h.doc)).toEqual([]);
		expect(transitions(fades.h).map((t) => t.duration).sort()).toEqual([10, 12]);
	});

	it('an insert edit that splits a clip inside a transition span is accepted too', () => {
		const { h, vb } = withCrossfades();
		const c = h.registerVideo({ audio: false });
		const r = h.tx([{ type: 'clip.place', source: { mediaId: c }, at: 104, mode: 'insert', tracks: { video: 'V1' } }]);
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		expect(checkInvariants(h.doc)).toEqual([]);
		const t = onTrack(h, 'V1')[0]!;
		expect(t.incomingClipId).toBe(vb);
		expect(t.duration).toBe(4);
	});
});
