// Spec 19, stream Glows: the Deep Glow PSF against the power law it stands for, the standalone effects as entries of the
// registry (§8), padding across every frame (TL-033), the global light of effects (TL-017) and handles (TL-092).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Appearance,
	appearanceClipReach,
	appearanceFromRecipe,
	buildRenderSnapshot,
	clipContentTime,
	clipLook,
	DG_OCTAVES,
	DG_P_LONG,
	DG_P_TIGHT,
	deepGlowPasses,
	defaultEffectRegistry,
	dgExponent,
	dgOctaves,
	dgReach,
	type EffectInstance,
	type EffectParams,
	type EffectSpec,
	FX_MAX_PADDING,
	type FxPlanContext,
	GLSL_TL_UNIT_KNOWN,
	gpuPadding,
	lookReach,
	planGpuEffect,
	planTitleLook,
	resolveAppearance,
	resolveCachedLayerProps,
	TITLE_LAYER_TYPES,
	TITLE_LOOK_EFFECTS,
	titleLayerType,
	validateGpuEffect,
	withDefaults,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const F = 23_520_000; // flicks per frame at 30 fps

type Range = NonNullable<EffectSpec['params'][number]['range']>;

const defaultsOf = (s: EffectSpec): EffectParams =>
	Object.fromEntries(s.params.map((p) => [p.name, p.default]));
const spec = (id: string) => defaultEffectRegistry.get(id) as EffectSpec;
const ids = (n: number) => () => `apl_${String(n++).padStart(16, '0')}`;

/** The mixture's radial intensity at distance r: Σ w / (2πσ²) exp(−r² / 2σ²), the green channel. */
const psf = (octaves: ReturnType<typeof dgOctaves>, r: number) =>
	octaves.reduce((sum, o) => {
		const s = o.sigma[1];
		return sum + (o.weight / (2 * Math.PI * s * s)) * Math.exp((-r * r) / (2 * s * s));
	}, 0);

describe('Deep Glow: the PSF', () => {
	it('is unit energy at any radius and falloff, and a fixed ratio of the radius', () => {
		for (const radius of [1, 40, 333, 1700])
			for (const falloff of [0, 25, 50, 100]) {
				const o = dgOctaves(radius, falloff, 0);
				expect(o).toHaveLength(DG_OCTAVES);
				expect(o.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(1, 10);
				expect(o.at(-1)!.sigma[1]).toBeCloseTo(radius / 3, 10);
				for (let i = 1; i < o.length; i++) expect(o[i]!.sigma[1] / o[i - 1]!.sigma[1]).toBeCloseTo(2, 10);
			}
	});

	it('Falloff runs from a long haze to tight, Pachislop’s exponents', () => {
		expect(dgExponent(0)).toBe(DG_P_LONG);
		expect(dgExponent(100)).toBe(DG_P_TIGHT);
		expect(dgExponent(50)).toBeCloseTo(2.4, 10);
		expect(dgExponent(-5)).toBe(DG_P_LONG);
		expect(dgExponent(500)).toBe(DG_P_TIGHT);
		// More of the light is far out with a long falloff, with the same total.
		const far = (f: number) => dgOctaves(300, f, 0).at(-1)!.weight;
		expect(far(0)).toBeGreaterThan(far(50));
		expect(far(50)).toBeGreaterThan(far(100));
	});

	it('between its octaves the mixture falls as r^-p', () => {
		for (const falloff of [0, 50, 100]) {
			const o = dgOctaves(3000, falloff, 0); // σ from 3.9 to 1000
			const slope = Math.log(psf(o, 300) / psf(o, 30)) / Math.log(10);
			expect(slope).toBeCloseTo(-dgExponent(falloff), 0);
			expect(Math.abs(slope + dgExponent(falloff))).toBeLessThan(0.15);
		}
	});

	it('chromatic scatter widens one end and narrows the other, ±20 % at ±100 %', () => {
		const wide = dgOctaves(300, 50, 100).at(-1)!.sigma;
		expect(wide[0] / wide[1]).toBeCloseTo(1.2, 10);
		expect(wide[2] / wide[1]).toBeCloseTo(0.8, 10);
		const flip = dgOctaves(300, 50, -100).at(-1)!.sigma;
		expect(flip[0] / flip[1]).toBeCloseTo(0.8, 10);
		expect(dgReach(300, 100)).toBeCloseTo(360, 10);
		expect(dgReach(300, 0)).toBeCloseTo(300, 10);
		expect(dgReach(-3, 0)).toBe(0);
		for (const o of dgOctaves(Number.NaN, Number.NaN, Number.NaN)) {
			expect(Number.isFinite(o.weight)).toBe(true);
			expect(o.sigma.every(Number.isFinite)).toBe(true);
		}
	});

	const plan = (radius: number, pxPerPercent: number, unitKnown = true) =>
		deepGlowPasses({
			radius,
			falloff: 50,
			chroma: 0,
			intensity: 1,
			tintAmount: 0,
			tintAt: () => [1, 1, 1],
			pxPerPercent,
			unitKnown,
			unit: GLSL_TL_UNIT_KNOWN,
			again: false,
		});
	const weights = (passes: ReturnType<typeof plan>) =>
		passes.reduce(
			(s, p) => s + Number((p.uniforms as { u_dgWeight?: number } | undefined)?.u_dgWeight ?? 0),
			0,
		);

	it('keeps all its energy at every resolution: an octave narrower than a pixel joins the unblurred term', () => {
		for (const k of [0.05, 0.25, 1, 4]) expect(weights(plan(120, k))).toBeCloseTo(1, 10);
		// Fewer blurs at low resolution, on a pyramid: each level is half the last.
		const blurs = (p: ReturnType<typeof plan>) => p.filter((x) => x.output === 'tlDgH').length;
		expect(blurs(plan(120, 0.25))).toBeLessThan(blurs(plan(120, 4)));
		const scales = plan(600, 1)
			.filter((x) => x.output === 'tlDgH')
			.map((x) => x.scale ?? 1);
		expect(Math.min(...scales)).toBeLessThanOrEqual(1 / 16);
		for (let i = 1; i < scales.length; i++) expect(scales[i]).toBeLessThanOrEqual(scales[i - 1]!);
	});

	it('takes the variance of the pyramid off the blur: no blur asks for more than its octave has', () => {
		for (const p of plan(600, 1).filter((x) => x.output === 'tlDgH')) {
			const u = p.uniforms as unknown as { u_dgSigma: number[]; u_dgPrev: number[]; u_dgVar: number };
			const s = u.u_dgSigma[1]!;
			const left = s * s - u.u_dgPrev[1]! ** 2 - u.u_dgVar;
			expect(left).toBeGreaterThan(0);
			expect(u.u_dgVar).toBeGreaterThanOrEqual(0);
		}
	});

	it('without a known unit stays three levels finer: the true unit may be far smaller than the plan’s bound', () => {
		const coarsest = (p: ReturnType<typeof plan>) => Math.min(...p.map((x) => x.scale ?? 1));
		expect(coarsest(plan(600, 1, false))).toBe(coarsest(plan(600, 1, true)) * 8);
	});
});

describe('the standalone effects of §8 (registry)', () => {
	const SECTION_8: Record<string, string> = {
		'Deep Glow': 'jasper.deep-glow',
		'Outer Glow': 'jasper.alpha-glow',
		'Inner Glow': 'jasper.inner-glow',
		'Inner Shadow': 'jasper.inner-shadow',
		'Contour Lines': 'jasper.contour-lines',
		'Perspective Shadow': 'jasper.perspective-shadow',
		'Floor Reflection': 'jasper.floor-reflection',
		'Gradient Overlay': 'jasper.gradient-overlay',
		'Shaded Extrude': 'jasper.shaded-extrude',
		Keyline: 'jasper.keyline',
	};

	for (const [name, id] of Object.entries(SECTION_8))
		describe(name, () => {
			const s = spec(id);

			it('is registered, valid, searchable and offered', () => {
				expect(s).toBeTruthy();
				expect(s.internal).toBeFalsy();
				expect(validateGpuEffect(s)).toEqual([]);
				expect(s.appliesTo).toBe('video');
				expect(s.capabilities.preview).toBe('webgl');
				const hay = [s.label, ...(s.keywords ?? [])].join(' ').toLowerCase();
				expect(hay).toContain(name.toLowerCase().split(' ').at(-1));
				expect(s.description).toBeTruthy();
			});

			it('animates every number, and has finite padding at defaults', () => {
				for (const p of s.params) if (p.type === 'number') expect(p.animatable, p.name).toBe(true);
				const pad = gpuPadding(s, defaultsOf(s), { width: 640, height: 360, pxScale: 1, fps: 30 });
				for (const v of Object.values(pad)) expect(Number.isFinite(v)).toBe(true);
			});
		});

	it('every effect of the family is listed above', () => {
		expect(TITLE_LOOK_EFFECTS.map((e) => e.id).sort()).toEqual(
			Object.values(SECTION_8)
				.filter((id) => id !== 'jasper.alpha-glow')
				.sort(),
		);
	});

	it('a look effect plans the same passes as its look layer, so they share GLSL', () => {
		const ctx: FxPlanContext = { width: 640, height: 360, pxScale: 1, fps: 30 };
		const s = spec('jasper.keyline');
		const passes = (typeof s.gpu!.passes === 'function' ? s.gpu!.passes(defaultsOf(s), ctx) : s.gpu!.passes)!;
		const look = appearanceFromRecipe(
			{
				layers: [
					{ type: 'rim', params: { width: 2, paint: { kind: 'color', color: [0.04, 0.02, 0.02, 1] } } },
					{ type: 'face', params: { paint: { kind: 'source' } } },
				],
			},
			ids(1),
		);
		const direct = planTitleLook({
			...ctx,
			structures: {
				titleLook: { appearance: resolveAppearance(look, 0), unitPx: 100, contentSeconds: 0 },
			},
		});
		expect(passes.map((p) => p.frag)).toEqual(direct.map((p) => p.frag));
	});

	it('Alpha Glow at Classic plans what it always did, and its look techniques share nothing with it', () => {
		const s = spec('jasper.alpha-glow');
		const ctx = {
			width: 320,
			height: 180,
			pxScale: 1,
			fps: 30,
			frame: 0,
			duration: 30,
			seed: 0.5,
			progress: 0,
		};
		const classic = planGpuEffect(s, { id: 'f', params: defaultsOf(s) }, ctx, { width: 320, height: 180 });
		expect(classic.passes).toHaveLength(4);
		expect(classic.uniforms.map((u) => u.name)).toContain('u_glow');
		expect(classic.requiresFloat).toBeUndefined();
		const soft = planGpuEffect(s, { id: 'f', params: { ...defaultsOf(s), technique: 'soft' } }, ctx, {
			width: 320,
			height: 180,
		});
		expect(soft.passes.length).toBeGreaterThan(5);
		expect(soft.uniforms.map((u) => u.name)).not.toContain('u_glow');
		expect(soft.passes.some((p) => p.output === 'tlComp')).toBe(true);
	});
});

describe('padding across a clip (TL-033)', () => {
	const ctxOf = (paramsAt: (f: number) => EffectParams, frames: number, frame = 0): FxPlanContext => ({
		width: 640,
		height: 360,
		pxScale: 1,
		fps: 30,
		frame,
		paramsAt,
		clip: {
			clipName: '',
			itemName: '',
			fileName: '',
			sourceInSeconds: 0,
			sourceStartTimecode: null,
			speed: 1,
			reverse: false,
			duration: frames,
		},
	});

	for (const [id, param, sides] of [
		['jasper.deep-glow', 'radius', ['left', 'top', 'right', 'bottom']],
		['jasper.inner-glow', 'radius', ['left', 'top', 'right', 'bottom']],
		['jasper.floor-reflection', 'fade', ['bottom']],
		['jasper.perspective-shadow', 'length', ['top', 'right']],
		['jasper.shaded-extrude', 'depth', ['right', 'bottom']],
		['jasper.keyline', 'width', ['left', 'top', 'right', 'bottom']],
	] as const)
		it(`${id}: the canvas holds ${param} at its largest on every frame`, () => {
			const s = spec(id);
			const base = defaultsOf(s);
			// A pulse in the middle of the clip: its first and last frames know nothing of it.
			const at = (f: number) => ({ ...base, [param]: f === 50 ? 400 : 20 });
			const still = gpuPadding(s, at(0), { width: 640, height: 360, pxScale: 1, fps: 30 });
			const peak = gpuPadding(s, at(50), { width: 640, height: 360, pxScale: 1, fps: 30 });
			const frame0 = gpuPadding(s, at(0), ctxOf(at, 101));
			// Sampled: frame 50 is one of the 32 samples of 101 frames only by luck, so the samples must catch a wide pulse.
			const wide = (f: number) => ({ ...base, [param]: f >= 30 && f <= 70 ? 400 : 20 });
			const held = gpuPadding(s, wide(0), ctxOf(wide, 101));
			for (const side of sides) {
				expect(peak[side]).toBeGreaterThan(still[side]);
				expect(held[side]).toBe(peak[side]);
				expect(frame0[side]).toBeGreaterThanOrEqual(still[side]);
			}
			// The frame being drawn always counts, however narrow the pulse.
			const onPulse = gpuPadding(s, at(50), ctxOf(at, 101, 50));
			for (const side of sides) expect(onPulse[side]).toBe(peak[side]);
		});

	it('every padding stays inside the framework’s limit at the largest params', () => {
		for (const id of ['jasper.deep-glow', 'jasper.alpha-glow', 'jasper.floor-reflection'])
			for (const [k, v] of Object.entries(
				gpuPadding(spec(id), defaultsOf(spec(id)), { width: 64, height: 36, pxScale: 1, fps: 30 }),
			))
				expect(v, `${id} ${k}`).toBeLessThanOrEqual(FX_MAX_PADDING);
		const s = spec('jasper.deep-glow');
		const max = s.params.find((p) => p.name === 'radius')!.range!.max!;
		const top = gpuPadding(
			s,
			{ ...defaultsOf(s), radius: max, chroma: 100 },
			{
				width: 64,
				height: 36,
				pxScale: 1,
				fps: 30,
			},
		);
		expect(top.left).toBeLessThan(FX_MAX_PADDING);
	});

	it('a look keeps a deep glow’s reach across its keys, and a reflection’s below the outermost rim', () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'T' }, ref: '$t' },
			{
				type: 'look.apply',
				clipIds: ['$t'],
				look: {
					name: 'Glow',
					recipe: { layers: [{ type: 'deepGlow', params: { radius: 40 } }, { type: 'face' }] },
				},
			},
		]);
		const clip = () => h.seq.clips[r.refs.$t!] as unknown as { effects: EffectInstance[] };
		const fx = clipLook(clip().effects)!;
		const layer = (fx.appearance as Appearance).layers[0]!.id;
		h.ok([
			{ type: 'keyframe.add', target: ['appearance', fx.id, layer, 'radius'], at: { frames: 0 }, value: 40 },
			{
				type: 'keyframe.add',
				target: ['appearance', fx.id, layer, 'radius'],
				at: { frames: 30 },
				value: 300,
			},
		]);
		const moved = clipLook(clip().effects)!.appearance as Appearance;
		expect(appearanceClipReach(moved, { from: 0, to: 59 * F, frames: 60 }).left).toBeCloseTo(300, 0);
		const b = appearanceFromRecipe(
			{
				layers: [
					{ type: 'rim', params: { width: 10 } },
					{ type: 'face' },
					{ type: 'reflection', params: { gap: 4, fade: 50, blur: 6 } },
				],
			},
			ids(1),
		);
		// The rim is below the reflection in the stack, and the reflection still starts under it.
		expect(lookReach(resolveAppearance(b, 0)).bottom).toBeCloseTo(10 + 4 + 50 + 6, 5);
	});

	it('a long shadow’s field keeps up with its length: 48 steps cover it at any distance', () => {
		const t = titleLayerType('shadow')!;
		const reach = t.fieldReach!(withDefaults(t, { kind: 'long', distance: 800 })).outside!;
		expect((reach * 48) / 800).toBeGreaterThanOrEqual(1);
	});

	it('regression: a shadow following the light pads every side, not only right and bottom', () => {
		// The light can be anywhere: under a light from the lower right the shadow falls up and left, and was clipped there.
		const t = titleLayerType('shadow')!;
		for (const kind of ['drop', 'long']) {
			const r = t.reach!(withDefaults(t, { kind, useLight: true, distance: 80, blur: 10, spread: 5 })) as {
				left: number;
				top: number;
				right: number;
				bottom: number;
			};
			for (const v of Object.values(r)) expect(v).toBeCloseTo(95, 5);
		}
	});

	it('perspective reach follows the direction and the foreshortening, and every side under a light', () => {
		const t = titleLayerType('shadow')!;
		const r = t.reach!(
			withDefaults(t, { kind: 'perspective', angle: 90, distance: 100, foreshorten: 50, blur: 0, spread: 0 }),
		) as { top: number; bottom: number };
		expect(r.bottom).toBeCloseTo(50, 5);
		expect(r.top).toBeCloseTo(0, 5);
		const lit = t.reach!(
			withDefaults(t, { kind: 'perspective', useLight: true, distance: 100, foreshorten: 100, blur: 0 }),
		) as { left: number; top: number; right: number; bottom: number };
		expect(Math.min(lit.left, lit.right)).toBeCloseTo(100, 5);
		expect(Math.min(lit.top, lit.bottom)).toBeGreaterThan(0);
	});
});

describe('the global light on effects (TL-017)', () => {
	function project(useGlobalLight: boolean) {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addText', at: 30, duration: 60, track: 'V2', content: { text: 'T' }, ref: '$t' },
			{
				type: 'effect.add',
				target: { clipId: '$t' },
				effectId: 'jasper.inner-shadow',
				params: { useGlobalLight },
			},
			{ type: 'sequence.setGlobalLight', angle: 0 },
			{ type: 'keyframe.add', target: ['globalLight', h.seqId, 'angle'], at: { sequenceFrame: 0 }, value: 0 },
			{
				type: 'keyframe.add',
				target: ['globalLight', h.seqId, 'angle'],
				at: { sequenceFrame: 100 },
				value: 100,
			},
		]);
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		return { clip: snap.videoTracks.flatMap((v) => v.clips).find((c) => c.clipId === r.refs.$t)! };
	}

	it('an effect following the light reads it at the frame, in sequence time', () => {
		const { clip } = project(true);
		expect(clip.sequenceLight).toBeTruthy();
		const light = (f: number) =>
			resolveCachedLayerProps(clip, clipContentTime(clip, f, { num: 30, den: 1 })).effects[0]!.globalLight!;
		expect(light(30).angle).toBeCloseTo(30, 5);
		expect(light(60).angle).toBeCloseTo(60, 5);
	});

	it('an effect on its own angle does not, and costs its clip nothing', () => {
		const { clip } = project(false);
		expect(clip.sequenceLight).toBeUndefined();
		const fx = resolveCachedLayerProps(clip, 0).effects[0]!;
		expect(fx.globalLight).toBeUndefined();
	});

	it('the toggle turns the layer to the light, from whatever the stage hands over', () => {
		const s = spec('jasper.inner-shadow');
		const ctx = {
			width: 320,
			height: 180,
			pxScale: 1,
			fps: 30,
			frame: 0,
			duration: 30,
			seed: 0.5,
			progress: 0,
			structures: { globalLight: { angle: 90, altitude: 30 } },
		};
		const u = (useGlobalLight: boolean) =>
			planGpuEffect(s, { id: 'f', params: { ...defaultsOf(s), useGlobalLight } }, ctx, {
				width: 320,
				height: 180,
			});
		const dir = u(true).uniforms.find((x) => x.name === 'u_tlLightDir')!.value;
		expect(dir[0]).toBeCloseTo(0, 5);
		expect(dir[1]).toBeCloseTo(1, 5);
		const pass = u(true).passes.find((p) => p.uniforms.some((x) => x.name === 'u_useLight'))!;
		expect(pass.uniforms.find((x) => x.name === 'u_useLight')!.value).toEqual([1]);
	});

	it('without a sequence light an effect takes the default one, and its padding does not depend on it', () => {
		const s = spec('jasper.perspective-shadow');
		const base = { width: 64, height: 36, pxScale: 1, fps: 30 };
		const p = { ...defaultsOf(s), useGlobalLight: true };
		expect(gpuPadding(s, p, base)).toEqual(
			gpuPadding(s, p, { ...base, structures: { globalLight: { angle: 10, altitude: 20 } } }),
		);
		const pad = gpuPadding(s, p, base);
		expect(Math.min(pad.left, pad.right)).toBeGreaterThanOrEqual(230);
	});
});

describe('any params in range', () => {
	const unit = fc.double({ min: 0, max: 1, noNaN: true });
	const value = (
		p: { type: string; default: unknown; options?: readonly string[]; range?: Range },
		x: number,
	) => {
		if (p.type === 'number') {
			const lo = p.range?.min ?? p.range?.softMin ?? -360;
			const hi = p.range?.max ?? p.range?.softMax ?? 360;
			return lo + (hi - lo) * x;
		}
		if (p.type === 'boolean') return x > 0.5;
		if (p.type === 'enum') return p.options![Math.floor(x * 0.999 * p.options!.length)];
		return p.default;
	};

	for (const t of TITLE_LAYER_TYPES)
		it(`layer ${t.type} plans, with a finite reach`, () => {
			fc.assert(
				fc.property(fc.array(unit, { minLength: t.params.length, maxLength: t.params.length }), (xs) => {
					const params = Object.fromEntries(t.params.map((p, i) => [p.name, value(p, xs[i]!)]));
					const appearance = resolveAppearance(
						appearanceFromRecipe({ layers: [{ type: 'face' }, { type: t.type, params }] }, ids(1)),
						0,
					);
					const passes = planTitleLook({
						width: 320,
						height: 180,
						pxScale: 1,
						fps: 30,
						structures: { titleLook: { appearance, unitPx: 64, contentSeconds: 0 } },
					});
					expect(passes.length).toBeGreaterThan(2);
					const r = lookReach(appearance);
					for (const v of Object.values(r)) {
						expect(Number.isFinite(v)).toBe(true);
						expect(v).toBeGreaterThanOrEqual(0);
					}
				}),
				{ numRuns: 40 },
			);
		});

	for (const s of [...TITLE_LOOK_EFFECTS, spec('jasper.alpha-glow')])
		it(`effect ${s.id} plans, with a finite padding`, () => {
			fc.assert(
				fc.property(fc.array(unit, { minLength: s.params.length, maxLength: s.params.length }), (xs) => {
					const p = Object.fromEntries(s.params.map((q, i) => [q.name, value(q, xs[i]!)])) as EffectParams;
					const ctx = { width: 320, height: 180, pxScale: 1, fps: 30 };
					const pad = gpuPadding(s, p, ctx);
					for (const v of Object.values(pad)) {
						expect(v).toBeGreaterThanOrEqual(0);
						expect(v).toBeLessThanOrEqual(FX_MAX_PADDING);
					}
					const plan = planGpuEffect(
						s,
						{ id: 'f', params: p },
						{ ...ctx, frame: 0, duration: 30, seed: 0.5, progress: 0 },
						{ width: 400, height: 260 },
					);
					expect(plan.passes.length).toBeGreaterThan(0);
				}),
				{ numRuns: 25 },
			);
		});
});

describe('handles (TL-092)', () => {
	it('name params of their layer, or of the look’s light', () => {
		for (const t of TITLE_LAYER_TYPES)
			for (const h of t.handles ?? []) {
				if (h.target !== 'light')
					for (const name of h.params)
						expect(
							t.params.map((p) => p.name),
							`${t.type} ${name}`,
						).toContain(name);
				else expect(h.params).toEqual(['angle']);
				if (h.when) expect(t.params.map((p) => p.name)).toContain(h.when.param);
			}
	});

	it('a shadow offers its offset, or the light’s angle while it follows the light', () => {
		for (const type of ['shadow', 'innerShadow']) {
			const h = titleLayerType(type)!.handles!;
			expect(h).toContainEqual({
				kind: 'offset',
				params: ['angle', 'distance'],
				when: { param: 'useLight', value: false },
			});
			expect(h).toContainEqual({
				kind: 'angle',
				params: ['angle'],
				target: 'light',
				when: { param: 'useLight', value: true },
			});
		}
	});
});
