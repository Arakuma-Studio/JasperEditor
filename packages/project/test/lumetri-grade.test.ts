import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { budgetMs } from '../../../scripts/perf/budget.ts';
import {
	type Animatable,
	bakeColorRun,
	type ColorOpContext,
	CREATIVE_LOOKS,
	type CurveValue,
	defaultEffectRegistry,
	EASE_PRESETS,
	type EffectParams,
	hslToRgb,
	hueCurveEyedropper,
	isNeutralHueCurve,
	LUMETRI_EFFECT_ID,
	LUMETRI_PARAMS,
	linearCurveEyedropper,
	lumetriFn,
	lumetriSpatialSettings,
	lumetriUsesSpatial,
	offsetCurveFn,
	type ParamValue,
	type Rgb,
	rgbToHsl,
	wheelOfRgb,
	wheelRgb,
} from '../src/index.ts';

const NO_LUTS: ColorOpContext = { lut: () => null };
const run = (params: EffectParams, c: Rgb, ctx: ColorOpContext = NO_LUTS): Rgb => {
	const fn = lumetriFn(params, ctx);
	const out: Rgb = [c[0], c[1], c[2]];
	fn?.(out);
	return out;
};
const Y = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const chroma = (c: Rgb) => Math.max(...c) - Math.min(...c);
const unit = fc.double({ min: 0, max: 1, noNaN: true });

describe('Creative adjustments (pointwise)', () => {
	it('Faded Film lifts black and compresses white', () => {
		const b = run({ fadedFilm: 100 }, [0, 0, 0]);
		const w = run({ fadedFilm: 100 }, [1, 1, 1]);
		expect(b[0]).toBeCloseTo(0.12, 6);
		expect(w[0]).toBeCloseTo(0.87, 6);
	});
	it('Creative Saturation 0 gives grey at the same luma; 200 doubles the chroma', () => {
		const c: Rgb = [0.6, 0.3, 0.2];
		const g = run({ creativeSaturation: 0 }, c);
		expect(chroma(g)).toBeLessThan(1e-9);
		expect(Y(g)).toBeCloseTo(Y(c), 9);
		const s = run({ creativeSaturation: 150 }, c);
		expect(chroma(s)).toBeCloseTo(chroma(c) * 1.5, 6);
	});
	it('Shadow Tint colours the shadows, Highlight Tint the highlights; Tint Balance moves the pivot', () => {
		const red: [number, number] = [1, 0];
		const dark = run({ shadowTint: red }, [0.1, 0.1, 0.1]);
		const bright = run({ shadowTint: red }, [0.9, 0.9, 0.9]);
		expect(dark[0] - dark[1]).toBeGreaterThan(0.1);
		expect(bright[0] - bright[1]).toBeLessThan(0.01);
		const hi = run({ highlightTint: red }, [0.9, 0.9, 0.9]);
		expect(hi[0] - hi[1]).toBeGreaterThan(0.1);
		// A higher balance makes more of the range "shadows".
		const mid: Rgb = [0.5, 0.5, 0.5];
		const low = run({ shadowTint: red, tintBalance: -100 }, mid);
		const high = run({ shadowTint: red, tintBalance: 100 }, mid);
		expect(high[0] - high[1]).toBeGreaterThan(low[0] - low[1]);
	});
	it('built-in looks stay bounded and mix by intensity', () => {
		const samples: Rgb[] = [
			[0.1, 0.2, 0.3],
			[0.8, 0.5, 0.2],
			[0.5, 0.5, 0.5],
		];
		for (const look of CREATIVE_LOOKS) {
			if (look.id === 'none') {
				continue;
			}
			const res = samples.map((c) => run({ creativeLook: look.id }, c));
			for (const c of res) for (const v of c) expect(v >= 0 && v <= 1).toBe(true);
			const half = run({ creativeLook: look.id, lookIntensity: 50 }, samples[1]!);
			const full = run({ creativeLook: look.id }, samples[1]!);
			for (let k = 0; k < 3; k++)
				expect(half[k]).toBeCloseTo(Math.min(1, Math.max(0, (samples[1]![k]! + full[k]!) / 2)), 1);
		}
	});
	it('a look LUT takes precedence over the built-in look', () => {
		const lut = {
			dimensions: 3 as const,
			size: 2,
			title: null,
			domainMin: [0, 0, 0] as Rgb,
			domainMax: [1, 1, 1] as Rgb,
			data: new Float32Array(24),
		};
		const ctx: ColorOpContext = { lut: () => lut };
		const out = run({ look: { mediaId: 'm' }, creativeLook: 'arctic' }, [0.5, 0.5, 0.5], ctx);
		expect(out).toEqual([0, 0, 0]);
	});
});

describe('Hue / saturation curves', () => {
	it('neutral curves are the identity; periodic curves are continuous across red', () => {
		expect(
			isNeutralHueCurve([
				[0, 0.5],
				[1, 0.5],
			]),
		).toBe(true);
		expect(
			offsetCurveFn(
				[
					[0, 0.5],
					[0.5, 0.5],
				],
				true,
			),
		).toBeNull();
		const f = offsetCurveFn(
			[
				[0, 0.8],
				[0.33, 0.5],
				[0.66, 0.4],
				[1, 0.8],
			],
			true,
		)!;
		expect(f(0)).toBeCloseTo(0.3, 6);
		expect(Math.abs(f(0.9999) - f(0))).toBeLessThan(0.01);
		expect(Math.abs(f(-0.25) - f(0.75))).toBeLessThan(1e-9);
		const g = offsetCurveFn(
			[
				[0.2, 0.7],
				[0.8, 0.3],
			],
			false,
		)!;
		expect(g(0)).toBeCloseTo(0.2, 6);
		expect(g(1)).toBeCloseTo(-0.2, 6);
	});
	it('Hue vs Sat desaturates only the chosen hue; greys are untouched', () => {
		// Red (x = 0) to 0: no saturation for reds; blue (x = 2/3) stays.
		const curve: CurveValue = {
			curve: [
				[0, 0],
				[0.17, 0.5],
				[0.5, 0.5],
				[0.83, 0.5],
			],
		};
		const red = run({ hueVsSat: curve }, [0.8, 0.2, 0.2]);
		const blue = run({ hueVsSat: curve }, [0.2, 0.2, 0.8]);
		const grey = run({ hueVsSat: curve }, [0.4, 0.4, 0.4]);
		expect(chroma(red)).toBeLessThan(0.02);
		expect(blue).toEqual([0.2, 0.2, 0.8].map((v) => expect.closeTo(v, 6)));
		expect(grey).toEqual([0.4, 0.4, 0.4].map((v) => expect.closeTo(v, 9)));
	});
	it('Hue vs Hue rotates a hue; Hue vs Luma brightens it; Luma vs Sat and Sat vs Sat scale saturation', () => {
		const hsl: Rgb = [0, 0, 0];
		const green: Rgb = [0.2, 0.8, 0.2];
		const hvh = run(
			{
				hueVsHue: {
					curve: [
						[0, 0.5],
						[0.33, 0.6],
						[0.66, 0.5],
					],
				},
			},
			green,
		);
		rgbToHsl(hvh[0], hvh[1], hvh[2], hsl);
		expect(hsl[0]).toBeGreaterThan(0.38);
		const hvl = run(
			{
				hueVsLuma: {
					curve: [
						[0, 0.5],
						[0.33, 1],
						[0.66, 0.5],
					],
				},
			},
			green,
		);
		expect(Y(hvl)).toBeGreaterThan(Y(green) + 0.1);
		const lvs = run(
			{
				lumaVsSat: {
					curve: [
						[0, 0.5],
						[1, 0],
					],
				},
			},
			[0.9, 0.7, 0.6],
		);
		expect(chroma(lvs)).toBeLessThan(chroma([0.9, 0.7, 0.6]));
		const svs = run(
			{
				satVsSat: {
					curve: [
						[0, 0.5],
						[1, 1],
					],
				},
			},
			[0.7, 0.3, 0.3],
		);
		expect(chroma(svs)).toBeGreaterThan(0.4);
	});
	it('eyedroppers add a centre point and two anchors at the picked value', () => {
		const r = hueCurveEyedropper(
			[
				[0, 0.5],
				[1, 0.5],
			],
			0.5,
		);
		expect(r.points.map((p) => p[0])).toEqual([0, 0.4167, 0.5, 0.5833]);
		expect(r.points[r.index]).toEqual([0.5, 0.5]);
		const w = hueCurveEyedropper(null, 0.01);
		expect(w.points.some((p) => p[0] > 0.9)).toBe(true);
		const l = linearCurveEyedropper(
			[
				[0, 0.5],
				[1, 0.5],
			],
			0.95,
		);
		expect(l.points.map((p) => p[0])).toEqual([0, 0.85, 0.95, 1]);
		expect(l.points[l.index]![0]).toBe(0.95);
	});
});

describe('section switches', () => {
	it('a section switched off acts as its defaults', () => {
		const c: Rgb = [0.3, 0.5, 0.7];
		expect(lumetriFn({ exposure: 2, basicOn: false }, NO_LUTS)).toBeNull();
		expect(lumetriFn({ fadedFilm: 50, creativeOn: false }, NO_LUTS)).toBeNull();
		expect(
			lumetriFn(
				{
					curveMaster: {
						curve: [
							[0, 0.2],
							[1, 1],
						],
					},
					curvesOn: false,
				},
				NO_LUTS,
			),
		).toBeNull();
		expect(lumetriFn({ shadowsLevel: 50, wheelsOn: false }, NO_LUTS)).toBeNull();
		expect(run({ exposure: 1, fadedFilm: 50, creativeOn: false }, c)).toEqual(run({ exposure: 1 }, c));
	});
});

describe('grade maths helpers', () => {
	it('HSL round trips and the wheel direction inverts', () => {
		fc.assert(
			fc.property(unit, unit, unit, (r, g, b) => {
				const hsl = rgbToHsl(r, g, b, [0, 0, 0]);
				const back = hslToRgb(hsl[0], hsl[1], hsl[2], [0, 0, 0]);
				return Math.abs(back[0] - r) < 1e-9 && Math.abs(back[1] - g) < 1e-9 && Math.abs(back[2] - b) < 1e-9;
			}),
		);
		fc.assert(
			fc.property(
				fc.double({ min: -0.7, max: 0.7, noNaN: true }),
				fc.double({ min: -0.7, max: 0.7, noNaN: true }),
				(x, y) => {
					const d = wheelRgb(x, y, [0, 0, 0]);
					const [x2, y2] = wheelOfRgb(0.5 + d[0], 0.5 + d[1], 0.5 + d[2]);
					const m = Math.min(1, Math.hypot(x, y));
					const s = m / (Math.hypot(x, y) || 1);
					return Math.abs(x2 - x * s) < 1e-9 && Math.abs(y2 - y * s) < 1e-9;
				},
			),
		);
	});
});

describe('full grade: properties and bake budget', () => {
	const fullGrade: EffectParams = {
		temperature: 20,
		exposure: 0.3,
		contrast: 15,
		creativeLook: 'teal-orange',
		lookIntensity: 70,
		fadedFilm: 20,
		creativeSaturation: 110,
		shadowTint: [0.3, -0.2],
		highlightTint: [-0.2, 0.3],
		tintBalance: 10,
		vibrance: 15,
		curveMaster: {
			curve: [
				[0, 0],
				[0.3, 0.25],
				[0.7, 0.78],
				[1, 1],
			],
		},
		hueVsSat: {
			curve: [
				[0, 0.6],
				[0.33, 0.4],
				[0.66, 0.55],
			],
		},
		hueVsHue: {
			curve: [
				[0, 0.5],
				[0.15, 0.55],
				[0.5, 0.5],
			],
		},
		hueVsLuma: {
			curve: [
				[0, 0.5],
				[0.6, 0.45],
			],
		},
		lumaVsSat: {
			curve: [
				[0, 0.4],
				[1, 0.5],
			],
		},
		satVsSat: {
			curve: [
				[0, 0.5],
				[1, 0.45],
			],
		},
		midtonesWheel: [0.1, 0.05],
		shadowsLevel: 5,
	};
	it('outputs stay finite and in 0..1 for any input and any section switches', () => {
		fc.assert(
			fc.property(unit, unit, unit, fc.boolean(), fc.boolean(), fc.boolean(), (r, g, b, b1, b2, b3) => {
				const out = run({ ...fullGrade, basicOn: b1, creativeOn: b2, curvesOn: b3 }, [r, g, b]);
				return out.every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
			}),
		);
	});
	it('a 33³ bake of a full grade with every new step takes < 30 ms (best of several runs)', () => {
		const effects = [
			{ id: 'fx', effectId: LUMETRI_EFFECT_ID, effectVersion: 1, enabled: true, params: fullGrade },
		];
		bakeColorRun(effects, defaultEffectRegistry, NO_LUTS, 33);
		const times: number[] = [];
		for (let i = 0; i < 5; i++) {
			const t0 = performance.now();
			bakeColorRun(effects, defaultEffectRegistry, NO_LUTS, 33);
			times.push(performance.now() - t0);
		}
		const best = Math.min(...times);
		console.info(`[color-grade] 33³ Lumetri bake with every completion step: best ${best.toFixed(2)} ms`);
		// Load-tolerant like every timing budget (docs/performance.md §2): exactly 30 ms with PERF=1.
		expect(best).toBeLessThan(budgetMs(30));
	});
});

describe('render snapshot expansion', () => {
	const A = (
		value: ParamValue,
		keyframes: { time: number; value: ParamValue }[] = [],
	): Animatable<ParamValue> => ({
		value,
		keyframes: keyframes.map((k, i) => ({
			id: `k${i}`,
			interpolation: 'linear',
			easeIn: EASE_PRESETS.linear,
			easeOut: EASE_PRESETS.linear,
			...k,
		})),
	});
	const lum = (params: EffectParams, extra: { enabled?: boolean; masks?: { id: string }[] } = {}) => ({
		id: 'fx1',
		effectId: LUMETRI_EFFECT_ID,
		effectVersion: 1,
		enabled: true,
		params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, A(v)])),
		...extra,
	});

	it('a keyframed amount that leaves the default at some key needs the stage', () => {
		const fx = {
			...lum({}),
			params: {
				vignetteAmount: A(0, [
					{ time: 0, value: 0 },
					{ time: 10, value: -3 },
				]),
			},
		};
		expect(lumetriUsesSpatial(fx)).toBe(true);
	});
});

describe('hostile params (AGENTS.md §0.2)', () => {
	const junk = fc.oneof(
		fc.constant(null),
		fc.constant(undefined),
		fc.double(),
		fc.string(),
		fc.boolean(),
		fc.array(fc.oneof(fc.double(), fc.string(), fc.constant(null)), { maxLength: 4 }),
		fc.record({
			curve: fc.array(fc.array(fc.oneof(fc.double(), fc.constant(null)), { maxLength: 3 }), {
				maxLength: 70,
			}),
		}),
		fc.record({ mediaId: fc.oneof(fc.string(), fc.double()) }),
	);
	const names = LUMETRI_PARAMS.map((p) => p.name);
	it('any values of any params: the colour fn and the spatial settings never throw and stay finite', () => {
		fc.assert(
			fc.property(
				fc.dictionary(fc.constantFrom(...names), junk, { maxKeys: 30 }),
				unit,
				unit,
				unit,
				(params, r, g, b) => {
					const fn = lumetriFn(params as never, NO_LUTS);
					const c: Rgb = [r, g, b];
					fn?.(c);
					if (!c.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return false;
					const s = lumetriSpatialSettings(params as never);
					const fields = Object.values(s).flatMap((v) => (typeof v === 'object' ? Object.values(v) : [v]));
					return fields.every((v) => typeof v !== 'number' || Number.isFinite(v));
				},
			),
			{ numRuns: 300 },
		);
	});
});
