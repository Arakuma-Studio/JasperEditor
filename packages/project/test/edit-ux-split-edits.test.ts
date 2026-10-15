// Split-edit tests ported from
// FilmCraft crates/engine/src/{split_edit_ripple_trim_tests.rs, ripple_delete_tests.rs} and
// crates/edit/src/tests.rs (ripple_trim_group_*, ripple_delete_closes_the_time_free_on_every_track,
// speed_on_a_linked_group_ripples_once). MIT OR Apache-2.0, Copyright (c) 2026 ArtCraft Team and the FilmCraft
// contributors. Frame numbers are at the harness's 30 fps.
import { describe, expect, it } from 'vitest';
import { type Clip, checkInvariants } from '../src/index.ts';
import { Harness } from './helpers.ts';

type Pair = { picture: string; sound: string };

/** Places `[inSec, inSec + len/30)` of a fresh 20 s asset at `at` with picture on `v` and sound on `a`. */
function placeAV(
	h: Harness,
	at: number,
	len: number,
	opts: { v?: string; a?: string; inSec?: number } = {},
): Pair {
	const m = h.registerVideo({ seconds: 20 });
	const inSec = opts.inSec ?? 2;
	const r = h.ok([
		{
			type: 'clip.place',
			source: { mediaId: m },
			at,
			tracks: { video: opts.v ?? 'V1', audio: opts.a ?? 'A1' },
			sourceRange: { in: { seconds: inSec }, out: { seconds: inSec + len / 30 } },
		},
	]);
	const [picture, sound] = (r.results[0] as { clipIds: string[] }).clipIds as [string, string];
	return { picture, sound };
}

const range = (h: Harness, id: string): [number, number] => {
	const c = h.seq.clips[id] as Clip;
	return [c.start, c.start + c.duration];
};
const start = (h: Harness, id: string) => range(h, id)[0];

/** Moves one sound edge alone (Linked Selection off for the trim), as a split edit does. */
function trimSound(h: Harness, sound: string, edge: 'in' | 'out', frames: number) {
	h.ok([{ type: 'clip.trim', clipId: sound, edge, deltaFrames: frames, linked: false }]);
}

function noInvariantErrors(h: Harness) {
	const issues = checkInvariants(h.doc);
	expect(issues).toEqual([]);
}

/** Two clips in a row on V1; the first's sound on A1, the second's on A2 leading its picture by 12 frames. */
function jCut(h: Harness) {
	for (const t of ['V2', 'V3', 'A3'])
		h.ok([{ type: 'track.update', trackId: t, patch: { syncLock: false } }]);
	const first = placeAV(h, 0, 48, { a: 'A1' });
	const second = placeAV(h, 48, 48, { a: 'A2' });
	trimSound(h, second.sound, 'in', -12);
	expect(start(h, second.picture) - start(h, second.sound)).toBe(12);
	return { first, second };
}

describe('ripple trim ahead of a J cut (FilmCraft split_edit_ripple_trim_tests)', () => {
	for (const frames of [8, -8]) {
		it(`${frames > 0 ? 'lengthening' : 'shortening'} keeps the early sound with its picture`, () => {
			const h = new Harness();
			const { first, second } = jCut(h);
			const before = h.doc;
			const pictureAt = start(h, second.picture);
			const soundAt = start(h, second.sound);
			const r = h.ok([
				{ type: 'clip.trim', clipId: first.picture, edge: 'out', mode: 'ripple', deltaFrames: frames },
			]);
			expect((r.results[0] as { deltaFrames: number }).deltaFrames).toBe(frames);
			expect(start(h, second.picture)).toBe(pictureAt + frames);
			expect(start(h, second.sound)).toBe(soundAt + frames);
			expect(Object.keys(h.seq.clips)).toHaveLength(Object.keys(before.sequences[h.seqId]!.clips).length);
			noInvariantErrors(h);
		});
	}

	it('is refused when the early sound has no room (sequence start, or a clip right before it)', () => {
		const h = new Harness();
		const { first, second } = jCut(h);
		// The sound starts at frame 36: 40 frames earlier is before the sequence starts.
		const r = h.tx([
			{ type: 'clip.trim', clipId: first.picture, edge: 'out', mode: 'ripple', deltaFrames: -40 },
		]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0]!.code).toBe('E_SYNC_CONFLICT');
		// A tone right before the sound on A2 leaves it no room either.
		const tone = h.registerVideo({ seconds: 5, kind: 'audio' });
		h.ok([
			{
				type: 'clip.place',
				source: { mediaId: tone },
				at: 12,
				tracks: { audio: 'A2' },
				sourceRange: { in: { seconds: 0 }, out: { seconds: 24 / 30 } },
			},
		]);
		const r2 = h.tx([
			{ type: 'clip.trim', clipId: first.picture, edge: 'out', mode: 'ripple', deltaFrames: -8 },
		]);
		expect(r2.ok).toBe(false);
		if (!r2.ok) expect(r2.errors[0]!.code).toBe('E_SYNC_CONFLICT');
		expect(start(h, second.picture) - start(h, second.sound)).toBe(12);
	});

	it('clampToSyncLock stops a gesture at the room the early sound has', () => {
		const h = new Harness();
		const { first, second } = jCut(h);
		const r = h.ok([
			{
				type: 'clip.trim',
				clipId: first.picture,
				edge: 'out',
				mode: 'ripple',
				deltaFrames: -40,
				clampToSyncLock: true,
			},
		]);
		// The sound can move 36 frames back to frame 0.
		expect((r.results[0] as { deltaFrames: number }).deltaFrames).toBe(-36);
		expect(start(h, second.sound)).toBe(0);
		expect(start(h, second.picture)).toBe(12);
		noInvariantErrors(h);
	});

	it('an In-edge ripple trim of the clip before an early sound moves it along with its picture', () => {
		const h = new Harness();
		for (const t of ['V3', 'A3']) h.ok([{ type: 'track.update', trackId: t, patch: { syncLock: false } }]);
		placeAV(h, 0, 30, { a: 'A1' });
		const b = placeAV(h, 30, 30, { a: 'A2' });
		const c = placeAV(h, 60, 30, { a: 'A1' });
		// c's sound starts 12 early, under b's picture (A1 has room: the first sound ends at 30).
		trimSound(h, c.sound, 'in', -12);
		expect(range(h, c.sound)).toEqual([48, 90]);
		h.ok([{ type: 'clip.trim', clipId: b.picture, edge: 'in', mode: 'ripple', deltaFrames: 3 }]);
		// b (and its sound) keep their start and lose 3 head frames; c and its early sound move up together.
		expect(range(h, b.picture)).toEqual([30, 57]);
		expect(range(h, b.sound)).toEqual([30, 57]);
		expect(range(h, c.picture)).toEqual([57, 87]);
		expect(range(h, c.sound)).toEqual([45, 87]);
		noInvariantErrors(h);
	});

	it('a linked clip that ends before the cut is not a split edit and stays', () => {
		const h = new Harness();
		const { first } = jCut(h);
		const early = placeAV(h, 0, 6, { v: 'V3', a: 'A3' });
		h.ok([{ type: 'track.update', trackId: 'A3', patch: { syncLock: true } }]);
		h.ok([{ type: 'clip.trim', clipId: first.picture, edge: 'out', mode: 'ripple', deltaFrames: 2 }]);
		expect(range(h, early.sound)).toEqual([0, 6]);
	});
});

/** Four 48-frame clips in a row, pictures on V1 and their sounds on A1. */
function fourClips(h: Harness): Pair[] {
	for (const t of ['V2', 'V3', 'A2', 'A3'])
		h.ok([{ type: 'track.update', trackId: t, patch: { syncLock: false } }]);
	return [0, 1, 2, 3].map((n) => placeAV(h, 48 * n, 48));
}

describe('ripple delete of split-edit clips (FilmCraft ripple_delete_tests)', () => {
	it('a J-cut clip closes one gap and later clips move once', () => {
		const h = new Harness();
		const [c1, c2, c3, c4] = fourClips(h) as [Pair, Pair, Pair, Pair];
		trimSound(h, c1.sound, 'out', -12);
		trimSound(h, c2.sound, 'in', -12);
		expect([start(h, c2.picture), start(h, c2.sound)]).toEqual([48, 36]);
		h.ok([{ type: 'marker.add', frame: 120, name: 'Later' }]);
		const r = h.ok([{ type: 'clip.extract', clipIds: [c2.picture, c2.sound] }]);
		expect(h.seq.clips[c2.picture]).toBeUndefined();
		expect(h.seq.clips[c2.sound]).toBeUndefined();
		expect(range(h, c3.picture)).toEqual([48, 96]);
		expect(range(h, c3.sound)).toEqual([48, 96]);
		expect([range(h, c4.picture), range(h, c4.sound)]).toEqual([
			[96, 144],
			[96, 144],
		]);
		expect(range(h, c1.sound)[1]).toBe(36);
		expect(h.seq.markers.map((m) => m.frame)).toEqual([72]);
		expect((r.results[0] as { ranges: { start: number; end: number }[] }).ranges).toEqual([
			{ start: 48, end: 96 },
		]);
		noInvariantErrors(h);
	});

	it('an L-cut clip keeps the next clip in sync', () => {
		const h = new Harness();
		const [, c2, c3, c4] = fourClips(h) as [Pair, Pair, Pair, Pair];
		trimSound(h, c3.sound, 'in', 12);
		trimSound(h, c2.sound, 'out', 12);
		expect([range(h, c2.picture)[1], range(h, c2.sound)[1]]).toEqual([96, 108]);
		h.ok([{ type: 'clip.extract', clipIds: [c2.picture, c2.sound] }]);
		expect(range(h, c3.picture)).toEqual([48, 96]);
		expect(range(h, c3.sound)).toEqual([60, 96]);
		expect([range(h, c4.picture), range(h, c4.sound)]).toEqual([
			[96, 144],
			[96, 144],
		]);
		noInvariantErrors(h);
	});

	it('a straight cut is unchanged', () => {
		const h = new Harness();
		const [, c2, c3] = fourClips(h) as [Pair, Pair, Pair];
		h.ok([{ type: 'clip.extract', clipIds: [c2.picture, c2.sound] }]);
		expect([range(h, c3.picture), range(h, c3.sound)]).toEqual([
			[48, 96],
			[48, 96],
		]);
	});

	it('two neighbours with a split edit between them close the whole gap', () => {
		const h = new Harness();
		const [, c2, c3, c4] = fourClips(h) as [Pair, Pair, Pair, Pair];
		trimSound(h, c3.sound, 'in', 12);
		trimSound(h, c2.sound, 'out', 12);
		h.ok([{ type: 'clip.extract', clipIds: [c2.picture, c2.sound, c3.picture, c3.sound] }]);
		expect([range(h, c4.picture), range(h, c4.sound)]).toEqual([
			[48, 96],
			[48, 96],
		]);
		noInvariantErrors(h);
	});

	it('straight cuts with sounds on alternating tracks close the whole gap', () => {
		const h = new Harness();
		for (const t of ['V2', 'V3', 'A3'])
			h.ok([{ type: 'track.update', trackId: t, patch: { syncLock: false } }]);
		const p = [0, 1, 2, 3].map((n) => placeAV(h, 48 * n, 48, { a: n % 2 === 0 ? 'A1' : 'A2' }));
		h.ok([{ type: 'clip.extract', clipIds: [p[1]!.picture, p[1]!.sound, p[2]!.picture, p[2]!.sound] }]);
		expect(range(h, p[3]!.picture)).toEqual([48, 96]);
		expect(range(h, p[3]!.sound)).toEqual([48, 96]);
		expect(h.spans('A2')).toEqual([[48, 96]]);
		noInvariantErrors(h);
	});

	it('a sound shorter than its picture with its neighbour right up against it closes only the sound stretch', () => {
		const h = new Harness();
		for (const t of ['V2', 'V3', 'A2', 'A3'])
			h.ok([{ type: 'track.update', trackId: t, patch: { syncLock: false } }]);
		const solid = (at: number, d: number, track: string) => ({
			type: 'clip.addSolid',
			at,
			duration: d,
			track,
			color: [0, 0, 1, 1],
		});
		const tone = h.registerVideo({ seconds: 20, kind: 'audio' });
		const aud = (at: number, d: number) => ({
			type: 'clip.place',
			source: { mediaId: tone },
			at,
			tracks: { audio: 'A1' },
			sourceRange: { in: { seconds: 1 }, out: { seconds: 1 + d / 30 } },
		});
		h.ok([aud(0, 12), solid(10, 10, 'V1'), aud(12, 6), solid(20, 10, 'V1'), aud(18, 12)]);
		const p = h.clips('V1')[0]!.id;
		const s = h.clips('A1')[1]!.id;
		h.ok([{ type: 'clip.extract', clipIds: [p, s] }]);
		expect(h.spans('V1')).toEqual([[14, 24]]);
		expect(h.spans('A1')).toEqual([
			[0, 12],
			[12, 24],
		]);
	});

	it('refuses extraction when no common gap can close', () => {
		const h = new Harness();
		for (const t of ['V2', 'V3', 'A2', 'A3'])
			h.ok([{ type: 'track.update', trackId: t, patch: { syncLock: false } }]);
		const solid = (at: number, d: number, track: string) => ({
			type: 'clip.addSolid',
			at,
			duration: d,
			track,
			color: [0, 0, 1, 1],
		});
		h.ok([solid(10, 10, 'V1'), solid(30, 10, 'V1'), solid(10, 10, 'V2'), solid(30, 10, 'V2')]);
		h.ok([{ type: 'track.update', trackId: 'V2', patch: { syncLock: false } }]);
		const x = h.clips('V1')[0]!.id;
		const y = h.clips('V2')[1]!.id;
		const r = h.tx([{ type: 'clip.extract', clipIds: [x, y] }]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0]).toMatchObject({ code: 'E_INVALID_PARAM', blocking: [x, y] });
	});
});

describe('speed change on a linked group ripples once (FilmCraft speed_on_a_linked_group_ripples_once)', () => {
	function build(soundLen: number) {
		const h = new Harness();
		for (const t of ['V2', 'V3', 'A2', 'A3'])
			h.ok([{ type: 'track.update', trackId: t, patch: { syncLock: false } }]);
		const a = placeAV(h, 0, 30);
		placeAV(h, 30, 30);
		if (soundLen !== 30) {
			// The second sound starts later by the difference so the first can be longer (a split edit).
			const b = h.clips('A1')[1]!.id;
			trimSound(h, b, 'in', soundLen - 30);
			trimSound(h, a.sound, 'out', soundLen - 30);
		}
		return { h, a };
	}
	it('straight cut: later clips move by the change on both tracks', () => {
		for (const [rate, picture, later] of [
			[0.5, [0, 60], [60, 90]],
			[2, [0, 15], [15, 45]],
		] as const) {
			const { h, a } = build(30);
			h.ok([{ type: 'clip.setSpeed', clipIds: [a.picture, a.sound], rate, ripple: true }]);
			expect(h.spans('V1')).toEqual([picture, later]);
			expect(h.spans('A1')).toEqual([picture, later]);
			noInvariantErrors(h);
		}
	});
	it('split edit: later material moves by the largest change on every track', () => {
		{
			const { h, a } = build(42);
			h.ok([{ type: 'clip.setSpeed', clipIds: [a.picture, a.sound], rate: 0.5, ripple: true }]);
			// picture 30 → 60 (+30), sound 42 → 84 (+42): later clips move by 42.
			expect(h.spans('V1')).toEqual([
				[0, 60],
				[72, 102],
			]);
			expect(h.spans('A1')).toEqual([
				[0, 84],
				[84, 102],
			]);
			noInvariantErrors(h);
		}
		{
			const { h, a } = build(42);
			h.ok([{ type: 'clip.setSpeed', clipIds: [a.picture, a.sound], rate: 2, ripple: true }]);
			// picture 30 → 15 (−15), sound 42 → 21 (−21): later clips move by −15.
			expect(h.spans('V1')).toEqual([
				[0, 15],
				[15, 45],
			]);
			expect(h.spans('A1')).toEqual([
				[0, 21],
				[27, 45],
			]);
			noInvariantErrors(h);
		}
	});
});
