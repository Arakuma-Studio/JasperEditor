// Time Remapping model (workstream `time`): curve evaluation, ramps, edits, bounds and frame selection.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	addKeyframe,
	clipMediaExtent,
	clipMediaTimeAt,
	clipSpeedAt,
	flicksPerFrame,
	frameIndexAt,
	insertHold,
	insertReverse,
	moveKeyframe,
	newRemap,
	pickFrames,
	type RemapKeyframe,
	remapEvaluator,
	remapFitDuration,
	remapRoom,
	remapSegmentViews,
	remapSlopes,
	remapSourceAt,
	removeKeyframes,
	setRamp,
	setSegmentSpeed,
	type TimeRemap,
} from '../src/index.ts';

const R30 = { num: 30, den: 1 };
const F = flicksPerFrame(R30);
let n = 0;
const newId = () => `kf_T${String(++n).padStart(15, '0')}`;
const key = (time: number, source: number, extra: Partial<RemapKeyframe> = {}): RemapKeyframe => ({
	id: newId(),
	time,
	source,
	...extra,
});
const remap = (keys: RemapKeyframe[], extra: Partial<TimeRemap> = {}): TimeRemap => ({
	enabled: true,
	keyframes: keys,
	speedBefore: 1,
	speedAfter: 1,
	...extra,
});
const clipWith = (r: TimeRemap | null, extra: Record<string, unknown> = {}) => ({
	kind: 'video',
	start: 100,
	duration: 90,
	sourceIn: 0,
	speed: { rate: 1, reverse: false },
	timeRemap: r,
	...extra,
});

describe('remap curve', () => {
	it('is the identity without keyframes', () => {
		const r = newRemap();
		for (const c of [0, 12345, 9e9]) expect(remapSourceAt(r, c)).toBe(c);
		expect(remapSlopes(r)).toEqual([1]);
	});

	it('is piecewise linear through its keyframes with edge slopes', () => {
		const r = remap([key(30 * F, 30 * F), key(60 * F, 45 * F), key(90 * F, 45 * F)], {
			speedBefore: 2,
			speedAfter: -1,
		});
		const ev = remapEvaluator(r);
		expect(ev(0).m).toBeCloseTo(30 * F - 60 * F, 3);
		expect(ev(45 * F).m).toBeCloseTo(37.5 * F, 3);
		expect(ev(45 * F).slope).toBeCloseTo(0.5);
		expect(ev(75 * F).slope).toBe(0);
		expect(ev(100 * F).m).toBeCloseTo(35 * F, 3);
	});

	it('speed transitions keep both keyframe anchors and are C1', () => {
		const r = remap([key(30 * F, 30 * F, { ramp: 6 * F }), key(60 * F, 75 * F, { ramp: 4 * F, ease: 0 })]);
		const ev = remapEvaluator(r);
		// Ends of the first transition lie on the polyline.
		expect(ev(24 * F).m).toBeCloseTo(24 * F, 1);
		expect(ev(36 * F).m).toBeCloseTo(30 * F + 6 * F * 1.5, 1);
		// Continuity of m and slope at every transition edge.
		for (const c of [24 * F, 36 * F, 56 * F, 64 * F]) {
			const a = ev(c - 1);
			const b = ev(c + 1);
			expect(Math.abs(a.m - b.m)).toBeLessThan(5);
			expect(Math.abs(a.slope - b.slope)).toBeLessThan(1e-3);
		}
		// The slope integrates to the media time (numerical check through the transition).
		let m = ev(20 * F).m;
		const step = F / 64;
		for (let c = 20 * F; c < 70 * F; c += step) m += ((ev(c).slope + ev(c + step).slope) / 2) * step;
		expect(m).toBeCloseTo(ev(70 * F).m, -1);
	});

	it('finds the zero-speed point inside a transition into reverse', () => {
		const r = remap([key(0, 0), key(30 * F, 30 * F, { ramp: 10 * F }), key(60 * F, 0)]);
		const c = clipWith(r, { start: 0, duration: 61 });
		const { max } = clipMediaExtent(c, 0, 60, R30);
		// The peak is inside the transition, before 30 frames of media (the corner is rounded off).
		expect(max).toBeLessThan(30 * F);
		expect(max).toBeGreaterThan(25 * F);
		let peak = 0;
		for (let f = 0; f <= 600; f++) peak = Math.max(peak, clipMediaTimeAt(c, f / 10, R30));
		expect(max).toBeGreaterThanOrEqual(peak - 1);
	});

	it('property: media time is continuous and finite for random curves', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						dt: fc.integer({ min: 1, max: 60 }),
						dm: fc.integer({ min: -60, max: 60 }),
						ramp: fc.integer({ min: 0, max: 30 }),
						ease: fc.double({ min: 0, max: 1, noNaN: true }),
					}),
					{ minLength: 1, maxLength: 8 },
				),
				(steps) => {
					let t = 0;
					let m = 1000 * F;
					const keys = steps.map((s) => {
						t += s.dt * F;
						m += s.dm * F;
						return key(t, m, { ramp: s.ramp * F, ease: s.ease });
					});
					const ev = remapEvaluator(remap(keys, { speedBefore: 0.5, speedAfter: 3 }));
					let prev = ev(-F).m;
					for (let c = 0; c <= t + 10 * F; c += F / 8) {
						const v = ev(c);
						expect(Number.isFinite(v.m) && Number.isFinite(v.slope)).toBe(true);
						// |Δm| ≤ max |slope| · Δc (slopes are at most 60 here) + rounding.
						expect(Math.abs(v.m - prev)).toBeLessThanOrEqual(61 * (F / 8) + 1);
						prev = v.m;
					}
				},
			),
			{ numRuns: 200 },
		);
	});
});

describe('clip mapping', () => {
	it('maps frames through content time and reports timeline speed', () => {
		const r = remap([key(0, 0), key(30 * F, 15 * F)], { speedAfter: 2 });
		const c = clipWith(r, { speed: { rate: 2, reverse: false } });
		// content runs 2 frames per frame; the first segment shows half of it.
		expect(clipMediaTimeAt(c, 100, R30)).toBe(0);
		expect(clipMediaTimeAt(c, 110, R30)).toBeCloseTo(10 * F, 3);
		expect(clipSpeedAt(c, 110, R30)).toBeCloseTo(1);
		expect(clipSpeedAt(c, 130, R30)).toBeCloseTo(4);
		const segs = remapSegmentViews(c, R30);
		expect(segs.map((s) => [s.kind, Math.round(s.speed * 100)])).toEqual([
			['forward', 100],
			['forward', 400],
		]);
	});

	it('ignores remaps on non-video clips and disabled remaps', () => {
		const r = remap([key(0, 0), key(30 * F, 0)]);
		expect(clipMediaTimeAt({ ...clipWith(r), kind: 'audio' }, 120, R30)).toBe(20 * F);
		expect(clipMediaTimeAt(clipWith({ ...r, enabled: false }), 120, R30)).toBe(20 * F);
	});
});

describe('edits', () => {
	const win = { c0: 0, c1: 90 * F };

	it('slowing a middle segment keeps its frames and pushes everything after it', () => {
		const base = remap([key(30 * F, 30 * F), key(60 * F, 60 * F)]);
		const e = setSegmentSpeed(base, 45 * F, 0.5, win, newId);
		const [a, b] = e.remap.keyframes;
		expect(a!.time).toBe(30 * F);
		expect(b!.time).toBeCloseTo(90 * F, 3);
		expect(b!.source).toBe(60 * F);
		// The clip's out point (content 90 F, media 90 F) moves 30 frames later and keeps its picture.
		expect(e.shift(90 * F)).toBeCloseTo(120 * F, 3);
		expect(remapSourceAt(e.remap, e.shift(90 * F))).toBeCloseTo(90 * F, 3);
		// Before the segment nothing moves.
		expect(e.shift(10 * F)).toBe(10 * F);
	});

	it('the first segment is anchored at the clip start, the last at its end', () => {
		const base = remap([key(30 * F, 30 * F)]);
		const head = setSegmentSpeed(base, 10 * F, 2, win, newId);
		expect(head.remap.keyframes[0]!.time).toBeCloseTo(15 * F, 3);
		expect(remapSourceAt(head.remap, 0)).toBeCloseTo(0, 3);
		expect(head.shift(90 * F)).toBeCloseTo(75 * F, 3);
		const tail = setSegmentSpeed(base, 60 * F, 4, win, newId);
		expect(tail.shift(90 * F)).toBeCloseTo(30 * F + 15 * F, 3);
		expect(remapSourceAt(tail.remap, tail.shift(90 * F))).toBeCloseTo(90 * F, 3);
	});

	it('changes a key-less remap by anchoring the first frame', () => {
		const e = setSegmentSpeed(newRemap(), 40 * F, 0.25, win, newId);
		expect(e.created).toHaveLength(1);
		expect(e.shift(90 * F)).toBeCloseTo(360 * F, 2);
		expect(remapSourceAt(e.remap, 0)).toBe(0);
	});

	it('keeps reverse segments reverse and refuses to speed a freeze', () => {
		const base = remap([key(0, 60 * F), key(30 * F, 30 * F), key(60 * F, 30 * F)]);
		const e = setSegmentSpeed(base, 10 * F, 2, win, newId);
		expect(e.remap.keyframes[1]!.time).toBeCloseTo(15 * F, 3);
		expect(remapSlopes(e.remap)[1]).toBeCloseTo(-2);
		expect(() => setSegmentSpeed(base, 45 * F, 2, win, newId)).toThrow(/freeze/);
		expect(() => setSegmentSpeed(base, 45 * F, 0, win, newId)).toThrow();
	});

	it('adding a keyframe never changes the picture', () => {
		const base = remap([key(30 * F, 30 * F)], { speedAfter: 0.5 });
		const e = addKeyframe(base, 50 * F, newId);
		for (let c = 0; c < 90 * F; c += F)
			expect(remapSourceAt(e.remap, c)).toBeCloseTo(remapSourceAt(base, c), 4);
		expect(() => addKeyframe(setRamp(base, base.keyframes[0]!.id, 5 * F).remap, 32 * F, newId)).toThrow(
			/transition/,
		);
	});

	it('freeze and palindrome reverse insert segments and move what follows', () => {
		const base = remap([]);
		const hold = insertHold(base, 30 * F, 20 * F, newId);
		expect(hold.remap.keyframes.map((k) => [k.time / F, k.source / F])).toEqual([
			[30, 30],
			[50, 30],
		]);
		expect(hold.shift(90 * F)).toBe(110 * F);
		const rev = insertReverse(base, 30 * F, 10 * F, 1, newId);
		expect(rev.remap.keyframes.map((k) => [k.time / F, k.source / F])).toEqual([
			[30, 30],
			[40, 20],
			[50, 30],
		]);
		expect(rev.shift(90 * F)).toBe(110 * F);
		// Never before media 0.
		const early = insertReverse(base, 5 * F, 30 * F, 1, newId);
		expect(early.remap.keyframes[1]!.source).toBe(0);
	});

	it('moving the first freeze keyframe slips the held frame; the second changes the hold length', () => {
		const h = insertHold(remap([]), 30 * F, 20 * F, newId).remap;
		const [k1, k2] = h.keyframes;
		const slip = moveKeyframe(h, k1!.id, 40 * F);
		expect(slip.remap.keyframes.map((k) => [k.time / F, k.source / F])).toEqual([
			[40, 40],
			[60, 40],
		]);
		const longer = moveKeyframe(h, k2!.id, 60 * F);
		expect(longer.remap.keyframes.map((k) => [k.time / F, k.source / F])).toEqual([
			[30, 30],
			[60, 30],
		]);
		expect(longer.shift(90 * F)).toBeCloseTo(100 * F, 3);
	});

	it('removing keyframes keeps the neighbours', () => {
		const base = remap([key(0, 0), key(30 * F, 15 * F), key(60 * F, 45 * F)]);
		const e = removeKeyframes(base, [base.keyframes[1]!.id]);
		expect(e.remap.keyframes).toHaveLength(2);
		expect(remapSourceAt(e.remap, 30 * F)).toBeCloseTo(22.5 * F, 3);
		const all = removeKeyframes(
			base,
			base.keyframes.map((k) => k.id),
		);
		expect(remapSourceAt(all.remap, 77)).toBe(77);
	});
});

describe('bounds', () => {
	const dur = 120 * F;
	it('room is limited by the media at both ends', () => {
		const c = clipWith(remap([key(0, 0)], { speedAfter: 0.5 }), { start: 100, duration: 60 });
		// 60 frames at 50 % show media 0…29.5; the media holds 120 frames → 180 more frames at 50 %.
		expect(remapRoom(c, R30, dur)).toEqual({ head: 0, tail: 180 });
		expect(remapFitDuration(c, 1000, R30, dur)).toBe(240);
		expect(remapRoom(c, R30, null).tail).toBe(Number.POSITIVE_INFINITY);
	});
});

describe('frame selection', () => {
	it('picks the last frame at or before the media time', () => {
		const cfr = { kind: 'cfr', rate: R30, count: 100 } as const;
		expect(frameIndexAt(cfr, 0)).toBe(0);
		expect(frameIndexAt(cfr, 1 / 30)).toBe(1);
		expect(frameIndexAt(cfr, 1 / 30 - 1e-4)).toBe(0);
		expect(frameIndexAt(cfr, 99)).toBe(99);
		const vfr = { kind: 'list', times: [0, 0.03, 0.1, 0.12, 0.3] } as const;
		expect(frameIndexAt(vfr, 0.05)).toBe(1);
		expect(frameIndexAt(vfr, 0.29999)).toBe(3);
		expect(pickFrames(vfr, 0.2, 'frame-blending')).toEqual({ a: 3, b: 4, w: expect.closeTo(0.4444, 3) });
		expect(pickFrames(vfr, 0.2, 'frame-sampling')).toEqual({ a: 3, b: 3, w: 0 });
		expect(pickFrames(vfr, 0.1, 'optical-flow')).toEqual({ a: 2, b: 2, w: 0 });
		expect(pickFrames(vfr, 9, 'optical-flow')).toEqual({ a: 4, b: 4, w: 0 });
	});
});

describe('time maps (interchange)', () => {
	it('round-trips a remap with segments, a ramp, a freeze and a reverse', async () => {
		const { remapToTimeMap, timeMapToRemap } = await import('../src/index.ts');
		const base = remap([key(0, 0), key(30 * F, 15 * F, { ramp: 4 * F }), key(60 * F, 75 * F)], {
			speedAfter: 0,
		});
		const c = clipWith(base, { start: 0, duration: 90 });
		const pts = remapToTimeMap(c, R30)!;
		expect(pts[0]).toMatchObject({ time: 0, value: 0 });
		expect(pts.some((p) => p.interp === 'smooth')).toBe(true);
		const back = timeMapToRemap(pts, 0, newId);
		expect(back.approximated).toBe(false);
		const c2 = clipWith(back.remap, { start: 0, duration: 90 });
		for (let f = 0; f < 90; f += 1)
			expect(clipMediaTimeAt(c2, f, R30)).toBeCloseTo(clipMediaTimeAt(c, f, R30), -2);
		expect(remapToTimeMap(clipWith(null), R30)).toBeNull();
	});
});
