import { describe, expect, it } from 'vitest';
import {
	type EffectParams,
	paramUniforms,
	planGpuTransition,
	SAPPHIRE_TRANSITION_SUBBINS,
	TRANSITION_BINS,
	TRANSITION_FAMILIES,
	type TransitionSpec,
	type TrFrameContext,
	transitionPasses,
	transitionSpec,
	validateGpuTransition,
} from '../src/index.ts';
import {
	blurScale,
	defocusRadii,
	dissolveBlurSigmas,
} from '../src/registry/transitions/sapphire-dissolves/blur.ts';
import {
	dissolveMix,
	dissolveTiming,
	envelope,
	peakTime,
	sapphirePoint,
	slowCurve,
} from '../src/registry/transitions/sapphire-dissolves/common.ts';
import {
	digitalDamageUniforms,
	sortScale,
	sortThreshold,
} from '../src/registry/transitions/sapphire-dissolves/glitch.ts';
import { glowSigma, leakScale, leakUniforms } from '../src/registry/transitions/sapphire-dissolves/glow.ts';
import {
	flashFrames,
	glareRays,
	glintRays,
	lensFlareUniforms,
	packRays,
	zapUniforms,
} from '../src/registry/transitions/sapphire-dissolves/light.ts';
import { brushPx, paintAmount } from '../src/registry/transitions/sapphire-dissolves/paint.ts';
import { migrateLumaV1 } from '../src/registry/transitions/sapphire-dissolves/patterns.ts';
import { raysGeometry, raysScale } from '../src/registry/transitions/sapphire-dissolves/rays.ts';
import { dissolveShakeUniforms } from '../src/registry/transitions/sapphire-dissolves/warps.ts';

const LABELS = [
	'S_Dissolve',
	'S_DissolveAutoPaint',
	'S_DissolveBlur',
	'S_DissolveBubble',
	'S_DissolveDefocus',
	'S_DissolveDiffuse',
	'S_DissolveDigitalDamage',
	'S_DissolveDistort',
	'S_DissolveEdgeRays',
	'S_DissolveFilm',
	'S_DissolveFlashbulbs',
	'S_DissolveGlare',
	'S_DissolveGlint',
	'S_DissolveGlintRainbow',
	'S_DissolveGlow',
	'S_DissolveLensFlare',
	'S_DissolveLightLeak',
	'S_DissolveLuma',
	'S_DissolvePixelMosh',
	'S_DissolvePixelSort',
	'S_DissolvePuddle',
	'S_DissolveRays',
	'S_DissolveShake',
	'S_DissolveSpeckle',
	'S_DissolveStatic',
	'S_DissolveTiles',
	'S_DissolveUltraGlow',
	'S_DissolveVortex',
	'S_DissolveWaves',
	'S_DissolveZap',
];

const FAMILY: readonly TransitionSpec[] =
	TRANSITION_FAMILIES.find((f) => f.file === 'sapphire-dissolves')?.transitions ?? [];
const spec = (label: string) => FAMILY.find((s) => s.label === label)!;
const defaults = (s: TransitionSpec, over: EffectParams = {}): EffectParams => ({
	...Object.fromEntries(s.params.map((p) => [p.name, p.default])),
	...over,
});
const kebab = (label: string) =>
	label
		.replace(/^S_/, '')
		.replace(/([a-z])([A-Z])/g, '$1-$2')
		.toLowerCase();
const frameCtx = (progress: number, over: Partial<TrFrameContext> = {}): TrFrameContext => ({
	width: 1920,
	height: 1080,
	fps: 30,
	duration: 30,
	frame: 15,
	linear: progress,
	progress,
	seed: 0.25,
	reversed: false,
	hasFrom: true,
	hasTo: true,
	...over,
});

describe('Sapphire dissolves catalogue', () => {
	it('has every S_Dissolve* of Sapphire, alphabetically, as jasper.s.<kebab> in Sapphire Transitions ▸ Dissolves', () => {
		expect(FAMILY.map((s) => s.label)).toEqual(LABELS);
		for (const s of FAMILY) {
			expect(s.id).toBe(`jasper.s.${kebab(s.label)}`);
			expect(s.bin).toBe(TRANSITION_BINS.sapphire);
			expect(s.subBin).toBe(SAPPHIRE_TRANSITION_SUBBINS.dissolves);
			expect(s.description.length).toBeGreaterThan(40);
			expect(transitionSpec(s.id)).toBe(s);
			expect(validateGpuTransition(s)).toEqual([]);
			const names = s.params.map((p) => p.name);
			expect(names.slice(0, 2)).toEqual(['startPercent', 'endPercent']);
			expect(names).toContain('reverse');
		}
	});

	it('declares no custom uniform or pass output that collides with another uniform', () => {
		const problems: string[] = [];
		for (const s of FAMILY) {
			const p = defaults(s);
			const params = new Set(paramUniforms(s, p).map((u) => u.name));
			const custom = Object.keys(s.gpu!.uniforms?.(p, frameCtx(0.4)) ?? {});
			const outputs = transitionPasses(s.gpu!, p, frameCtx(0.4))
				.slice(0, -1)
				.map((pass, i) => `u_${pass.output ?? `pass${i + 2}`}`);
			for (const u of custom) if (params.has(u)) problems.push(`${s.id}: ${u} is also a param uniform`);
			for (const o of outputs) {
				if (params.has(o) || custom.includes(o))
					problems.push(`${s.id}: output ${o} collides with a uniform`);
			}
			expect(outputs.length).toBeLessThanOrEqual(8);
		}
		expect(problems).toEqual([]);
	});

	it('plans every dissolve two-sided and one-sided with default params', () => {
		const side = { width: 64, height: 36, compToCanvas: [1, 0, 0, 0, 1, 0, 0, 0, 1], opacity: 1 };
		for (const s of FAMILY) {
			for (const sides of ['both', 'in', 'out'] as const) {
				const r = planGpuTransition(
					s,
					{ id: 'trn', params: defaults(s), frame: 3, duration: 9, sides },
					{ width: 64, height: 36, fps: 30 },
					{ out: side, in: side },
				);
				expect(r.plan.passes.at(-1)!.output).toBeNull();
				for (const u of r.plan.uniforms) expect(u.value.every(Number.isFinite)).toBe(true);
			}
		}
	});
});

describe('Sapphire dissolve timing', () => {
	it('Slow In / Slow Out ease the ends and keep 0 → 0, 1 → 1, monotone', () => {
		for (const [a, b] of [
			[0, 0],
			[0.2, 0.2],
			[1, 0],
			[0.5, 1],
		] as const) {
			expect(slowCurve(0, a, b)).toBe(0);
			expect(slowCurve(1, a, b)).toBe(1);
			let prev = 0;
			for (let i = 1; i <= 50; i++) {
				const v = slowCurve(i / 50, a, b);
				expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
				prev = v;
			}
		}
		expect(slowCurve(0.25, 0, 0)).toBeCloseTo(0.25);
		expect(slowCurve(0.1, 1, 1)).toBeLessThan(0.05); // a slow start
	});

	it('Shift Peak moves the peak; the envelope is 0 at the ends and 1 at the peak', () => {
		expect(peakTime(0.5, 0)).toBe(0.5);
		expect(peakTime(0.3, -0.2)).toBeCloseTo(0.5);
		expect(peakTime(0, 0.3)).toBe(0);
		expect(peakTime(1, 0.3)).toBe(1);
		expect(envelope(0)).toBe(0);
		expect(envelope(1)).toBeCloseTo(0, 12);
		expect(envelope(0.5)).toBe(1);
	});

	it('Dissolve Speed narrows the cross fade around the peak', () => {
		expect(dissolveMix(0.25, 1)).toBeCloseTo(0.25);
		expect(dissolveMix(0.25, 3)).toBe(0);
		expect(dissolveMix(0.5, 10)).toBe(0.5);
		expect(dissolveMix(0.6, 10)).toBe(1);
	});

	it('every combination keeps the ends: env 0, mix 0 at progress 0 and 1 at progress 1', () => {
		for (const dissolveSpeed of [1, 3, 11])
			for (const shiftPeak of [-0.45, 0, 0.3])
				for (const slow of [0, 0.5, 1]) {
					const p = { dissolveSpeed, shiftPeak, slowIn: slow, slowOut: 1 - slow };
					expect(dissolveTiming(p, 0)).toMatchObject({ env: 0, mix: 0, t: 0 });
					const end = dissolveTiming(p, 1);
					expect(end.mix).toBe(1);
					expect(end.env).toBeCloseTo(0, 12);
				}
		const peak = dissolveTiming({ shiftPeak: 0.2 }, 0.7);
		expect(peak.env).toBeCloseTo(1);
		expect(peak.mix).toBeCloseTo(0.5);
	});

	it('converts Sapphire centred points to frame-normalised ones', () => {
		expect(sapphirePoint(0, 0)).toEqual([0.5, 0.5]);
		expect(sapphirePoint(1, 0)).toEqual([1, 0.5]);
		expect(sapphirePoint(0, 0.5625)).toEqual([0.5, 0]); // y up, half widths on a 16:9 frame
	});
});

describe('Sapphire dissolves: per-dissolve maths', () => {
	it('S_DissolveLuma v1 params migrate to Sapphire’s Use Luma Of / Softness / Smooth Pattern', () => {
		const s = spec('S_DissolveLuma');
		expect(s.version).toBe(2);
		expect(s.migrate).toBe(migrateLumaV1);
		expect(migrateLumaV1(1, { lumaFrom: 'from', width: 0.25, invert: false, blurLuma: 57.6 })).toMatchObject({
			useLumaOf: 'foreground',
			invertPattern: true,
			softness: 0.125,
			smoothPattern: expect.closeTo(1, 9),
		});
		expect(migrateLumaV1(1, { lumaFrom: 'to', invert: true })).toMatchObject({
			useLumaOf: 'background',
			invertPattern: true,
		});
		expect(migrateLumaV1(2, { softness: 0.3 })).toEqual({ softness: 0.3 });
		expect(defaults(s)).toMatchObject({ useLumaOf: 'difference', softness: 0.1, invertPattern: false });
		const outputs = transitionPasses(s.gpu!, defaults(s), frameCtx(0.5)).map((p) => p.output);
		expect(outputs.slice(0, 3)).toEqual(['luma', 'lumaBlurH', 'lumaBlur']);
	});

	it('blurs and defocus ramp per side and pick a reduced resolution for big kernels', () => {
		const p = defaults(spec('S_DissolveBlur'));
		const s0 = dissolveBlurSigmas(p, 0, 1920);
		expect(s0.from).toEqual([0, 0]);
		expect(s0.to[0]).toBeCloseTo(2 * 0.03 * 1920);
		const s1 = dissolveBlurSigmas(p, 1, 1920);
		expect(s1.to).toEqual([0, 0]);
		expect(blurScale(10)).toBe(1);
		expect(blurScale(115)).toBe(0.125);
		const d = defaultsOf('S_DissolveDefocus');
		expect(defocusRadii(d, 0, 1920).from).toBe(0);
		expect(defocusRadii(d, 1, 1920).to).toBe(0);
		expect(defocusRadii(d, 0.5, 1920).from).toBeCloseTo(0.8 * 0.05 * 1920 * 0.5);
	});

	it('glows mix the two sides’ widths; light leaks scale by Transition Scale Mode', () => {
		const p = { glowWidth: 0.4, relFromWidth: 1, relToWidth: 2, widthX: 1, widthY: 0.5 };
		expect(glowSigma(p, 1000, 0).map((v) => Math.round(v))).toEqual([40, 20]);
		expect(glowSigma(p, 1000, 1).map((v) => Math.round(v))).toEqual([80, 40]);
		expect(leakScale({ transitionScaleMode: 'sizeUp' }, 0, 0)).toBe(1);
		expect(leakScale({ transitionScaleMode: 'sizeUp' }, 1, 0)).toBeCloseTo(4.9);
		expect(leakScale({ transitionScaleMode: 'sizeDown' }, 1, 0)).toBe(1);
		expect(leakScale({ transitionScaleMode: 'sizeUpDown' }, 0.5, 1)).toBeCloseTo(4.9);
		expect(leakScale({ transitionScaleMode: 'no' }, 0.3, 0.5)).toBe(1);
		const u = leakUniforms(defaultsOf('S_DissolveLightLeak'), {
			width: 1920,
			height: 1080,
			time: 0,
			t: 0.5,
			env: 1,
			seed: 0.1,
		});
		const data = (u.u_leakData as { vec4s: number[] }).vec4s;
		expect(data).toHaveLength(72);
		expect(data[4]).toBe(2.4);
		expect(data[24 + 4]).toBe(1);
		expect(data[48 + 4]).toBe(0); // element 3 is off by default
	});

	it('glints, glares and lens flares grow towards the peak and vanish at the ends', () => {
		const g = defaultsOf('S_DissolveGlint');
		const peak = glintRays(g, 1920, 1, 0.5);
		const end = glintRays(g, 1920, 0, 1);
		expect(peak.map((r) => r.angle)).toEqual([0, 90, -45, 45]);
		expect(peak[0]!.length).toBeCloseTo(2 * 0.1 * 1920);
		expect(end[0]!.length).toBeCloseTo(peak[0]!.length * 0.2); // Glint Shrink 0.8
		expect(glintRays({ ...g, swapDiagonals: true }, 1920, 1, 0).map((r) => r.angle)).toEqual([
			0, 90, 45, -45,
		]);
		const packed = packRays(peak);
		expect(packed.u_rayCount).toBe(4);
		expect(packed.u_rays.vec4s).toHaveLength(64);
		expect(packed.u_rays.vec4s[4 + 1]).toBeCloseTo(1); // Y ray: (0, 1)
		expect(glareRays(defaultsOf('S_DissolveGlare'), 1920, 1).rays).toHaveLength(2);
		expect(glareRays({ ...defaultsOf('S_DissolveGlare'), style: 'star8' }, 1920, 1).rays).toHaveLength(4);
		const f = defaultsOf('S_DissolveLensFlare');
		expect(lensFlareUniforms(f, { width: 1920, height: 1080, env: 0, t: 0 }).u_flareBright).toBe(0);
		const mid = lensFlareUniforms(f, { width: 1920, height: 1080, env: 1, t: 0.5 });
		expect(mid.u_flareBright).toBe(8);
		expect(mid.u_hot).toEqual([960, 540]); // through the Hotspot Center at the midpoint
	});

	it('flashbulbs count flashes per (held) frame on the envelope; zap bolts too', () => {
		const p = defaultsOf('S_DissolveFlashbulbs');
		const at = (progress: number, frame = 10) =>
			flashFrames(p, { frame, duration: 30, seed: 0.3, progressAt: () => progress });
		expect(at(0).u_flashFrames.vec4s[1]).toBe(0);
		const mid = at(0.5).u_flashFrames.vec4s;
		expect(mid).toHaveLength(8); // Hold Frames 1: this frame and the previous one (vec4 each)
		expect(mid[1]!).toBeGreaterThan(20 * 0.79);
		expect(mid[6]!).toBeCloseTo(0.1); // decay of the held frame
		expect(at(0.5, 0).u_flashFrames.vec4s[5]).toBe(0); // no frame before the span
		const z = defaultsOf('S_DissolveZap');
		expect(zapUniforms(z, { width: 1920, height: 1080, env: 0, mix: 0 }).u_boltCount).toBe(0);
		expect(zapUniforms(z, { width: 1920, height: 1080, env: 1, mix: 0.5 }).u_boltCount).toBe(35);
	});

	it('rays travel along their angle through the centre, shrink and fade by the envelope', () => {
		const p = defaultsOf('S_DissolveRays');
		const mid = raysGeometry(p, { width: 1920, height: 1080, t: 0.5, env: 1 });
		expect(mid.u_raysCenterUv).toEqual([0.5, 0.5]);
		expect(mid.u_raysEnv).toBe(1);
		expect(mid.u_sMin[1]).toBeCloseTo(1.75 ** (-1 / 3));
		expect(mid.u_revRays).toBe(false);
		const start = raysGeometry(p, { width: 1920, height: 1080, t: 0, env: 0 });
		expect(start.u_raysCenterUv[0]).toBeCloseTo(0.5 - 0.2 / 2);
		expect(start.u_raysEnv).toBe(0);
		expect(raysScale({ raysRes: 'half' })).toBe(0.25);
	});

	it('glitches: damage, sort threshold and mosh follow the envelope', () => {
		const d = defaultsOf('S_DissolveDigitalDamage');
		const ctx = { frame: 3, fps: 30, seed: 0.4, width: 1920 };
		expect(digitalDamageUniforms(d, { ...ctx, progress: 0 }).u_damage).toBe(0);
		expect(digitalDamageUniforms(d, { ...ctx, progress: 0.5 }).u_damage).toBeCloseTo(1);
		expect(sortThreshold({}, 0)).toBe(1);
		expect(sortThreshold({}, 1)).toBe(0);
		expect(sortThreshold({ sortDirection: 'below', maxPercentage: 0.5 }, 1)).toBe(0.5);
		expect(sortScale({}, 1080)).toBe(0.5);
		expect(sortScale({ downsample: true, sortResolution: 270 }, 1080)).toBe(0.25);
	});

	it('shake poses are the identity at the ends and move at the peak', () => {
		const p = defaultsOf('S_DissolveShake');
		const ctx = { frame: 7, fps: 30, seed: 0.2 };
		const still = dissolveShakeUniforms(p, { ...ctx, progress: 0 });
		expect(still.u_shakeNow.vec4s.slice(0, 4)).toEqual([0, 0, 1, 0]);
		expect(still.u_mbPlan.ivec4[0]).toBe(1); // nothing moves: one tap
		const moving = dissolveShakeUniforms(p, { ...ctx, progress: 0.5 });
		expect(Math.hypot(moving.u_shakeNow.vec4s[0]!, moving.u_shakeNow.vec4s[1]!)).toBeGreaterThan(0);
		expect(moving.u_mbPlan.ivec4[0]).toBeGreaterThan(1); // Motion Blur (on by default) over the shutter
	});

	it('auto paint fades the painting in and out; the brush peaks mid-way', () => {
		const p = defaultsOf('S_DissolveAutoPaint');
		expect(paintAmount(p, 0)).toBe(0);
		expect(paintAmount(p, 1)).toBe(0);
		expect(paintAmount(p, 0.5)).toBe(1);
		expect(brushPx(p, 0, 1920)).toBeCloseTo(0.04 * 0.25 * 1920);
		expect(brushPx(p, 1, 1920)).toBeCloseTo(0.4 * 0.25 * 1920);
	});
});

function defaultsOf(label: string): EffectParams {
	return defaults(spec(label));
}
