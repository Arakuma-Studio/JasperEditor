// Family-private conventions of the Sapphire Glows + Lighting family: Sapphire units, the shared "tail" params of
// Sapphire's light effects (Show, Combine, Edge Mode, Affect Alpha, … From Alpha, … Under Source, Light Background,
// Source Opacity, Bg Brightness), the Atmosphere set, and the GLSL that finishes a light effect with them.
//
// Units. Sapphire sizes and widths are relative to the frame: a width of 1 = 1/10 of the frame (layer) width
// (`SAPPHIRE_UNIT`), so a look is resolution independent (Glow Width 0.4 on 1920 px ≈ a 77 px glow sigma). Sapphire
// screen points ([0 0] = frame centre, y up, in frame widths) become fx `point` params normalised to the layer box
// ([0,0] top-left, y down) with `sapphirePoint`, assuming a 16:9 frame for the defaults.
import type { ParamSpec } from '../../effects.ts';
import type { Vec2 } from '../../../schema/common.ts';
import { fxParam } from '../params.ts';
import type { GlslChunk } from '../shader.ts';
import { GLSL_NOISE } from '../glsl/noise.ts';

/** Layer pixels per Sapphire width unit, for a layer of `width` px. */
export const SAPPHIRE_UNIT = 0.1;
export const unitPx = (width: number) => SAPPHIRE_UNIT * width;

/** A Sapphire screen point (centre origin, y up, frame widths) → layer-normalised point (16:9 frame). */
export function sapphirePoint(x: number, y: number, aspect = 16 / 9): Vec2 {
	return [round(0.5 + x), round(0.5 - y * aspect)];
}
const round = (x: number) => Math.round(x * 1e4) / 1e4;

/** A slider with Sapphire's open ranges ("≥ 0"): soft max for the UI, no hard max. */
export function slider(
	name: string,
	label: string,
	def: number,
	range: { min?: number; max?: number; softMin?: number; softMax?: number; step?: number } = {},
	extra: { group?: string; animatable?: boolean } = {},
): ParamSpec {
	return fxParam.number(
		name,
		label,
		def,
		{ min: 0, softMax: Math.max(1, def * 4), step: 0.001, ...range },
		extra,
	);
}

/** Sapphire "Show" popup (`u_show`: 0 = Result, 1 = the effect's diagnostic view, …). */
export function showChoice(options: readonly string[] = ['Result', 'Threshold']): ParamSpec {
	const values = options.map((o) => o.toLowerCase().replace(/[^a-z0-9]+/g, ''));
	return fxParam.choice('show', 'Show', values, options, values[0]!);
}

export const COMBINE_GLOW = ['Mult', 'Add', 'Screen', 'Difference', 'Overlay'] as const;

/** Sapphire "Combine" popup over a subset of `SGL_COMBINE` modes (`u_combine` → `sgl_combineMode`). */
export function combineChoice(labels: readonly string[], def: string): ParamSpec {
	const values = labels.map((o) => o.toLowerCase().replace(/[^a-z0-9]+/g, ''));
	return fxParam.choice('combine', 'Combine', values, labels, values[labels.indexOf(def)]!);
}

/** GLSL index of each Combine label (see `sgl_combine`). */
export const SGL_COMBINE: Record<string, number> = {
	Mult: 0,
	Add: 1,
	Screen: 2,
	Difference: 3,
	Overlay: 4,
	'Flare Only': 5,
	'Leaks Only': 5,
	'Lights Only': 5,
	'Flashes Only': 5,
	'Rays Only': 5,
};

/** SGL_COMBINE index of a Combine popup value (`{int}` uniform `u_mode`). */
export function combineMode(value: unknown, labels: readonly string[], def: string): { int: number } {
	const values = labels.map((o) => o.toLowerCase().replace(/[^a-z0-9]+/g, ''));
	const i = values.indexOf(String(value));
	return { int: SGL_COMBINE[labels[i < 0 ? labels.indexOf(def) : i]!] ?? 2 };
}

/** The tail of Sapphire's light effects, in Sapphire order. `what` = 'Glow', 'Rays', 'Glint'… */
export function lightTail(
	what: string,
	o: {
		affectAlpha?: boolean;
		fromAlpha?: boolean;
		under?: boolean;
		lightBackground?: boolean;
		opacity?: boolean;
	} = {},
): ParamSpec[] {
	const out: ParamSpec[] = [];
	if (o.affectAlpha !== false) out.push(slider('affectAlpha', 'Affect Alpha', 1, { softMax: 2 }));
	if (o.fromAlpha !== false)
		out.push(slider('fromAlpha', `${what} From Alpha`, 0, { max: 1, softMax: 1 }));
	if (o.under !== false) out.push(slider('underSource', `${what} Under Source`, 0, { max: 1, softMax: 1 }));
	if (o.lightBackground) out.push(slider('lightBackground', 'Light Background', 0, { max: 1, softMax: 1 }));
	if (o.opacity !== false) {
		out.push(slider('sourceOpacity', 'Source Opacity', 1, { max: 1, softMax: 1 }));
		out.push(slider('bgBrightness', 'Bg Brightness', 1, { softMax: 2 }));
	}
	return out;
}

/** Sapphire "Edge Mode" for glows: Reflect (default, glow clipped to the frame like Sapphire without Expand
 * Borders) or Transparent (the glow spills outside the layer box). `u_edgeMode` 0 = Transparent, 1 = Reflect. */
export function glowEdgeMode(): ParamSpec {
	return fxParam.choice('edgeMode', 'Edge Mode', ['transparent', 'reflect'], ['Transparent', 'Reflect'], 'reflect');
}

/** Sapphire's Atmosphere set (dusty air modulating the light). */
export function atmosphereParams(def: { amp?: number; freq?: number; detail?: number } = {}): ParamSpec[] {
	return [
		slider('atmosphereAmp', 'Atmosphere Amp', def.amp ?? 0, { softMax: 2 }),
		slider('atmosphereFreq', 'Atmosphere Freq', def.freq ?? 1, { min: 0.1, max: 20, softMax: 20 }),
		slider('atmosphereDetail', 'Atmosphere Detail', def.detail ?? 0.6, { max: 1, softMax: 1 }),
		slider('atmosphereSeed', 'Atmosphere Seed', 0.123, { softMax: 1 }),
		slider('atmosphereSpeed', 'Atmosphere Speed', 1, { min: -10, softMin: -2, softMax: 2 }),
	];
}

export const GLSL_SGL_FINISH: GlslChunk = {
	name: 'sgl/finish',
	deps: [GLSL_NOISE],
	source: /* glsl */ `
float sgl_maxc(vec3 c) { return max(c.r, max(c.g, c.b)); }
// Sapphire threshold: per channel, values above thr (+ the Threshold Add Color) remapped to 0..1 (white stays white).
vec3 sgl_threshold(vec3 c, float thr, vec3 addColor) {
  vec3 t = clamp(vec3(thr) + addColor, 0.0, 0.999);
  return max(c - t, 0.0) / (1.0 - t);
}
// Combine light (straight, may exceed 1) with a premultiplied base. mode = SGL_COMBINE index:
// 0 Mult, 1 Add, 2 Screen, 3 Difference, 4 Overlay, 5 light only.
vec3 sgl_combineRgb(int mode, vec3 b, vec3 g) {
  if (mode == 0) return b * g;
  if (mode == 1) return b + g;
  if (mode == 3) return abs(b - g);
  if (mode == 4) {
    vec3 gc = min(g, vec3(1.0));
    return mix(2.0 * b * gc, 1.0 - 2.0 * (1.0 - b) * (1.0 - gc), step(0.5, b)) + max(g - 1.0, 0.0);
  }
  if (mode == 5) return g;
  return b + g - b * min(g, vec3(1.0));
}
// The tail of a light effect: base = source × Source Opacity × Bg Brightness; light combined with it; Affect Alpha
// grows alpha with the light; Under Source puts the source back over the light; Light Background lights the base
// multiplicatively. Returns premultiplied RGBA (rgb ≤ a ≤ 1).
vec4 sgl_finishLight(vec4 src, vec3 light, int mode, float affectAlpha, float under, float lightBg,
                     float srcOpacity, float bgBright) {
  vec4 base = src * clamp(srcOpacity, 0.0, 1.0);
  base.rgb *= bgBright;
  if (mode == 5) base = vec4(0.0);
  vec3 rgb = sgl_combineRgb(mode, base.rgb, light);
  float a = max(base.a, clamp(sgl_maxc(light) * affectAlpha, 0.0, 1.0));
  if (mode == 0) a = base.a;
  vec4 res = vec4(rgb, a);
  if (under > 0.0) {
    vec4 l = vec4(light, clamp(sgl_maxc(light) * affectAlpha, 0.0, 1.0));
    vec4 over = src + vec4(sgl_combineRgb(mode == 5 ? 5 : 1, vec3(0.0), l.rgb), l.a) * (1.0 - src.a);
    res = mix(res, over, clamp(under, 0.0, 1.0));
  }
  if (lightBg > 0.0) res.rgb = mix(res.rgb, base.rgb * (1.0 + light), clamp(lightBg, 0.0, 1.0));
  res.rgb = clamp(res.rgb, 0.0, 1.0);
  res.a = clamp(max(res.a, sgl_maxc(res.rgb)), 0.0, 1.0);
  return res;
}
// Atmosphere: dusty-air noise factor (≥ 0) at layer-normalised point n (aspect-corrected by ar = h / w).
float sgl_atmosphere(vec2 n, float ar, float amp, float freq, float detail, float seed, float t) {
  if (amp <= 0.0) return 1.0;
  int oct = 1 + int(detail * 6.0);
  float v = fx_fbm3(vec3(n.x * freq * 4.0, n.y * ar * freq * 4.0, t * 0.25), oct, 2.0, 0.5 + 0.2 * detail, fract(seed));
  return max(0.0, 1.0 + amp * v * 1.5);
}
// Reflect edge mode: the layer-normalised point mirrored into the box.
vec2 sgl_mirrorNorm(vec2 n) { vec2 m = mod(n, 2.0); return mix(m, 2.0 - m, step(1.0, m)); }
`,
};
