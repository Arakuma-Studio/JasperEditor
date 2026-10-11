import { describe, expect, it } from 'vitest';
import type { EffectParams, EffectSpec } from '../src/index.ts';
import { defaultEffectRegistry, FX_FAMILIES, planGpuEffect, SAPPHIRE_BINS } from '../src/index.ts';
import { combineMode, sapphirePoint, unitPx } from '../src/registry/fx/sapphire-glows-lighting/common.ts';
import { jfaPasses } from '../src/registry/fx/sapphire-glows-lighting/distance.ts';
import { FLARE_LENSES, flareChunk, packFlare } from '../src/registry/fx/sapphire-glows-lighting/flare.ts';
import {
	brightDownscale,
	channelWeights,
	glowCascade,
	levelDownscale,
	levelWeights,
} from '../src/registry/fx/sapphire-glows-lighting/glow.ts';
import { rayPasses, rayUniforms } from '../src/registry/fx/sapphire-glows-lighting/streak.ts';
import { trackPasses } from '../src/registry/fx/sapphire-glows-lighting/track.ts';
import { SAPPHIRE_GLOWS_LIGHTING_EFFECTS } from '../src/registry/fx/sapphire-glows-lighting.ts';

const ctx = { width: 1920, height: 1080, pxScale: 1, fps: 30 };
const fctx = { ...ctx, frame: 10, duration: 150, seed: 0.5, progress: 0 };
const defaults = (s: EffectSpec, over: EffectParams = {}): EffectParams => ({
	...Object.fromEntries(s.params.map((p) => [p.name, p.default])),
	...over,
});
const byId = (id: string) => SAPPHIRE_GLOWS_LIGHTING_EFFECTS.find((s) => s.id === id)!;

const EXPECTED: [string, string][] = [
	['S_Glow', 'jasper.s.glow'],
	['S_GlowAura', 'jasper.s.glow-aura'],
	['S_GlowDarks', 'jasper.s.glow-darks'],
	['S_GlowDist', 'jasper.s.glow-dist'],
	['S_GlowEdges', 'jasper.s.glow-edges'],
	['S_GlowNoise', 'jasper.s.glow-noise'],
	['S_GlowOrthicon', 'jasper.s.glow-orthicon'],
	['S_GlowRainbow', 'jasper.s.glow-rainbow'],
	['S_GlowRings', 'jasper.s.glow-rings'],
	['S_UltraGlow', 'jasper.s.ultra-glow'],
	['S_ZGlow', 'jasper.s.zglow'],
	['S_Rays', 'jasper.s.rays'],
	['S_EdgeRays', 'jasper.s.edge-rays'],
	['S_Streaks', 'jasper.s.streaks'],
	['S_LensFlare', 'jasper.s.lens-flare'],
	['S_LensFlareAutoTrack', 'jasper.s.lens-flare-auto-track'],
	['S_LightLeak', 'jasper.s.light-leak'],
	['S_Glint', 'jasper.s.glint'],
	['S_GlintRainbow', 'jasper.s.glint-rainbow'],
	['S_Glare', 'jasper.s.glare'],
	['S_BokehLights', 'jasper.s.bokeh-lights'],
	['S_DropShadow', 'jasper.s.drop-shadow'],
	['S_Flashbulbs', 'jasper.s.flashbulbs'],
	['S_Light3D', 'jasper.s.light-3d'],
	['S_SpotLight', 'jasper.s.spot-light'],
];

describe('Sapphire Glows + Lighting catalogue', () => {
	it('ships the 25 Sapphire effects with their Sapphire names, registered, in Sapphire Lighting', () => {
		expect(SAPPHIRE_GLOWS_LIGHTING_EFFECTS.map((s) => [s.label, s.id])).toEqual(EXPECTED);
		const fam = FX_FAMILIES.find((f) => f.file === 'sapphire-glows-lighting')!;
		expect(fam.effects).toBe(SAPPHIRE_GLOWS_LIGHTING_EFFECTS);
		for (const s of SAPPHIRE_GLOWS_LIGHTING_EFFECTS) {
			expect(defaultEffectRegistry.get(s.id)).toBe(s);
			expect(s.bin).toBe(SAPPHIRE_BINS.lighting);
		}
	});

	it('plans every effect with default and with extreme params (≤ 12 textures, finite padding)', () => {
		for (const s of SAPPHIRE_GLOWS_LIGHTING_EFFECTS) {
			for (const over of [{}, extremes(s)]) {
				const p = defaults(s, over);
				const plan = planGpuEffect(s, { id: 'fx', params: p }, fctx, { width: 2400, height: 1500 });
				expect(plan.passes.filter((x) => x.output).length + plan.textures.length, s.id).toBeLessThanOrEqual(
					12,
				);
				const pad = s.gpu!.padding?.(p, ctx) ?? 0;
				for (const v of typeof pad === 'number' ? [pad] : Object.values(pad))
					expect(Number.isFinite(v) && v >= 0, `${s.id} padding`).toBe(true);
			}
		}
	});

	it('keeps Sapphire defaults of the key controls', () => {
		const d = (id: string) => defaults(byId(id));
		expect(d('jasper.s.glow')).toMatchObject({
			brightness: 2,
			threshold: 0.5,
			glowWidth: 0.4,
			widthGreen: 1.2,
			widthBlue: 1.4,
		});
		expect(d('jasper.s.ultra-glow')).toMatchObject({
			brightness: 1.8,
			glowFalloff: 0.35,
			afterGlowWidth: 0.808,
		});
		expect(d('jasper.s.rays')).toMatchObject({ raysLength: 0.25, raysBrightness: 3, center: [0.5, 0.5] });
		expect(d('jasper.s.lens-flare')).toMatchObject({
			lens: 'zoom50300',
			scaleWidths: 1.15,
			hotspot: sapphirePoint(-0.444, 0.176),
		});
		expect(d('jasper.s.glint')).toMatchObject({
			threshold: 0.7,
			size: 2,
			sizeDiag1: 0.75,
			sizeRed: 0.5,
			sizeBlue: 1.5,
		});
		expect(d('jasper.s.drop-shadow')).toMatchObject({ shadowBlur: 0.1, shift: [0.042, -0.042] });
		expect(d('jasper.s.bokeh-lights')).toMatchObject({ lights: 30, shape: '7', roundness: 0.3 });
	});
});

/** Big widths/lengths/counts to stress planning. */
function extremes(s: EffectSpec): EffectParams {
	const o: EffectParams = {};
	for (const p of s.params) {
		if (p.type !== 'number') continue;
		if (/width|size|length|blur|reach|lights|flashes|hotspots/i.test(p.name))
			o[p.name] = p.range?.max ?? (p.range?.softMax ?? 1) * 4;
	}
	return o;
}

describe('glow cascade', () => {
	it('doubles the sigma per level, downscales wide levels, never coarsens back', () => {
		const c = glowCascade({ input: 'bright', prefix: 'g', sigmaX: 160, sigmaY: 160, levels: 5 });
		expect(c.levels).toEqual(['g0', 'g1', 'g2', 'g3', 'g4']);
		expect(c.passes).toHaveLength(10);
		const scales = c.passes.map((p) => p.scale!);
		for (let i = 1; i < scales.length; i++) expect(scales[i]!).toBeLessThanOrEqual(scales[i - 1]!);
		expect(scales.at(-1)).toBeLessThan(1 / 8);
		expect(c.passes.every((p) => p.format === 'rgba16f')).toBe(true);
	});

	it('keeps the short axis resolved for strongly stretched kernels', () => {
		expect(levelDownscale(100, 100)).toBe(16);
		expect(levelDownscale(200, 1)).toBeLessThanOrEqual(8);
		expect(levelDownscale(0, 0)).toBe(1);
		expect(brightDownscale(4, 5)).toBe(1);
		expect(brightDownscale(1000, 5)).toBe(8);
	});

	it('level weights are normalised; narrower channels shift their profile down', () => {
		for (const slope of [-1, 0, 0.7, 2]) {
			const w = levelWeights(5, slope);
			expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
		}
		const w = channelWeights(5, 0.7, [1, 1.2, 1.4]);
		const mean = (a: number[]) => a.reduce((s, x, k) => s + x * k, 0);
		expect(mean(w.u_wr.floats)).toBeLessThan(mean(w.u_wg.floats));
		expect(mean(w.u_wg.floats)).toBeLessThan(mean(w.u_wb.floats));
	});
});

describe('family helpers', () => {
	it('Sapphire units and points', () => {
		expect(unitPx(1920)).toBeCloseTo(192);
		expect(sapphirePoint(0, 0)).toEqual([0.5, 0.5]);
		const [x, y] = sapphirePoint(-0.444, 0.176);
		expect(x).toBeCloseTo(0.056, 3);
		expect(y).toBeCloseTo(0.5 - 0.176 * (16 / 9), 3);
		expect(combineMode('screen', ['Mult', 'Add', 'Screen'], 'Screen')).toEqual({ int: 2 });
		expect(combineMode('flareonly', ['Screen', 'Add', 'Flare Only'], 'Screen')).toEqual({ int: 5 });
		expect(combineMode('nonsense', ['Screen', 'Add'], 'Add')).toEqual({ int: 1 });
	});

	it('ray passes compose three radial combs; Rays Length maps to log scale ranges', () => {
		const r = rayPasses('r', 0.5);
		expect(r.map((p) => p.output)).toEqual(['r1', 'r2', 'r3']);
		expect(r.map((p) => p.uniforms!.u_rspan)).toEqual([1 / 144, 1 / 12, 1]);
		const u = rayUniforms(0.25, [1, 1, 1], 0, 0);
		expect(u.u_rlen[0]).toBeCloseTo(Math.log(0.75));
		expect(u.u_rsplit).toBe(false);
		expect(rayUniforms(-1, [1, 1, 1], 0, 0.5).u_rlen[0]).toBeCloseTo(Math.log(2));
		expect(rayUniforms(0.25, [1, 1.2, 1], 0.5, 1).u_rsplit).toBe(true);
	});

	it('jump flooding covers the reach with halving steps', () => {
		const j = jfaPasses('1.0', 300);
		expect(j.down).toBe(4);
		expect(j.passes.map((p) => p.uniforms?.u_jstep).filter(Boolean)).toEqual([64, 32, 16, 8, 4, 2, 1]);
		expect(j.field).toBe('jf7');
	});

	it('lenses pack into GLSL constants; the tracker plans 1–3 hotspots', () => {
		expect(FLARE_LENSES.map((l) => l.label).slice(0, 10)).toEqual([
			'50_300mm_zoom',
			'35mm_prime',
			'105mm_prime',
			'anamorphic1',
			'anamorphic2',
			'anamorphicBlue',
			'rays_only',
			'rays_only2',
			'rays_only3',
			'simple_hex',
		]);
		for (const l of FLARE_LENSES) {
			expect(packFlare(l.elements)).toHaveLength(l.elements.length * 11);
			expect(flareChunk(l).source).toContain(`SGL_FLARE_N = ${l.elements.length}`);
		}
		expect(trackPasses(1).map((p) => p.output)).toEqual(['tA', 'tB0', 'tC0', 'tD0']);
		expect(trackPasses(3)).toHaveLength(10);
		expect(trackPasses(3)[4]!.frag).toContain('u_tD0');
	});

	it('time hooks: only the animated effects redraw per frame; the light leak passes its Center at mid-clip', () => {
		const still = SAPPHIRE_GLOWS_LIGHTING_EFFECTS.filter((s) => s.gpu!.timeInvariant).map((s) => s.id);
		expect(still).toEqual(['jasper.s.drop-shadow', 'jasper.s.light-3d', 'jasper.s.spot-light']);
		const leak = byId('jasper.s.light-leak');
		const u = (frame: number) =>
			leak.gpu!.uniforms!(defaults(leak), { ...fctx, frame, duration: 101 }) as Record<string, unknown>;
		expect(u(50).u_tMid).toBe(0);
		expect(u(80).u_tMid).toBe(1);
		expect(u(80)).toEqual(u(80));
	});

	it('S_DropShadow pads towards the shift; S_Rays pads for its reach', () => {
		const ds = byId('jasper.s.drop-shadow');
		const pad = ds.gpu!.padding!(defaults(ds), ctx) as {
			left: number;
			right: number;
			top: number;
			bottom: number;
		};
		expect(pad.right).toBeGreaterThan(pad.left);
		expect(pad.bottom).toBeGreaterThan(pad.top);
		const rays = byId('jasper.s.rays');
		expect(rays.gpu!.padding!(defaults(rays), ctx)).toBeGreaterThan(100);
		expect(rays.gpu!.padding!(defaults(rays, { raysLength: 0 }), ctx)).toBe(0);
	});
});
