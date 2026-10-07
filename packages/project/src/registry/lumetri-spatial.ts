// `jasper.lumetri-spatial` (color-grade): the GPU stage of a Lumetri Color instance's spatial steps — Creative ▸
// Sharpen, HSL Secondary (key, Refine, Correction, Show Mask) and Vignette (maths: color/lumetri-spatial.ts). The
// pointwise Lumetri steps stay in the colour run's baked LUT (native `lut3d`); these cannot, so the render
// snapshot (render/snapshot.ts → `expandLumetriSpatial`) inserts this INTERNAL effect right after every Lumetri
// instance that uses them, carrying the instance's spatial params (keyframes and expressions included) and its
// effect masks. From there the fx framework renders it everywhere: the Player and Remotion renders run the shader,
// and the export planner bakes the layer (hybrid) or renders through Remotion — never dropped.
//
// It is never listed (Effects panel, agent catalogue) and cannot be added by commands (`internal`); the
// before/after toggle bypasses it with the colour effects (`gradeBypass`).
import {
	LUMETRI_SPATIAL_PARAMS,
	lumetriSpatialActive,
	lumetriSpatialSettings,
} from '../color/lumetri-spatial.ts';
import type { Animatable } from '../schema/common.ts';
import { LUMETRI_EFFECT_ID, LUMETRI_PARAMS } from './color-effects.ts';
import type { EffectParams, EffectSpec } from './effects.ts';
import { defineShaderEffect } from './fx/define.ts';
import { GLSL_COLOR } from './fx/glsl/color.ts';
import { gaussianBlurPasses } from './fx/passes.ts';
import type { GlslChunk, ShaderPass } from './fx/shader.ts';

export const LUMETRI_SPATIAL_EFFECT_ID = 'jasper.lumetri-spatial';

/** Gaussian σ of the sharpen detail (layer px at full resolution). */
export const LUMETRI_SHARPEN_SIGMA = 1;
/** Largest Refine ▸ Blur σ (layer px at full resolution, Blur = 100). */
export const LUMETRI_KEY_BLUR_MAX = 20;

const GLSL_LUMETRI_KEY: GlslChunk = {
	name: 'lumetri/key',
	deps: [GLSL_COLOR],
	source: /* glsl */ `
float lm_band(float v, vec4 k) {
  if (k.x < 0.5) return 1.0;
  float a = min(k.y, k.z);
  float b = max(k.y, k.z);
  float d = v < a ? a - v : (v > b ? v - b : 0.0);
  if (d <= 0.0) return 1.0;
  return k.w > 0.0 ? max(0.0, 1.0 - d / k.w) : 0.0;
}
// HSL Secondary key of a straight colour (color/lumetri-spatial.ts secondaryKey).
float lm_key(vec3 c) {
  vec3 hsl = fx_rgb2hsl(clamp(c, 0.0, 1.0));
  float w = 1.0;
  if (u_lmKeyHue.x > 0.5 && u_lmKeyHue.z < 0.5 - 1e-6) {
    float dd = abs(hsl.x - u_lmKeyHue.y);
    dd = fract(dd);
    float d = min(dd, 1.0 - dd);
    float hw = d <= u_lmKeyHue.z ? 1.0 : (u_lmKeyHue.w > 0.0 ? max(0.0, 1.0 - (d - u_lmKeyHue.z) / u_lmKeyHue.w) : 0.0);
    w *= hw * min(1.0, hsl.y * 20.0);
  }
  w *= lm_band(hsl.y, u_lmKeySat);
  w *= lm_band(hsl.z, u_lmKeyLuma);
  return w;
}
`,
};

/** Median of 9 (a min/max network: branch-free, cheap on software GL). */
const GLSL_MEDIAN9 = /* glsl */ `
void lm_sort2(inout float a, inout float b) { float t = min(a, b); b = max(a, b); a = t; }
float lm_median9(float p0, float p1, float p2, float p3, float p4, float p5, float p6, float p7, float p8) {
  lm_sort2(p1, p2); lm_sort2(p4, p5); lm_sort2(p7, p8);
  lm_sort2(p0, p1); lm_sort2(p3, p4); lm_sort2(p6, p7);
  lm_sort2(p1, p2); lm_sort2(p4, p5); lm_sort2(p7, p8);
  lm_sort2(p0, p3); lm_sort2(p5, p8); lm_sort2(p4, p7);
  lm_sort2(p3, p6); lm_sort2(p1, p4); lm_sort2(p2, p5);
  lm_sort2(p4, p7); lm_sort2(p4, p2); lm_sort2(p6, p4);
  lm_sort2(p4, p2);
  return p4;
}
`;

type Flags = { key: boolean; denoise: boolean; blur: boolean; sharpen: boolean };

function flagsOf(p: EffectParams): Flags {
	const s = lumetriSpatialSettings(p);
	const key = s.secondary;
	return {
		key,
		denoise: key && s.denoise > 0,
		blur: key && s.blur > 0,
		sharpen: s.sharpen !== 0 || (key && s.showMask === 0 && s.secSharpen !== 0),
	};
}

function finalPass(f: Flags, keyTex: string | null): ShaderPass {
	const body = /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (src.a <= 0.0) { fragColor = vec4(0.0); return; }
  vec3 c = src.rgb / src.a;
  float k = 0.0;
  ${f.key ? (keyTex ? `k = texture(${keyTex}, v_uv).r;` : 'k = lm_key(c);') : ''}
  ${f.key ? 'if (u_lmInvert) k = 1.0 - k;' : ''}
  ${
		f.key
			? `
  if (u_lmShowMask == 1) {
    float g = clamp(fx_luma(c), 0.0, 1.0) * 0.2 + 0.4;
    fragColor = vec4(clamp(mix(vec3(g), c, k), 0.0, 1.0) * src.a, src.a);
    return;
  }
  if (u_lmShowMask == 2) { fragColor = vec4(clamp(c * k, 0.0, 1.0) * src.a, src.a); return; }
  if (u_lmShowMask == 3) { fragColor = vec4(vec3(clamp(k, 0.0, 1.0)) * src.a, src.a); return; }`
			: ''
	}
  ${
		f.sharpen
			? `
  {
    vec4 soft = texture(u_soft, v_uv);
    vec3 s3 = soft.a > 0.0 ? soft.rgb / soft.a : c;
    float detail = fx_luma(c) - fx_luma(s3);
    float amount = u_lmSharpen + u_lmSecSharpen * k;
    float kk = amount > 0.0 ? 2.5 * amount : amount;
    c += detail * kk;
  }`
			: ''
	}
  ${
		f.key
			? `
  if (k > 0.0) {
    vec3 d = c;
    d *= vec3(1.0 + 0.25 * u_lmSecTemp, 1.0 - 0.25 * u_lmSecTint, 1.0 - 0.25 * u_lmSecTemp);
    d = 0.5 + (d - 0.5) * (1.0 + u_lmSecContrast);
    float y = fx_luma(d);
    d = y + (d - y) * u_lmSecSat;
    if (u_lmThreeWay) {
      d = d + u_lmLift * (1.0 - d);
      d = vec3(d.r > 0.0 ? pow(d.r, u_lmGamma.r) : d.r, d.g > 0.0 ? pow(d.g, u_lmGamma.g) : d.g, d.b > 0.0 ? pow(d.b, u_lmGamma.b) : d.b);
      d *= u_lmGain;
    } else {
      d += u_lmOffset;
    }
    c = mix(c, d, k);
  }`
			: ''
	}
  if (u_lmVigAmount != 0.0) {
    vec2 n = fx_layerNorm() * 2.0 - 1.0;
    float aspect = u_box.z / max(u_box.w, 1e-6);
    if (u_lmVigRound > 0.0) n *= vec2(1.0 + (max(aspect, 1.0) - 1.0) * u_lmVigRound, 1.0 + (max(1.0 / aspect, 1.0) - 1.0) * u_lmVigRound);
    float pw = 2.0 + max(0.0, -u_lmVigRound) * 6.0;
    float r = pow(pow(abs(n.x), pw) + pow(abs(n.y), pw), 1.0 / pw) / 1.4142135623730951;
    float start = u_lmVigMid * 0.9;
    float fe = smoothstep(start, start + 0.05 + u_lmVigFeather * (1.05 - start), r);
    if (u_lmVigAmount < 0.0) c *= max(0.0, 1.0 + u_lmVigAmount * 0.2 * fe);
    else c += (1.0 - c) * min(1.0, u_lmVigAmount * 0.2 * fe);
  }
  fragColor = vec4(clamp(c, 0.0, 1.0) * src.a, src.a);
}`;
	return { frag: body, include: [GLSL_COLOR, ...(f.key && !keyTex ? [GLSL_LUMETRI_KEY] : [])] };
}

function passes(p: EffectParams): ShaderPass[] {
	const f = flagsOf(p);
	const out: ShaderPass[] = [];
	let keyTex: string | null = null;
	if (f.key && (f.denoise || f.blur)) {
		out.push({
			output: 'key',
			include: [GLSL_LUMETRI_KEY],
			frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  float k = src.a > 0.0 ? lm_key(src.rgb / src.a) : 0.0;
  fragColor = vec4(k, k, k, 1.0);
}`,
		});
		keyTex = 'u_key';
		if (f.denoise) {
			out.push({
				output: 'keyDenoised',
				frag: /* glsl */ `${GLSL_MEDIAN9}
float lm_at(vec2 o) { return texture(u_key, v_uv + o * u_texel * u_lmDenoiseStep).r; }
void main() {
  float m = lm_median9(lm_at(vec2(-1.0, -1.0)), lm_at(vec2(0.0, -1.0)), lm_at(vec2(1.0, -1.0)),
    lm_at(vec2(-1.0, 0.0)), lm_at(vec2(0.0)), lm_at(vec2(1.0, 0.0)),
    lm_at(vec2(-1.0, 1.0)), lm_at(vec2(0.0, 1.0)), lm_at(vec2(1.0, 1.0)));
  float k = texture(u_key, v_uv).r;
  k = mix(k, m, u_lmDenoise);
  fragColor = vec4(k, k, k, 1.0);
}`,
				filter: 'nearest',
			});
			keyTex = 'u_keyDenoised';
		}
		if (f.blur) {
			out.push(
				...gaussianBlurPasses({
					input: keyTex.slice(2),
					output: 'keyBlurred',
					sigma: { uniform: 'u_lmKeyBlurSigma' },
				}),
			);
			keyTex = 'u_keyBlurred';
		}
	}
	if (f.sharpen)
		out.push(...gaussianBlurPasses({ input: 'source', output: 'soft', sigma: { uniform: 'u_lmSharpSigma' } }));
	out.push(finalPass(f, keyTex));
	return out;
}

/** Spatial params of the Lumetri spec (same names, ranges and defaults). */
const SPATIAL_PARAM_SPECS = LUMETRI_PARAMS.filter((p) => LUMETRI_SPATIAL_PARAMS.includes(p.name));

const BASE_SPEC = defineShaderEffect({
	id: LUMETRI_SPATIAL_EFFECT_ID,
	label: 'Lumetri Color (spatial stage)',
	category: 'Color Correction',
	description:
		'Internal GPU stage of Lumetri Color: Creative Sharpen, HSL Secondary (key, refine, correction) and Vignette.',
	params: SPATIAL_PARAM_SPECS.map((p) => ({ ...p })),
	gpu: {
		timeInvariant: true,
		passes: (p) => passes(p),
		uniforms: (p, ctx) => {
			const s = lumetriSpatialSettings(p);
			const px = ctx.pxScale;
			return {
				u_lmSharpen: s.sharpen,
				u_lmSecSharpen: s.secondary && s.showMask === 0 ? s.secSharpen : 0,
				u_lmSharpSigma: LUMETRI_SHARPEN_SIGMA * px,
				u_lmShowMask: { int: s.showMask },
				u_lmInvert: s.invert,
				u_lmKeyHue: [s.hue.on ? 1 : 0, s.hue.a, s.hue.b, s.hue.soft],
				u_lmKeySat: [s.sat.on ? 1 : 0, s.sat.a, s.sat.b, s.sat.soft],
				u_lmKeyLuma: [s.luma.on ? 1 : 0, s.luma.a, s.luma.b, s.luma.soft],
				u_lmDenoise: s.denoise,
				u_lmDenoiseStep: Math.max(1, (1 + 2 * s.denoise) * px),
				u_lmKeyBlurSigma: s.blur * LUMETRI_KEY_BLUR_MAX * px,
				u_lmSecTemp: s.temperature,
				u_lmSecTint: s.tint,
				u_lmSecContrast: s.contrast,
				u_lmSecSat: s.saturation,
				u_lmThreeWay: s.threeWay,
				u_lmOffset: [...s.offset],
				u_lmLift: [...s.lift],
				u_lmGamma: [...s.gamma],
				u_lmGain: [...s.gain],
				u_lmVigAmount: s.vignette.amount,
				u_lmVigMid: s.vignette.midpoint,
				u_lmVigRound: s.vignette.roundness,
				u_lmVigFeather: s.vignette.feather,
			};
		},
	},
});

export const LUMETRI_SPATIAL_EFFECT: EffectSpec = {
	...BASE_SPEC,
	internal: true,
	gradeBypass: true,
	// Exported with the colour effects' native badge semantics: the planner bakes the layer (hybrid) or uses Remotion.
};

// ---------------------------------------------------------------- render snapshot expansion

type InstanceLike = {
	id: string;
	effectId: string;
	effectVersion: number;
	enabled: boolean;
	params: Record<string, Animatable<unknown>>;
	masks?: unknown;
};

/** True when an animatable can take a non-default value at some time (static value, any keyframe, an expression). */
function mayDiffer(a: Animatable<unknown> | undefined, def: unknown): boolean {
	if (!a) return false;
	if ((a as { expression?: { enabled?: boolean } }).expression?.enabled) return true;
	const same = (v: unknown) => JSON.stringify(v) === JSON.stringify(def);
	if (a.keyframes?.length) return a.keyframes.some((k) => !same(k.value)) || !same(a.value);
	return !same(a.value);
}

/** True when a Lumetri instance can use its spatial steps at some frame (the companion stage is needed). */
export function lumetriUsesSpatial(fx: InstanceLike): boolean {
	if (fx.effectId !== LUMETRI_EFFECT_ID || !fx.enabled) return false;
	const triggers = [
		'secShowMask',
		'secTemperature',
		'secTint',
		'secContrast',
		'secSharpen',
		'secSaturation',
		'secWheel',
		'secWheelLevel',
		'secShadowsWheel',
		'secShadowsLevel',
		'secMidtonesWheel',
		'secMidtonesLevel',
		'secHighlightsWheel',
		'secHighlightsLevel',
	];
	const differs = (name: string) => {
		const spec = SPATIAL_PARAM_SPECS.find((p) => p.name === name);
		return !!spec && mayDiffer(fx.params[name], spec.default);
	};
	// Section switches are hold-only booleans: off at every key = never used.
	const neverOn = (name: string) => {
		const a = fx.params[name];
		if (!a) return false;
		if ((a as { expression?: { enabled?: boolean } }).expression?.enabled) return false;
		return a.value === false && (a.keyframes ?? []).every((k) => k.value === false);
	};
	const secUsed = !neverOn('secondaryOn') && triggers.some(differs);
	const sharpenUsed = !neverOn('creativeOn') && differs('sharpen');
	const vignetteUsed = !neverOn('vignetteOn') && differs('vignetteAmount');
	return secUsed || sharpenUsed || vignetteUsed;
}

/** The id of the companion instance of a Lumetri instance (render snapshots only; never in documents). */
export const lumetriSpatialInstanceId = (fxId: string) => `${fxId}~spatial`;

/**
 * Render snapshots: inserts the spatial companion stage after every enabled Lumetri instance that uses spatial
 * steps (same masks, the spatial params with their animation). Other effects pass through unchanged; a list
 * without such an instance is returned as is.
 */
export function expandLumetriSpatial<E extends InstanceLike>(effects: readonly E[]): E[] {
	if (!effects.some((fx) => lumetriUsesSpatial(fx))) return effects as E[];
	const out: E[] = [];
	for (const fx of effects) {
		out.push(fx);
		if (!lumetriUsesSpatial(fx)) continue;
		const params: Record<string, Animatable<unknown>> = {};
		for (const name of LUMETRI_SPATIAL_PARAMS) if (fx.params[name]) params[name] = fx.params[name]!;
		out.push({
			...fx,
			id: lumetriSpatialInstanceId(fx.id),
			effectId: LUMETRI_SPATIAL_EFFECT_ID,
			effectVersion: 1,
			params,
		} as E);
	}
	return out;
}

/** Whether evaluated Lumetri params use the spatial stage at this frame (tests, UI badges). */
export function lumetriSpatialActiveAt(p: EffectParams): boolean {
	return lumetriSpatialActive(lumetriSpatialSettings(p));
}
