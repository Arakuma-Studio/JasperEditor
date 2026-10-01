// S06 §9.1: Lumetri reference maths (CG-020…023), PCHIP curves, the M1 colour ops and colour-run fusion.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	applyLut,
	BLACK_WHITE_OP,
	BRIGHTNESS_CONTRAST_OP,
	bakeColorRun,
	bakeLut,
	brightnessContrastLinear,
	type ColorOpContext,
	colorRunKey,
	curveFn,
	defaultEffectRegistry,
	defaultParams,
	effectBadges,
	effectRuns,
	HUE_SATURATION_OP,
	hueRotateMatrix,
	identityLut,
	LUMETRI_EFFECT,
	LUMETRI_EFFECT_ID,
	LUMETRI_PARAMS,
	type Lut,
	lumetriFn,
	mulMat3x3,
	normalizeCurve,
	pchipSlopes,
	type Rgb,
	sampleCurve,
	saturateMatrix,
	wheelDirection,
	whiteBalanceGains,
} from '../src/index.ts';

const NO_LUTS: ColorOpContext = { lut: () => null };
const run = (params: Record<string, unknown>, c: Rgb, ctx: ColorOpContext = NO_LUTS): Rgb => {
	const fn = lumetriFn(params as never, ctx);
	const out: Rgb = [c[0], c[1], c[2]];
	fn?.(out);
	return out;
};
const Y = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const unit = fc.double({ min: 0, max: 1, noNaN: true });
const rgb = fc.tuple(unit, unit, unit) as fc.Arbitrary<Rgb>;

describe('jasper.lumetri@1 spec (S06:CG-001/002)', () => {
	it('is registered by default as a colour correction effect with the contract param list', () => {
		const spec = defaultEffectRegistry.get(LUMETRI_EFFECT_ID);
		expect(spec).toBe(LUMETRI_EFFECT);
		expect(spec?.category).toBe('Color Correction');
		expect(spec?.appliesTo).toBe('video');
		expect(spec?.version).toBe(1);
		expect(LUMETRI_PARAMS.map((p) => p.name)).toEqual([
			'inputLut',
			'temperature',
			'tint',
			'exposure',
			'contrast',
			'highlights',
			'shadows',
			'whites',
			'blacks',
			'saturation',
			'look',
			'lookIntensity',
			'vibrance',
			'curveMaster',
			'curveRed',
			'curveGreen',
			'curveBlue',
			'shadowsWheel',
			'midtonesWheel',
			'highlightsWheel',
			'shadowsLevel',
			'midtonesLevel',
			'highlightsLevel',
		]);
		const by = Object.fromEntries(LUMETRI_PARAMS.map((p) => [p.name, p]));
		expect(by.exposure!.range).toMatchObject({ min: -5, max: 5 });
		expect(by.saturation!.default).toBe(100);
		expect(by.look!.mediaKinds).toEqual(['lut']);
		expect(by.look!.animatable).toBe(false);
		expect(by.curveRed!.type).toBe('curve');
		expect(by.midtonesWheel!.ui?.control).toBe('wheel');
		expect(effectBadges(spec!)).toEqual({ realtime: true, native: true });
	});
});

describe('Lumetri maths (S06 §3)', () => {
	it('CG-021: defaults are the identity (null function; bit-exact on lattice points)', () => {
		expect(lumetriFn(defaultParams(LUMETRI_EFFECT), NO_LUTS)).toBeNull();
		expect(lumetriFn({}, NO_LUTS)).toBeNull();
		// An offline LUT is skipped (CG-004).
		expect(lumetriFn({ look: { mediaId: 'med_missing' }, inputLut: { mediaId: '' } }, NO_LUTS)).toBeNull();
		const lut = bakeColorRun(
			[{ id: 'a', effectId: LUMETRI_EFFECT_ID, effectVersion: 1, enabled: true, params: {} }],
			defaultEffectRegistry,
			NO_LUTS,
		);
		expect(lut).toBeNull();
	});

	it('CG-022: temperature warms (r > b), tint > 0 lowers green, exposure +1 doubles linear light, saturation 0 is grey', () => {
		for (const v of [0.1, 0.3, 0.5, 0.8]) {
			const warm = run({ temperature: 40 }, [v, v, v]);
			expect(warm[0]).toBeGreaterThan(warm[2]);
			const cool = run({ temperature: -40 }, [v, v, v]);
			expect(cool[2]).toBeGreaterThan(cool[0]);
			const magenta = run({ tint: 50 }, [v, v, v]);
			expect(magenta[1]).toBeLessThan(magenta[0]);
			expect(magenta[1]).toBeLessThan(magenta[2]);
			const up = run({ exposure: 1 }, [v, v, v]);
			const Lin = v ** 2.4;
			if (2 * Lin <= 1) expect(up[0] ** 2.4).toBeCloseTo(2 * Lin, 9);
			else expect(up[0]).toBe(1);
		}
		fc.assert(
			fc.property(rgb, (c) => {
				const g = run({ saturation: 0 }, c);
				return Math.abs(g[0] - g[1]) < 1e-12 && Math.abs(g[1] - g[2]) < 1e-12;
			}),
		);
	});

	it('white balance gains keep the luma of grey', () => {
		for (const [t, n] of [
			[100, 0],
			[-100, 0],
			[0, 100],
			[37, -64],
		]) {
			const g = whiteBalanceGains(t!, n!);
			expect(0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2]).toBeCloseTo(1, 12);
		}
	});

	it('contrast pivots around mid-grey; whites/blacks move the end points', () => {
		expect(run({ contrast: 50 }, [0.5, 0.5, 0.5])).toEqual([0.5, 0.5, 0.5]);
		expect(run({ contrast: 50 }, [0.7, 0.7, 0.7])[0]).toBeCloseTo(0.8, 12);
		expect(run({ blacks: 50 }, [0, 0, 0])[0]).toBeCloseTo(0.1, 12);
		expect(run({ whites: -50 }, [1, 1, 1])[0]).toBeCloseTo(0.9, 12);
	});

	it('highlights act on bright tones, shadows on dark tones', () => {
		const dark: Rgb = [0.1, 0.1, 0.1];
		const bright: Rgb = [0.9, 0.9, 0.9];
		expect(run({ highlights: 100 }, dark)[0]).toBeCloseTo(0.1, 12);
		expect(run({ highlights: 100 }, bright)[0]).toBeGreaterThan(0.9);
		expect(run({ highlights: -100 }, bright)[0]).toBeLessThan(0.9);
		expect(run({ shadows: 100 }, dark)[0]).toBeGreaterThan(0.1);
		expect(run({ shadows: -100 }, dark)[0]).toBeLessThan(0.1);
		expect(run({ shadows: 100 }, bright)[0]).toBeCloseTo(0.9, 12);
	});

	it('vibrance boosts dull colours more than saturated ones', () => {
		const dull: Rgb = [0.5, 0.45, 0.4];
		const vivid: Rgb = [0.9, 0.2, 0.1];
		const spread = (c: Rgb) => Math.max(...c) - Math.min(...c);
		const gd = spread(run({ vibrance: 100 }, dull)) / spread(dull);
		const gv = spread(run({ vibrance: 100 }, vivid)) / spread(vivid);
		expect(gd).toBeGreaterThan(gv);
		expect(gd).toBeGreaterThan(1.8);
	});

	it('wheels: a shadows wheel towards red raises r most in the darks; gamma/gain follow their levels', () => {
		const d = wheelDirection([1, 0]);
		expect(d[0]).toBeCloseTo(1, 12);
		expect(d[1]).toBeCloseTo(-0.5, 12);
		expect(d[2]).toBeCloseTo(-0.5, 12);
		// Amount saturates at the unit circle.
		expect(wheelDirection([3, 0])[0]).toBeCloseTo(1, 12);
		const dark = run({ shadowsWheel: [1, 0] }, [0.1, 0.1, 0.1]);
		const bright = run({ shadowsWheel: [1, 0] }, [0.9, 0.9, 0.9]);
		expect(dark[0] - 0.1).toBeGreaterThan(bright[0] - 0.9);
		expect(dark[0]).toBeGreaterThan(dark[1]);
		expect(dark[0]).toBeGreaterThan(dark[2]);
		// Blue-ish highlights wheel (hue 240°).
		const hb = run(
			{ highlightsWheel: [Math.cos((4 * Math.PI) / 3), Math.sin((4 * Math.PI) / 3)] },
			[0.6, 0.6, 0.6],
		);
		expect(hb[2]).toBeGreaterThan(hb[0]);
		expect(run({ midtonesLevel: 50 }, [0.25, 0.25, 0.25])[0]).toBeCloseTo(0.25 ** (1 / 1.25), 12);
		expect(run({ highlightsLevel: 20 }, [0.5, 0.5, 0.5])[0]).toBeCloseTo(0.55, 12);
		expect(run({ shadowsLevel: 100 }, [0, 0, 0])[0]).toBeCloseTo(0.1, 12);
	});

	it('curves: master then per channel', () => {
		const lift = {
			curve: [
				[0, 0.2],
				[1, 1],
			],
		};
		expect(run({ curveMaster: lift }, [0, 0, 0])).toEqual([0.2, 0.2, 0.2]);
		const out = run(
			{
				curveRed: {
					curve: [
						[0, 0],
						[0.5, 0.7],
						[1, 1],
					],
				},
			},
			[0.5, 0.5, 0.5],
		);
		expect(out[0]).toBeCloseTo(0.7, 12);
		expect(out[1]).toBe(0.5);
	});

	it('input LUT and look LUT with intensity (order of CG-020)', () => {
		const invert = bakeLut(5, (c) => {
			c[0] = 1 - c[0];
			c[1] = 1 - c[1];
			c[2] = 1 - c[2];
		});
		const ctx: ColorOpContext = { lut: (id) => (id === 'med_inv' ? invert : null) };
		expect(run({ inputLut: { mediaId: 'med_inv' } }, [0.25, 0.5, 1], ctx)).toEqual([0.75, 0.5, 0]);
		const half = run({ look: { mediaId: 'med_inv' }, lookIntensity: 50 }, [0.2, 0.2, 0.2], ctx);
		expect(half[0]).toBeCloseTo(0.5, 6);
		// Input LUT runs before exposure: invert then brighten ≠ brighten then invert.
		const a = run({ inputLut: { mediaId: 'med_inv' }, exposure: 1 }, [0.8, 0.8, 0.8], ctx);
		expect(a[0]).toBeCloseTo((2 * 0.2 ** 2.4) ** (1 / 2.4), 5);
	});

	it('output is always clamped to 0..1', () => {
		fc.assert(
			fc.property(rgb, (c) => {
				const o = run(
					{ exposure: 4, contrast: 100, saturation: 200, vibrance: 100, highlightsLevel: 100, whites: 100 },
					c,
				);
				return o.every((x) => x >= 0 && x <= 1);
			}),
		);
	});
});

describe('PCHIP curves (S06 §3.1 step 10)', () => {
	it('passes through its points and is flat outside them', () => {
		const pts = [
			[0.1, 0.05],
			[0.3, 0.4],
			[0.6, 0.62],
			[0.9, 0.95],
		];
		const f = curveFn(pts)!;
		for (const [x, y] of pts) expect(f(x!)).toBeCloseTo(y!, 12);
		expect(f(0)).toBe(0.05);
		expect(f(1)).toBe(0.95);
		expect(f(-1)).toBe(0.05);
	});

	it('monotone data gives a monotone curve (property test)', () => {
		const pointsArb = fc
			.uniqueArray(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 2, maxLength: 12 })
			.chain((xs) =>
				fc
					.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: xs.length, maxLength: xs.length })
					.map((ys) => {
						const sx = [...xs].sort((a, b) => a - b);
						const sy = [...ys].sort((a, b) => a - b);
						return sx.map((x, i) => [x, sy[i]!]);
					}),
			);
		fc.assert(
			fc.property(pointsArb, (pts) => {
				const norm = normalizeCurve(pts);
				if (!norm) return true;
				const s = sampleCurve(norm, 512);
				for (let i = 1; i < s.length; i++) if (s[i]! < s[i - 1]! - 1e-12) return false;
				return true;
			}),
		);
	});

	it('slopes are zero at local extrema (shape preserving)', () => {
		const m = pchipSlopes([0, 0.5, 1], [0, 1, 0]);
		expect(m[1]).toBe(0);
	});

	it('the identity curve and collinear points are the identity', () => {
		expect(
			curveFn([
				[0, 0],
				[1, 1],
			]),
		).toBeNull();
		expect(
			curveFn([
				[0, 0],
				[0.4, 0.4],
				[1, 1],
			]),
		).toBeNull();
		expect(curveFn(null)).toBeNull();
		expect(
			normalizeCurve([
				[1, 2],
				[0, -1],
				[0.5, 0.5],
			]),
		).toEqual([
			[0, 0],
			[0.5, 0.5],
			[1, 1],
		]);
	});
});

describe('M1 colour ops (S06:CG-003/023)', () => {
	const apply = (op: typeof BRIGHTNESS_CONTRAST_OP, p: Record<string, unknown>, c: Rgb): Rgb => {
		const o: Rgb = [...c];
		op.build(p as never, NO_LUTS)?.(o);
		return o;
	};
	const mat = (m: number[], c: Rgb): Rgb => [
		m[0]! * c[0] + m[1]! * c[1] + m[2]! * c[2],
		m[3]! * c[0] + m[4]! * c[1] + m[5]! * c[2],
		m[6]! * c[0] + m[7]! * c[1] + m[8]! * c[2],
	];
	const clamp = (c: Rgb): Rgb => c.map((x) => Math.min(1, Math.max(0, x))) as Rgb;

	it('Brightness & Contrast matches S03:FX-040 within 1e-6', () => {
		fc.assert(
			fc.property(
				rgb,
				fc.double({ min: -100, max: 100, noNaN: true }),
				fc.double({ min: -100, max: 100, noNaN: true }),
				(c, b, k) => {
					const o = apply(BRIGHTNESS_CONTRAST_OP, { brightness: b, contrast: k }, c);
					const { slope, intercept } = brightnessContrastLinear({ brightness: b, contrast: k });
					return o.every(
						(x, i) =>
							Math.abs(x - Math.min(1, Math.max(0, (1 + k / 100) * (c[i]! - 0.5) + 0.5 + b / 200))) < 1e-6 &&
							Math.abs(slope * c[i]! + intercept - ((1 + k / 100) * (c[i]! - 0.5) + 0.5 + b / 200)) < 1e-9,
					);
				},
			),
		);
		expect(BRIGHTNESS_CONTRAST_OP.build({ brightness: 0, contrast: 0 }, NO_LUTS)).toBeNull();
	});

	it('Hue/Saturation equals the CSS hue-rotate then saturate matrices within 1e-6', () => {
		fc.assert(
			fc.property(
				rgb,
				fc.double({ min: -180, max: 180, noNaN: true }),
				fc.double({ min: -100, max: 100, noNaN: true }),
				(c, h, s) => {
					const o = apply(HUE_SATURATION_OP, { hue: h, saturation: s }, c);
					const want = clamp(mat(saturateMatrix(1 + s / 100), mat(hueRotateMatrix(h), c)));
					return o.every((x, i) => Math.abs(x - want[i]!) < 1e-6);
				},
			),
		);
		// Pure saturation 0 is grey; rotation keeps luma of grey.
		const g = apply(HUE_SATURATION_OP, { saturation: -100 }, [0.9, 0.2, 0.1]);
		expect(Math.abs(g[0] - g[1])).toBeLessThan(1e-9);
		expect(mulMat3x3(hueRotateMatrix(0), saturateMatrix(1))[0]).toBeCloseTo(1, 12);
		expect(HUE_SATURATION_OP.build({ hue: 0, saturation: 0 }, NO_LUTS)).toBeNull();
	});

	it('Black & White is lerp(v, Y(v), amount)', () => {
		fc.assert(
			fc.property(rgb, fc.double({ min: 0, max: 100, noNaN: true }), (c, a) => {
				const o = apply(BLACK_WHITE_OP, { amount: a }, c);
				const y = Y(c);
				return o.every((x, i) => Math.abs(x - (c[i]! + (y - c[i]!) * (a / 100))) < 1e-6);
			}),
		);
		expect(BLACK_WHITE_OP.build({ amount: 0 }, NO_LUTS)).toBeNull();
	});

	it('the M1 colour effects have no native filter strings any more (no eq/hue, D-13) but fuse as colour runs', () => {
		for (const id of ['jasper.brightness-contrast', 'jasper.hue-saturation', 'jasper.black-white']) {
			const spec = defaultEffectRegistry.get(id)!;
			expect(spec.native).toBeNull();
			expect(spec.color).toBeDefined();
			expect(effectBadges(spec).native).toBe(true);
		}
	});
});

describe('colour runs with Lumetri (S06:CG-011/012)', () => {
	const fx = (id: string, effectId: string, params: Record<string, unknown>, enabled = true) => ({
		id,
		effectId,
		effectVersion: 1,
		enabled,
		params,
	});

	it('consecutive colour effects fuse; blur ends the run; the baked LUT equals the composed function', () => {
		const stack = [
			fx('a', 'jasper.brightness-contrast', { brightness: 5, contrast: -20 }),
			fx('b', LUMETRI_EFFECT_ID, { temperature: 10, exposure: -0.3, saturation: 90, shadows: 20 }),
			fx('c', 'jasper.gaussian-blur', { radius: 3 }),
			fx('d', 'jasper.black-white', { amount: 50 }),
		];
		const runs = effectRuns(stack, defaultEffectRegistry);
		expect(runs.map((r) => r.kind)).toEqual(['color', 'other', 'color']);
		const first = runs[0]!;
		if (first.kind !== 'color') throw new Error('expected a colour run');
		expect(first.effects.map((e) => e.id)).toEqual(['a', 'b']);
		const lut = bakeColorRun(first.effects, defaultEffectRegistry, NO_LUTS, 33)!;
		const bc = BRIGHTNESS_CONTRAST_OP.build({ brightness: 5, contrast: -20 }, NO_LUTS)!;
		const lu = lumetriFn({ temperature: 10, exposure: -0.3, saturation: 90, shadows: 20 }, NO_LUTS)!;
		let worst = 0;
		let within = 0;
		for (let i = 0; i < 2000; i++) {
			const c: Rgb = [Math.random(), Math.random(), Math.random()];
			const ref: Rgb = [...c];
			bc(ref);
			lu(ref);
			const got: Rgb = [...c];
			applyLut(lut, got);
			let e = 0;
			for (let k = 0; k < 3; k++) e = Math.max(e, Math.abs(got[k]! - ref[k]!));
			worst = Math.max(worst, e);
			if (e < 1 / 255) within++;
		}
		// A smooth grade (no clipping kinks) interpolates at 33³ to well below one 8-bit code value.
		expect(within / 2000).toBe(1);
		expect(worst).toBeLessThan(0.5 / 255);
	});

	it('the run key changes with params and with the content identity of referenced LUTs', () => {
		const e = [fx('a', LUMETRI_EFFECT_ID, { look: { mediaId: 'med_L' }, exposure: 1 })];
		const k1 = colorRunKey(e, (id) => `fp-${id}-1`);
		const k2 = colorRunKey(e, (id) => `fp-${id}-2`);
		const k3 = colorRunKey(
			[fx('a', LUMETRI_EFFECT_ID, { look: { mediaId: 'med_L' }, exposure: 1.1 })],
			(id) => `fp-${id}-1`,
		);
		expect(new Set([k1, k2, k3]).size).toBe(3);
	});

	it('a 33³ bake of a full grade takes < 15 ms (S06:CG-043; reported, fails above 2×)', () => {
		const look: Lut = identityLut(33);
		const ctx: ColorOpContext = { lut: () => look };
		const params = {
			inputLut: { mediaId: 'x' },
			temperature: -35,
			tint: 8,
			exposure: 0.4,
			contrast: 12,
			highlights: -30,
			shadows: 40,
			whites: 5,
			blacks: -5,
			saturation: 110,
			look: { mediaId: 'y' },
			lookIntensity: 85,
			vibrance: 20,
			curveMaster: {
				curve: [
					[0, 0],
					[0.2, 0.22],
					[0.42, 0.5],
					[0.62, 0.66],
					[0.8, 0.8],
					[1, 1],
				],
			},
			curveBlue: {
				curve: [
					[0, 0.02],
					[0.5, 0.52],
					[1, 1],
				],
			},
			shadowsWheel: [0.1, 0.2],
			midtonesWheel: [-0.1, 0.05],
			highlightsWheel: [0.05, -0.1],
			shadowsLevel: 5,
			midtonesLevel: 3,
			highlightsLevel: -4,
		};
		const effects = [fx('a', LUMETRI_EFFECT_ID, params)];
		bakeColorRun(effects, defaultEffectRegistry, ctx, 33); // warm-up (JIT)
		// CPU time of this worker (process.cpuUsage), not wall time: parallel test files on a loaded host would
		// otherwise measure the scheduler instead of the bake.
		const times: number[] = [];
		const wall: number[] = [];
		for (let i = 0; i < 12; i++) {
			const u0 = process.cpuUsage();
			const t0 = performance.now();
			bakeColorRun(effects, defaultEffectRegistry, ctx, 33);
			wall.push(performance.now() - t0);
			const u = process.cpuUsage(u0);
			times.push((u.user + u.system) / 1000);
		}
		const best = Math.min(...times);
		console.info(
			`[S06 §9.9] 33³ Lumetri bake (full grade): best CPU ${best.toFixed(2)} ms, wall ${Math.min(...wall).toFixed(2)} ms (budget 15 ms)`,
		);
		expect(best).toBeLessThan(30);
	});
});
