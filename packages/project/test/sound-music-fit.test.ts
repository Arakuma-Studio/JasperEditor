// Music to picture in the model (spec 12 P6-E11; wp-note "Phase 6 → WP-E7"): tuning tonal sounds to a key, the stop
// ramp on the bar line, End on Bar, `clip.remix` with anchors, a fade-in over a trimmed intro, crossfades that end at
// the joints and cuts rounded down; the style fields `tuneToMusic` / `stopOnBar`. Undo / redo, refusals, repair, and
// properties on hostile input.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	endOnBarPlan,
	FLICKS_PER_SECOND,
	inKey,
	isTunable,
	loadProject,
	readRemixAnchors,
	remixCommandOf,
	repairDocument,
	resolveSoundStyle,
	STOP_ON_BAR_WINDOW_SEC,
	stopBeforeDip,
	stopOnBar,
	tuneRun,
	tuneToKey,
	tuningReason,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
/** The same document up to fresh ids (a redo mints new ones). */
const noIds = (x: unknown) =>
	JSON.parse(JSON.stringify(x).replace(/"(kf|snd|fx|trk|trn|clp|grp)_[0-9A-Za-z]+"/g, '"$1"'));
const S = FLICKS_PER_SECOND;
const R30 = { num: 30, den: 1 };
const C_MAJOR = { tonic: 0, mode: 'major' as const, confidence: 0.9 };
const A_MINOR = { tonic: 9, mode: 'minor' as const, confidence: 0.9 };

describe('tuning to the key', () => {
	it('a chime of MIDI 70 over C major goes to an in-key note within ±1 st (A, the more stable of A and B)', () => {
		const t = tuneToKey(70, C_MAJOR)!;
		expect(Math.abs(t.st)).toBeLessThanOrEqual(1);
		expect(inKey(70 + t.st, C_MAJOR)).toBe(true);
		expect(t).toMatchObject({ st: -1, targetMidi: 69, note: 'A4', key: 'C major' });
		expect(tuningReason(t.st, t.key)).toBe('tuned -1 st to C major');
		expect(tuningReason(1, 'A minor')).toBe('tuned +1 st to A minor');
		// cents: 60.3 → C (−0.3), 61.6 → D (+0.4); in key already: no shift
		expect(tuneToKey(60.3, C_MAJOR)!.st).toBeCloseTo(-0.3, 6);
		expect(tuneToKey(61.6, C_MAJOR)).toMatchObject({ targetMidi: 62 });
		expect(tuneToKey(64.05, C_MAJOR)!.st).toBe(0);
		// A minor: G♯ (68) is out of the natural minor scale → A (69) or G (67): A, the tonic
		expect(tuneToKey(68, A_MINOR)).toMatchObject({ targetMidi: 69, st: 1 });
	});

	it('which sounds are tuned: chimes and shimmers with a pitch, any clearly pitched sound', () => {
		expect(isTunable(['chime'], { pitchMidi: 70, pitchConfidence: 0.5 })).toBe(true);
		expect(isTunable(['shimmer'], { pitchMidi: 70, pitchConfidence: 0 })).toBe(true);
		expect(isTunable(['pop'], { pitchMidi: 70, pitchConfidence: 0.85 })).toBe(true);
		expect(isTunable(['pop'], { pitchMidi: 70, pitchConfidence: 0.7 })).toBe(false);
		expect(isTunable(['chime'], { pitchMidi: null, pitchConfidence: 0.9 })).toBe(false);
		expect(isTunable(null, null)).toBe(false);
	});

	it('a run climbs the scale: every step in key, rising, at most four steps', () => {
		const st = tuneRun(70, [0, 1, 2, 3, 4, 4], C_MAJOR)!;
		const notes = st.map((s) => 70 + s);
		expect(notes).toEqual([69, 71, 72, 74, 76, 76]);
		expect(notes.every((n) => inKey(n, C_MAJOR))).toBe(true);
		expect(tuneRun(70, [0, 1, 2, 3, 4, 5, 6], C_MAJOR)!.at(-1)).toBe(76 - 70);
		expect(tuneRun(Number.NaN, [0, 1], C_MAJOR)).toBeNull();
	});

	it('never throws; a shift is ≤ 2 st and lands in key (property)', () => {
		fc.assert(
			fc.property(
				fc.double({ min: -20, max: 160, noNaN: false }),
				fc.integer({ min: -3, max: 14 }),
				fc.constantFrom('major', 'minor', 'dorian'),
				(p, tonic, mode) => {
					const t = tuneToKey(p, { tonic, mode } as never);
					if (t === null) return true;
					expect(Math.abs(t.st)).toBeLessThanOrEqual(2);
					expect(inKey(t.targetMidi, { tonic, mode } as never)).toBe(true);
					return true;
				},
			),
			{ numRuns: 500 },
		);
	});
});

describe('the stop on the bar line', () => {
	const hero = 300; // 10 s at 30 fps
	it('the ramp ends on the downbeat before the hero (else the beat), inside the window', () => {
		const grid = { downbeats: [8 * S, 9.6 * S], beats: [9.6 * S, 9.85 * S, 10.1 * S] };
		const r = stopOnBar(hero, STOP_ON_BAR_WINDOW_SEC, grid, R30)!;
		expect(r).toMatchObject({ on: 'downbeat' });
		expect(r.seconds).toBeCloseTo(0.4, 9);
		const dip = stopBeforeDip(hero, { seconds: r.seconds, depthDb: -24 }, R30)!;
		expect(Math.abs(dip.start - 9.6 * S)).toBeLessThanOrEqual(1);
		// a narrower window: the beat
		expect(stopOnBar(hero, 0.25, grid, R30)).toMatchObject({ on: 'beat' });
		expect(stopOnBar(hero, 0.25, grid, R30)!.seconds).toBeCloseTo(0.15, 9);
		// nothing in the window (a beat closer than 0.1 s is not used)
		expect(stopOnBar(hero, 0.25, { downbeats: [], beats: [9.95 * S] }, R30)).toBeNull();
		expect(stopOnBar(hero, Number.NaN, grid, R30)).toBeNull();
		expect(stopOnBar(hero, 0.5, { downbeats: [Number.NaN], beats: 'x' as never }, R30)).toBeNull();
	});
});

/** A 20 s music clip on A1 at frame 0 (30 fps). */
function music(h: Harness, seconds = 20) {
	const m = h.registerVideo({ kind: 'audio', seconds });
	h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: 'A1' } }]);
	h.ok([{ type: 'essentialSound.setType', clipIds: [h.clips('A1')[0]!.id], audioType: 'music' }]);
	return h.clips('A1')[0]!.id;
}

describe('End on Bar', () => {
	it('ends the music just before a bar line with a one-beat fade; undo / redo; nearest; refusals', () => {
		const h = new Harness();
		const id = music(h);
		const downbeats = [0.5, 2.5, 4.5, 6.5, 8.5, 10.5, 12.5, 14.5, 16.5, 18.5];
		h.ok([{ type: 'clip.trim', clipId: id, edge: 'out', deltaFrames: -(600 - 400) }]); // ends at 13.33 s
		const before = h.doc;
		const snap = clone(before);
		const p = endOnBarPlan(h.doc, h.seq, id, downbeats, { bpm: 120 });
		expect(p.ok).toBe(true);
		if (!p.ok) return;
		// the last bar line at or before 13.33 s: 12.5 s = frame 375; the clip ends at frame 374 (≥ 3 ms before it)
		expect(p.endFrame).toBe(374);
		expect(p.barFrame).toBeCloseTo(375, 6);
		expect(p.fadeFrames).toBe(15);
		h.ok(p.commands);
		const c = h.seq.clips[id]!;
		expect(c.start + c.duration).toBe(374);
		const fade = Object.values(h.seq.transitions).find((t) => t.outgoingClipId === id && !t.incomingClipId)!;
		expect(fade.duration).toBe(15);
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(before).toEqual(snap);
		const after = noIds(h.doc.sequences);
		h.doc = before;
		h.ok(p.commands);
		expect(noIds(h.doc.sequences)).toEqual(after);
		// again on the trimmed clip: the same bar line, the fade is updated, not doubled
		const again = endOnBarPlan(h.doc, h.seq, id, downbeats, { fadeSeconds: 1 });
		expect(again.ok && again.endFrame).toBe(374);
		h.ok(again.ok ? again.commands : []);
		expect(Object.values(h.seq.transitions).filter((t) => t.outgoingClipId === id).length).toBe(1);
		// nearest: the clip ending at 14.0 s takes the bar line at 14.5 s (media and room after it)
		const h2 = new Harness();
		const id2 = music(h2);
		h2.ok([{ type: 'clip.trim', clipId: id2, edge: 'out', deltaFrames: -(600 - 420) }]);
		const near = endOnBarPlan(h2.doc, h2.seq, id2, downbeats, { bpm: 120, direction: 'nearest' });
		expect(near.ok && near.endFrame).toBe(434);
		const earlier = endOnBarPlan(h2.doc, h2.seq, id2, downbeats, { bpm: 120 });
		expect(earlier.ok && earlier.endFrame).toBe(374);
		// refusals
		expect(endOnBarPlan(h.doc, h.seq, 'clp_nope', downbeats)).toMatchObject({
			ok: false,
			code: 'E_NOT_FOUND',
		});
		expect(endOnBarPlan(h.doc, h.seq, id, [])).toMatchObject({ ok: false, code: 'E_INVALID_PARAM' });
		expect(endOnBarPlan(h.doc, h.seq, id, [30, 40])).toMatchObject({ ok: false });
		expect(endOnBarPlan(h.doc, h.seq, id, [Number.NaN, Number.POSITIVE_INFINITY])).toMatchObject({
			ok: false,
		});
	});

	it('never throws on hostile bar lines (property)', () => {
		const h = new Harness();
		const id = music(h);
		fc.assert(
			fc.property(
				fc.array(fc.double({ noNaN: false }), { maxLength: 20 }),
				fc.option(fc.double({ noNaN: false })),
				(lines, fadeSeconds) => {
					const p = endOnBarPlan(h.doc, h.seq, id, lines, {
						...(fadeSeconds !== null ? { fadeSeconds } : {}),
						direction: 'nearest',
					});
					if (p.ok) {
						const r = h.tx(p.commands);
						expect(r.ok).toBe(true);
					}
					return true;
				},
			),
			{ numRuns: 200 },
		);
	});
});

describe('clip.remix for music to picture', () => {
	const pieces = [
		{ srcSeconds: 0.4, lenSeconds: 4.01 },
		{ srcSeconds: 10.11, lenSeconds: 3.99 },
		{ srcSeconds: 16, lenSeconds: 4 },
	];

	it('rounds cuts down, ends the crossfades at the joints, records anchors, fades a trimmed intro in; revert removes it', () => {
		const h = new Harness();
		const id = music(h);
		const before = h.doc;
		const cmd = remixCommandOf(
			h.seq.clips[id] as never,
			{
				bpm: 120,
				pieces,
				lengthSeconds: 12,
				headTrimSeconds: 0.4,
				anchors: [{ sourceSeconds: 12, outputSeconds: 6, landedSeconds: 6 }],
			},
			R30,
		);
		expect(cmd).toMatchObject({
			targetFrames: 360,
			anchors: [{ sourceSeconds: 12, frame: 180 }],
			fadeInFrames: 1,
		});
		const r = h.ok([cmd]);
		const list = h.clips('A1') as unknown as {
			id: string;
			start: number;
			duration: number;
			remix?: { fadeInId?: string; anchors?: unknown };
		}[];
		// 4.01 s → frame 120 (down), 8.0 s → 240
		expect(list.map((c) => [c.start, c.duration])).toEqual([
			[0, 120],
			[120, 120],
			[240, 120],
		]);
		const joints = Object.values(h.seq.transitions).filter((t) => t.incomingClipId && t.outgoingClipId);
		expect(joints.map((t) => t.alignment)).toEqual(['end-at-cut', 'end-at-cut']);
		expect(joints.every((t) => t.duration === 1)).toBe(true);
		const fadeIn = Object.values(h.seq.transitions).find(
			(t) => t.incomingClipId === list[0]!.id && !t.outgoingClipId,
		)!;
		expect(fadeIn.duration).toBe(1);
		expect(readRemixAnchors(list[1]!.remix)).toEqual([{ sourceSeconds: 12, frame: 180 }]);
		expect((list[0]!.remix as { fadeInId?: string }).fadeInId).toBe(fadeIn.id);
		expect(checkInvariants(h.doc)).toEqual([]);
		expect((r.results[0] as { pieces: number }).pieces).toBe(3);
		// undo leaves the earlier document; redo gives the same
		const after = noIds(h.doc.sequences);
		const done = h.doc;
		h.doc = before;
		h.ok([cmd]);
		expect(noIds(h.doc.sequences)).toEqual(after);
		// the save round-trips; revert restores the clip without the remix's fade-in
		expect(loadProject(clone(done)).repairs).toEqual([]);
		h.ok([{ type: 'clip.remixRevert', clipId: h.clips('A1')[2]!.id }]);
		expect(h.clips('A1').length).toBe(1);
		expect(Object.values(h.seq.transitions)).toEqual([]);
	});

	it('crossfades at 60 fps last 2 frames (≥ 30 ms); anchors outside the remix are refused', () => {
		const h = new Harness({ preset: 'uhd-2160p-60' });
		const id = music(h);
		h.ok([{ type: 'clip.remix', clipId: id, targetFrames: 720, pieces, bpm: 120 }]);
		const joints = Object.values(h.seq.transitions).filter((t) => t.incomingClipId && t.outgoingClipId);
		expect(joints.every((t) => t.duration === 2)).toBe(true);
		const h2 = new Harness();
		const id2 = music(h2);
		const r = h2.tx([
			{
				type: 'clip.remix',
				clipId: id2,
				targetFrames: 360,
				pieces,
				bpm: 120,
				anchors: [{ sourceSeconds: 1, frame: 400 }],
			},
		]);
		expect(r.ok).toBe(false);
		expect(r.ok ? '' : r.errors[0]!.code).toBe('E_INVALID_PARAM');
		const bad = h2.tx([
			{
				type: 'clip.remix',
				clipId: id2,
				targetFrames: 360,
				pieces,
				bpm: 120,
				anchors: [{ sourceSeconds: -1, frame: 10 }],
			},
		]);
		expect(bad.ok).toBe(false);
	});

	it('unreadable stored anchors are an invariant issue; repair keeps the readable ones', () => {
		const h = new Harness();
		const id = music(h);
		h.ok([
			{
				type: 'clip.remix',
				clipId: id,
				targetFrames: 360,
				pieces,
				bpm: 120,
				anchors: [{ sourceSeconds: 12, frame: 180 }],
			},
		]);
		const doc = clone(h.doc);
		const c = Object.values(doc.sequences[h.seqId]!.clips)[0]! as { remix: { anchors: unknown[] } };
		c.remix.anchors = [{ sourceSeconds: 12, frame: 180 }, { sourceSeconds: 'x', frame: -1 }, 7];
		expect(checkInvariants(doc).some((i) => i.message.includes('remix anchors'))).toBe(true);
		const { document, report } = repairDocument(doc, h.ids);
		expect(report.some((r) => r.action === 'repair-remix-anchors')).toBe(true);
		const fixed = document.sequences[h.seqId]!.clips[(c as unknown as { id: string }).id] as unknown as {
			remix?: { anchors?: unknown };
		};
		expect(readRemixAnchors(fixed.remix)).toEqual([{ sourceSeconds: 12, frame: 180 }]);
		expect(checkInvariants(document)).toEqual([]);
	});
});

describe('style: tuneToMusic and stopOnBar', () => {
	it('default on; setSettings stores, null resets; undo / redo; refusals', () => {
		expect(resolveSoundStyle()).toMatchObject({ tuneToMusic: true, stopOnBar: true });
		const h = new Harness();
		const before = h.doc;
		h.ok([{ type: 'soundDesign.setSettings', style: { tuneToMusic: false, stopOnBar: false } }]);
		expect(h.seq.soundDesign?.settings?.style).toEqual({ tuneToMusic: false, stopOnBar: false });
		expect(resolveSoundStyle(h.seq.soundDesign?.settings?.style)).toMatchObject({
			tuneToMusic: false,
			stopOnBar: false,
		});
		expect(resolveSoundStyle({ tuneToMusic: true }, h.seq.soundDesign?.settings?.style).tuneToMusic).toBe(
			true,
		);
		const one = h.doc;
		h.ok([{ type: 'soundDesign.setSettings', style: { tuneToMusic: null } }]);
		expect(h.seq.soundDesign?.settings?.style).toEqual({ stopOnBar: false });
		expect(Object.values(before.sequences)[0]!.soundDesign).toBeUndefined();
		const after = clone(h.doc.sequences);
		h.doc = one;
		h.ok([{ type: 'soundDesign.setSettings', style: { tuneToMusic: null } }]);
		expect(clone(h.doc.sequences)).toEqual(after);
		expect(h.tx([{ type: 'soundDesign.setSettings', style: { tuneToMusic: 'yes' } }]).ok).toBe(false);
		expect(h.tx([{ type: 'soundDesign.setSettings', style: { stopOnBar: 1 } }]).ok).toBe(false);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});
