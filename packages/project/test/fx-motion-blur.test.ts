import { describe, expect, it } from 'vitest';
import {
	angleShutter,
	centredShutter,
	mbKeyTimes,
	mbQuality,
	mbQualityParam,
	mbTapCount,
	mbTimeWarp,
	mbUniforms,
	planMotionBlur,
	poseTrackLengths,
	toUniform,
} from '../src/index.ts';

type Pose = { x: number; y: number; rot: number; zoom: number };
/** Box corners + centre of a 100×50 box moved by a pose (translate, rotate about the centre, zoom). */
const corners = (q: Pose, scale = 1): [number, number][] =>
	(
		[
			[-50, -25],
			[50, -25],
			[50, 25],
			[-50, 25],
			[0, 0],
		] as const
	).map(([x, y]) => {
		const c = Math.cos(q.rot);
		const s = Math.sin(q.rot);
		return [(q.x + q.zoom * (c * x - s * y)) * scale, (q.y + q.zoom * (s * x + c * y)) * scale];
	});
const plan = (
	poseAt: (f: number) => Pose,
	extra: { scale?: number; quality?: string; length?: number } = {},
) =>
	planMotionBlur({
		frame: 10,
		window: centredShutter(extra.length ?? 1),
		poseAt,
		points: (q) => corners(q, extra.scale ?? 1),
		pack: (q) => [q.x, q.y, q.rot, q.zoom],
		stride: 1,
		quality: extra.quality,
	});

describe('shutter windows', () => {
	it('Mo Blur Length is centred on the frame, Shutter Shift moves it', () => {
		expect(centredShutter(1)).toEqual({ start: -0.5, end: 0.5 });
		expect(centredShutter(2, 0.25)).toEqual({ start: -0.75, end: 1.25 });
		expect(centredShutter(-1)).toEqual({ start: 0, end: 0 });
	});
	it('Shutter Angle / 360 frames, centred by default (Premiere Transform), with an After Effects phase', () => {
		expect(angleShutter(180)).toEqual({ start: -0.25, end: 0.25 });
		expect(angleShutter(360)).toEqual({ start: -0.5, end: 0.5 });
		expect(angleShutter(180, 0)).toEqual({ start: 0, end: 0.5 });
		expect(angleShutter(0)).toEqual({ start: 0, end: 0 });
	});
	it('key times: FX_MB_KEYS evenly over the interval, both ends included', () => {
		const t = mbKeyTimes(10, centredShutter(1));
		expect(t).toHaveLength(32);
		expect(t[0]).toBeCloseTo(9.5);
		expect(t[31]).toBeCloseTo(10.5);
		expect(t[1]! - t[0]!).toBeCloseTo(1 / 31);
	});
});

describe('tap counts', () => {
	it('≤ 1 px apart up to 64 taps (Auto), 1 without motion', () => {
		expect(mbTapCount(0)).toBe(1);
		expect(mbTapCount(0.4)).toBe(1);
		expect(mbTapCount(1.0)).toBe(1);
		expect(mbTapCount(1.01)).toBe(2);
		expect(mbTapCount(40)).toBe(40);
		expect(mbTapCount(500)).toBe(64);
		expect(mbTapCount(500, mbQuality('high'))).toBe(96);
		expect(mbTapCount(40, mbQuality('draft'))).toBe(16);
		expect(mbTapCount(Number.NaN)).toBe(1);
	});
	it('quality param: Auto by default, advanced group; unknown values are Auto', () => {
		const q = mbQualityParam();
		expect(q.default).toBe('auto');
		expect(q.animatable).toBe(false);
		expect(q.group).toBe('Advanced');
		expect(mbQuality(undefined)).toEqual(mbQuality('auto'));
		expect(mbQuality('bogus')).toEqual(mbQuality('auto'));
	});
});

describe('planMotionBlur', () => {
	const still = () => ({ x: 0, y: 0, rot: 0, zoom: 1 });
	it('nothing moves → 1 tap and zero-filled arrays of the fixed size', () => {
		const p = plan(still);
		expect(p.taps).toBe(1);
		expect(p.packed).toEqual(new Array(128).fill(0));
		const u = mbUniforms(p);
		expect(toUniform('u_mbPlan', u.u_mbPlan!).value).toEqual([1, 0, 1, 0]);
		expect(toUniform('u_mbKeys', u.u_mbKeys!).value).toHaveLength(128);
		expect(toUniform('u_mbWarp', u.u_mbWarp!).value).toHaveLength(32);
	});
	it('an empty shutter → 1 tap even when moving', () => {
		expect(plan((f) => ({ ...still(), x: f * 40 }), { length: 0 }).taps).toBe(1);
	});
	it('a linear move of 40 px over the shutter → 40 taps, no jitter, no time warp', () => {
		const p = plan((f) => ({ ...still(), x: f * 40 }));
		expect(p.extentPx).toBeCloseTo(40, 6);
		expect(p.taps).toBe(40);
		expect(p.jitter).toBe(false);
		expect(p.warp).toBeNull();
		expect(p.keys).toBe(32);
	});
	it('the preview scale reduces the taps proportionally', () => {
		const move = (f: number) => ({ ...still(), x: f * 40 });
		expect(plan(move, { scale: 0.5 }).taps).toBe(20);
		expect(plan(move, { scale: 0.25 }).taps).toBe(10);
	});
	it('rotation and zoom count at the box corners (not only the centre)', () => {
		// 90° per frame about the centre: the corners travel a quarter circle of radius √(50² + 25²).
		const spin = plan((f) => ({ ...still(), rot: (f * Math.PI) / 2 }));
		expect(spin.extentPx).toBeCloseTo((Math.hypot(50, 25) * Math.PI) / 2, 0);
		expect(spin.taps).toBe(64);
		// Zoom 1 → 2 over the frame: the corners move by √(50² + 25²).
		const zoom = plan((f) => ({ ...still(), zoom: 1 + (f - 9.5) }));
		expect(zoom.extentPx).toBeCloseTo(Math.hypot(50, 25), 1);
	});
	it('very fast moves are capped and jittered', () => {
		const p = plan((f) => ({ ...still(), x: f * 400 }));
		expect(p.taps).toBe(64);
		expect(p.jitter).toBe(true);
		expect(plan((f) => ({ ...still(), x: f * 400 }), { quality: 'high' }).taps).toBe(96);
	});
	it('a curved path counts its length, not the endpoint distance (a shake that goes and comes back)', () => {
		const p = plan((f) => ({ ...still(), x: 30 * Math.sin(2 * Math.PI * (f - 10)) }));
		// Over one full period the endpoints coincide; the path is 4 × 30 px.
		expect(p.extentPx).toBeGreaterThan(110);
		expect(p.extentPx).toBeLessThanOrEqual(120 + 1e-6);
	});
	it('packs the key poses at exact sub-frame times (stride vec4s each)', () => {
		const p = planMotionBlur({
			frame: 10,
			window: centredShutter(1),
			poseAt: (f) => f,
			points: (f) => [[f * 50, 0]],
			pack: (f) => [f, 0, 0, 0, -f, 0, 0, 0],
			stride: 2,
		});
		expect(p.packed).toHaveLength(256);
		expect(p.packed[0]).toBeCloseTo(9.5);
		expect(p.packed[4]).toBeCloseTo(-9.5);
		expect(p.packed[248]).toBeCloseTo(10.5);
		expect(() =>
			planMotionBlur({
				frame: 0,
				window: centredShutter(1),
				poseAt: (f) => f,
				points: (f) => [[f, 0]],
				pack: (f) => [f],
				stride: 1,
			}),
		).toThrow();
	});
	it('is a pure function of the frame (same plan in any order)', () => {
		const move = (f: number) => ({ ...still(), x: 30 * Math.sin(f), rot: 0.1 * f });
		const a = plan(move);
		plan((f) => ({ ...still(), x: f * 5 }));
		expect(plan(move)).toEqual(a);
	});
});

describe('time warp and helpers', () => {
	it('constant speed → identity (null); a burst gets taps by path length', () => {
		expect(mbTimeWarp([2, 2, 2, 2])).toBeNull();
		expect(mbTimeWarp([0, 0, 0])).toBeNull();
		// All the motion in the middle segment of three: half of the taps... (75 % path share) land there.
		const w = mbTimeWarp([0, 30, 0])!;
		expect(w).toHaveLength(32);
		expect(w[0]).toBe(0);
		expect(w[31]).toBe(1);
		for (let i = 1; i < w.length; i++) expect(w[i]!).toBeGreaterThanOrEqual(w[i - 1]!);
		const inMiddle = w.filter((s) => s > 1 / 3 && s < 2 / 3).length / w.length;
		expect(inMiddle).toBeGreaterThan(0.7);
	});
	it('track lengths: per segment, the farthest-moving point', () => {
		const r = poseTrackLengths([
			[
				[0, 0],
				[10, 0],
			],
			[
				[3, 4],
				[10, 1],
			],
			[
				[3, 4],
				[10, 1],
			],
		]);
		expect(r.segments).toEqual([5, 0]);
		expect(r.total).toBe(5);
	});
});
