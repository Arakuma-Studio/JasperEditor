// Sapphire Blur+Sharpen — S_FreeLens ("freelensing": a detached lens held in front of the camera). Model:
// - the lens Shift moves the picture the opposite way; Tilt X/Y tilt the plane of focus, so the defocus grows with
//   the distance from the focal line (Focal Point Offset) along the tilt direction, plus Distance for overall blur;
//   Perspective Amount adds keystone; Distortion (linked to the lens or manual) bends the picture radially;
// - the defocus is a real iris gather (Highlight Shape/Roundness, Rotate Highlights, Rel Height, Boost Highlights)
//   on 4 interpolated levels (the depth map of the current lens pose);
// - Light Leak: a row of soft polygonal elements from the Hotspot towards the Pivot (screened), linked to the tilt;
// - Glow of the bright parts; Shake (Normal / Twitchy / Jumpy random lens motion, deterministic per Seed) with
//   motion blur of the shake: the framework's adaptive shutter — the lens pose (shift, tilt keystone,
//   distortion) at exact sub-frame times over Mo Blur Length, ~1 tap per pixel of travel between them, so
//   curved and rotating shakes blur along their real path; Vignette (shape, softness, colour, combine modes, blur).
// Units: Sapphire screen units (U = half the layer width, y down) for Shift, offsets, Hotspot/Pivot, sizes and radii.
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_HASH } from '../glsl/hash.ts';
import { GLSL_MB_POSES } from '../glsl/motion-blur.ts';
import { centredShutter, mbQualityParam, mbStaticPlan, mbUniforms, planMotionBlur } from '../motion-blur.ts';
import { fxParam } from '../params.ts';
import { type FxFrameContext, type FxPlanContext, fxRandom } from '../shader.ts';
import {
	bool,
	choiceIndex,
	clamp,
	GLSL_SBS_COMMON,
	num,
	SBS_WRAPS,
	SbsPlan,
	sColor,
	sNum,
	sSize,
	sUnit,
	sWrap,
	unitPx,
	vec2,
} from './common.ts';
import {
	DEFOCUS_RADIUS_PER_UNIT,
	GLSL_SBS_IRIS,
	gatherPass,
	IRIS_SHAPE_VIEW,
	type IrisConfig,
	irisShapeParam,
	irisSides,
	shapeViewPassParts,
} from './iris.ts';

const FL_SHOW = ['result', 'depthMap', 'shape'] as const;
const SHAKE_MODES = ['normal', 'twitchy', 'jumpy'] as const;
const BLUR_RES = ['full', 'half', 'quarter'] as const;
const VIG_COMBINE = [
	'composite',
	'mult',
	'add',
	'screen',
	'subtractInv',
	'vignetteOnly',
	'vignetteOnlyInv',
] as const;
const LEVELS = 4;

function noise1(seed: number, t: number): number {
	const i = Math.floor(t);
	const f = t - i;
	const a = fxRandom(seed, i) * 2 - 1;
	const b = fxRandom(seed, i + 1) * 2 - 1;
	const s = f * f * (3 - 2 * f);
	return a + (b - a) * s;
}

/** Random lens motion at clip time `sec`: offsets of shift (S units), tilt (deg), distance and leak intensity. */
function freeLensShake(p: EffectParams, seed: number, sec: number) {
	const zero = { x: 0, y: 0, tiltX: 0, tiltY: 0, distance: 0, leak: 0 };
	if (!bool(p.shake, true)) return zero;
	const amp = num(p.amplitude, 1);
	const freq = Math.max(0, num(p.frequency, 8));
	const mode = choiceIndex(p.shakeMode, SHAKE_MODES, 'normal');
	const t = sec * freq * 0.25 + num(p.phase);
	const chan = (k: number, f: number) => {
		const s = (seed + k * 0.1234567) % 1;
		const tt = t * Math.max(0, f);
		if (mode === 1) {
			const gate = noise1((s + 0.5) % 1, sec * Math.max(0, num(p.twitchFrequency, 2))) * 0.5 + 0.5;
			const still = clamp(num(p.twitchStillness, 0.7), 0, 1);
			const g = clamp((gate - still) / 0.1, 0, 1);
			return noise1(s, tt * 4) * g;
		}
		if (mode === 2) {
			const seg = Math.floor(tt);
			const centre = fxRandom((s + 0.77) % 1, seg) < clamp(num(p.jumpCenterBias), 0, 1);
			const jump = centre ? 0 : fxRandom(s, seg) * 2 - 1;
			return jump + clamp(num(p.jumpDrift, 0.3), 0, 1) * noise1((s + 0.33) % 1, tt * 3) * 0.5;
		}
		return noise1(s, tt);
	};
	return {
		x: num(p.xRandAmp) * amp * chan(1, num(p.xRandFreq, 1)) * 0.05,
		y: num(p.yRandAmp) * amp * chan(2, num(p.yRandFreq, 1)) * 0.05,
		tiltX: num(p.tiltXRandAmp) * amp * chan(3, num(p.tiltXRandFreq, 1)) * 5,
		tiltY: num(p.tiltYRandAmp) * amp * chan(4, num(p.tiltYRandFreq, 1)) * 5,
		distance: num(p.distanceRandAmp) * amp * chan(5, num(p.distanceRandFreq, 1)) * 0.05,
		leak: num(p.leakIntRandAmp) * amp * chan(6, num(p.leakIntRandFreq, 1)) * 0.5,
	};
}

/** The lens pose (base params + shake) and the derived amounts. */
function freeLensPose(p: EffectParams, seed: number, sec: number) {
	const sh = freeLensShake(p, seed, sec);
	const shift = vec2(p.shift, [0, 0]);
	const tiltX = clamp(num(p.tiltX, 12.5) + sh.tiltX, -89, 89);
	const tiltY = clamp(num(p.tiltY) + sh.tiltY, -89, 89);
	const distance = num(p.distance) + sh.distance;
	const tiltMag = Math.hypot(tiltX, tiltY) / 45;
	return {
		shift: [shift[0] + sh.x, shift[1] + sh.y] as [number, number],
		tiltX,
		tiltY,
		distance,
		tiltMag,
		distortion: bool(p.linkDistortionToLens, true)
			? -(0.06 * tiltMag + 0.15 * distance)
			: num(p.distortionAmount),
		leak: (bool(p.linkLeakToLens, true) ? 0.6 * tiltMag : 0) + num(p.leakIntensity) + sh.leak,
	};
}

/** Largest defocus amount over the layer (corners) for a pose. */
function maxAmount(p: EffectParams, ctx: FxPlanContext, pose: ReturnType<typeof freeLensPose>) {
	const f = vec2(p.focalPointOffset, [0, 0]);
	const dir = [Math.sin((pose.tiltX * Math.PI) / 180), Math.sin((pose.tiltY * Math.PI) / 180)];
	const persp = Math.sqrt(Math.max(0.25, num(p.perspectiveAmount, 1)));
	const hy = ctx.height / Math.max(1, ctx.width);
	let m = 0;
	for (const [x, y] of [
		[-1, -hy],
		[1, -hy],
		[-1, hy],
		[1, hy],
	] as const)
		m = Math.max(m, Math.abs((x - f[0]) * dir[0]! + (y - f[1]) * dir[1]!) * persp);
	return m * 2 + Math.abs(pose.distance) * 3;
}

/**
 * Upper bound of the defocus amount over the layer for any shake (the level radii are planned once per params; the
 * per-frame pose then interpolates within them).
 */
function amountBound(p: EffectParams, ctx: FxPlanContext): number {
	const amp = bool(p.shake, true) ? num(p.amplitude, 1) : 0;
	const pose = freeLensPose({ ...p, shake: false }, 0, 0);
	const bound = {
		...pose,
		tiltX: Math.min(89, Math.abs(pose.tiltX) + Math.abs(num(p.tiltXRandAmp)) * amp * 5),
		tiltY: Math.min(89, Math.abs(pose.tiltY) + Math.abs(num(p.tiltYRandAmp)) * amp * 5),
		distance: Math.abs(pose.distance) + Math.abs(num(p.distanceRandAmp)) * amp * 0.05,
	};
	const vb = bool(p.vignette, true) ? Math.max(0, num(p.vigBlurAmount)) * 2 : 0;
	// Focal offsets/tilt signs: bound with both signs of the tilt.
	return Math.max(maxAmount(p, ctx, bound), maxAmount(p, ctx, { ...bound, tiltX: -bound.tiltX })) + vb;
}

const GLSL_FREELENS = {
	name: 'sapphire-blur-sharpen/freelens',
	deps: [GLSL_SBS_COMMON, GLSL_HASH],
	source: /* glsl */ `
// Sapphire units of a layer-px point (relative to the layer centre, U = half the layer width).
vec2 fl_q(vec2 layerPx) { vec2 L = u_box.zw / u_pxScale; return (layerPx - 0.5 * L) / (0.5 * L.x); }
vec2 fl_px(vec2 q) { vec2 L = u_box.zw / u_pxScale; return q * (0.5 * L.x) + 0.5 * L; }
float fl_wrap(float v, int mode, out bool outside) {
  outside = false;
  if (mode == 1) return fract(v);
  if (mode == 2) { float m = mod(v, 2.0); return m > 1.0 ? 2.0 - m : m; }
  outside = v < 0.0 || v > 1.0;
  return clamp(v, 0.0, 1.0);
}
vec4 fl_sample(vec2 q) {
  vec2 n = fl_px(q) * u_pxScale / u_box.zw;
  bool ox, oy;
  n.x = fl_wrap(n.x, int(u_flWrap.x), ox);
  n.y = fl_wrap(n.y, int(u_flWrap.y), oy);
  if (ox || oy) return vec4(0.0);
  return texture(u_source, sbs_uvOfNorm(n));
}
// Where the output point q reads the source under a lens pose: lens shift (picture moves the other way), keystone
// (tilt = sines of Tilt X / Y), distortion.
vec2 fl_warpP(vec2 q, vec2 shift, vec2 tilt, float distortion) {
  vec2 s = q + shift;
  if (u_distortion) {
    vec2 d = s * vec2(u_scaleWidth, u_scaleHeight);
    s = s * (1.0 + distortion * dot(d, d));
  }
  s *= 1.0 + u_perspectiveAmount * 0.1 * dot(q, tilt);
  return s;
}
vec2 fl_warp(vec2 q) { return fl_warpP(q, u_flShift, u_flPose.xy, u_flPose.z); }
// Defocus amount at q: distance from the focal line along the tilt, plus Distance.
float fl_amount(vec2 q) {
  return abs(dot(q - u_focalPointOffset, u_flPose.xy)) * sqrt(max(u_perspectiveAmount, 0.25)) * 2.0 + abs(u_flPose.w) * 3.0;
}
`,
};

export const S_FREE_LENS = defineShaderEffect({
	id: 'jasper.s.free-lens',
	label: 'S_FreeLens',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Freelensing: a detached lens tilted and moved in front of the camera — a tilted plane of focus with bokeh, lens distortion, light leaks, glow, vignette and optional random lens shake with motion blur.',
	keywords: ['freelens', 'freelensing', 'tilt shift', 'lens whacking', 'light leak', 'defocus', 'sapphire'],
	expensive: true,
	params: [
		fxParam.vec2('shift', 'Shift', [0, 0], { max: 2, softMin: -2, softMax: 2, step: 0.001 }),
		sNum('tiltX', 'Tilt X', 12.5, { min: -45, max: 45, step: 0.1 }),
		sNum('tiltY', 'Tilt Y', 0, { min: -45, max: 45, step: 0.1 }),
		sNum('distance', 'Distance', 0, { min: -0.3, max: 0.5, step: 0.001 }),
		sNum('rotateHighlights', 'Rotate Highlights', 0, { min: -180, max: 180, step: 0.1 }),
		sNum('perspectiveAmount', 'Perspective Amount', 1, { min: 0.25, max: 4, step: 0.01 }),
		sWrap('wrapX', 'Wrap X', 'reflect'),
		sWrap('wrapY', 'Wrap Y', 'reflect'),
		fxParam.toggle('filter', 'Filter', true),
		sSize('defocusWidth', 'Defocus Width', 0.104, 1),
		fxParam.vec2('focalPointOffset', 'Focal Point Offset', [0, 0], {
			max: 2,
			softMin: -2,
			softMax: 2,
			step: 0.001,
		}),
		sNum('chromaDistort', 'Chroma Distort', 0, { softMin: -2, softMax: 2, step: 0.01 }),
		sNum('relHeight', 'Rel Height', 1, { min: 0.01, softMax: 4, step: 0.01 }),
		fxParam.choice('show', 'Show', FL_SHOW, ['Result', 'DepthMap', 'Shape'], 'result'),
		irisShapeParam('highlightShape', 'Highlight Shape', '6'),
		sNum('highlightRoundness', 'Highlight Roundness', 0, { softMin: -1, softMax: 2, step: 0.01 }),
		sNum('boostHighlights', 'Boost Highlights', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('highlightThreshold', 'Highlight Threshold', 0.9, { min: 0, softMax: 1, step: 0.01 }),
		fxParam.toggle('distortion', 'Distortion', true),
		fxParam.toggle('linkDistortionToLens', 'Link Distortion To Lens', true),
		sNum('distortionAmount', 'Distortion Amount', 0, { min: -0.15, max: 0.15, step: 0.001 }),
		sNum('scaleWidth', 'Scale Width', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('scaleHeight', 'Scale Height', 1, { min: 0, softMax: 4, step: 0.01 }),
		fxParam.toggle('lightLeak', 'Light Leak', true),
		fxParam.toggle('linkLeakToLens', 'Link Leak To Lens', true),
		sNum('leakIntensity', 'Leak Intensity', 0, { softMin: -1, softMax: 2, step: 0.01 }),
		sNum('leakRelHeight', 'Leak Rel Height', 2, { min: 0, softMax: 4, step: 0.01 }),
		sSize('leakSize', 'Leak Size', 0.35, 2),
		sNum('varySize', 'Vary Size', 1, { min: 0, softMax: 2, step: 0.01 }),
		fxParam.vec2('lightLeakHotspot', 'Light Leak Hotspot', [-0.5, 0.25], {
			softMin: -2,
			softMax: 2,
			step: 0.001,
		}),
		fxParam.vec2('lightLeakPivot', 'Light Leak Pivot', [0, 0.25], { softMin: -2, softMax: 2, step: 0.001 }),
		sNum('leakRoundness', 'Leak Roundness', 0.7, { min: -1, max: 1, step: 0.01 }),
		sNum('sides', 'Sides', 4, { min: 3, max: 16, step: 1, int: true }),
		sNum('copies', 'Copies', 5, { min: 1, max: 34, step: 1, int: true }),
		sNum('spread', 'Spread', 4, { min: 0, softMax: 10, step: 0.01 }),
		sColor('outerColor', 'Outer Color', [1, 0.8, 1]),
		sColor('midColor', 'Mid Color', [1, 0.9, 1]),
		sColor('centerColor', 'Center Color', [1, 1, 1]),
		sUnit('midpoint', 'Midpoint', 0.5),
		sNum('softness', 'Softness', 4, { min: 0, softMax: 10, step: 0.01 }),
		sNum('glowBrightness', 'Glow Brightness', 1, { min: 0, softMax: 4, step: 0.01 }),
		sSize('glowWidth', 'Glow Width', 0.4, 2),
		sNum('glowThreshold', 'Glow Threshold', 0.8, { min: 0, softMax: 1, step: 0.01 }),
		fxParam.toggle('shake', 'Shake', true),
		fxParam.choice('shakeMode', 'Shake Mode', SHAKE_MODES, ['Normal', 'Twitchy', 'Jumpy'], 'normal'),
		sUnit('jumpDrift', 'Jump Drift', 0.3),
		sNum('jumpCenterBias', 'Jump Center Bias', 0, { min: 0, softMax: 1, step: 0.01 }),
		sUnit('twitchStillness', 'Twitch Stillness', 0.7),
		sNum('twitchFrequency', 'Twitch Frequency', 2, { min: 0, softMax: 10, step: 0.01 }),
		sNum('amplitude', 'Amplitude', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('frequency', 'Frequency', 8, { min: 0, softMax: 30, step: 0.01 }),
		sNum('phase', 'Phase', 0, { softMin: -10, softMax: 10, step: 0.01 }),
		fxParam.toggle('motionBlur', 'Motion Blur', true),
		sNum('moBlurLength', 'Mo Blur Length', 1, { min: 0, softMax: 4, step: 0.01 }),
		fxParam.choice('blurRes', 'Blur Res', BLUR_RES, ['Full', 'Half', 'Quarter'], 'full'),
		{ ...sNum('seed', 'Seed', 0, { min: 0, softMax: 1000, step: 1 }), animatable: false },
		...(['x', 'y', 'tiltX', 'tiltY', 'distance', 'leakInt'] as const).flatMap((k) => {
			const label = {
				x: 'X',
				y: 'Y',
				tiltX: 'Tilt X',
				tiltY: 'Tilt Y',
				distance: 'Distance',
				leakInt: 'Leak Int',
			}[k];
			return [
				sNum(`${k}RandAmp`, `${label} Rand Amp`, 0, { min: 0, softMax: 4, step: 0.01 }),
				sNum(`${k}RandFreq`, `${label} Rand Freq`, 1, { min: 0, softMax: 10, step: 0.01 }),
			];
		}),
		fxParam.toggle('vignette', 'Vignette', true),
		fxParam.toggle('linkVigToLens', 'Link Vig To Lens', true),
		sNum('vigIntensity', 'Vig Intensity', 0.2, { min: 0, softMax: 1, step: 0.01 }),
		fxParam.point('vigCenter', 'Vig Center', [0.5, 0.5]),
		sUnit('vigSquareness', 'Vig Squareness', 0),
		sSize('vigRadius', 'Vig Radius', 1.5, 4),
		sNum('vigRelHeight', 'Vig Rel Height', 1, { min: 0.05, softMax: 4, step: 0.01 }),
		sNum('vigRelWidth', 'Vig Rel Width', 1, { min: 0.05, softMax: 4, step: 0.01 }),
		fxParam.angle('vigRotate', 'Vig Rotate', 0),
		sSize('vigEdgeSoftness', 'Vig Edge Softness', 0.46, 2),
		sUnit('vigSmoothCurve', 'Vig Smooth Curve', 1),
		sColor('vigColor', 'Vig Color', [0, 0, 0]),
		sNum('vigBlurAmount', 'Vig Blur Amount', 0, { min: 0, softMax: 2, step: 0.01 }),
		fxParam.toggle('vigBlurInside', 'Vig Blur Inside', false),
		sNum('vigSourceBrightness', 'Vig Source Brightness', 1, { min: 0, softMax: 4, step: 0.01 }),
		fxParam.choice(
			'vigCombine',
			'Vig Combine',
			VIG_COMBINE,
			['Composite', 'Mult', 'Add', 'Screen', 'Subtract Inv', 'Vignette Only', 'Vignette Only Inv'],
			'mult',
		),
		mbQualityParam(),
	],
	gpu: {
		uniforms: (p, ctx: FxFrameContext) => {
			const sec = ctx.frame / Math.max(1, ctx.fps);
			const pose = freeLensPose(p, ctx.seed, sec);
			// Shake motion blur: the lens pose at the shutter's key times (2 vec4: shift, tilt sines; distortion), taps
			// from the travel of the source points read at the layer box corners and centre (prep-pass px).
			const len = bool(p.motionBlur, true) ? Math.max(0, num(p.moBlurLength, 1)) : 0;
			const fps = Math.max(1, ctx.fps);
			const keyPose = (f: number) => {
				const q = freeLensPose(p, ctx.seed, f / fps);
				const r = Math.PI / 180;
				return [q.shift[0], q.shift[1], Math.sin(q.tiltX * r), Math.sin(q.tiltY * r), q.distortion, 0, 0, 0];
			};
			const blurScale = 1 / 2 ** choiceIndex(p.blurRes, BLUR_RES, 'full');
			const unit = unitPx(ctx) * blurScale;
			const hy = ctx.height / Math.max(1, ctx.width);
			const persp = num(p.perspectiveAmount, 1);
			const distortOn = bool(p.distortion, true);
			const sc = [num(p.scaleWidth, 1), num(p.scaleHeight, 1)];
			const warp = (k: number[], x: number, y: number): [number, number] => {
				let sx = x + k[0]!;
				let sy = y + k[1]!;
				if (distortOn) {
					const dx = sx * sc[0]!;
					const dy = sy * sc[1]!;
					const g = 1 + k[4]! * (dx * dx + dy * dy);
					sx *= g;
					sy *= g;
				}
				const kk = 1 + persp * 0.1 * (x * k[2]! + y * k[3]!);
				return [sx * kk * unit, sy * kk * unit];
			};
			const mb =
				len > 0 && bool(p.shake, true)
					? planMotionBlur({
							frame: ctx.frame,
							window: centredShutter(len),
							poseAt: keyPose,
							points: (k) =>
								(
									[
										[-1, -hy],
										[1, -hy],
										[1, hy],
										[-1, hy],
										[0, 0],
									] as const
								).map(([x, y]) => warp(k, x, y)),
							pack: (k) => k,
							stride: 2,
							quality: p.mbQuality,
						})
					: mbStaticPlan(2);
			const vigI =
				num(p.vigIntensity, 0.2) *
				(bool(p.linkVigToLens, true) ? 1 + 2 * pose.tiltMag : 1) *
				(bool(p.vignette, true) ? 1 : 0);
			return {
				u_flShift: pose.shift,
				u_flPose: [
					Math.sin((pose.tiltX * Math.PI) / 180),
					Math.sin((pose.tiltY * Math.PI) / 180),
					pose.distortion,
					pose.distance,
				],
				u_flWrap: [choiceIndex(p.wrapX, SBS_WRAPS, 'reflect'), choiceIndex(p.wrapY, SBS_WRAPS, 'reflect')],
				u_flAmax: amountBound(p, ctx),
				u_flLeak: bool(p.lightLeak, true) ? pose.leak : 0,
				u_flVig: vigI,
				u_flVigShift: bool(p.linkVigToLens, true) ? pose.shift : [0, 0],
				...mbUniforms(mb),
			};
		},
		passes: (p, ctx) => {
			const plan = new SbsPlan(ctx);
			const blurK = choiceIndex(p.blurRes, BLUR_RES, 'full');
			// 1. Warped source (shift, keystone, distortion, shake motion blur, chroma distort), boosted highlights.
			plan.pass({
				output: 'prep',
				include: [GLSL_FREELENS, GLSL_SBS_COMMON, GLSL_MB_POSES],
				format: 'rgba16f',
				scale: 1 / 2 ** blurK,
				frag: /* glsl */ `
vec4 fl_read(vec2 q) {
  vec2 s = fl_warp(q);
  if (abs(u_chromaDistort) < 1.0e-4) return fl_sample(s);
  float k = u_chromaDistort * 0.02;
  vec4 g = fl_sample(s);
  return vec4(fl_sample(s * (1.0 - k)).r, g.g, fl_sample(s * (1.0 + k)).b, g.a);
}
vec4 fl_readP(vec2 q, vec4 a, vec4 b) {
  vec2 s = fl_warpP(q, a.xy, a.zw, b.x);
  if (abs(u_chromaDistort) < 1.0e-4) return fl_sample(s);
  float k = u_chromaDistort * 0.02;
  vec4 g = fl_sample(s);
  return vec4(fl_sample(s * (1.0 - k)).r, g.g, fl_sample(s * (1.0 + k)).b, g.a);
}
void main() {
  vec2 q = fl_q(fx_layerPx());
  vec4 c = vec4(0.0);
  if (!fx_mbOn()) c = fl_read(q);
  else {
    // Shake motion blur: the lens poses along their real path over the shutter (adaptive taps).
    int n = fx_mbTaps();
    float j = fx_mbPlanJitter();
    float wsum = 0.0;
    for (int i = 0; i < fx_mbDyn(FX_MB_TAP_LIMIT); i++) {
      if (i >= n) break;
      vec2 t = fx_mbTap(i, n, j);
      c += fl_readP(q, fx_mbPose(0, t.x), fx_mbPose(1, t.x)) * t.y;
      wsum += t.y;
    }
    c /= max(wsum, 1e-6);
  }
  vec4 s = fx_unpremultiply(c);
  fragColor = vec4(sbs_boost(s.rgb, u_boostHighlights, u_highlightThreshold) * s.a, s.a);
}`,
			});
			// 2. Defocus levels (iris) for the depth interpolation.
			const amax = amountBound(p, ctx);
			const r = num(p.defocusWidth, 0.104) * DEFOCUS_RADIUS_PER_UNIT * unitPx(ctx) * amax;
			const rel = Math.max(0.01, num(p.relHeight, 1));
			const iris: IrisConfig = {
				sides: irisSides(p.highlightShape, '6'),
				roundness: num(p.highlightRoundness),
				rotate: num(p.rotateHighlights),
				bokeh: 0,
			};
			const levels: string[] = ['prep'];
			for (let i = 1; i < LEVELS; i++)
				levels.push(
					gatherPass(plan, {
						input: 'prep',
						output: `fl${i}`,
						radiusX: (r * i) / (LEVELS - 1),
						radiusY: ((r * i) / (LEVELS - 1)) * rel,
						iris,
						edge: 3,
						maxLevel: 6,
					}).output,
				);
			// 3. Glow: a blur of the (boosted) picture on the gathers' own pyramid; Glow Threshold keeps its bright part
			//    in the final pass (no extra threshold texture: the effect stays within the texture budget).
			const glowSigma = num(p.glowWidth, 0.4) * unitPx(ctx) * 0.125;
			const glow = num(p.glowBrightness, 1) > 0 && glowSigma > 0.2;
			if (glow)
				plan.blur2d({
					input: 'prep',
					output: 'glow',
					sigmaX: glowSigma,
					sigmaY: glowSigma,
					edge: 3,
					maxLevel: 6,
					comb: false,
				});
			const shape = choiceIndex(p.show, FL_SHOW, 'result') === 2 ? shapeViewPassParts(iris) : null;
			const mixLevels = levels
				.slice(1)
				.map(
					(n, j) =>
						`  if (t <= ${(j + 1).toFixed(1)}) return mix(texture(u_${levels[j]}, uv), texture(u_${n}, uv), t - ${j.toFixed(1)});`,
				)
				.join('\n');
			const leakCount = clamp(Math.round(num(p.copies, 5)), 1, 34);
			plan.pass({
				include: shape ? [shape.defines, GLSL_FREELENS, GLSL_SBS_IRIS] : [GLSL_FREELENS],
				uniforms: { ...(shape?.uniforms ?? {}), u_shapeRel: rel },
				frag: /* glsl */ `
${shape ? IRIS_SHAPE_VIEW : ''}
vec4 fl_levels(vec2 uv, float t) {
${mixLevels}
  return texture(u_${levels[levels.length - 1]}, uv);
}
float fl_poly(float th, float n, float round) {
  float seg = 6.28318531 / n;
  float ph = mod(th, seg) - 0.5 * seg;
  float poly = cos(0.5 * seg) / cos(ph);
  return max(poly + round * (1.0 - poly), 0.05);
}
vec3 fl_leak(vec2 q) {
  vec3 light = vec3(0.0);
  vec2 dir = u_lightLeakPivot - u_lightLeakHotspot;
  float ang = atan(dir.y, dir.x);
  float c = cos(-ang), s = sin(-ang);
  for (int k = 0; k < ${leakCount}; k++) {
    float t = ${leakCount > 1 ? `float(k) / ${(leakCount - 1).toFixed(1)}` : '0.0'};
    vec2 pos = u_lightLeakHotspot + dir * t * u_spread * 0.25;
    float size = u_leakSize * max(0.05, 1.0 + u_varySize * (fx_hash1(k, 0.37) - 0.5) * 0.9);
    vec2 d = q - pos;
    d = vec2(c * d.x - s * d.y, s * d.x + c * d.y) / (size * vec2(1.0, max(u_leakRelHeight, 0.01)) * 0.5);
    float r = length(d) / fl_poly(atan(d.y, d.x), u_sides, u_leakRoundness);
    float es = clamp(u_softness * 0.1, 0.01, 1.0);
    float a = 1.0 - smoothstep(1.0 - es, 1.0, r);
    float m = clamp(u_midpoint, 0.001, 0.999);
    vec3 col = r < m ? mix(u_centerColor.rgb, u_midColor.rgb, r / m) : mix(u_midColor.rgb, u_outerColor.rgb, (r - m) / (1.0 - m));
    light += col * a * 0.35;
  }
  return light;
}
float fl_vignette(vec2 q) {
  vec2 c = fl_q(u_vigCenter * u_box.zw / u_pxScale) - u_flVigShift;
  float a = radians(u_vigRotate);
  vec2 d = q - c;
  d = vec2(cos(a) * d.x + sin(a) * d.y, -sin(a) * d.x + cos(a) * d.y);
  d /= max(u_vigRadius, 1.0e-3) * vec2(u_vigRelWidth, u_vigRelHeight);
  float n = mix(length(d), max(abs(d.x), abs(d.y)), u_vigSquareness);
  float soft = max(u_vigEdgeSoftness / max(u_vigRadius, 1.0e-3), 1.0e-3);
  float v = clamp((n - (1.0 - soft)) / soft, 0.0, 1.0);
  return mix(v, smoothstep(0.0, 1.0, v), u_vigSmoothCurve);
}
void main() {
${shape ? '  fragColor = sbs_shapeView(u_shapeRel, 0.8); return;' : ''}
  vec2 q = fl_q(fx_layerPx());
  float vig = u_vignette ? fl_vignette(q) : 0.0;
  float amount = fl_amount(q) + (u_vignette ? u_vigBlurAmount * 2.0 * (u_vigBlurInside ? 1.0 - vig : vig) : 0.0);
  if (u_show == 1) { float d = u_flAmax > 0.0 ? amount / u_flAmax : 0.0; fragColor = vec4(vec3(clamp(d, 0.0, 1.0)), 1.0); return; }
  float t = u_flAmax > 0.0 ? clamp(amount / u_flAmax, 0.0, 1.0) * ${(LEVELS - 1).toFixed(1)} : 0.0;
  vec4 d = fx_unpremultiply(fl_levels(v_uv, t));
  vec3 c = d.rgb;
  if (u_flLeak != 0.0) { vec3 l = clamp(fl_leak(q) * u_flLeak, 0.0, 1.0); c = c + l - clamp(c, 0.0, 1.0) * l; }
${glow ? '  { vec3 g = fx_unpremultiply(texture(u_glow, v_uv)).rgb; c += max(g - u_glowThreshold, 0.0) / max(1.0 - u_glowThreshold, 0.05) * u_glowBrightness * 0.5; }' : ''}
  c = clamp(c, 0.0, 1.0) * u_vigSourceBrightness;
  float vi = clamp(vig * u_flVig, 0.0, 1.0);
  vec3 vc = u_vigColor.rgb;
  if (u_vigCombine == 0) c = mix(c, vc, vi);
  else if (u_vigCombine == 1) c *= mix(vec3(1.0), vc, vi);
  else if (u_vigCombine == 2) c += vc * vi;
  else if (u_vigCombine == 3) c = c + vc * vi - c * vc * vi;
  else if (u_vigCombine == 4) c -= (1.0 - vc) * vi;
  else if (u_vigCombine == 5) c = vec3(vi);
  else if (u_vigCombine == 6) c = vec3(1.0 - vi);
  float a = u_vigCombine >= 5 ? 1.0 : d.a;
  fragColor = vec4(clamp(c, 0.0, 1.0) * a, a);
}`,
			});
			return plan.passes;
		},
	},
});

export const SBS_FREELENS: readonly EffectSpec[] = [S_FREE_LENS];
