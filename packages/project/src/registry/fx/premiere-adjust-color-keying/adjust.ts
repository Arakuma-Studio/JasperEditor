// Premiere Pro "Adjust" video effects (fx family premiere-adjust-color-keying): Auto Color, Auto Contrast, Auto
// Levels (./analysis.ts), Convolution Kernel, Extract, Levels, Lighting Effects, ProcAmp.
import type { EffectParams, EffectSpec, ParamSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { fxParam } from '../params.ts';
import { AUTO_COLOR, AUTO_CONTRAST, AUTO_LEVELS } from './analysis.ts';
import { GLSL_PACG, num, popup, slider } from './common.ts';

const KERNEL = ['11', '12', '13', '21', '22', '23', '31', '32', '33'] as const;

/** The kernel as a GLSL mat3 (column-major): m[col][row] = M<row+1><col+1>. */
export function kernelMat3(p: EffectParams): number[] {
	const m = (r: number, c: number) => num(p[`m${r}${c}`], r === 2 && c === 2 ? 1 : 0);
	return [m(1, 1), m(2, 1), m(3, 1), m(1, 2), m(2, 2), m(3, 2), m(1, 3), m(2, 3), m(3, 3)];
}

/** Convolution Kernel: a 3×3 weighted sum of each pixel's neighbours, divided by Scale, plus Offset. */
export const CONVOLUTION_KERNEL = defineShaderEffect({
	id: 'jasper.convolution-kernel',
	label: 'Convolution Kernel',
	category: 'Adjust',
	description:
		'Applies a 3×3 convolution matrix (M11…M33, Offset, Scale): emboss, sharpen, blur and edge kernels of your own.',
	keywords: ['kernel', 'matrix', 'emboss', 'edge detect', 'sharpen', 'filter'],
	params: [
		...KERNEL.map((k) =>
			slider(`m${k}`, `M${k}`, k === '22' ? 1 : 0, -999, 999, { softMin: -30, softMax: 30, step: 1 }),
		),
		slider('offset', 'Offset', 0, -999, 999, { softMin: -255, softMax: 255, step: 1 }),
		slider('scale', 'Scale', 1, -999, 999, { softMin: 1, softMax: 30, step: 1 }),
		fxParam.toggle('processAlpha', 'Process Alpha', false),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p) => ({ u_kernel: { mat3: kernelMat3(p) } }),
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 sum = vec4(0.0);
  for (int row = 0; row < 3; row++)
    for (int col = 0; col < 3; col++) {
      vec4 t = texture(u_source, v_uv + vec2(float(col - 1), float(row - 1)) * u_texel);
      sum += (u_processAlpha ? t : vec4(pacg_straight(t), 1.0)) * u_kernel[col][row];
    }
  float sc = abs(u_scale) < 1.0e-4 ? 1.0 : u_scale;
  vec3 c = clamp(sum.rgb / sc + u_offset / 255.0, 0.0, 1.0);
  if (u_processAlpha) {
    float a = clamp(sum.a / sc + u_offset / 255.0, 0.0, 1.0);
    fragColor = vec4(min(c, vec3(a)), a);
    return;
  }
  fragColor = fx_premultiply(vec4(c, src.a));
}`,
			},
		],
	},
});

export const EXTRACT = defineShaderEffect({
	id: 'jasper.extract',
	label: 'Extract',
	category: 'Adjust',
	description:
		'Turns the picture black and white: luminance between the black and white input levels becomes white, the rest black.',
	keywords: ['threshold', 'black and white', 'high contrast', 'luminance'],
	params: [
		slider('blackInputLevel', 'Black Input Level', 128, 0, 255, { step: 1 }),
		slider('whiteInputLevel', 'White Input Level', 255, 0, 255, { step: 1 }),
		slider('softness', 'Softness', 0, 0, 100, { step: 0.1 }),
		fxParam.toggle('invert', 'Invert', false),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  float y = pacg_luma601(pacg_straight(src)) * 255.0;
  float s = max(u_softness * 1.28, 1.0e-3);
  float v = smoothstep(u_blackInputLevel - s, u_blackInputLevel, y + 0.5)
          * (1.0 - smoothstep(u_whiteInputLevel, u_whiteInputLevel + s, y - 0.5));
  if (u_invert) v = 1.0 - v;
  fragColor = vec4(vec3(v) * src.a, src.a);
}`,
			},
		],
	},
});

const LEVEL_SETS = [
	['', '(RGB)'],
	['R', '(R)'],
	['G', '(G)'],
	['B', '(B)'],
] as const;

function levelsParams(): ParamSpec[] {
	const out: ParamSpec[] = [];
	for (const [k, l] of LEVEL_SETS) {
		out.push(
			slider(`blackInput${k}`, `${l} Black Input Level`, 0, 0, 255, { step: 1 }),
			slider(`whiteInput${k}`, `${l} White Input Level`, 255, 0, 255, { step: 1 }),
			slider(`blackOutput${k}`, `${l} Black Output Level`, 0, 0, 255, { step: 1 }),
			slider(`whiteOutput${k}`, `${l} White Output Level`, 255, 0, 255, { step: 1 }),
			slider(`gamma${k}`, `${l} Gamma`, 100, 10, 999, { softMax: 300, step: 1 }),
		);
	}
	return out;
}

/** Levels as uniforms (levels 0..1, gamma = value / 100): the master (RGB) set and the per-channel sets as vec3. */
function levelsUniforms(p: EffectParams) {
	const set = (k: string) =>
		[
			num(p[`blackInput${k}`], 0) / 255,
			num(p[`whiteInput${k}`], 255) / 255,
			num(p[`blackOutput${k}`], 0) / 255,
			num(p[`whiteOutput${k}`], 255) / 255,
			num(p[`gamma${k}`], 100) / 100,
		] as const;
	const m = set('');
	const r = set('R');
	const g = set('G');
	const b = set('B');
	const v = (i: number) => [r[i], g[i], b[i]] as [number, number, number];
	return {
		u_lvMaster: [m[0], m[1], m[2], m[3]] as [number, number, number, number],
		u_lvMasterGamma: m[4],
		u_lvInBlack: v(0),
		u_lvInWhite: v(1),
		u_lvOutBlack: v(2),
		u_lvOutWhite: v(3),
		u_lvGamma: v(4),
	};
}

export const LEVELS = defineShaderEffect({
	id: 'jasper.levels',
	label: 'Levels',
	category: 'Adjust',
	description:
		'Remaps input black/white levels to output levels with a gamma, for the composite (RGB) and each channel.',
	keywords: ['levels', 'gamma', 'black point', 'white point', 'histogram', 'tone'],
	params: levelsParams(),
	gpu: {
		timeInvariant: true,
		uniforms: (p) => levelsUniforms(p),
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
vec3 lv(vec3 c, vec3 ib, vec3 iw, vec3 ob, vec3 ow, vec3 g) {
  vec3 v = clamp((c - ib) / max(iw - ib, vec3(1.0 / 255.0)), 0.0, 1.0);
  v = pow(v, 1.0 / max(g, vec3(0.01)));
  return ob + v * (ow - ob);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src);
  c = lv(c, u_lvInBlack, u_lvInWhite, u_lvOutBlack, u_lvOutWhite, u_lvGamma);
  c = lv(c, vec3(u_lvMaster.x), vec3(u_lvMaster.y), vec3(u_lvMaster.z), vec3(u_lvMaster.w), vec3(u_lvMasterGamma));
  fragColor = fx_premultiply(vec4(clamp(c, 0.0, 1.0), src.a));
}`,
			},
		],
	},
});

const LIGHT_TYPES: [string, string][] = [
	['none', 'None'],
	['directional', 'Directional'],
	['omni', 'Omni'],
	['spotlight', 'Spotlight'],
];

function lightParams(i: number): ParamSpec[] {
	const g = `Light ${i}`;
	const on = i === 1;
	const n = (s: string) => `light${i}${s}`;
	return [
		popup(n('Type'), 'Light Type', LIGHT_TYPES, on ? 'spotlight' : 'none', g),
		fxParam.color(n('Color'), 'Light Color', [1, 1, 1, 1], { group: g }),
		fxParam.point(n('Center'), 'Center', on ? [0.4, 0.4] : [0.5, 0.5], { group: g }),
		slider(n('MajorRadius'), 'Major Radius', 20, 0, 100, { group: g }),
		slider(n('MinorRadius'), 'Minor Radius', 20, 0, 100, { group: g }),
		fxParam.angle(n('Angle'), 'Angle', 0, { group: g }),
		slider(n('Intensity'), 'Intensity', 20, -100, 100, { softMin: 0, softMax: 50, group: g }),
		slider(n('Focus'), 'Focus', 50, -100, 100, { group: g }),
	];
}

const lightCall = (i: number) =>
	`light(u_light${i}Type, u_light${i}Color.rgb, u_light${i}Center, u_light${i}MajorRadius, u_light${i}MinorRadius, u_light${i}Angle, u_light${i}Intensity, u_light${i}Focus, p, n, base, diff, spec);`;

export const LIGHTING_EFFECTS = defineShaderEffect({
	id: 'jasper.lighting-effects',
	label: 'Lighting Effects',
	category: 'Adjust',
	description:
		'Lights the clip with up to five directional, omni or spot lights, an ambient light, surface gloss and an optional bump (texture) layer.',
	keywords: ['light', 'spotlight', 'omni', 'bump map', 'emboss', 'texture'],
	expensive: true,
	params: [
		...[1, 2, 3, 4, 5].flatMap(lightParams),
		fxParam.color('ambienceLightColor', 'Ambience Light Color', [1, 1, 1, 1]),
		slider('ambienceIntensity', 'Ambience Intensity', 20, -100, 100),
		slider('surfaceGloss', 'Surface Gloss', 0, -100, 100),
		slider('surfaceMaterial', 'Surface Material', 0, -100, 100),
		slider('exposure', 'Exposure', 0, -100, 100),
		fxParam.media('bumpLayer', 'Bump Layer'),
		popup('bumpChannel', 'Bump Channel', [
			['r', 'R'],
			['g', 'G'],
			['b', 'B'],
			['luminance', 'Luminance'],
			['alpha', 'Alpha'],
		]),
		slider('bumpHeight', 'Bump Height', 1, -100, 100, { softMin: -10, softMax: 10, step: 0.01 }),
		fxParam.toggle('whiteIsHigh', 'White is High', true),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
float bumpAt(vec2 n) {
  vec4 t = texture(u_bumpLayer, clamp(n, 0.0, 1.0));
  vec3 c = pacg_straight(t);
  float h = u_bumpChannel == 0 ? c.r : u_bumpChannel == 1 ? c.g : u_bumpChannel == 2 ? c.b : u_bumpChannel == 3 ? fx_luma(c) : t.a;
  return u_whiteIsHigh ? h : 1.0 - h;
}
// Adds one light's diffuse and specular contribution (p = layer px, n = surface normal, base = surface colour).
void light(int type, vec3 color, vec2 center, float major, float minor, float angle, float intensity, float focus,
           vec2 p, vec3 n, vec3 base, inout vec3 diff, inout vec3 spec) {
  if (type == 0) return;
  vec2 box = u_box.zw / u_pxScale;
  float unit = min(box.x, box.y) * 0.02;
  vec2 c = center * box;
  float R = max(major * unit, 1.0);
  float r = max(minor * unit, 1.0);
  float amount = intensity / 20.0;
  float shape = 1.0;
  vec3 L;
  if (type == 1) {
    // Directional: parallel light coming from the side of the centre point (seen from the middle of the layer).
    L = normalize(vec3(c - box * 0.5, R));
  } else {
    L = normalize(vec3(c, R) - vec3(p, 0.0));
    if (type == 2) {
      float d = length(p - c) / R;
      shape = 1.0 / (1.0 + d * d);
    } else {
      float a = radians(angle);
      vec2 q = mat2(cos(a), -sin(a), sin(a), cos(a)) * (p - c);
      float d = length(q / vec2(R, r));
      float inner = clamp(focus / 100.0, -0.98, 0.98) * 0.5 + 0.5;
      shape = 1.0 - smoothstep(inner, 1.0, d);
    }
  }
  float ndl = max(dot(n, L), 0.0);
  diff += color * amount * shape * ndl;
  float gloss = u_surfaceGloss / 100.0;
  if (gloss > 0.0) {
    vec3 h = normalize(L + vec3(0.0, 0.0, 1.0));
    vec3 sc = mix(color, base, u_surfaceMaterial / 200.0 + 0.5);
    spec += sc * amount * shape * gloss * pow(max(dot(n, h), 0.0), 24.0);
  }
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 base = pacg_straight(src);
  vec2 p = fx_layerPx();
  vec3 n = vec3(0.0, 0.0, 1.0);
  if (u_bumpLayer_size.x > 0.0) {
    vec2 ln = fx_layerNorm();
    vec2 e = 1.5 / u_bumpLayer_size;
    float k = u_bumpHeight * 3.0;
    float dx = (bumpAt(ln + vec2(e.x, 0.0)) - bumpAt(ln - vec2(e.x, 0.0))) * k;
    float dy = (bumpAt(ln + vec2(0.0, e.y)) - bumpAt(ln - vec2(0.0, e.y))) * k;
    n = normalize(vec3(-dx, -dy, 1.0));
  }
  vec3 diff = u_ambienceLightColor.rgb * (u_ambienceIntensity / 100.0);
  vec3 spec = vec3(0.0);
  ${[1, 2, 3, 4, 5].map(lightCall).join('\n  ')}
  float gloss = u_surfaceGloss / 100.0;
  vec3 lit = base * diff * (gloss < 0.0 ? 1.0 + gloss * 0.5 : 1.0) + spec;
  lit *= exp2(u_exposure / 50.0);
  fragColor = fx_premultiply(vec4(clamp(lit, 0.0, 1.0), src.a));
}`,
			},
		],
	},
});

/** ProcAmp: a broadcast processing amplifier (brightness, contrast, hue, saturation), with a split-screen preview. */
export const PROC_AMP = defineShaderEffect({
	id: 'jasper.proc-amp',
	label: 'ProcAmp',
	category: 'Adjust',
	description:
		'Broadcast-style processing amplifier: brightness, contrast, hue and saturation, with a split view.',
	keywords: ['brightness', 'contrast', 'hue', 'saturation', 'proc amp'],
	params: [
		slider('brightness', 'Brightness', 0, -100, 100, { step: 0.1 }),
		slider('contrast', 'Contrast', 100, 0, 200, { step: 0.1 }),
		fxParam.angle('hue', 'Hue', 0),
		slider('saturation', 'Saturation', 100, 0, 200, { step: 0.1 }),
		fxParam.toggle('splitScreen', 'Split Screen', false),
		fxParam.percent('splitPercent', 'Split Percent', 50),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_splitScreen && fx_layerNorm().x > u_splitPercent / 100.0) { fragColor = src; return; }
  vec3 c = pacg_straight(src);
  vec3 yiq = pacg_rgb2yiq(c);
  yiq.x = (yiq.x - 0.5) * (u_contrast / 100.0) + 0.5 + u_brightness / 255.0;
  float a = radians(u_hue);
  yiq.yz = mat2(cos(a), -sin(a), sin(a), cos(a)) * yiq.yz * (u_saturation / 100.0);
  fragColor = fx_premultiply(vec4(pacg_clamp01(pacg_yiq2rgb(yiq)), src.a));
}`,
			},
		],
	},
});

export const ADJUST_EFFECTS: readonly EffectSpec[] = [
	AUTO_COLOR,
	AUTO_CONTRAST,
	AUTO_LEVELS,
	CONVOLUTION_KERNEL,
	EXTRACT,
	LEVELS,
	LIGHTING_EFFECTS,
	PROC_AMP,
];
