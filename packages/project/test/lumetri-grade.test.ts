// color-grade: the Lumetri completion — creative adjustments, built-in looks, hue/saturation curves, section
// switches (pointwise, baked into the colour run) and the spatial stage's maths and snapshot expansion.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { budgetMs } from '../../../scripts/perf/budget.ts';
import {
	type Animatable,
	addColorToKey,
	bakeColorRun,
	type ColorOpContext,
	CREATIVE_LOOKS,
	type CurveValue,
	DEFAULT_SECONDARY_KEY,
	defaultEffectRegistry,
	EASE_PRESETS,
	type EffectParams,
	effectiveParams,
	expandLumetriSpatial,
	hslToRgb,
	hueCurveEyedropper,
	isNeutralHueCurve,
	keyFromColor,
	LUMETRI_EFFECT,
	LUMETRI_EFFECT_ID,
	LUMETRI_GROUPS,
	LUMETRI_PARAMS,
	LUMETRI_SPATIAL_EFFECT_ID,
	LUMETRI_SPATIAL_PARAMS,
	linearCurveEyedropper,
	lumetriFn,
	lumetriSpatialActive,
	lumetriSpatialPixel,
	lumetriSpatialSettings,
	lumetriUsesSpatial,
	offsetCurveFn,
	type ParamValue,
	type Rgb,
	removeColorFromKey,
	rgbToHsl,
	type SecondaryKey,
	secondaryKey,
	vignetteWeight,
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

describe('Lumetri completion params', () => {
	it('appends the color-grade params after the S06 contract, with identity defaults', () => {
		const names = LUMETRI_PARAMS.map((p) => p.name);
		expect(names.slice(25)).toContain('hueVsSat');
		expect(names).toContain('vignetteAmount');
		expect(names).toContain('secHueCenter');
		expect(new Set(names).size).toBe(names.length);
		// Every spatial param exists on the Lumetri spec.
		for (const n of LUMETRI_SPATIAL_PARAMS) expect(names).toContain(n);
		// Section switches and groups.
		expect(LUMETRI_GROUPS.map((g) => g.group)).toEqual([
			'basic',
			'creative',
			'curves',
			'wheels',
			'secondary',
			'vignette',
		]);
		for (const g of LUMETRI_GROUPS) expect(names).toContain(g.toggle);
		// The defaults change nothing (bit-exact old grades).
		expect(lumetriFn(effectiveParams(LUMETRI_EFFECT, {}), NO_LUTS)).toBeNull();
		expect(lumetriSpatialActive(lumetriSpatialSettings(effectiveParams(LUMETRI_EFFECT, {})))).toBe(false);
	});

	it('the internal spatial stage is registered but never listed', () => {
		const spec = defaultEffectRegistry.get(LUMETRI_SPATIAL_EFFECT_ID);
		expect(spec?.internal).toBe(true);
		expect(spec?.gradeBypass).toBe(true);
		expect(spec?.gpu).toBeDefined();
		expect(spec?.params.map((p) => p.name)).toEqual(LUMETRI_SPATIAL_PARAMS);
	});
});

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
	it('built-in looks are distinct, bounded after the clamp and mixed by intensity', () => {
		const samples: Rgb[] = [
			[0.1, 0.2, 0.3],
			[0.8, 0.5, 0.2],
			[0.5, 0.5, 0.5],
		];
		const outs = new Set<string>();
		for (const look of CREATIVE_LOOKS) {
			if (look.id === 'none') {
				expect(lumetriFn({ creativeLook: 'none' }, NO_LUTS)).toBeNull();
				continue;
			}
			const res = samples.map((c) => run({ creativeLook: look.id }, c));
			for (const c of res) for (const v of c) expect(v >= 0 && v <= 1).toBe(true);
			outs.add(JSON.stringify(res.map((c) => c.map((v) => v.toFixed(3)))));
			const half = run({ creativeLook: look.id, lookIntensity: 50 }, samples[1]!);
			const full = run({ creativeLook: look.id }, samples[1]!);
			for (let k = 0; k < 3; k++)
				expect(half[k]).toBeCloseTo(Math.min(1, Math.max(0, (samples[1]![k]! + full[k]!) / 2)), 1);
		}
		expect(outs.size).toBe(CREATIVE_LOOKS.length - 1);
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
		// An all-black LUT.
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
		// Non-periodic: flat outside.
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
		// Around red the anchors wrap.
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

describe('spatial stage maths', () => {
	const s0 = (p: EffectParams) => lumetriSpatialSettings(p);
	it('keys on hue, saturation and lightness with soft edges; greys leave a hue key', () => {
		const s = s0({ secHueCenter: 0, secHueRange: 15, secHueSoft: 15, secTemperature: 50 });
		expect(s.secondary).toBe(true);
		expect(secondaryKey(s, 0.9, 0.1, 0.1)).toBeCloseTo(1, 6);
		expect(secondaryKey(s, 0.1, 0.1, 0.9)).toBe(0);
		expect(secondaryKey(s, 0.5, 0.5, 0.5)).toBe(0);
		// 22.5° from red: half way through the softness.
		const hsl = hslToRgb(22.5 / 360, 0.8, 0.5, [0, 0, 0]);
		expect(secondaryKey(s, hsl[0], hsl[1], hsl[2])).toBeCloseTo(0.5, 2);
		const l = s0({ secLumaLow: 60, secLumaHigh: 100, secLumaSoft: 10, secSaturation: 0 });
		expect(secondaryKey(l, 0.8, 0.8, 0.8)).toBe(1);
		expect(secondaryKey(l, 0.55, 0.55, 0.55)).toBeCloseTo(0.5, 6);
		expect(secondaryKey(l, 0.2, 0.2, 0.2)).toBe(0);
	});
	it('the correction applies inside the key only; Show Mask and Invert', () => {
		const s = s0({ secHueCenter: 0, secHueRange: 20, secSaturation: 0 });
		const red = lumetriSpatialPixel(s, [0.9, 0.1, 0.1], 0.5, 0.5, 16 / 9);
		expect(chroma(red)).toBeLessThan(1e-6);
		const blue = lumetriSpatialPixel(s, [0.1, 0.1, 0.9], 0.5, 0.5, 16 / 9);
		expect(blue).toEqual([0.1, 0.1, 0.9]);
		const inv = s0({ secHueCenter: 0, secHueRange: 20, secSaturation: 0, secInvert: true });
		expect(chroma(lumetriSpatialPixel(inv, [0.1, 0.1, 0.9], 0.5, 0.5, 1))).toBeLessThan(1e-6);
		const wb = s0({ secHueCenter: 0, secHueRange: 20, secShowMask: true, secMaskStyle: 'whiteBlack' });
		expect(lumetriSpatialPixel(wb, [0.9, 0.1, 0.1], 0.5, 0.5, 1)).toEqual([1, 1, 1]);
		expect(lumetriSpatialPixel(wb, [0.1, 0.1, 0.9], 0.5, 0.5, 1)).toEqual([0, 0, 0]);
		const cg = s0({ secHueCenter: 0, secHueRange: 20, secShowMask: true });
		const grey = lumetriSpatialPixel(cg, [0.1, 0.1, 0.9], 0.5, 0.5, 1);
		expect(chroma(grey)).toBeLessThan(1e-9);
	});
	it('3-way correction wheels use the Lumetri wheel maths', () => {
		const s = s0({ secWheelMode: 'three', secHighlightsLevel: 50 });
		const out = lumetriSpatialPixel(s, [0.5, 0.5, 0.5], 0.5, 0.5, 1);
		expect(out[0]).toBeCloseTo(0.625, 6);
	});
	it('the vignette darkens the corners, not the centre; roundness and feather shape it', () => {
		const v = s0({ vignetteAmount: -3 }).vignette;
		expect(vignetteWeight(v, 0.5, 0.5, 16 / 9)).toBe(0);
		expect(vignetteWeight(v, 0, 0, 16 / 9)).toBeGreaterThan(0.9);
		const c = lumetriSpatialPixel(s0({ vignetteAmount: -5, vignetteFeather: 0 }), [0.8, 0.8, 0.8], 0, 0, 1);
		expect(c[0]).toBeLessThan(0.05);
		const lighter = lumetriSpatialPixel(
			s0({ vignetteAmount: 5, vignetteFeather: 0 }),
			[0.2, 0.2, 0.2],
			0,
			0,
			1,
		);
		expect(lighter[0]).toBeGreaterThan(0.95);
		const round = s0({ vignetteAmount: -3, vignetteRoundness: 100 }).vignette;
		// A circle on a wide frame reaches the left/right edges earlier than the aspect-following ellipse.
		expect(vignetteWeight(round, 0.02, 0.5, 16 / 9)).toBeGreaterThan(vignetteWeight(v, 0.02, 0.5, 16 / 9));
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
	it('adds the spatial companion after a Lumetri instance that uses vignette, sharpen or the secondary', () => {
		const masks = [{ id: 'm1' }];
		const list = expandLumetriSpatial([lum({ vignetteAmount: -2, exposure: 1 }, { masks })]);
		expect(list.map((f) => f.effectId)).toEqual([LUMETRI_EFFECT_ID, LUMETRI_SPATIAL_EFFECT_ID]);
		expect(list[1]!.id).toBe('fx1~spatial');
		expect(list[1]!.masks).toBe(masks);
		expect(Object.keys(list[1]!.params)).toEqual(['vignetteAmount']);
	});
	it('nothing is added for pointwise grades, disabled instances or switched-off sections', () => {
		const plain = [
			lum({
				exposure: 1,
				hueVsSat: {
					curve: [
						[0, 0.2],
						[1, 0.2],
					],
				},
			}),
		];
		expect(expandLumetriSpatial(plain)).toBe(plain);
		expect(lumetriUsesSpatial(lum({ vignetteAmount: -2 }, { enabled: false }))).toBe(false);
		expect(lumetriUsesSpatial(lum({ vignetteAmount: -2, vignetteOn: false }))).toBe(false);
		expect(lumetriUsesSpatial(lum({ secHueCenter: 120 }))).toBe(false);
		expect(lumetriUsesSpatial(lum({ secSaturation: 50 }))).toBe(true);
		expect(lumetriUsesSpatial(lum({ secSaturation: 50, secondaryOn: false }))).toBe(false);
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

describe('HSL Secondary eyedroppers', () => {
	const s0 = (p: EffectParams) => lumetriSpatialSettings({ secSaturation: 0, ...p });
	const key = (k: SecondaryKey, rgb: [number, number, number]) => secondaryKey(s0(k), ...rgb);
	const orange: [number, number, number] = [0.9, 0.5, 0.1];
	const red: [number, number, number] = [0.85, 0.1, 0.1];
	const blue: [number, number, number] = [0.1, 0.2, 0.9];
	it('Set Color keys the picked colour, not others; greys key on lightness only', () => {
		const k = keyFromColor(orange);
		expect(key(k, orange)).toBe(1);
		expect(key(k, blue)).toBe(0);
		const g = keyFromColor([0.5, 0.5, 0.5]);
		expect(g.secHueOn).toBe(false);
		expect(key(g, [0.52, 0.5, 0.5])).toBe(1);
		expect(key(g, [0.95, 0.95, 0.95])).toBe(0);
	});
	it('Add Color extends the key to the new colour and keeps the old one', () => {
		const k = addColorToKey(keyFromColor(orange), red);
		expect(key(k, orange)).toBe(1);
		expect(key(k, red)).toBe(1);
		expect(key(k, blue)).toBe(0);
	});
	it('Remove Color drops the picked colour and keeps the rest of the key', () => {
		const wide = addColorToKey(keyFromColor(orange), red);
		const k = removeColorFromKey(wide, red);
		expect(key(k, red)).toBe(0);
		expect(key(k, orange)).toBeGreaterThan(0.99);
		expect(removeColorFromKey(DEFAULT_SECONDARY_KEY, blue)).not.toEqual(DEFAULT_SECONDARY_KEY);
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
					const px = lumetriSpatialPixel(s, [r, g, b], 0.3, 0.7, 16 / 9);
					return px.every((v) => Number.isFinite(v));
				},
			),
			{ numRuns: 300 },
		);
	});
	it('snapshot expansion tolerates malformed animatables', () => {
		fc.assert(
			fc.property(fc.dictionary(fc.constantFrom(...names), junk, { maxKeys: 10 }), (raw) => {
				const params = Object.fromEntries(
					Object.entries(raw).map(([k, v]) => [k, { value: v, keyframes: [] }]),
				) as never;
				const list = expandLumetriSpatial([
					{ id: 'fx', effectId: LUMETRI_EFFECT_ID, effectVersion: 1, enabled: true, params },
				]);
				return list.length >= 1 && list.length <= 2;
			}),
			{ numRuns: 200 },
		);
	});
});
