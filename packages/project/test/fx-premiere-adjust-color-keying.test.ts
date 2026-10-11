import { describe, expect, it } from 'vitest';
import {
	defaultEffectRegistry,
	type EffectParams,
	type EffectSpec,
	type FxPlanContext,
	gpuPasses,
	planGpuEffect,
} from '../src/index.ts';
import { kernelMat3, levelsUniforms } from '../src/registry/fx/premiere-adjust-color-keying/adjust.ts';
import { equalizeLutScale } from '../src/registry/fx/premiere-adjust-color-keying/analysis.ts';
import {
	blurScale,
	cameraBlurRadius,
	premiereDirection,
} from '../src/registry/fx/premiere-adjust-color-keying/blur-sharpen.ts';
import { channelMixerUniforms } from '../src/registry/fx/premiere-adjust-color-keying/color-correction.ts';
import {
	ANALYSIS_SIDE,
	analysisThumbPass,
	statsScale,
} from '../src/registry/fx/premiere-adjust-color-keying/common.ts';
import {
	ULTRA_KEY_PRESETS,
	ultraKeyMatteValues,
} from '../src/registry/fx/premiere-adjust-color-keying/keying.ts';
import {
	basic3dPadding,
	dropShadowOffset,
	dropShadowPadding,
	radialShadowPadding,
} from '../src/registry/fx/premiere-adjust-color-keying/perspective.ts';
import { transformInverse } from '../src/registry/fx/premiere-adjust-color-keying/transform.ts';
import { cineonLogToLinear } from '../src/registry/fx/premiere-adjust-color-keying/utility.ts';
import { PREMIERE_ADJUST_COLOR_KEYING_EFFECTS as FAMILY } from '../src/registry/fx/premiere-adjust-color-keying.ts';

const ctx: FxPlanContext = { width: 1920, height: 1080, pxScale: 1, fps: 30 };
const frame = { ...ctx, frame: 0, duration: 150, seed: 0.5, progress: 0 };
const defaults = (s: EffectSpec): EffectParams =>
	Object.fromEntries(s.params.map((p) => [p.name, p.default]));
const byId = (id: string) => {
	const s = FAMILY.find((e) => e.id === id);
	if (!s) throw new Error(id);
	return s;
};

const EXPECTED: Record<string, string[]> = {
	Adjust: [
		'Auto Color',
		'Auto Contrast',
		'Auto Levels',
		'Convolution Kernel',
		'Extract',
		'Levels',
		'Lighting Effects',
		'ProcAmp',
	],
	'Blur & Sharpen': [
		'Camera Blur',
		'Channel Blur',
		'Compound Blur',
		'Directional Blur',
		'Reduce Interlace Flicker',
		'Sharpen',
		'Unsharp Mask',
	],
	Channel: [
		'Arithmetic',
		'Blend',
		'Calculations',
		'Compound Arithmetic',
		'Invert',
		'Set Matte',
		'Solid Composite',
	],
	'Color Correction': [
		'Change Color',
		'Change to Color',
		'Channel Mixer',
		'Color Balance',
		'Color Balance (HLS)',
		'Equalize',
		'Leave Color',
		'Tint',
		'Video Limiter',
	],
	'Image Control': ['Color Balance (RGB)', 'Color Pass', 'Color Replace', 'Gamma Correction'],
	Keying: [
		'Ultra Key',
		'Alpha Adjust',
		'Color Key',
		'Difference Matte',
		'Image Matte Key',
		'Luma Key',
		'Non Red Key',
		'Remove Matte',
		'Track Matte Key',
	],
	Perspective: ['Basic 3D', 'Bevel Alpha', 'Bevel Edges', 'Drop Shadow', 'Radial Shadow'],
	Transform: ['Edge Feather', 'Transform'],
	Utility: ['Cineon Converter'],
};

describe('fx family premiere-adjust-color-keying: catalogue', () => {
	it('has the Premiere effects of each bin, under their category, with kebab ids', () => {
		const got: Record<string, string[]> = {};
		for (const s of FAMILY) (got[s.category] ??= []).push(s.label);
		expect(got).toEqual(EXPECTED);
		for (const s of FAMILY) {
			expect(s.id).toMatch(/^jasper\.[a-z0-9]+(-[a-z0-9]+)*$/);
			expect(s.bin).toBeUndefined();
			expect(s.description?.length).toBeGreaterThan(20);
			expect(s.keywords?.length).toBeGreaterThan(0);
		}
	});

	it('does not duplicate the existing effects and is registered by default', () => {
		const existing = [
			'Crop',
			'Gaussian Blur',
			'Brightness & Contrast',
			'Hue/Saturation',
			'Black & White',
			'Lumetri Color',
		];
		for (const s of FAMILY) {
			expect(existing).not.toContain(s.label);
			expect(defaultEffectRegistry.get(s.id)).toBe(s);
		}
	});

	it('every entry plans with default params', () => {
		for (const s of FAMILY) {
			const plan = planGpuEffect(s, { id: 'fx', params: defaults(s) }, frame, { width: 1920, height: 1080 });
			expect(plan.passes.length).toBeGreaterThan(0);
			expect(plan.passes.at(-1)!.output).toBeNull();
		}
	});

	it('keyframable numeric / colour / point params; popups and checkboxes hold-only', () => {
		for (const s of FAMILY)
			for (const p of s.params) {
				if (p.type === 'number' || p.type === 'color' || p.type === 'vec2')
					expect(p.animatable, `${s.id}.${p.name}`).toBe(true);
				if (p.type === 'enum' || p.type === 'boolean' || p.type === 'media') expect(p.animatable).toBe(false);
				if (p.type === 'vec2') expect(p.ui?.control).toBe('point');
			}
	});

	it('effects whose output depends only on params + input are time-invariant (media-driven ones are not)', () => {
		const media = FAMILY.filter((s) => s.params.some((p) => p.type === 'media'));
		for (const s of media)
			expect(s.gpu?.timeInvariant ?? false, s.id).toBe(s.id === 'jasper.image-matte-key');
		for (const s of FAMILY.filter((x) => !media.includes(x))) expect(s.gpu?.timeInvariant, s.id).toBe(true);
	});
});

describe('fx family premiere-adjust-color-keying: maths', () => {
	it('Convolution Kernel → column-major mat3 (m[col][row] = M<row><col>)', () => {
		const m = kernelMat3({ m12: 5, m21: 7 });
		expect(m).toEqual([0, 7, 0, 5, 1, 0, 0, 0, 0]);
	});

	it('Levels uniforms: 0..255 → 0..1, gamma / 100, per channel', () => {
		const u = levelsUniforms({ blackInput: 51, gammaR: 200, whiteOutputB: 0 });
		expect(u.u_lvMaster[0]).toBeCloseTo(0.2);
		expect(u.u_lvGamma).toEqual([2, 1, 1]);
		expect(u.u_lvOutWhite).toEqual([1, 1, 0]);
	});

	it('Channel Mixer: identity by default; Monochrome uses the red row for every output', () => {
		expect(channelMixerUniforms({}).u_mix.mat3).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
		const m = channelMixerUniforms({ monochrome: true, redRed: 30, redGreen: 60, redBlue: 10, redConst: 5 });
		expect(m.u_mix.mat3).toEqual([0.3, 0.3, 0.3, 0.6, 0.6, 0.6, 0.1, 0.1, 0.1]);
		expect(m.u_mixConst).toEqual([0.05, 0.05, 0.05]);
	});

	it('Ultra Key settings: Default/Custom use the sliders, Relaxed/Aggressive their presets', () => {
		expect(ultraKeyMatteValues({ setting: 'default', tolerance: 80 }).tolerance).toBe(80);
		expect(ultraKeyMatteValues({ setting: 'custom', pedestal: 3 }).pedestal).toBe(3);
		expect(ultraKeyMatteValues({ setting: 'aggressive', tolerance: 1 })).toEqual(
			ULTRA_KEY_PRESETS.aggressive,
		);
		const uk = byId('jasper.ultra-key');
		const d = defaults(uk);
		for (const [k, v] of Object.entries(ULTRA_KEY_PRESETS.default)) expect(d[k]).toBe(v);
		expect(gpuPasses(uk.gpu!, d, ctx).length).toBe(2);
		expect(gpuPasses(uk.gpu!, { ...d, choke: 20, soften: 20 }, ctx).length).toBe(6);
	});

	it('Premiere directions: 0° = up, clockwise; Drop Shadow 135° → lower right, padded on that side', () => {
		const [x, y] = premiereDirection(0);
		expect(x).toBeCloseTo(0);
		expect(y).toBeCloseTo(-1);
		const [dx, dy] = dropShadowOffset({ direction: 135, distance: 10 });
		expect(dx).toBeCloseTo(7.071, 2);
		expect(dy).toBeCloseTo(7.071, 2);
		const pad = dropShadowPadding({ direction: 135, distance: 10, softness: 10 });
		expect(pad.right).toBeCloseTo(7.071 + 13, 2);
		expect(pad.left).toBeCloseTo(13);
		expect(byId('jasper.drop-shadow').gpu!.padding!(defaults(byId('jasper.drop-shadow')), ctx)).toBeTruthy();
	});

	it('Radial Shadow pads only with Resize Layer; Basic 3D pads only when the plane comes closer', () => {
		expect(radialShadowPadding({ resizeLayer: false, projectionDistance: 50 }, ctx)).toBe(0);
		expect(
			radialShadowPadding({ resizeLayer: true, projectionDistance: 50, lightSource: [0.5, 0.5] }, ctx),
		).toBeGreaterThan(500);
		expect(basic3dPadding({}, ctx)).toBeLessThanOrEqual(3);
		expect(basic3dPadding({ distanceToImage: -50 }, ctx)).toBeGreaterThan(900);
		expect(basic3dPadding({ distanceToImage: 100 }, ctx)).toBeLessThanOrEqual(3);
		expect(basic3dPadding({ swivel: 60 }, ctx)).toBeGreaterThan(3);
	});

	it('Transform inverse: identity by default; position, scale and rotation invert exactly', () => {
		const size = { width: 100, height: 50 };
		expect(transformInverse({}, size)!.map((v) => v + 0)).toEqual([1, 0, 0, 1, 0, 0]);
		const apply = (m: number[], x: number, y: number) => [
			m[0]! * x + m[2]! * y + m[4]!,
			m[1]! * x + m[3]! * y + m[5]!,
		];
		const moved = transformInverse({ position: [0.75, 0.5] }, size)!;
		expect(apply(moved, 75, 25)).toEqual([50, 25]);
		const scaled = transformInverse({ uniformScale: false, scaleWidth: 200, scaleHeight: 50 }, size)!;
		const [sx, sy] = apply(scaled, 70, 30);
		expect(sx).toBeCloseTo(60);
		expect(sy).toBeCloseTo(35);
		const rot = transformInverse({ rotation: 90 }, size)!;
		const [rx, ry] = apply(rot, 50, 35); // 10 px below the centre came from 10 px right of it (clockwise)
		expect(rx).toBeCloseTo(60);
		expect(ry).toBeCloseTo(25);
		expect(transformInverse({ scaleHeight: 0 }, size)).toBeNull();
	});

	it('analysis passes: a ≈96 px thumbnail, 1-px statistics, ≥ 256 cumulative-histogram texels', () => {
		const thumb = analysisThumbPass(ctx);
		expect(Math.round(1920 * thumb.scale!)).toBe(ANALYSIS_SIDE);
		expect(Math.ceil(1920 * statsScale(ctx))).toBeLessThanOrEqual(2);
		for (const c of [ctx, { ...ctx, width: 640, height: 360 }, { ...ctx, width: 4096, height: 2160 }]) {
			const s = equalizeLutScale(c);
			expect(Math.ceil(c.width * s) * Math.ceil(c.height * s)).toBeGreaterThanOrEqual(256);
		}
		expect(gpuPasses(byId('jasper.auto-color').gpu!, {}, ctx).map((p) => p.output ?? null)).toEqual([
			'thumb',
			'lo',
			'hi',
			'mid',
			null,
		]);
	});

	it('blur helpers: Camera Blur radius, downscale factors', () => {
		expect(cameraBlurRadius({ percentBlur: 100 }, ctx)).toBeCloseTo(76.8);
		expect(cameraBlurRadius({ percentBlur: 0 }, ctx)).toBe(0);
		expect([blurScale(4), blurScale(20), blurScale(100)]).toEqual([1, 0.5, 0.25]);
	});

	it('Cineon log → linear: black point → 0, white point → 1, monotonic', () => {
		expect(cineonLogToLinear(95, 95, 685)).toBeCloseTo(0);
		expect(cineonLogToLinear(685, 95, 685)).toBeCloseTo(1);
		expect(cineonLogToLinear(445, 95, 685)).toBeGreaterThan(cineonLogToLinear(400, 95, 685));
		expect(cineonLogToLinear(445, 95, 685)).toBeCloseTo(0.18, 1);
	});
});
