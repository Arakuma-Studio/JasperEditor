// Smooth Slide (docs/wp-notes/smooth-slide.md): independent easing / shutter / dolly laws and document commands.
// Actual direction, reflection and edge pixels belong to the compositions GL owner.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	SMOOTH_SLIDE,
	SMOOTH_SLIDE_EASINGS,
	smoothSlideEase,
	smoothSlideFrameStep,
	smoothSlideMotionBlur,
	smoothSlideReflectionSigma,
	smoothSlideScale,
	type Transition,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const defaults = () => Object.fromEntries(SMOOTH_SLIDE.params.map((p) => [p.name, p.default]));

describe('Smooth Slide: easing curves', () => {
	it('every curve starts at 0, ends at 1, stays in range and is monotonic', () => {
		for (const id of SMOOTH_SLIDE_EASINGS) {
			expect(smoothSlideEase(id, 0), id).toBe(0);
			expect(smoothSlideEase(id, 1), id).toBe(1);
			let prev = 0;
			for (let i = 1; i <= 200; i++) {
				const v = smoothSlideEase(id, i / 200);
				expect(v, `${id} @ ${i / 200}`).toBeGreaterThanOrEqual(prev - 1e-12);
				expect(v).toBeLessThanOrEqual(1);
				prev = v;
			}
		}
	});

	it('matches the closed forms (Penner) at known points', () => {
		expect(smoothSlideEase('linear', 0.3)).toBeCloseTo(0.3, 12);
		expect(smoothSlideEase('easeInQuad', 0.5)).toBeCloseTo(0.25, 12);
		expect(smoothSlideEase('easeOutQuad', 0.5)).toBeCloseTo(0.75, 12);
		expect(smoothSlideEase('easeInOutQuad', 0.25)).toBeCloseTo(0.125, 12);
		expect(smoothSlideEase('easeInOutCubic', 0.25)).toBeCloseTo(0.0625, 12);
		expect(smoothSlideEase('easeInQuint', 0.5)).toBeCloseTo(1 / 32, 12);
		expect(smoothSlideEase('easeInSine', 0.5)).toBeCloseTo(1 - Math.cos(Math.PI / 4), 12);
		expect(smoothSlideEase('easeInExpo', 0.5)).toBeCloseTo(2 ** -5, 12);
		expect(smoothSlideEase('easeOutCirc', 0.5)).toBeCloseTo(Math.sqrt(0.75), 12);
		for (const id of SMOOTH_SLIDE_EASINGS.filter((x) => x.startsWith('easeInOut')))
			expect(smoothSlideEase(id, 0.5), id).toBeCloseTo(0.5, 9);
	});

	it('Ease Out is Ease In mirrored; In Out is point-symmetric; unknown values fall back to In Out Quad', () => {
		fc.assert(
			fc.property(
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.constantFrom('Sine', 'Quad', 'Cubic', 'Quart', 'Quint', 'Expo', 'Circ'),
				(t, c) => {
					// Expo's closed form jumps by 2^-10 at its ends (exactly 0 / 1 there): mirror within that.
					const tol = c === 'Expo' ? 1e-3 : 1e-9;
					const out = smoothSlideEase(`easeOut${c}`, t);
					expect(Math.abs(out - (1 - smoothSlideEase(`easeIn${c}`, 1 - t)))).toBeLessThanOrEqual(tol);
					const io = smoothSlideEase(`easeInOut${c}`, t);
					expect(Math.abs(io - (1 - smoothSlideEase(`easeInOut${c}`, 1 - t)))).toBeLessThanOrEqual(tol);
				},
			),
		);
		expect(smoothSlideEase('bogus', 0.25)).toBe(0.125);
		expect(smoothSlideEase('easeInQuad', Number.NaN)).toBe(0);
		expect(smoothSlideEase('easeInQuad', 7)).toBe(1);
	});
});

describe('Smooth Slide: poses, shutter and dolly', () => {
	const ctx = (
		progress: number,
		o: Partial<{ duration: number; hasFrom: boolean; hasTo: boolean }> = {},
	) => ({
		progress,
		duration: 15,
		hasFrom: true,
		hasTo: true,
		width: 1920,
		height: 1080,
		...o,
	});

	it('blurs over Shutter Angle / 360 frames centred on the frame, about one tap per pixel of travel', () => {
		const p = { ...defaults(), animation: 'linear', direction: 'up' };
		// Linear easing, 15 frames two-sided: 1/16 progress per frame = 1080 / 16 = 67.5 px of travel at 360°.
		const step = 1 / 16;
		const at = (q: Record<string, unknown>, progress = 0.5) =>
			smoothSlideMotionBlur({ ...p, ...q }, ctx(progress));
		const hi = at({ shutterAngle: 360 });
		expect(hi.pose.e).toBeCloseTo(0.5, 12);
		expect(hi.plan.times.at(-1)! - hi.plan.times[0]!).toBeCloseTo(step, 12);
		expect(hi.plan.extentPx).toBeCloseTo(67.5, 6);
		expect(hi.plan.taps).toBe(68);
		const wide = at({ shutterAngle: 720 });
		expect(wide.plan.times.at(-1)! - wide.plan.times[0]!).toBeCloseTo(2 * step, 12);
		// Out-of-range angles are clamped to 90 … 720.
		const tiny = at({ shutterAngle: 1 });
		expect(tiny.plan.times.at(-1)! - tiny.plan.times[0]!).toBeCloseTo(0.25 * step, 12);
		expect(at({ motionBlur: 'off' }).plan.taps).toBe(1);
	});

	it('Low / Medium / High cap the taps of a fast push at 16 / 64 / 96', () => {
		// Left over 1920 px in 15 frames: 120 px of travel per frame.
		const fast = (motionBlur: string) =>
			smoothSlideMotionBlur({ ...defaults(), animation: 'linear', direction: 'left', motionBlur }, ctx(0.5))
				.plan;
		expect([fast('low').taps, fast('medium').taps, fast('high').taps]).toEqual([16, 64, 96]);
		expect(fast('high').jitter).toBe(true);
	});

	it('shrinks the shutter at the ends: progress 0 is exactly A and 1 exactly B', () => {
		for (const progress of [0, 1]) {
			const { pose, plan } = smoothSlideMotionBlur({ ...defaults(), dolly: 1 }, ctx(progress));
			expect(plan.taps).toBe(1);
			expect(pose.e).toBe(progress);
			expect(pose.s).toBeCloseTo(1, 12);
		}
		const near = smoothSlideMotionBlur({ ...defaults(), animation: 'linear' }, ctx(0.01));
		for (const t of near.plan.times) expect(t).toBeGreaterThanOrEqual(0);
	});

	it('the frame step follows the span (two-sided 1 / (d + 1), one-sided 1 / d) and Start / End', () => {
		expect(smoothSlideFrameStep(defaults(), { duration: 15, hasFrom: true, hasTo: false })).toBeCloseTo(
			1 / 15,
		);
		expect(smoothSlideFrameStep({ ...defaults(), startPercent: 20, endPercent: 70 }, ctx(0.5))).toBeCloseTo(
			0.5 / 16,
		);
		expect(smoothSlideFrameStep(defaults(), { duration: 0, hasFrom: true, hasTo: true })).toBeCloseTo(0.5);
	});

	it('dolly scale: 1 at both ends, 1 / (1 + dolly) mid-move; clamped and finite', () => {
		expect(smoothSlideScale(0, 1.2)).toBe(1);
		expect(smoothSlideScale(1, 1.2)).toBeCloseTo(1, 12);
		expect(smoothSlideScale(0.5, 1.2)).toBeCloseTo(1 / 2.2, 12);
		expect(smoothSlideScale(0.5, 0)).toBe(1);
		expect(smoothSlideScale(0.5, 99)).toBeCloseTo(1 / 2.2, 12);
		expect(smoothSlideScale(0.5, Number.NaN)).toBe(1);
		fc.assert(
			fc.property(fc.double({ min: -1, max: 2, noNaN: true }), fc.double({ noNaN: true }), (e, d) => {
				const s = smoothSlideScale(e, d);
				expect(s).toBeGreaterThan(0.45);
				expect(s).toBeLessThanOrEqual(1);
			}),
		);
	});

	it('reflection blur σ scales with Blurriness and the sequence height', () => {
		expect(smoothSlideReflectionSigma(10, 1080)).toBeCloseTo(4, 12);
		expect(smoothSlideReflectionSigma(10, 2160)).toBeCloseTo(8, 12);
		expect(smoothSlideReflectionSigma(500, 1080)).toBeCloseTo(40, 12);
		expect(smoothSlideReflectionSigma(Number.NaN, 1080)).toBe(0);
	});
});

describe('Smooth Slide in the document', () => {
	function twoSolids() {
		const h = new Harness();
		h.ok([
			{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1] },
			{ type: 'clip.addSolid', at: 60, duration: 60, track: 'V1', color: [0, 0, 1, 1] },
		]);
		return h;
	}
	const only = (h: Harness) => Object.values(h.seq.transitions)[0] as Transition;

	it('adds with validated params, edits by param.set / keyframes, refuses bad values; invariants hold', () => {
		const h = twoSolids();
		const before = h.doc;
		h.ok([
			{
				type: 'transition.add',
				trackId: 'V1',
				at: 60,
				effectId: 'jasper.smooth-slide',
				duration: 15,
				params: { direction: 'down', animation: 'easeInOutCubic', dolly: 0.6, reflection: true },
			},
		]);
		expect(checkInvariants(h.doc)).toEqual([]);
		const t = only(h);
		expect(t.params.direction).toEqual({ value: 'down', keyframes: [] });
		expect(t.params.dolly).toEqual({ value: 0.6, keyframes: [] });
		// Out of range numbers are clamped, unknown options / names are refused with E_INVALID_PARAM.
		h.ok([{ type: 'transition.update', transitionId: t.id, params: { dolly: 9, shutterAngle: 10 } }]);
		expect(only(h).params.dolly!.value).toBe(1.2);
		expect(only(h).params.shutterAngle!.value).toBe(90);
		for (const params of [{ direction: 'sideways' }, { motionBlur: 'ultra' }, { bluriness: 3 }]) {
			const r = h.tx([{ type: 'transition.update', transitionId: t.id, params }]);
			expect(r.ok, JSON.stringify(params)).toBe(false);
			if (!r.ok) expect(r.errors[0]!.code).toBe('E_INVALID_PARAM');
		}
		h.ok([
			{ type: 'param.set', target: ['transition', t.id, 'shutterAngle'], value: 180 },
			{ type: 'keyframe.add', target: ['transition', t.id, 'dolly'], at: { sequenceFrame: 53 }, value: 0 },
			{ type: 'keyframe.add', target: ['transition', t.id, 'dolly'], at: { sequenceFrame: 60 }, value: 1.2 },
		]);
		expect(only(h).params.shutterAngle!.value).toBe(180);
		expect(only(h).params.dolly!.keyframes).toHaveLength(2);
		expect(checkInvariants(h.doc)).toEqual([]);
		// The original document is untouched (undo restores it).
		expect(Object.values(Object.values(before.sequences)[0]!.transitions)).toEqual([]);
	});
});
