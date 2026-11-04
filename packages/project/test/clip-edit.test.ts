import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	applyTransaction,
	type Clip,
	checkInvariants,
	createRandomIdSource,
	flicksPerFrame,
	type ProjectDocument,
	RATES,
	sequenceDuration,
	sourceOut,
} from '../src/index.ts';
import { Harness, makeCtx } from './helpers.ts';

const F30 = flicksPerFrame(RATES.r30);
const solid = (at: number, duration: number, track: string) => ({
	type: 'clip.addSolid',
	at,
	duration,
	track,
	color: [0, 0, 1, 1],
});

/** Places `[inSec, outSec)` of a fresh video asset at `at` (linked V/A unless audio: false). */
function place(
	h: Harness,
	at: number,
	opts: { seconds?: number; inSec?: number; outSec?: number; audio?: boolean; v?: string } = {},
) {
	const m = h.registerVideo({ seconds: opts.seconds ?? 20, audio: opts.audio });
	const r = h.ok([
		{
			type: 'clip.place',
			source: { mediaId: m },
			at,
			tracks: { video: opts.v ?? 'V1' },
			sourceRange: { in: { seconds: opts.inSec ?? 0 }, out: { seconds: opts.outSec ?? 10 } },
		},
	]);
	return (r.results[0] as { clipIds: string[] }).clipIds;
}

/**
 * A solid on `track` covering `[at, at + dur)` whose content starts `head` frames in, so its in edge
 * can extend left by `head` frames (generators cannot show content before content time 0, S01:CLP-005).
 */
function headed(h: Harness, at: number, dur: number, head: number, track = 'V1'): string {
	const r = h.ok([solid(at - head, dur + head, track)]);
	const id = (r.results[0] as { clipId: string }).clipId;
	h.ok([{ type: 'clip.trim', clipId: id, edge: 'in', deltaFrames: head }]);
	return id;
}

const byId = (h: Harness, id: string) => h.seq.clips[id]! as Clip;

describe('clip.trim mode roll (S02:TL-545)', () => {
	type Case = {
		name: string;
		setup: (h: Harness) => string;
		edge: 'in' | 'out';
		delta: number;
		expectSpans: [number, number][];
		clamped?: boolean;
	};
	const cases: Case[] = [
		{
			name: 'butt edit, out edge +10',
			setup: (h) => {
				h.ok([solid(0, 100, 'V1'), solid(100, 50, 'V1')]);
				return h.clips('V1')[0]!.id;
			},
			edge: 'out',
			delta: 10,
			expectSpans: [
				[0, 110],
				[110, 150],
			],
		},
		{
			name: 'butt edit, in edge -30 (incoming grabbed)',
			setup: (h) => {
				const b = headed(h, 100, 50, 60);
				h.ok([solid(0, 100, 'V1')]);
				return b;
			},
			edge: 'in',
			delta: -30,
			expectSpans: [
				[0, 70],
				[70, 150],
			],
		},
		{
			name: 'both sides keep >= 1 frame',
			setup: (h) => {
				h.ok([solid(0, 100, 'V1'), solid(100, 50, 'V1')]);
				return h.clips('V1')[0]!.id;
			},
			edge: 'out',
			delta: 500,
			expectSpans: [
				[0, 149],
				[149, 150],
			],
			clamped: true,
		},
		{
			name: 'clip|gap: the gap shrinks until the next clip',
			setup: (h) => {
				h.ok([solid(0, 100, 'V1'), solid(130, 20, 'V1')]);
				return h.clips('V1')[0]!.id;
			},
			edge: 'out',
			delta: 50,
			expectSpans: [
				[0, 130],
				[130, 150],
			],
			clamped: true,
		},
		{
			name: 'gap|clip: the gap resizes, frame 0 bounds it',
			setup: (h) => headed(h, 50, 70, 50),
			edge: 'in',
			delta: -100,
			expectSpans: [[0, 120]],
			clamped: true,
		},
		{
			name: 'last clip out edge behaves like a regular trim',
			setup: (h) => {
				h.ok([solid(0, 100, 'V1')]);
				return h.clips('V1')[0]!.id;
			},
			edge: 'out',
			delta: 25,
			expectSpans: [[0, 125]],
		},
	];
	for (const c of cases) {
		it(c.name, () => {
			const h = new Harness();
			const id = c.setup(h);
			const r = h.ok([{ type: 'clip.trim', clipId: id, edge: c.edge, deltaFrames: c.delta, mode: 'roll' }]);
			expect(h.spans('V1')).toEqual(c.expectSpans);
			expect(r.warnings.some((w) => w.code === 'W_DURATION_CLAMPED')).toBe(!!c.clamped);
		});
	}

	it('media handles limit both sides and source stays glued to the picture', () => {
		const h = new Harness();
		// A shows 0..3 s of its media (5 s long): 2 s tail handle. B shows 1..4 s: 1 s head handle.
		const [a] = place(h, 0, { seconds: 5, inSec: 0, outSec: 3, audio: false });
		const m = h.registerVideo({ seconds: 5, audio: false });
		h.ok([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 90,
				sourceRange: { in: { seconds: 1 }, out: { seconds: 4 } },
			},
		]);
		const b = h.clips('V1')[1]!.id;
		h.ok([{ type: 'clip.trim', clipId: a!, edge: 'out', deltaFrames: -100, mode: 'roll' }]);
		// B's head handle is 30 frames: the edit can move left by at most 30.
		expect(h.spans('V1')).toEqual([
			[0, 60],
			[60, 180],
		]);
		expect(byId(h, b).sourceIn).toBe(0);
		h.ok([{ type: 'clip.trim', clipId: a!, edge: 'out', deltaFrames: 1000, mode: 'roll' }]);
		// A's tail handle is 5 s - 2 s shown = 90 frames beyond 60 → 150, B keeps >= 1 frame (179).
		expect(h.spans('V1')).toEqual([
			[0, 150],
			[150, 180],
		]);
		expect(byId(h, b).sourceIn).toBe(90 * F30);
	});

	it('linked partners roll together; Alt (linked: false) rolls one side only', () => {
		const h = new Harness();
		const [v1, a1] = place(h, 0, { outSec: 3 });
		place(h, 90, { inSec: 2, outSec: 5 });
		h.ok([{ type: 'clip.trim', clipId: v1!, edge: 'out', deltaFrames: 10, mode: 'roll' }]);
		expect(h.spans('V1')).toEqual([
			[0, 100],
			[100, 180],
		]);
		expect(h.spans('A1')).toEqual([
			[0, 100],
			[100, 180],
		]);
		h.ok([{ type: 'clip.trim', clipId: a1!, edge: 'out', deltaFrames: -5, mode: 'roll', linked: false }]);
		expect(h.spans('V1')).toEqual([
			[0, 100],
			[100, 180],
		]);
		expect(h.spans('A1')).toEqual([
			[0, 95],
			[95, 180],
		]);
	});

	it('refuses on a locked track', () => {
		const h = new Harness();
		h.ok([solid(0, 100, 'V1'), solid(100, 50, 'V1')]);
		h.ok([{ type: 'track.update', trackId: 'V1', patch: { locked: true } }]);
		const r = h.tx([
			{ type: 'clip.trim', clipId: h.clips('V1')[0]!.id, edge: 'out', deltaFrames: 5, mode: 'roll' },
		]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0]!.code).toBe('E_TRACK_LOCKED');
	});
});

describe('clip.slip (S02:TL-625, AC-12b)', () => {
	it('AC-12b: a clip with 10 frames of head handle stops after 10 frames of rightward slip', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20, audio: false });
		h.ok([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 50,
				sourceRange: { in: { sourceFrames: 10 }, out: { sourceFrames: 110 } },
			},
		]);
		const id = h.clips('V1')[0]!.id;
		const r = h.ok([{ type: 'clip.slip', clipIds: [id], deltaFrames: 25 }]);
		expect(r.results[0]).toMatchObject({ deltaFrames: 10 });
		expect(r.warnings.map((w) => w.code)).toContain('W_DURATION_CLAMPED');
		const c = byId(h, id);
		expect([c.start, c.duration, c.sourceIn]).toEqual([50, 100, 0]);
	});

	it('leftward slip shows later material and stops at the end of the media', () => {
		const h = new Harness();
		const [id] = place(h, 0, { seconds: 5, inSec: 1, outSec: 4, audio: false });
		// 1 s of tail handle = 30 frames.
		h.ok([{ type: 'clip.slip', clipIds: [id!], deltaFrames: -100 }]);
		const c = byId(h, id!);
		expect(c.sourceIn).toBe(60 * F30);
		expect(sourceOut(c, RATES.r30)).toBe(150 * F30);
		expect([c.start, c.duration]).toEqual([0, 90]);
	});

	it.each([
		{ speed: 0.5, reverse: false, delta: 4, expectIn: 60 * F30 - 2 * F30 },
		{ speed: 2, reverse: false, delta: -3, expectIn: 60 * F30 + 6 * F30 },
		{ speed: 1, reverse: true, delta: 5, expectIn: 60 * F30 + 5 * F30 },
	])('speed $speed reverse $reverse slips by delta × F × rate', ({ speed, reverse, delta, expectIn }) => {
		const h = new Harness();
		const [id] = place(h, 0, { seconds: 20, inSec: 2, outSec: 4, audio: false });
		h.ok([{ type: 'clip.setSpeed', clipIds: [id!], rate: speed, reverse, ripple: true }]);
		const before = byId(h, id!);
		h.ok([{ type: 'clip.slip', clipIds: [id!], deltaFrames: delta }]);
		const after = byId(h, id!);
		expect(after.sourceIn).toBe(expectIn);
		expect([after.start, after.duration]).toEqual([before.start, before.duration]);
	});

	it('multi-clip slip moves in lockstep with the most restrictive handle', () => {
		const h = new Harness();
		const [a] = place(h, 0, { inSec: 1, outSec: 2, audio: false }); // 30 frames head
		const [b] = place(h, 100, { inSec: 0.5, outSec: 2, audio: false }); // 15 frames head
		h.ok([{ type: 'clip.slip', clipIds: [a!, b!], deltaFrames: 20 }]);
		expect(byId(h, a!).sourceIn).toBe(15 * F30);
		expect(byId(h, b!).sourceIn).toBe(0);
	});

	it('refuses when none of the selected clips can slip', () => {
		const h = new Harness();
		h.ok([solid(0, 100, 'V1')]);
		const r = h.tx([{ type: 'clip.slip', clipIds: [h.clips('V1')[0]!.id], deltaFrames: 3 }]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0]!.code).toBe('E_INVALID_PARAM');
	});
});

describe('clip.slide (S02:TL-630, AC-12c)', () => {
	it('AC-12c: sliding B between A and C by +12 lengthens A, shortens C, keeps B source and length', () => {
		const h = new Harness();
		const [a] = place(h, 0, { inSec: 0, outSec: 3, audio: false });
		const [b] = place(h, 90, { inSec: 2, outSec: 4, audio: false });
		const [c] = place(h, 150, { inSec: 5, outSec: 8, audio: false });
		const bSource = [byId(h, b!).sourceIn, sourceOut(byId(h, b!), RATES.r30)];
		const cIn = byId(h, c!).sourceIn;
		const len = sequenceDuration(h.seq);
		h.ok([{ type: 'clip.slide', clipId: b!, deltaFrames: 12 }]);
		expect(h.spans('V1')).toEqual([
			[0, 102],
			[102, 162],
			[162, 240],
		]);
		expect([byId(h, b!).sourceIn, sourceOut(byId(h, b!), RATES.r30)]).toEqual(bSource);
		expect(byId(h, a!).duration).toBe(102);
		expect(byId(h, c!).sourceIn).toBe(cIn + 12 * F30);
		expect(sequenceDuration(h.seq)).toBe(len);
	});

	it.each([
		{
			name: 'next clip keeps one frame',
			delta: 500,
			expect: [
				[0, 149],
				[149, 159],
				[159, 160],
			],
		},
		{
			name: 'previous clip keeps one frame',
			delta: -500,
			expect: [
				[0, 1],
				[1, 11],
				[11, 160],
			],
		},
	])('$name', ({ delta, expect: spans }) => {
		const h = new Harness();
		headed(h, 110, 50, 110);
		h.ok([solid(0, 100, 'V1'), solid(100, 10, 'V1')]);
		const b = h.clips('V1')[1]!.id;
		h.ok([{ type: 'clip.slide', clipId: b, deltaFrames: delta }]);
		expect(h.spans('V1')).toEqual(spans);
	});

	it('gap neighbours resize instead of clips; frame 0 bounds the slide', () => {
		const h = new Harness();
		headed(h, 50, 10, 50);
		h.ok([solid(20, 10, 'V1')]);
		const b = h.clips('V1')[0]!.id;
		h.ok([{ type: 'clip.slide', clipId: b, deltaFrames: 100 }]);
		expect(h.spans('V1')).toEqual([
			[40, 50],
			[50, 60],
		]);
		h.ok([{ type: 'clip.slide', clipId: b, deltaFrames: -100 }]);
		expect(h.spans('V1')).toEqual([
			[0, 10],
			[10, 60],
		]);
	});

	it('neighbour media limits stop the slide', () => {
		const h = new Harness();
		const [a] = place(h, 0, { seconds: 4, inSec: 0, outSec: 3, audio: false }); // 30 frames tail
		place(h, 90, { inSec: 2, outSec: 3, audio: false });
		const b = h.clips('V1')[1]!.id;
		h.ok([{ type: 'clip.slide', clipId: b, deltaFrames: 60 }]);
		expect(byId(h, a!).duration).toBe(120);
		expect(byId(h, b).start).toBe(120);
	});

	it('linked partners slide with the clip', () => {
		const h = new Harness();
		place(h, 0, { outSec: 3 });
		const [bv, ba] = place(h, 90, { inSec: 3, outSec: 5 });
		place(h, 150, { inSec: 6, outSec: 9 });
		h.ok([{ type: 'clip.slide', clipId: bv!, deltaFrames: -10 }]);
		expect(byId(h, bv!).start).toBe(80);
		expect(byId(h, ba!).start).toBe(80);
		expect(h.spans('A1')).toEqual(h.spans('V1'));
	});
});

describe('clip.setSpeed (S01:CLP-008, S02 AC-12d)', () => {
	it('AC-12d: stretching a 100-frame clip to 200 frames yields speed 0.5 and the same source range', () => {
		const h = new Harness();
		const [id] = place(h, 0, { inSec: 1, outSec: 1 + 100 / 30, audio: false });
		const c0 = byId(h, id!);
		expect(c0.duration).toBe(100);
		h.ok([{ type: 'clip.setSpeed', clipIds: [id!], duration: 200, ripple: true }]);
		const c = byId(h, id!);
		expect(c.speed.rate).toBe(0.5);
		expect(c.duration).toBe(200);
		expect([c.sourceIn, sourceOut(c, RATES.r30)]).toEqual([c0.sourceIn, sourceOut(c0, RATES.r30)]);
	});

	it('a rate derives the duration from the source span', () => {
		const h = new Harness();
		const [id] = place(h, 0, { outSec: 3, audio: false });
		h.ok([{ type: 'clip.setSpeed', clipIds: [id!], rate: 2, ripple: false }]);
		expect([byId(h, id!).duration, byId(h, id!).speed.rate]).toEqual([45, 2]);
	});

	it('without ripple the duration is clamped to the next clip and the rate is kept', () => {
		const h = new Harness();
		const [id] = place(h, 0, { outSec: 3, audio: false });
		h.ok([solid(120, 30, 'V1')]);
		const r = h.ok([{ type: 'clip.setSpeed', clipIds: [id!], rate: 0.5, ripple: false }]);
		expect([byId(h, id!).duration, byId(h, id!).speed.rate]).toEqual([120, 0.5]);
		expect(r.warnings.map((w) => w.code)).toContain('W_DURATION_CLAMPED');
	});

	it('with ripple later clips and sync-locked tracks shift', () => {
		const h = new Harness();
		const [id] = place(h, 0, { outSec: 3, audio: false });
		h.ok([solid(120, 30, 'V1'), solid(200, 30, 'V2')]);
		h.ok([{ type: 'clip.setSpeed', clipIds: [id!], rate: 0.5, ripple: true }]);
		expect(h.spans('V1')).toEqual([
			[0, 180],
			[210, 240],
		]);
		expect(h.spans('V2')).toEqual([[290, 320]]);
	});

	it('linked V/A shift sync-locked followers only once', () => {
		const h = new Harness();
		const [v, a] = place(h, 0, { outSec: 3 });
		h.ok([solid(200, 30, 'V2')]);
		h.ok([{ type: 'clip.setSpeed', clipIds: [v!, a!], rate: 0.5, ripple: true }]);
		expect(h.spans('V1')).toEqual([[0, 180]]);
		expect(h.spans('A1')).toEqual([[0, 180]]);
		expect(h.spans('V2')).toEqual([[290, 320]]);
	});

	it('reverse flips the mapping without touching sourceIn or duration', () => {
		const h = new Harness();
		const [id] = place(h, 0, { inSec: 2, outSec: 4, audio: false });
		const c0 = byId(h, id!);
		h.ok([{ type: 'clip.setSpeed', clipIds: [id!], reverse: true, ripple: false }]);
		const c = byId(h, id!);
		expect(c.speed.reverse).toBe(true);
		expect([c.sourceIn, c.duration]).toEqual([c0.sourceIn, c0.duration]);
	});

	it('clips without speed (stills, text, solids) only change duration', () => {
		const h = new Harness();
		h.ok([solid(0, 100, 'V1')]);
		const id = h.clips('V1')[0]!.id;
		const r = h.ok([{ type: 'clip.setSpeed', clipIds: [id], rate: 2, duration: 50, ripple: false }]);
		expect([byId(h, id).duration, byId(h, id).speed.rate]).toEqual([50, 1]);
		expect(r.warnings.map((w) => w.code)).toContain('W_VALUE_CLAMPED');
	});
});

describe('clip.duplicate (S01 clip.duplicate, S02:TL-683, S01:CLB-012)', () => {
	it('copies to the first free space to the right with new ids and a mirrored link group', () => {
		const h = new Harness();
		const [v, a] = place(h, 0, { outSec: 2 });
		h.ok([solid(60, 10, 'V1')]); // blocks the space right after the selection on V1
		const r = h.ok([{ type: 'clip.duplicate', clipIds: [v!, a!] }]);
		const res = r.results[0] as { clipIds: string[]; map: Record<string, string> };
		const cv = byId(h, res.map[v!]!);
		const ca = byId(h, res.map[a!]!);
		expect([cv.start, ca.start]).toEqual([70, 70]);
		expect(cv.linkId).not.toBeNull();
		expect(cv.linkId).toBe(ca.linkId);
		expect(cv.linkId).not.toBe(byId(h, v!).linkId);
		expect(cv.sourceIn).toBe(byId(h, v!).sourceIn);
	});

	it('deltaFrames and destination tracks place copies with overwrite semantics', () => {
		const h = new Harness();
		h.ok([solid(0, 100, 'V1'), solid(0, 300, 'V2')]);
		const src = h.clips('V1')[0]!.id;
		h.ok([{ type: 'clip.duplicate', clipIds: [src], deltaFrames: 150, tracks: ['V2'] }]);
		expect(h.spans('V2')).toEqual([
			[0, 150],
			[150, 250],
			[250, 300],
		]);
		expect(h.spans('V1')).toEqual([[0, 100]]);
	});

	it('copies keyframes with fresh ids', () => {
		const h = new Harness();
		h.ok([solid(0, 100, 'V1')]);
		const src = h.clips('V1')[0]!.id;
		h.ok([
			{ type: 'param.setAnimated', target: ['clip', src, 'opacity'], animated: true, at: { frames: 0 } },
		]);
		const r = h.ok([{ type: 'clip.duplicate', clipIds: [src], at: 200 }]);
		const copy = byId(h, (r.results[0] as { clipIds: string[] }).clipIds[0]!) as Extract<
			Clip,
			{ kind: 'solid' }
		>;
		const orig = byId(h, src) as Extract<Clip, { kind: 'solid' }>;
		expect(copy.opacity.keyframes).toHaveLength(1);
		expect(copy.opacity.keyframes[0]!.id).not.toBe(orig.opacity.keyframes[0]!.id);
		expect(copy.start).toBe(200);
	});
});

describe('clip.link / clip.unlink (S01:CLP-010, S02:TL-704)', () => {
	it('unlink dissolves the group; link re-creates one', () => {
		const h = new Harness();
		const [v, a] = place(h, 0, { outSec: 2 });
		h.ok([{ type: 'clip.unlink', clipIds: [v!] }]);
		expect(byId(h, v!).linkId).toBeNull();
		expect(byId(h, a!).linkId).toBeNull();
		expect(Object.keys(h.seq.links)).toHaveLength(0);
		const r = h.ok([{ type: 'clip.link', clipIds: [v!, a!] }]);
		const linkId = (r.results[0] as { linkId: string }).linkId;
		expect(byId(h, v!).linkId).toBe(linkId);
		expect(byId(h, a!).linkId).toBe(linkId);
	});

	it.each([
		{
			name: 'two clips on one track',
			build: (h: Harness): string[] => {
				const mediaId = h.registerVideo({ kind: 'audio', seconds: 2 });
				return h
					.ok(
						[0, 20].map((at) => ({
							type: 'clip.place',
							source: { mediaId },
							at,
							sourceRange: { in: { seconds: 0 }, out: { seconds: 0.25 } },
							tracks: { audio: 'A1' },
						})),
					)
					.results.flatMap((x) => (x as { clipIds: string[] }).clipIds);
			},
		},
		{ name: 'two video clips', build: [solid(0, 10, 'V1'), solid(0, 10, 'V2')] },
		{ name: 'a single clip', build: [solid(0, 10, 'V1')] },
	])('link refuses $name', ({ build }) => {
		const h = new Harness();
		const ids =
			typeof build === 'function'
				? build(h)
				: h.ok(build).results.map((x) => (x as { clipId: string }).clipId);
		const r = h.tx([{ type: 'clip.link', clipIds: ids }]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0]!.code).toBe('E_INVALID_PARAM');
	});

	it('linking moves a clip out of its previous group (dissolving it when it drops below two)', () => {
		const h = new Harness();
		const [v, a] = place(h, 0, { outSec: 2 });
		h.ok([solid(0, 60, 'V2')]);
		const s = h.clips('V2')[0]!.id;
		h.ok([{ type: 'clip.link', clipIds: [s, a!] }]);
		expect(byId(h, a!).linkId).toBe(byId(h, s).linkId);
		expect(byId(h, v!).linkId).toBeNull();
	});
});

describe('clip.fitToFrame (S01:FX-004)', () => {
	it.each([
		{ mode: 'fit', w: 3840, h: 2160, scale: 50 },
		{ mode: 'fill', w: 1920, h: 800, scale: 135 },
		{ mode: 'none', w: 3840, h: 2160, scale: 100 },
	] as const)('$mode on a $w×$h clip in 1080p', ({ mode, w, h: hh, scale }) => {
		const h = new Harness();
		const m = h.registerVideo({ width: w, height: hh, audio: false });
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0, scaling: 'none' }]);
		const id = h.clips('V1')[0]!.id;
		h.ok([{ type: 'clip.fitToFrame', clipIds: [id], mode }]);
		const c = byId(h, id) as Extract<Clip, { kind: 'video' }>;
		expect(c.transform.scale.value).toBeCloseTo(scale, 6);
	});

	it('skips clips without a transform and refuses when none has one', () => {
		const h = new Harness();
		const [, a] = place(h, 0, { outSec: 1 });
		const r = h.tx([{ type: 'clip.fitToFrame', clipIds: [a!], mode: 'fit' }]);
		expect(r).toMatchObject({ ok: false, errors: [{ code: 'E_INVALID_PARAM' }] });
	});
});

describe('range.lift / range.extract (S02:TL-690, AC-13d, AC-16b)', () => {
	it('AC-13d: extract In=100 Out=199 removes exactly 100 frames from targeted and sync-locked tracks', () => {
		const h = new Harness();
		h.ok([solid(0, 300, 'V1'), solid(50, 300, 'V2')]);
		const m = h.registerVideo({ seconds: 20, kind: 'audio' });
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: 'A1' } }]);
		const before = sequenceDuration(h.seq);
		h.ok([{ type: 'sequence.setInOut', in: 100, out: 200 }]);
		h.ok([{ type: 'range.extract', from: 100, to: 200, tracks: ['V1'] }]);
		expect(h.spans('V1')).toEqual([
			[0, 100],
			[100, 200],
		]);
		expect(h.spans('V2')).toEqual([
			[50, 100],
			[100, 250],
		]);
		expect(h.spans('A1')).toEqual([
			[0, 100],
			[100, 500],
		]);
		expect(sequenceDuration(h.seq)).toBe(before - 100);
	});

	it('tracks that are neither targeted nor sync-locked are untouched; locked tracks never shift', () => {
		const h = new Harness();
		h.ok([solid(0, 300, 'V1'), solid(0, 300, 'V2'), solid(0, 300, 'V3')]);
		h.ok([
			{ type: 'track.update', trackId: 'V2', patch: { syncLock: false } },
			{ type: 'track.update', trackId: 'V3', patch: { locked: true } },
		]);
		h.ok([{ type: 'range.extract', from: 100, to: 150, tracks: ['V1'] }]);
		expect(h.spans('V1')).toEqual([
			[0, 100],
			[100, 250],
		]);
		expect(h.spans('V2')).toEqual([[0, 300]]);
		expect(h.spans('V3')).toEqual([[0, 300]]);
	});

	it('lift leaves a gap and splits clips at In and Out with relinked right parts', () => {
		const h = new Harness();
		const [v, a] = place(h, 0, { outSec: 10 });
		h.ok([{ type: 'range.lift', from: 100, to: 150, tracks: ['V1', 'A1'] }]);
		expect(h.spans('V1')).toEqual([
			[0, 100],
			[150, 300],
		]);
		expect(h.spans('A1')).toEqual(h.spans('V1'));
		const rightV = h.clips('V1')[1]!;
		const rightA = h.clips('A1')[1]!;
		expect(rightV.linkId).not.toBeNull();
		expect(rightV.linkId).toBe(rightA.linkId);
		expect(byId(h, v!).linkId).toBe(byId(h, a!).linkId);
		expect(rightV.sourceIn).toBe(150 * F30);
	});

	it('AC-16b: extracting 30 frames before a marker moves it 30 frames left (and keeps it with rippleMarkers false)', () => {
		const h = new Harness();
		h.ok([solid(0, 300, 'V1'), { type: 'marker.add', frame: 200, name: 'm' }]);
		h.ok([{ type: 'range.extract', from: 50, to: 80, tracks: ['V1'] }]);
		expect(h.seq.markers[0]!.frame).toBe(170);
		h.ok([{ type: 'range.extract', from: 50, to: 80, tracks: ['V1'], rippleMarkers: false }]);
		expect(h.seq.markers[0]!.frame).toBe(170);
	});

	it('refuses an empty range and an explicitly locked track', () => {
		const h = new Harness();
		h.ok([solid(0, 300, 'V1')]);
		expect(h.tx([{ type: 'range.lift', from: 100, to: 100 }])).toMatchObject({
			ok: false,
			errors: [{ code: 'E_INVALID_PARAM' }],
		});
		h.ok([{ type: 'track.update', trackId: 'V1', patch: { locked: true } }]);
		const r = h.tx([{ type: 'range.extract', from: 0, to: 10, tracks: ['V1'] }]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0]!.code).toBe('E_TRACK_LOCKED');
	});
});

describe('gap.close (S02:TL-741)', () => {
	it('closes the gap and ripples sync-locked tracks that are empty in the gap range', () => {
		const h = new Harness();
		h.ok([
			solid(0, 50, 'V1'),
			solid(100, 50, 'V1'),
			solid(150, 50, 'V2'),
			{ type: 'marker.add', frame: 120 },
		]);
		h.ok([{ type: 'gap.close', trackId: 'V1', at: 70 }]);
		expect(h.spans('V1')).toEqual([
			[0, 50],
			[50, 100],
		]);
		expect(h.spans('V2')).toEqual([[100, 150]]);
		expect(h.seq.markers[0]!.frame).toBe(70);
	});

	it('refuses with E_SYNC_CONFLICT naming the blocking clip; sync lock off makes it succeed', () => {
		const h = new Harness();
		h.ok([solid(0, 50, 'V1'), solid(100, 50, 'V1'), solid(60, 10, 'V2')]);
		const blocker = h.clips('V2')[0]!.id;
		const r = h.tx([{ type: 'gap.close', trackId: 'V1', at: 70 }]);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errors[0]!.code).toBe('E_SYNC_CONFLICT');
			expect(r.errors[0]!.blocking).toContain(blocker);
		}
		h.ok([{ type: 'track.update', trackId: 'V2', patch: { syncLock: false } }]);
		h.ok([{ type: 'gap.close', trackId: 'V1', at: 70 }]);
		expect(h.spans('V1')).toEqual([
			[0, 50],
			[50, 100],
		]);
		expect(h.spans('V2')).toEqual([[60, 70]]);
	});

	it('the area after the last clip is not a gap', () => {
		const h = new Harness();
		h.ok([solid(0, 50, 'V1')]);
		expect(h.tx([{ type: 'gap.close', trackId: 'V1', at: 70 }])).toMatchObject({
			ok: false,
			errors: [{ code: 'E_INVALID_PARAM' }],
		});
	});
});

describe('S02 acceptance (model level)', () => {
	it('AC-11d: Q (ripple-remove [clipStart, playhead)) removes the head and closes the gap', () => {
		const h = new Harness();
		h.ok([solid(0, 100, 'V1'), solid(100, 100, 'V1')]);
		const c = h.clips('V1')[1]!;
		const playhead = 130;
		h.ok([{ type: 'clip.trim', clipId: c.id, edge: 'in', deltaFrames: playhead - c.start, mode: 'ripple' }]);
		expect(h.spans('V1')).toEqual([
			[0, 100],
			[100, 170],
		]);
		expect(byId(h, c.id).sourceIn).toBe(30 * F30);
	});

	it('AC-13a: Add Edit on targeted V1/A1 splits only V1/A1 clips crossing 240', () => {
		const h = new Harness();
		place(h, 0, { outSec: 10 });
		h.ok([solid(0, 400, 'V2')]);
		h.ok([{ type: 'clip.split', at: 240, tracks: ['V1', 'A1'] }]);
		expect(h.spans('V1')).toEqual([
			[0, 240],
			[240, 300],
		]);
		expect(h.spans('A1')).toEqual(h.spans('V1'));
		expect(h.spans('V2')).toEqual([[0, 400]]);
	});
});

type Op =
	| { k: 'roll'; clip: number; edge: boolean; delta: number; linked: boolean }
	| { k: 'slip'; clip: number; n: number; delta: number }
	| { k: 'slide'; clip: number; delta: number }
	| { k: 'speed'; clip: number; rate: number; ripple: boolean; byDuration: boolean; dur: number }
	| { k: 'dup'; clip: number; n: number; delta: number; auto: boolean }
	| { k: 'link'; a: number; b: number }
	| { k: 'unlink'; clip: number }
	| { k: 'fit'; clip: number; mode: number }
	| { k: 'lift'; from: number; len: number; extract: boolean; all: boolean }
	| { k: 'gap'; track: number; at: number }
	| { k: 'split'; at: number }
	| { k: 'lock'; track: number; locked: boolean; sync: boolean };

const small = fc.integer({ min: -120, max: 120 });
const op: fc.Arbitrary<Op> = fc.oneof(
	fc.record({
		k: fc.constant('roll' as const),
		clip: fc.nat(99),
		edge: fc.boolean(),
		delta: small,
		linked: fc.boolean(),
	}),
	fc.record({
		k: fc.constant('slip' as const),
		clip: fc.nat(99),
		n: fc.integer({ min: 1, max: 3 }),
		delta: small,
	}),
	fc.record({ k: fc.constant('slide' as const), clip: fc.nat(99), delta: small }),
	fc.record({
		k: fc.constant('speed' as const),
		clip: fc.nat(99),
		rate: fc.constantFrom(0.25, 0.5, 1, 1.5, 2, 4),
		ripple: fc.boolean(),
		byDuration: fc.boolean(),
		dur: fc.integer({ min: 1, max: 400 }),
	}),
	fc.record({
		k: fc.constant('dup' as const),
		clip: fc.nat(99),
		n: fc.integer({ min: 1, max: 2 }),
		delta: small,
		auto: fc.boolean(),
	}),
	fc.record({ k: fc.constant('link' as const), a: fc.nat(99), b: fc.nat(99) }),
	fc.record({ k: fc.constant('unlink' as const), clip: fc.nat(99) }),
	fc.record({ k: fc.constant('fit' as const), clip: fc.nat(99), mode: fc.nat(2) }),
	fc.record({
		k: fc.constant('lift' as const),
		from: fc.integer({ min: 0, max: 600 }),
		len: fc.integer({ min: 1, max: 150 }),
		extract: fc.boolean(),
		all: fc.boolean(),
	}),
	fc.record({
		k: fc.constant('gap' as const),
		track: fc.integer({ min: 1, max: 3 }),
		at: fc.integer({ min: 0, max: 600 }),
	}),
	fc.record({ k: fc.constant('split' as const), at: fc.integer({ min: 0, max: 600 }) }),
	fc.record({
		k: fc.constant('lock' as const),
		track: fc.integer({ min: 1, max: 3 }),
		locked: fc.boolean(),
		sync: fc.boolean(),
	}),
);

function concretize(o: Op, doc: ProjectDocument): unknown {
	const seq = Object.values(doc.sequences)[0]!;
	const ids = Object.keys(seq.clips).sort();
	const pick = (i: number) => ids[i % Math.max(1, ids.length)] ?? 'clp_0000000000000000';
	switch (o.k) {
		case 'roll':
			return {
				type: 'clip.trim',
				clipId: pick(o.clip),
				edge: o.edge ? 'in' : 'out',
				deltaFrames: o.delta,
				mode: 'roll',
				linked: o.linked,
			};
		case 'slip':
			return {
				type: 'clip.slip',
				clipIds: Array.from({ length: o.n }, (_, i) => pick(o.clip + i * 5)),
				deltaFrames: o.delta,
			};
		case 'slide':
			return { type: 'clip.slide', clipId: pick(o.clip), deltaFrames: o.delta };
		case 'speed':
			return o.byDuration
				? { type: 'clip.setSpeed', clipIds: [pick(o.clip)], duration: o.dur, ripple: o.ripple }
				: { type: 'clip.setSpeed', clipIds: [pick(o.clip)], rate: o.rate, ripple: o.ripple };
		case 'dup':
			return o.auto
				? { type: 'clip.duplicate', clipIds: Array.from({ length: o.n }, (_, i) => pick(o.clip + i)) }
				: {
						type: 'clip.duplicate',
						clipIds: Array.from({ length: o.n }, (_, i) => pick(o.clip + i)),
						deltaFrames: o.delta,
					};
		case 'link':
			return { type: 'clip.link', clipIds: [pick(o.a), pick(o.b)] };
		case 'unlink':
			return { type: 'clip.unlink', clipIds: [pick(o.clip)] };
		case 'fit':
			return {
				type: 'clip.fitToFrame',
				clipIds: [pick(o.clip)],
				mode: (['fit', 'fill', 'none'] as const)[o.mode],
			};
		case 'lift':
			return {
				type: o.extract ? 'range.extract' : 'range.lift',
				from: o.from,
				to: o.from + o.len,
				...(o.all ? {} : { tracks: ['V1', 'A1'] }),
			};
		case 'gap':
			return { type: 'gap.close', trackId: `V${o.track}`, at: o.at };
		case 'split':
			return { type: 'clip.split', at: o.at, scope: 'all-unlocked' };
		case 'lock':
			return { type: 'track.update', trackId: `V${o.track}`, patch: { locked: o.locked, syncLock: o.sync } };
	}
}

describe('invariants under random WP-2B commands (S02:TL-1051)', () => {
	it('every committed document passes INV-001…015; rejections leave the document unchanged', () => {
		const h = new Harness({ seed: 5 });
		place(h, 0, { outSec: 4 });
		place(h, 150, { inSec: 3, outSec: 8, v: 'V2' });
		h.ok([solid(100, 90, 'V1'), solid(0, 60, 'V3'), { type: 'marker.add', frame: 300 }]);
		const base = h.doc;
		const ids = createRandomIdSource();
		let successes = 0;
		fc.assert(
			fc.property(
				fc.array(fc.array(op, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 6 }),
				(txs) => {
					let doc = base;
					let revision = 0;
					for (const tx of txs) {
						const commands = tx.map((o) => concretize(o, doc));
						const { document, result } = applyTransaction(
							doc,
							{ label: 'prop', origin: 'user', commands },
							makeCtx({ revision }, ids),
						);
						if (result.ok) {
							successes++;
							const issues = checkInvariants(document);
							if (issues.length)
								throw new Error(`invariants: ${JSON.stringify(issues)} after ${JSON.stringify(commands)}`);
							const dry = applyTransaction(
								doc,
								{ label: 'prop', origin: 'user', commands, dryRun: true },
								makeCtx({ revision }, createRandomIdSource()),
							);
							if (!dry.result.ok || dry.document !== doc) throw new Error('dry run disagreed or mutated');
							doc = document;
							revision = result.revision;
						} else {
							if (document !== doc) throw new Error('rejected transaction changed the document');
							const bad = result.errors.filter((e) => e.code === 'E_INVARIANT' || e.code === 'E_INTERNAL');
							if (bad.length)
								throw new Error(`invalid document: ${JSON.stringify(bad)} for ${JSON.stringify(commands)}`);
						}
					}
				},
			),
			{ numRuns: 1500, seed: 20260930 },
		);
		expect(successes).toBeGreaterThan(0);
	});
});
