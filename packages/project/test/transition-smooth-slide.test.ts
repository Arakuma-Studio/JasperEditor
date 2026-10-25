// Smooth Slide (docs/wp-notes/smooth-slide.md): param schema, easing curves, poses / shutter, dolly, the CPU
// reference geometry (direction, reflection, edge smoothing) and the document commands with refusals + invariants.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	type EffectParams,
	planGpuTransition,
	SMOOTH_SLIDE,
	SMOOTH_SLIDE_EASINGS,
	SMOOTH_SLIDE_MAX_SAMPLES,
	SMOOTH_SLIDE_REFLECTION_OPACITY,
	SMOOTH_SLIDE_SAMPLES,
	smoothSlideContributions,
	smoothSlideCoverage,
	smoothSlideDirection,
	smoothSlideEase,
	smoothSlideFrameStep,
	smoothSlidePoses,
	smoothSlideReflectionSigma,
	smoothSlideScale,
	TRANSITION_SPECS,
	type Transition,
	transitionSpec,
	validateGpuTransition,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const defaults = () => Object.fromEntries(SMOOTH_SLIDE.params.map((p) => [p.name, p.default]));
const param = (name: string) => SMOOTH_SLIDE.params.find((p) => p.name === name)!;

describe('Smooth Slide: registration and params', () => {
	it('is a valid GPU transition in the Slide bin with a neutral name', () => {
		expect(transitionSpec('jasper.smooth-slide')).toBe(SMOOTH_SLIDE);
		expect(TRANSITION_SPECS.filter((s) => s.id === 'jasper.smooth-slide')).toHaveLength(1);
		expect(validateGpuTransition(SMOOTH_SLIDE)).toEqual([]);
		expect(SMOOTH_SLIDE).toMatchObject({ label: 'Smooth Slide', bin: 'Slide', appliesTo: 'video' });
		expect(SMOOTH_SLIDE.capabilities).toEqual({ preview: 'webgl', export: ['remotion'] });
		expect(`${SMOOTH_SLIDE.label} ${SMOOTH_SLIDE.description}`).not.toMatch(/universe|red giant|maxon/i);
	});

	it('has every control with its range and default', () => {
		expect(SMOOTH_SLIDE.params.map((p) => p.name)).toEqual([
			'startPercent',
			'endPercent',
			'useCompletion',
			'completion',
			'direction',
			'animation',
			'dolly',
			'reflection',
			'blurriness',
			'falloff',
			'aspect',
			'motionBlur',
			'shutterAngle',
			'edgeSmoothing',
			'reverse',
		]);
		expect(param('direction')).toMatchObject({ options: ['right', 'left', 'up', 'down'], default: 'left' });
		expect(param('animation').options).toHaveLength(22);
		expect(param('animation')).toMatchObject({ default: 'easeInOutQuad' });
		expect(param('animation').options![16]).toBe('easeInOutQuad');
		expect(param('animation').options![17]).toBe('easeInOutCubic');
		expect(param('dolly')).toMatchObject({ default: 0, range: { min: 0, max: 1.2 }, animatable: true });
		expect(param('reflection')).toMatchObject({ type: 'boolean', default: false, group: 'Reflection' });
		expect(param('blurriness')).toMatchObject({ default: 10, range: { min: 0, max: 100 } });
		expect(param('falloff')).toMatchObject({ default: 0.1, range: { min: 0, max: 1 } });
		expect(param('aspect')).toMatchObject({ default: 1, range: { min: 0.01, max: 20 } });
		expect(param('motionBlur')).toMatchObject({ options: ['off', 'low', 'medium', 'high'], default: 'high' });
		expect(param('shutterAngle')).toMatchObject({ default: 360, unit: 'deg', range: { min: 90, max: 720 } });
		expect(param('edgeSmoothing')).toMatchObject({
			options: ['none', 'low', 'medium', 'high'],
			default: 'none',
		});
	});
});

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
		expect(smoothSlideEase('bogus', 0.25)).toBe(smoothSlideEase('easeInOutQuad', 0.25));
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
		...o,
	});

	it('takes 1 / 4 / 8 / 16 poses spread over Shutter Angle / 360 frames, centred on the frame', () => {
		const p = { ...defaults(), animation: 'linear' };
		for (const [level, n] of Object.entries(SMOOTH_SLIDE_SAMPLES)) {
			const poses = smoothSlidePoses({ ...p, motionBlur: level }, ctx(0.5));
			expect(poses, level).toHaveLength(n);
			expect(n).toBeLessThanOrEqual(SMOOTH_SLIDE_MAX_SAMPLES);
			const mean = poses.reduce((s, q) => s + q.e, 0) / n;
			expect(mean).toBeCloseTo(0.5, 12);
		}
		// Linear easing: the poses span (1 − 1/n) of the shutter (stratum centres), 360° = 1 frame = 1/16 progress.
		const step = smoothSlideFrameStep(p, ctx(0.5));
		expect(step).toBeCloseTo(1 / 16, 12);
		const hi = smoothSlidePoses({ ...p, motionBlur: 'high', shutterAngle: 360 }, ctx(0.5));
		expect(hi.at(-1)!.e - hi[0]!.e).toBeCloseTo(step * (15 / 16), 12);
		const wide = smoothSlidePoses({ ...p, motionBlur: 'high', shutterAngle: 720 }, ctx(0.5));
		expect(wide.at(-1)!.e - wide[0]!.e).toBeCloseTo(2 * step * (15 / 16), 12);
		// Out-of-range angles are clamped to 90 … 720.
		const tiny = smoothSlidePoses({ ...p, motionBlur: 'high', shutterAngle: 1 }, ctx(0.5));
		expect(tiny.at(-1)!.e - tiny[0]!.e).toBeCloseTo(0.25 * step * (15 / 16), 12);
	});

	it('shrinks the shutter at the ends: progress 0 is exactly A and 1 exactly B', () => {
		for (const progress of [0, 1]) {
			const poses = smoothSlidePoses({ ...defaults(), dolly: 1 }, ctx(progress));
			for (const q of poses) {
				expect(q.e).toBe(progress);
				expect(q.s).toBeCloseTo(1, 12);
			}
		}
		const near = smoothSlidePoses({ ...defaults(), animation: 'linear' }, ctx(0.01));
		for (const q of near) expect(q.e).toBeGreaterThanOrEqual(0);
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

	it('plans 16 packed poses, the direction and the edge width as uniforms; blur passes only with a reflection', () => {
		const pics = {
			out: { width: 64, height: 36, compToCanvas: [1, 0, 0, 0, 1, 0, 0, 0, 1], opacity: 1 },
			in: null,
		};
		const plan = (params: Record<string, unknown>) =>
			planGpuTransition(
				SMOOTH_SLIDE,
				{ id: 'trn_x', params: { ...defaults(), ...params } as never, frame: 3, duration: 10, sides: 'out' },
				{ width: 64, height: 36, fps: 30 },
				pics,
			);
		const p = plan({ direction: 'up', edgeSmoothing: 'medium', motionBlur: 'low' });
		const u = (n: string) => p.plan.uniforms.find((x) => x.name === n)!;
		expect(u('u_slDir').value).toEqual([0, -1]);
		expect(u('u_slCount').value).toEqual([4]);
		expect(u('u_slAa').value).toEqual([2]);
		expect(u('u_slPoses').value).toHaveLength(4 * SMOOTH_SLIDE_MAX_SAMPLES);
		// Two placement passes + the compositing pass; a blurred reflection adds two separable blurs per side.
		expect(p.plan.passes).toHaveLength(3);
		expect(plan({ reflection: true }).plan.passes).toHaveLength(3 + 4);
		expect(plan({ reflection: true, blurriness: 0 }).plan.passes).toHaveLength(3);
	});
});

describe('Smooth Slide: CPU reference geometry', () => {
	const F = { width: 64, height: 36 };
	const at = (x: number, y: number, e: number, params: Record<string, unknown>, s = 1) =>
		smoothSlideContributions([x, y], { e, s }, { ...defaults(), ...params } as EffectParams, F);
	type C = ReturnType<typeof at>;
	const same = (got: C, want: C) => {
		expect(got.map((c) => [c.side, c.reflection])).toEqual(want.map((c) => [c.side, c.reflection]));
		got.forEach((c, i) => {
			expect(c.weight).toBeCloseTo(want[i]!.weight, 9);
			expect(c.uv[0]).toBeCloseTo(want[i]!.uv[0], 9);
			expect(c.uv[1]).toBeCloseTo(want[i]!.uv[1], 9);
		});
	};

	it('directions: both pictures travel together; B enters from the opposite edge', () => {
		expect(smoothSlideDirection('left')).toEqual([-1, 0]);
		expect(smoothSlideDirection('down')).toEqual([0, 1]);
		expect(smoothSlideDirection('nonsense')).toEqual([-1, 0]);
		// Left at e = 0.5: the left half shows A's right half, the right half B's left half.
		same(at(8.5, 10.5, 0.5, { direction: 'left' }), [
			{ side: 'from', uv: [8.5 / 64 + 0.5, 10.5 / 36], weight: 1, reflection: false },
		]);
		same(at(40.5, 10.5, 0.5, { direction: 'left' }), [
			{ side: 'to', uv: [40.5 / 64 - 0.5, 10.5 / 36], weight: 1, reflection: false },
		]);
		expect(at(8.5, 10.5, 0.5, { direction: 'right' })[0]!.side).toBe('to');
		expect(at(8.5, 4.5, 0.5, { direction: 'up' })[0]!.side).toBe('from');
		expect(at(8.5, 4.5, 0.5, { direction: 'down' })[0]!.side).toBe('to');
		same(at(8.5, 4.5, 0.25, { direction: 'down' }), [
			{ side: 'to', uv: [8.5 / 64, 4.5 / 36 + 0.75], weight: 1, reflection: false },
		]);
	});

	it('dolly: pictures scale about the centre; the uncovered frame is empty', () => {
		// s = 0.5 at e = 0 (A only): A covers the middle half of the frame.
		expect(at(2.5, 2.5, 0, {}, 0.5)).toEqual([]);
		same(at(32.5, 18.5, 0, {}, 0.5), [
			{ side: 'from', uv: [0.5 + 0.5 / 32, 0.5 + 0.5 / 18], weight: 1, reflection: false },
		]);
	});

	it('reflection: mirrored below the picture, Aspect squeezes it, Falloff fades it', () => {
		// s = 0.5, e = 0: A spans rows 9 … 27; row 29.5 is 2.5 px (5 picture px = 5/36 heights) below its edge.
		const r = at(32.5, 29.5, 0, { reflection: true, falloff: 0 }, 0.5);
		expect(r).toHaveLength(1);
		const dy = 5 / 36;
		expect(r[0]!.reflection).toBe(true);
		expect(r[0]!.uv[1]).toBeCloseTo(1 - dy, 9);
		expect(r[0]!.weight).toBeCloseTo(SMOOTH_SLIDE_REFLECTION_OPACITY, 9);
		const squeezed = at(32.5, 29.5, 0, { reflection: true, falloff: 0, aspect: 2 }, 0.5);
		expect(squeezed[0]!.uv[1]).toBeCloseTo(1 - 2 * dy, 9);
		const faded = at(32.5, 29.5, 0, { reflection: true, falloff: 0.5 }, 0.5);
		expect(faded[0]!.weight).toBeCloseTo(SMOOTH_SLIDE_REFLECTION_OPACITY * (1 - dy * 0.5 * 8), 9);
		// Aspect 4: the reflection is 1/4 picture high (rows 27 … 31.5): row 33.5 is empty.
		expect(at(32.5, 33.5, 0, { reflection: true, aspect: 4 }, 0.5)).toEqual([]);
		// Off: nothing below.
		expect(at(32.5, 29.5, 0, { reflection: false }, 0.5)).toEqual([]);
		// Vertical moves: only the lower picture reflects (Down: A is below B; Up: B is below A). Row 33.5 at s = 0.5 is
		// picture row 1.361: below A (offset 0.2) for Down at e = 0.2, below B (offset 0.2) for Up at e = 0.8.
		const flags = (c: C) => c.map((k) => [k.side, k.reflection]);
		const r1 = { reflection: true, falloff: 0 };
		expect(flags(at(32.5, 33.5, 0.2, { ...r1, direction: 'down' }, 0.5))).toEqual([['from', true]]);
		expect(flags(at(32.5, 33.5, 0.8, { ...r1, direction: 'up' }, 0.5))).toEqual([['to', true]]);
		// Where the upper picture's reflection would be, the lower picture shows (no reflection drawn over it).
		expect(flags(at(32.5, 18.5, 0.2, { ...r1, direction: 'down' }, 0.5))).toEqual([['from', false]]);
	});

	it('edge smoothing: a box filter over the seam, exact at the frame borders at rest', () => {
		// Seam of Left at e = 0.5 sits at x = 32.
		const hard = at(31.5, 10.5, 0.5, { edgeSmoothing: 'none' });
		expect(hard.map((c) => [c.side, c.weight])).toEqual([['from', 1]]);
		const soft = at(31.5, 10.5, 0.5, { edgeSmoothing: 'high' });
		expect(soft.map((c) => c.side)).toEqual(['from', 'to']);
		expect(soft[0]!.weight).toBeCloseTo(2 / 3, 9);
		expect(soft[1]!.weight).toBeCloseTo(1 / 3, 9);
		for (const x of [0.5, 63.5]) {
			same(at(x, 0.5, 0, { edgeSmoothing: 'high' }), [
				{ side: 'from', uv: [x / 64, 0.5 / 36], weight: 1, reflection: false },
			]);
		}
		fc.assert(
			fc.property(
				fc.double({ min: 0, max: 64, noNaN: true }),
				fc.double({ min: -10, max: 70, noNaN: true }),
				fc.double({ min: 0, max: 30, noNaN: true }),
				fc.integer({ min: 0, max: 3 }),
				(x, a, len, w) => {
					const c = smoothSlideCoverage(x, a, a + len, w, 64);
					expect(c).toBeGreaterThanOrEqual(0);
					expect(c).toBeLessThanOrEqual(1);
				},
			),
		);
	});

	it('coverages of all contributions never exceed 1 (pictures and reflections are disjoint)', () => {
		fc.assert(
			fc.property(
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.double({ min: 0.45, max: 1, noNaN: true }),
				fc.constantFrom('left', 'right', 'up', 'down'),
				fc.constantFrom('none', 'low', 'medium', 'high'),
				fc.double({ min: 0.01, max: 20, noNaN: true }),
				fc.integer({ min: 0, max: 63 }),
				fc.integer({ min: 0, max: 35 }),
				(e, s, direction, edgeSmoothing, aspect, x, y) => {
					const c = at(
						x + 0.5,
						y + 0.5,
						e,
						{ direction, edgeSmoothing, aspect, reflection: true, falloff: 0 },
						s,
					);
					const geometric = c.reduce(
						(sum, k) => sum + (k.reflection ? k.weight / SMOOTH_SLIDE_REFLECTION_OPACITY : k.weight),
						0,
					);
					expect(geometric).toBeLessThanOrEqual(1 + 1e-9);
				},
			),
		);
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

	it('works one-sided at a head and a tail', () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addSolid', at: 30, duration: 60, track: 'V2', color: [1, 0, 0, 1], ref: '$c' },
		]);
		const c = r.refs.$c!;
		h.ok([
			{ type: 'transition.add', clipId: c, edge: 'in', effectId: 'jasper.smooth-slide', duration: 12 },
			{ type: 'transition.add', clipId: c, edge: 'out', effectId: 'jasper.smooth-slide', duration: 12 },
		]);
		expect(Object.values(h.seq.transitions)).toHaveLength(2);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});
