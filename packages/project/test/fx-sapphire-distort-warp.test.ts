// Sapphire Distort family (fx catalogue, wave 2): the entries follow Sapphire's parameter sets and the framework's
// rules, and the TypeScript maths behind them (projective transforms, shake curves, fades, pass plans, padding) is
// right. Pixel behaviour in real WebGL: packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts.
import { describe, expect, it } from 'vitest';
import {
	defaultEffectRegistry,
	type EffectParams,
	type EffectSpec,
	FX_MB_KEYS,
	gpuPadding,
	gpuPasses,
	paramUniforms,
	planGpuEffect,
	SAPPHIRE_BINS,
	validateGpuEffect,
} from '../src/index.ts';
import {
	boundsPadding,
	cornerPinInverse,
	MAT3_IDENTITY,
	mat3Apply,
	mat3Invert,
	mat3Mul,
	shakeNoise,
	shakePose,
	shutterTimes,
	squareToQuad,
	transformedBounds,
	warpTransformForward,
} from '../src/registry/fx/sapphire-distort-warp/math.ts';
import {
	dropGrid,
	lensPasses,
	parallaxAmount,
	SAPPHIRE_DISTORT_WARP_EFFECTS,
	shakeParamsOf,
	shakeUniforms,
} from '../src/registry/fx/sapphire-distort-warp.ts';

const LABELS = [
	'S_Distort',
	'S_DistortBlur',
	'S_DistortChroma',
	'S_DistortRGB',
	'S_InfiniteZoom',
	'S_ParallaxStrips',
	'S_Shake',
	'S_StretchFrameEdges',
	'S_WarpBubble',
	'S_WarpBubble2',
	'S_WarpChroma',
	'S_WarpCornerPin',
	'S_WarpDrops',
	'S_WarpFishEye',
	'S_WarpMagnify',
	'S_WarpPerspective',
	'S_WarpPolar',
	'S_WarpPuddle',
	'S_WarpPuff',
	'S_WarpRepeat',
	'S_WarpTransform',
	'S_WarpVortex',
	'S_WarpWaves',
	'S_WarpWaves2',
];

const byLabel = (l: string) => SAPPHIRE_DISTORT_WARP_EFFECTS.find((s) => s.label === l)!;
const defaults = (s: EffectSpec, over: EffectParams = {}): EffectParams => ({
	...Object.fromEntries(s.params.map((p) => [p.name, p.default])),
	...over,
});
const names = (l: string) => byLabel(l).params.map((p) => p.label);
const ctx = { width: 1920, height: 1080, pxScale: 1, fps: 30 };
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

describe('Sapphire Distort catalogue', () => {
	it('has the 24 effects, registered, in the Sapphire Distort bin, with jasper.s.<kebab> ids', () => {
		expect(SAPPHIRE_DISTORT_WARP_EFFECTS.map((s) => s.label)).toEqual(LABELS);
		for (const s of SAPPHIRE_DISTORT_WARP_EFFECTS) {
			expect(defaultEffectRegistry.get(s.id)).toBe(s);
			expect(s.bin).toBe(SAPPHIRE_BINS.distort);
			expect(s.category).toBe('Distort');
			expect(s.id).toMatch(/^jasper\.s\.[a-z0-9]+(-[a-z0-9]+)*$/);
			expect(s.description).toBeTruthy();
			expect(validateGpuEffect(s)).toEqual([]);
		}
		expect(byLabel('S_WarpFishEye').id).toBe('jasper.s.warp-fish-eye');
		expect(byLabel('S_DistortRGB').id).toBe('jasper.s.distort-rgb');
	});

	it('follows Sapphire parameter names and order (Mocha/Mask/Crop blocks omitted)', () => {
		expect(names('S_WarpFishEye')).toEqual([
			'Amount',
			'Center',
			'Z Dist',
			'Rotate',
			'Shift Orig',
			'Wrap X',
			'Wrap Y',
			'Filter',
		]);
		expect(names('S_Distort')).toEqual([
			'Lens',
			'Amount',
			'Fine',
			'Blur Lens',
			'Rotate Warp Dir',
			'Amount Rel',
			'Wrap X',
			'Wrap Y',
			'Filter',
		]);
		expect(names('S_WarpWaves')).toEqual([
			'Amplitude',
			'Frequency',
			'Angle',
			'Displace Angle',
			'Phase Start',
			'Phase Speed',
			'Z Dist',
			'Wrap X',
			'Wrap Y',
			'Filter',
		]);
		expect(names('S_StretchFrameEdges')).toEqual([
			'Center Squeeze',
			'Center Width',
			'Border Width',
			'Shift X',
			'Smooth',
			'Wrap',
		]);
		expect(names('S_Shake').slice(0, 14)).toEqual([
			'Style',
			'Amplitude',
			'Frequency',
			'Phase',
			'Stillness',
			'Twitch Frequency',
			'Drift',
			'Center Bias',
			'Z Dist',
			'Motion Blur',
			'Mo Blur Length',
			'Seed',
			'Wrap X',
			'Wrap Y',
		]);
		expect(names('S_Shake')).toContain('Tilt Rand Amp');
		expect(names('S_Shake')).toContain('RGB Randomness');
	});

	it('uses Sapphire defaults (spot checks) and per-effect wrap defaults', () => {
		const d = (l: string) => defaults(byLabel(l));
		expect(d('S_WarpMagnify')).toMatchObject({
			magnifyAmount: 2,
			lensRadius: 0.4,
			lensEdgeWidth: 0.5,
			lensEdgeShape: 1,
		});
		expect(d('S_WarpPerspective')).toMatchObject({ latitude: 35, zDist: 3, wrapX: 'tile', wrapY: 'tile' });
		expect(d('S_WarpPolar')).toMatchObject({
			innerRadius: 0.028,
			outerRadius: 0.84,
			wrapX: 'no',
			wrapY: 'no',
		});
		expect(d('S_WarpPuddle')).toMatchObject({
			amplitude: 0.1,
			frequency: 8,
			relHeight: 0.75,
			outerRadius: 1.4,
		});
		expect(d('S_WarpWaves2')).toMatchObject({
			aAmplitude: 0.06,
			bAmplitude: 0.12,
			bAngle: 15,
			bPhaseSpeed: -1,
		});
		expect(d('S_InfiniteZoom')).toMatchObject({
			transparentArea: 'outside',
			shrinkPerLevel: 0.5,
			spiralStrands: 'ccw1',
		});
		expect(d('S_ParallaxStrips')).toMatchObject({
			nStrips: 50,
			size: 0.35,
			seed: 0.123,
			fade: 'end',
			wrap: 'reflect',
		});
		expect(d('S_WarpBubble')).toMatchObject({
			amplitude: 0.25,
			frequency: 16,
			seed: 0.23,
			shiftSpeed: [0.1, 0],
		});
		expect(d('S_Shake')).toMatchObject({ amplitude: 1, frequency: 8, xRandAmp: 0.2, yRandAmp: 0.1, seed: 0 });
		expect(d('S_WarpRepeat')).toMatchObject({ steps: 3, fromZDist: 1.5, filter: false });
	});

	it('centres are on-canvas point params; Seed feeds u_seed rather than its own uniform', () => {
		for (const l of ['S_WarpFishEye', 'S_WarpVortex', 'S_WarpPuddle', 'S_WarpPolar', 'S_WarpChroma']) {
			const c = byLabel(l).params.find((p) => p.name === 'center')!;
			expect(c.ui?.control).toBe('point');
			expect(c.default).toEqual([0.5, 0.5]);
		}
		expect(byLabel('S_WarpCornerPin').params.filter((p) => p.ui?.control === 'point')).toHaveLength(4);
		const u = paramUniforms(byLabel('S_Shake'), defaults(byLabel('S_Shake'))).map((x) => x.name);
		expect(u).not.toContain('u_seed');
		expect(u).toContain('u_wrapX');
	});

	it('marks the heavy effects expensive and the static ones time-invariant', () => {
		for (const l of ['S_WarpDrops', 'S_ParallaxStrips', 'S_InfiniteZoom', 'S_DistortChroma', 'S_WarpChroma'])
			expect(byLabel(l).expensive).toBe(true);
		for (const l of ['S_WarpFishEye', 'S_WarpTransform', 'S_WarpPerspective', 'S_StretchFrameEdges'])
			expect(byLabel(l).gpu?.timeInvariant).toBe(true);
		// Animated by time (speeds) or by a (possibly video) media input: redrawn every frame.
		for (const l of ['S_Shake', 'S_WarpPuddle', 'S_WarpBubble', 'S_WarpVortex', 'S_Distort', 'S_WarpDrops'])
			expect(byLabel(l).gpu?.timeInvariant).toBeFalsy();
	});

	it('plans every effect at a 4K and a small layer', () => {
		for (const s of SAPPHIRE_DISTORT_WARP_EFFECTS)
			for (const [w, h] of [
				[3840, 2160],
				[64, 36],
			] as const) {
				const plan = planGpuEffect(
					s,
					{ id: 'fx', params: defaults(s) },
					{ width: w, height: h, pxScale: 1, fps: 30, frame: 3, duration: 90, seed: 0.5, progress: 0 },
					{ width: w, height: h },
				);
				expect(plan.passes.length).toBeGreaterThan(0);
				expect(plan.passes.at(-1)!.output).toBeNull();
			}
	});
});

describe('lens passes (S_Distort family, S_WarpPuff)', () => {
	it('luminance → separable blur into lensB, at half resolution for wide blurs', () => {
		const p = lensPasses(0.4, ctx, true);
		expect(p.map((x) => x.output)).toEqual(['lensL', 'lensBH', 'lensB']);
		expect(p[0]!.frag).toContain('u_lens_size');
		expect(p[1]!.scale).toBe(0.5); // 0.4 × 0.02 × 1920 ≈ 15 px sigma
		expect(lensPasses(0.1, { ...ctx, width: 640 }, false)[1]!.scale).toBe(1);
		expect(lensPasses(0, ctx, false)[0]!.frag).not.toContain('u_lens');
		const passes = gpuPasses(byLabel('S_WarpPuff').gpu!, defaults(byLabel('S_WarpPuff')), ctx);
		expect(passes).toHaveLength(4);
	});
});

describe('projective maths', () => {
	it('squareToQuad maps the unit square onto the quad; invert round-trips', () => {
		const q: [number, number][] = [
			[-0.4, -0.2],
			[0.3, -0.25],
			[0.45, 0.2],
			[-0.3, 0.3],
		];
		const m = squareToQuad(q[0]!, q[1]!, q[2]!, q[3]!)!;
		const corners: [number, number][] = [
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
		];
		corners.forEach(([x, y], i) => {
			const r = mat3Apply(m, x, y)!;
			expect(close(r[0], q[i]![0], 1e-9) && close(r[1], q[i]![1], 1e-9)).toBe(true);
		});
		const id = mat3Mul(m, mat3Invert(m)!);
		for (const [i, v] of id.entries()) expect(close(v, MAT3_IDENTITY[i]!, 1e-9)).toBe(true);
		expect(mat3Invert([1, 2, 3, 2, 4, 6, 0, 0, 1])).toBeNull();
	});

	it('cornerPinInverse maps each pinned corner (frame units) back to its source corner', () => {
		const aspect = 9 / 16;
		const pins = { tl: [0.1, 0.38], tr: [0.69, 0], br: [0.81, 0.93], bl: [0.22, 0.89] } as const;
		const inv = cornerPinInverse(pins, aspect)!;
		const f = (n: readonly [number, number]) => [n[0] - 0.5, (n[1] - 0.5) * aspect] as const;
		const at = (n: readonly [number, number]) => mat3Apply(inv, f(n)[0], f(n)[1])!;
		expect(at(pins.tl).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0]);
		expect(at(pins.tr).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 0]);
		expect(at(pins.br).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 1]);
		expect(at(pins.bl).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1]);
		// A degenerate quad (all corners on one point) has no inverse.
		expect(
			cornerPinInverse({ tl: [0.5, 0.5], tr: [0.5, 0.5], br: [0.5, 0.5], bl: [0.5, 0.5] }, aspect),
		).toBeNull();
	});

	const T0 = {
		scale: [1, 1] as [number, number],
		shift: [0, 0] as [number, number],
		zDist: 1,
		rotate: 0,
		swivel: 0,
		tilt: 0,
		perspectiveAmount: 1,
		shear: [0, 0] as [number, number],
	};

	it('S_WarpTransform: identity, shift, rotation (clockwise on screen), Z Dist, perspective', () => {
		const m = (o: Partial<typeof T0>) => warpTransformForward({ ...T0, ...o });
		const ap = (o: Partial<typeof T0>, x: number, y: number) => mat3Apply(m(o), x, y)!;
		expect(ap({}, 0.3, -0.1)).toEqual([0.3, -0.1]);
		expect(ap({ shift: [0.1, 0.2] }, 0, 0)).toEqual([0.1, 0.2]);
		const r = ap({ rotate: 90 }, 0.2, 0); // right → down on screen (y down)
		expect(close(r[0], 0, 1e-12) && close(r[1], 0.2, 1e-12)).toBe(true);
		expect(ap({ zDist: 2 }, 0.4, 0)).toEqual([0.2, 0]);
		// Swivel: the right half recedes (smaller), the left comes closer.
		const right = ap({ swivel: 40 }, 0.5, 0.2);
		const left = ap({ swivel: 40 }, -0.5, 0.2);
		expect(Math.abs(right[1])).not.toBeCloseTo(Math.abs(left[1]), 3);
	});

	it('padding covers the transformed box, and is zero when it stays inside', () => {
		const aspect = 1080 / 1920;
		const b0 = transformedBounds(warpTransformForward(T0), aspect)!;
		expect(boundsPadding(b0, 1920, 1080)).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
		const b1 = transformedBounds(warpTransformForward({ ...T0, shift: [0.25, 0] }), aspect)!;
		const p1 = boundsPadding(b1, 1920, 1080);
		expect(p1.right).toBe(482);
		expect(p1.left).toBe(0);
		const spec = byLabel('S_WarpTransform');
		expect(gpuPadding(spec, defaults(spec, { scale: [1.5, 1.5] }), ctx).left).toBeGreaterThan(400);
		// Behind the camera → no finite bounds.
		expect(
			transformedBounds(
				warpTransformForward({ ...T0, scale: [3, 3], swivel: 60, perspectiveAmount: 0.25 }),
				aspect,
			),
		).toBeNull();
	});

	it('S_WarpCornerPin pads by how far the pins leave the box', () => {
		const spec = byLabel('S_WarpCornerPin');
		expect(gpuPadding(spec, defaults(spec), ctx)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
		const p = gpuPadding(spec, defaults(spec, { topLeft: [-0.1, -0.2] }), ctx);
		expect(p.left).toBe(192);
		expect(p.top).toBe(216);
	});
});

describe('S_Shake model', () => {
	const sp = shakeParamsOf(defaults(byLabel('S_Shake')));

	it('noise is deterministic, smooth (C1) and about −1..1', () => {
		expect(shakeNoise(0.3, 1, 2.7)).toBe(shakeNoise(0.3, 1, 2.7));
		expect(shakeNoise(0.3, 1, 2.7)).not.toBe(shakeNoise(0.4, 1, 2.7));
		let max = 0;
		let prev = shakeNoise(0.3, 1, 0);
		let maxStep = 0;
		for (let x = 0.001; x < 40; x += 0.001) {
			const v = shakeNoise(0.3, 1, x);
			max = Math.max(max, Math.abs(v));
			maxStep = Math.max(maxStep, Math.abs(v - prev));
			prev = v;
		}
		expect(max).toBeLessThan(1.6);
		expect(max).toBeGreaterThan(0.5);
		expect(maxStep).toBeLessThan(0.01); // no jumps, also across the knots
	});

	it('poses are seeded, smooth in time, and vanish at Amplitude 0', () => {
		const a = shakePose(sp, 0.2, 1.5, 1);
		expect(shakePose(sp, 0.2, 1.5, 1)).toEqual(a);
		expect(shakePose(sp, 0.7, 1.5, 1)).not.toEqual(a);
		const b = shakePose(sp, 0.2, 1.5 + 1 / 240, 1);
		expect(Math.abs(b.dx - a.dx)).toBeLessThan(0.01);
		// x shakes ±(Amplitude × X Rand Amp × 0.1) frame widths, more than y (0.1 × 0.1).
		let mx = 0;
		let my = 0;
		for (let f = 0; f < 300; f++) {
			const p = shakePose(sp, 0.2, f / 30, 1);
			mx = Math.max(mx, Math.abs(p.dx));
			my = Math.max(my, Math.abs(p.dy));
			expect(p.zoom).toBe(1); // Z Rand Amp 0
			expect(p.tilt).toBe(0);
		}
		expect(mx).toBeGreaterThan(0.01);
		expect(mx).toBeLessThan(0.035);
		expect(my).toBeLessThan(mx);
		const still = shakeParamsOf(defaults(byLabel('S_Shake'), { amplitude: 0 }));
		expect(shakePose(still, 0.2, 1.5, 0)).toEqual({ dx: 0, dy: 0, zoom: 1, tilt: 0 });
	});

	it('Twitchy with Stillness 1 never moves; Jumpy holds between jumps; channels differ with RGB settings', () => {
		const tw = shakeParamsOf(defaults(byLabel('S_Shake'), { style: 'twitchy', stillness: 1 }));
		for (let f = 0; f < 120; f++) expect(shakePose(tw, 0.2, f / 30, 0).dx).toBe(0);
		const jp = shakeParamsOf(defaults(byLabel('S_Shake'), { style: 'jumpy', drift: 0 }));
		// Rate = Frequency × Rand Freq / 4 = 2 jumps per second: constant within half a second.
		expect(shakePose(jp, 0.2, 0.05, 0).dx).toBe(shakePose(jp, 0.2, 0.45, 0).dx);
		const rgb = shakeParamsOf(defaults(byLabel('S_Shake'), { redAmplitude: 2 }));
		expect(shakePose(rgb, 0.2, 1, 0).dx).toBeCloseTo(2 * shakePose(rgb, 0.2, 1, 1).dx, 12);
	});

	it('uniforms: the pose of the frame per channel; motion blur plans an adaptive shutter', () => {
		const spec = byLabel('S_Shake');
		const ctx = { frame: 12, fps: 30, seed: 0.4, width: 1920, height: 1080, pxScale: 1 };
		const u = shakeUniforms(defaults(spec), ctx);
		expect(u.u_shakeNow.vec4s).toHaveLength(12);
		expect(u.u_mbPlan.ivec4[0]).toBe(1); // blur off: one tap, the unchanged single-pose path
		expect(u.u_mbKeys.vec4s).toHaveLength(FX_MB_KEYS * 3 * 4);
		expect(u.u_shakeRgb).toBe(false);
		const mb = shakeUniforms(defaults(spec, { motionBlur: true }), ctx);
		expect(mb.u_mbPlan.ivec4[0]).toBeGreaterThan(1);
		expect(mb.u_mbPlan.ivec4[2]).toBe(3); // 3 channels per key pose
		expect(mb.u_mbKeys.vec4s).toHaveLength(FX_MB_KEYS * 3 * 4);
		expect(mb.u_mbKeys.vec4s[4]).not.toBe(mb.u_mbKeys.vec4s[12 * (FX_MB_KEYS - 1) + 4]);
		// The pose of the frame is unchanged by the blur; the key arrays keep their size without blur.
		expect(mb.u_shakeNow).toEqual(u.u_shakeNow);
		// Faster shakes take more taps; the preview scale takes proportionally fewer.
		const fast = shakeUniforms(defaults(spec, { motionBlur: true, amplitude: 4 }), ctx).u_mbPlan.ivec4[0];
		const slow = shakeUniforms(defaults(spec, { motionBlur: true, amplitude: 0.5 }), ctx).u_mbPlan.ivec4[0];
		expect(fast).toBeGreaterThan(slow);
		const half = shakeUniforms(defaults(spec, { motionBlur: true, amplitude: 0.5 }), {
			...ctx,
			pxScale: 0.5,
		});
		expect(half.u_mbPlan.ivec4[0]).toBeLessThanOrEqual(Math.ceil(slow / 2) + 1);
		expect(shakeUniforms(defaults(spec, { motionBlur: true, amplitude: 0 }), ctx).u_mbPlan.ivec4[0]).toBe(1);
		expect(shakeUniforms(defaults(spec, { bluePhase: 0.5 }), { frame: 0, fps: 30, seed: 0 }).u_shakeRgb).toBe(
			true,
		);
		const t = shutterTimes(1, 30, 1, 4);
		expect(t[0]).toBeCloseTo(1 - 0.375 / 30, 12);
		expect(t[3]).toBeCloseTo(1 + 0.375 / 30, 12);
		expect(shutterTimes(1, 30, 1, 1)).toEqual([1]);
	});

	it('pads a layer by the reach of the shake', () => {
		const spec = byLabel('S_Shake');
		const p = gpuPadding(spec, defaults(spec), ctx);
		expect(p.left).toBeGreaterThan(0.03 * 1920);
		expect(gpuPadding(spec, defaults(spec, { amplitude: 0 }), ctx).left).toBe(0);
	});
});

describe('other TypeScript hooks', () => {
	it('S_ParallaxStrips fades out (End) or in (Start) with clip time, or follows Manual Amount', () => {
		const spec = byLabel('S_ParallaxStrips');
		const p = defaults(spec);
		expect(parallaxAmount(p, 0, 100)).toBe(1);
		expect(parallaxAmount(p, 99, 100)).toBe(0);
		expect(parallaxAmount(p, 50, 100)).toBeGreaterThan(0.8); // Slow Fade 0.9 keeps it strong for longer
		expect(parallaxAmount({ ...p, slowFade: 0 }, 50, 100)).toBeCloseTo(1 - 50 / 99, 10);
		expect(parallaxAmount({ ...p, fade: 'start' }, 0, 100)).toBe(0);
		expect(parallaxAmount({ ...p, fade: 'start' }, 99, 100)).toBe(1);
		expect(parallaxAmount({ ...p, mode: 'manual', manualAmount: 0.3 }, 99, 100)).toBe(0.3);
	});

	it('S_WarpDrops searches ≈192 cells and plans its five passes', () => {
		expect(dropGrid(1920, 1080)).toBe(18);
		expect(dropGrid(1080, 1920)).toBe(10);
		const passes = gpuPasses(byLabel('S_WarpDrops').gpu!, defaults(byLabel('S_WarpDrops')), ctx);
		expect(passes.map((p) => p.output ?? null)).toEqual([
			'dropCells',
			'dropPeaks',
			'dropList',
			'dropDisp',
			null,
		]);
		expect(passes[0]!.scale).toBeCloseTo(18 / 1920, 12);
	});

	it('S_InfiniteZoom splits the zoom into a level and a fraction', () => {
		const spec = byLabel('S_InfiniteZoom');
		const u = spec.gpu!.uniforms!(defaults(spec, { zoom: 5 }), {
			...ctx,
			frame: 0,
			duration: 10,
			seed: 0,
			progress: 0,
		}) as Record<string, number>;
		expect(u.u_izL).toBeCloseTo(Math.LN2, 12);
		expect(u.u_izLevel).toBe(2); // 5 = 2^2.32
		expect(u.u_izFrac).toBeCloseTo(Math.log2(5) - 2, 12);
		expect(u.u_izStrands).toBe(1);
	});
});
