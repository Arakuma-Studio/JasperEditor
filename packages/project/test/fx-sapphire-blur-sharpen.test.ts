import { describe, expect, it } from 'vitest';
import type { EffectParams, EffectSpec, FxFrameContext } from '../src/index.ts';
import {
	defaultEffectRegistry,
	FX_FAMILIES,
	FX_MAX_TEXTURES,
	gpuPadding,
	planGpuEffect,
	SAPPHIRE_BINS,
	validateGpuEffect,
} from '../src/index.ts';
import { edgeOf, levelFor, unitPx } from '../src/registry/fx/sapphire-blur-sharpen/common.ts';
import { zMaxAmount } from '../src/registry/fx/sapphire-blur-sharpen/depth.ts';
import { freeLensPose, freeLensShake } from '../src/registry/fx/sapphire-blur-sharpen/freelens.ts';
import { fringeOf, irisSides } from '../src/registry/fx/sapphire-blur-sharpen/iris.ts';
import { moPathLength } from '../src/registry/fx/sapphire-blur-sharpen/motion.ts';

const FAMILY = FX_FAMILIES.find((f) => f.file === 'sapphire-blur-sharpen')!.effects;
const spec = (id: string) => FAMILY.find((s) => s.id === id)!;
const defaults = (s: EffectSpec, over: EffectParams = {}): EffectParams => ({
	...Object.fromEntries(s.params.map((p) => [p.name, p.default])),
	...over,
});
const ctx: FxFrameContext = {
	width: 1920,
	height: 1080,
	pxScale: 1,
	fps: 30,
	frame: 12,
	duration: 120,
	seed: 0.3,
	progress: 0,
};
const plan = (s: EffectSpec, over: EffectParams = {}, c: FxFrameContext = ctx) =>
	planGpuEffect(s, { id: 'fx', params: defaults(s, over) }, c, { width: c.width, height: c.height });

const LABELS = [
	'S_AdvancedDefocus',
	'S_Beauty',
	'S_Blur',
	'S_BlurChannels',
	'S_BlurChroma',
	'S_BlurDirectional',
	'S_BlurMoCurves',
	'S_BlurMotion',
	'S_Convolve',
	'S_ConvolveComp',
	'S_Deband',
	'S_DefocusPrism',
	'S_EdgeAwareBlur',
	'S_EdgeBlur',
	'S_FreeLens',
	'S_GrainRemove',
	'S_Median',
	'S_RackDefocus',
	'S_RackDfComp',
	'S_Sharpen',
	'S_SoftFocus',
	'S_ZBlur',
	'S_ZConvolve',
	'S_ZDefocus',
];

describe('Sapphire Blur+Sharpen catalogue', () => {
	it('has the 24 Sapphire effects, sorted, in the Blur+Sharpen bin, registered and valid', () => {
		expect(FAMILY.map((s) => s.label)).toEqual(LABELS);
		for (const s of FAMILY) {
			expect(s.id).toMatch(/^jasper\.s\.[a-z0-9-]+$/);
			expect(s.bin).toBe(SAPPHIRE_BINS.blurSharpen);
			expect(s.description?.length).toBeGreaterThan(20);
			expect(validateGpuEffect(s)).toEqual([]);
			expect(defaultEffectRegistry.get(s.id)).toBe(s);
		}
	});

	it('keeps Sapphire parameter names, defaults and ranges', () => {
		const p = (id: string, name: string) => spec(id).params.find((x) => x.name === name)!;
		expect(p('jasper.s.rack-defocus', 'defocusWidth')).toMatchObject({
			label: 'Defocus Width',
			default: 0.088,
		});
		expect(p('jasper.s.rack-defocus', 'edgeMode').default).toBe('reflect');
		expect(p('jasper.s.advanced-defocus', 'useGamma').default).toBe(1.8);
		expect(p('jasper.s.advanced-defocus', 'bokeh').default).toBe(-0.3);
		expect(p('jasper.s.advanced-defocus', 'shape').default).toBe('polygon');
		expect(p('jasper.s.blur', 'blurAmount').default).toBe(0.4);
		expect(p('jasper.s.blur-directional', 'filter').default).toBe('box');
		expect(p('jasper.s.blur-directional', 'angle').default).toBe(45);
		expect(p('jasper.s.blur-motion', 'toZDist').default).toBe(0.8);
		expect(p('jasper.s.beauty', 'skinColor').default).toEqual([0.556, 0.37, 0.257, 1]);
		expect(p('jasper.s.beauty', 'saturation')).toMatchObject({ default: 1.1, range: { min: -2, max: 8 } });
		expect(p('jasper.s.deband', 'edgeThreshold')).toMatchObject({ default: 2, range: { min: 0, max: 255 } });
		expect(p('jasper.s.median', 'size')).toMatchObject({ default: 1, range: { min: 0.1, max: 40 } });
		expect(p('jasper.s.z-defocus', 'defocusWidth').default).toBe(0.35);
		expect(p('jasper.s.z-blur', 'blurWidth').default).toBe(0.168);
		expect(p('jasper.s.free-lens', 'tiltX')).toMatchObject({ default: 12.5, range: { min: -45, max: 45 } });
		expect(p('jasper.s.convolve', 'kernelCrop1').default).toEqual([-0.997, -0.747]);
		expect(p('jasper.s.sharpen', 'scaleTinyDetails').default).toBe(3);
		expect(p('jasper.s.blur', 'mixWithOriginal').label).toBe('Mix With Source');
		for (const id of ['jasper.s.z-defocus', 'jasper.s.z-blur', 'jasper.s.z-convolve'])
			expect(p(id, 'zBuffer').type).toBe('media');
		for (const s of FAMILY)
			for (const x of s.params) {
				if (x.type === 'number' && x.name !== 'seed') expect(x.animatable, `${s.id}.${x.name}`).toBe(true);
				if (x.type === 'color' || x.type === 'vec2') expect(x.animatable).toBe(true);
				if (x.type === 'enum' || x.type === 'boolean' || x.type === 'media') expect(x.animatable).toBe(false);
			}
	});

	it('marks the heavy effects expensive', () => {
		for (const id of [
			'jasper.s.rack-defocus',
			'jasper.s.advanced-defocus',
			'jasper.s.z-defocus',
			'jasper.s.median',
			'jasper.s.free-lens',
		])
			expect(spec(id).expensive).toBe(true);
		expect(spec('jasper.s.blur').expensive).toBeUndefined();
	});
});

describe('Sapphire units and planning helpers', () => {
	it('one Sapphire unit is half the layer width (canvas px)', () => {
		expect(unitPx({ width: 1920, pxScale: 1 })).toBe(960);
		expect(unitPx({ width: 1920, pxScale: 0.5 })).toBe(480);
	});
	it('levelFor picks power-of-two downscales', () => {
		expect(levelFor(8, 10)).toBe(0);
		expect(levelFor(42, 10)).toBe(3);
		expect(levelFor(10000, 10)).toBe(6);
	});
	it('edge modes: soft borders win, else the Edge Mode popup', () => {
		expect(edgeOf({ edgeMode: 'transparent' })).toBe(0);
		expect(edgeOf({ edgeMode: 'reflect' })).toBe(2);
		expect(edgeOf({ edgeMode: 'reflect', softBorders: true })).toBe(3);
		expect(edgeOf({}, 1)).toBe(1);
	});
	it('iris shapes and colour fringing', () => {
		expect(irisSides('circle')).toBe(0);
		expect(irisSides('6')).toBe(6);
		expect(fringeOf(0)).toBeUndefined();
		const rb = fringeOf(1)!;
		expect(rb[2]).toBeGreaterThan(1);
		expect(rb[0]).toBeLessThan(1);
		expect(fringeOf(1, true)).toEqual([rb[2], 1, rb[2]]);
	});
});

describe('pass planning', () => {
	it('S_Blur: a small blur stays full size, a huge one runs on the pyramid', () => {
		const small = plan(spec('jasper.s.blur'), { blurAmount: 0.2 });
		expect(small.passes.every((p) => p.width === 1920)).toBe(true);
		const big = plan(spec('jasper.s.blur'), { blurAmount: 4 });
		expect(Math.min(...big.passes.map((p) => p.width))).toBeLessThanOrEqual(240);
		expect(big.passes.at(-1)!.width).toBe(1920);
	});

	it('S_RackDefocus: the iris is gathered on a level where its radius is ≤ ~10 texels', () => {
		const p = plan(spec('jasper.s.rack-defocus'));
		const gather = p.passes.find((x) => x.output === 'defocus')!;
		// radius = 0.088 × 960 / 2 ≈ 42 px → 1/8 scale.
		expect(gather.width).toBe(240);
		const r = gather.uniforms.find((u) => u.name === 'u_gRadius')!.value;
		expect(r[0]).toBeCloseTo((0.088 * 960) / 2 / 8, 3);
		const count = gather.uniforms.find((u) => u.name === 'u_gCount')!.value[0]!;
		expect(count).toBeGreaterThan(Math.PI * r[0]! * r[0]!);
		expect(count).toBeLessThanOrEqual(400);
		expect(gather.format).toBe('rgba16f');
	});

	it('S_AdvancedDefocus Resolution adds downscale steps', () => {
		const full = plan(spec('jasper.s.advanced-defocus')).passes.find((x) => x.output === 'defocus')!;
		const quarter = plan(spec('jasper.s.advanced-defocus'), { defocusResolution: 'quarter' }).passes.find(
			(x) => x.output === 'defocus',
		)!;
		expect(quarter.width).toBe(full.width / 4);
	});

	it('variants compile separately: fringing / prism / show shape add their switches', () => {
		const src = (s: EffectSpec, o: EffectParams) =>
			plan(s, o)
				.passes.map((p) => p.source)
				.join('\n');
		expect(src(spec('jasper.s.rack-defocus'), { colorFringing: 1 })).toContain('#define SBS_FRINGE 1');
		expect(src(spec('jasper.s.defocus-prism'), {})).toContain('#define SBS_PRISM 1');
		expect(src(spec('jasper.s.rack-defocus'), { showShape: true })).toContain('sbs_shapeView');
	});

	it('never exceeds the texture budget, even with stress params', () => {
		const stress: Record<string, EffectParams> = {
			'jasper.s.beauty': { postBlur: 0.2, softFocus: 0.5, glowWidth: 1 },
			'jasper.s.blur': { blurAmount: 40, blurRel: [8, 0.1] },
			'jasper.s.z-defocus': { layers: 50, layerMode: 'comp', focalDepth: 0.5 },
			'jasper.s.z-convolve': { layers: 50, size: 4 },
			'jasper.s.z-blur': { layers: 50, layerMode: 'interp', blurWidth: 2 },
			'jasper.s.convolve-comp': { sizeFront: 4, sizeBack: 4 },
			'jasper.s.free-lens': { tiltX: 45, tiltY: 45, glowWidth: 2, defocusWidth: 1 },
			'jasper.s.rack-df-comp': {
				background: { mediaId: 'b' },
				middle: { mediaId: 'm' },
				defocusBackground: 1,
			},
			'jasper.s.deband': { preBlur: 4, growEdges: 10, postBlur: 4 },
			'jasper.s.edge-aware-blur': { edgeSmooth: 1, blurType: 'sharpEdges', filter: 'smooth' },
			'jasper.s.sharpen': { smallDetailSize: 0.1 },
		};
		for (const s of FAMILY) {
			const p = plan(s, stress[s.id] ?? {});
			const outputs = p.passes.filter((x) => x.output).length;
			expect(outputs + p.textures.length, s.id).toBeLessThanOrEqual(FX_MAX_TEXTURES);
			expect(new Set(p.passes.map((x) => x.output).filter(Boolean)).size, s.id).toBe(outputs);
		}
	});

	it('Soft Borders pad the layer by the blur / iris reach; off = no padding', () => {
		const pc = { width: 1920, height: 1080, pxScale: 1, fps: 30 };
		const blur = spec('jasper.s.blur');
		expect(gpuPadding(blur, defaults(blur), pc).left).toBe(0);
		expect(gpuPadding(blur, defaults(blur, { softBorders: true }), pc).left).toBeCloseTo(
			(3 * 0.4 * 960) / 24,
			6,
		);
		const rack = spec('jasper.s.rack-defocus');
		expect(gpuPadding(rack, defaults(rack, { softBorders: true }), pc).top).toBeCloseTo(0.088 * 0.5 * 960, 6);
	});
});

describe('depth layers', () => {
	it('the largest defocus amount follows focal depth, depth of field and the near/far widths', () => {
		expect(zMaxAmount({ focalDepth: 0, depthOfField: 0.1, widthRelNear: 1, widthRelFar: 1 })).toBeCloseTo(
			0.95,
		);
		expect(zMaxAmount({ focalDepth: 0.5, depthOfField: 0.2, widthRelNear: 2, widthRelFar: 1 })).toBeCloseTo(
			0.8,
		);
		expect(zMaxAmount({ focalDepth: 0.5, depthOfField: 1, widthRelNear: 1, widthRelFar: 1 })).toBe(0);
	});
	it('Interp gathers K−1 levels, Comp K slices (K ≤ 6)', () => {
		const z = spec('jasper.s.z-defocus');
		const interp = plan(z, { layers: 5 }).passes.filter((p) => /^zl\d$/.test(p.output ?? ''));
		expect(interp).toHaveLength(4);
		const comp = plan(z, { layers: 50, layerMode: 'comp' }).passes.filter((p) =>
			/^zs\d$/.test(p.output ?? ''),
		);
		expect(comp).toHaveLength(6);
		expect(comp[0]!.source).toContain('#define SBS_SLICE 1');
	});
});

describe('motion', () => {
	it('path length of the default zoom blur and of a pure rotation', () => {
		const pc = { width: 1920, height: 1080, pxScale: 1, fps: 30 };
		const zoom = moPathLength(
			{ zDist: 1, rotate: 0, shift: [0, 0] },
			{ zDist: 0.8, rotate: 0, shift: [0, 0] },
			[0.5, 0.5],
			pc,
		);
		// A corner is 1101 px from the centre; the source point moves to 0.8 × that: ~220 px.
		expect(zoom).toBeGreaterThan(210);
		expect(zoom).toBeLessThan(230);
		const none = moPathLength(
			{ zDist: 1, rotate: 0, shift: [0, 0] },
			{ zDist: 1, rotate: 0, shift: [0, 0] },
			[0.5, 0.5],
			pc,
		);
		expect(none).toBe(0);
	});

	it('S_BlurMoCurves reads its curves through ctx.paramsAt when the host provides it', () => {
		const s = spec('jasper.s.blur-mo-curves');
		const p = defaults(s, { shutterDuration: 2 });
		const base = s.gpu!.uniforms!(p, ctx);
		expect(base.u_moFrom).toEqual(base.u_moTo);
		const withCurves = s.gpu!.uniforms!(p, {
			...ctx,
			paramsAt: (f: number) => ({ ...p, rotate: f * 2 }),
		} as FxFrameContext);
		// Rotation from frame 11 to 13 (shutter 2 around frame 12).
		expect((withCurves.u_moFrom as readonly number[])[1]).toBeCloseTo((22 * Math.PI) / 180, 6);
		expect((withCurves.u_moTo as readonly number[])[1]).toBeCloseTo((26 * Math.PI) / 180, 6);
	});
});

describe('S_FreeLens shake', () => {
	const s = spec('jasper.s.free-lens');
	it('is off by default (all random amplitudes 0) and deterministic per seed and time', () => {
		expect(Object.values(freeLensShake(defaults(s), 0.4, 1.3)).every((v) => v === 0)).toBe(true);
		const p = defaults(s, { xRandAmp: 1, yRandAmp: 1, tiltXRandAmp: 1 });
		const a = freeLensShake(p, 0.4, 1.3);
		expect(freeLensShake(p, 0.4, 1.3)).toEqual(a);
		expect(freeLensShake(p, 0.7, 1.3)).not.toEqual(a);
		expect(freeLensShake(p, 0.4, 1.9)).not.toEqual(a);
		for (const mode of ['twitchy', 'jumpy'])
			expect(Number.isFinite(freeLensShake({ ...p, shakeMode: mode }, 0.4, 2.2).x)).toBe(true);
	});
	it('links distortion and light leak to the lens tilt', () => {
		const pose = freeLensPose(defaults(s), 0, 0);
		expect(pose.distortion).toBeLessThan(0);
		expect(pose.leak).toBeGreaterThan(0);
		const manual = freeLensPose(defaults(s, { linkDistortionToLens: false, distortionAmount: 0.1 }), 0, 0);
		expect(manual.distortion).toBe(0.1);
	});
});
