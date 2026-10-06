// Shared pieces of the Sapphire-style wipes (family "sapphire-wipes-other", wipes only): the param builders that
// mirror Sapphire's wipe controls (Edge Softness, the Border / Border Glow block, Grad Add / Grad Angle, pattern
// Frequency / Rel Width / Shift, Seed), the GLSL helpers every wipe uses, and `sapphireWipe`, which builds one entry
// (bin Sapphire Transitions ▸ Wipes) around a single-pass shader.
//
// How a Sapphire wipe is drawn here. Every wipe computes a signed distance `d` in sequence px from its transition
// edge (d > 0 = the incoming clip B) and hands it to `sw_composite`, which mixes A and B over the Edge Softness,
// draws Sapphire's border (a band of Border Width centred on the edge, moved by Border Shift towards B, feathered by
// Border Softness, Border Opacity) and its Border Glow (a light along the border with per-channel widths — Sapphire's
// Width Red / Green / Blue give the chromatic fringe — modulated by an animated noise: Noise Amp / Freq / Speed).
// - Geometric wipes (line, clock) compute `d` analytically.
// - Shape wipes (circle, rectangle, star, wedges) define a gauge `sw_gauge(px)` (0 at the shape centre, growing
//   outwards, homogeneous like a distance); the gauge over the whole frame is sampled along the frame border
//   (`sw_gaugeCover`), so the shape starts from nothing and ends covering the frame exactly.
// - Pattern wipes (cells, dots, checkers, tiles, stripes, rings, blobs, flux, plasma, weave, moire) compute a
//   threshold field v (0..1: the order in which pixels switch), add Sapphire's Grad Add · position along Grad Angle,
//   and `sw_fieldWipe` turns "v below the moving threshold" into a px distance through the screen-space gradient of
//   v (so softness, borders and glows have the same px widths on every pattern).
// The distance is pushed out by `u_swMargin` px (from the params, `wipeMargin`) at both ends so the soft edge, the
// border and the glow have left the frame at progress 0 and 1; `sw_composite` returns A / B exactly at 0 / 1.
//
// Sapphire controls without an equivalent here: Transition Dir (= Reverse), Auto Trans / Wipe Percent (= the
// transition's own progress with Start / End), Opacity (sides are premultiplied pictures), the on-screen widget
// toggles (Show Wipe / Show Center / …) and Crop.
import type { Vec2 } from '../../../schema/common.ts';
import type { TransitionSpec } from '../../../transitions.ts';
import type { EffectParams, ParamSpec } from '../../effects.ts';
import { GLSL_NOISE } from '../../fx/glsl/noise.ts';
import { GLSL_UV } from '../../fx/glsl/sample.ts';
import { fxParam, seedParam } from '../../fx/params.ts';
import type { FxUniformValue, GlslChunk } from '../../fx/shader.ts';
import { defineShaderTransition, SAPPHIRE_TRANSITION_SUBBINS, TRANSITION_BINS, trParam } from '../define.ts';
import { GLSL_TR_WIPE } from '../glsl.ts';
import type { TrFrameContext } from '../shader.ts';

export const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ---------------------------------------------------------------- params

/** Sapphire's default border colour (a dark red). */
export const SAPPHIRE_BORDER_COLOR: [number, number, number, number] = [0.75, 0, 0, 1];

export const swParam = {
	/** Edge Softness (px): width of the soft transition edge. */
	edgeSoftness(def = 0): ParamSpec {
		return fxParam.pixels('edgeSoftness', 'Edge Softness', def, 200);
	},
	/** Edge Width (fraction of the frame along the wipe direction) of the band-type wipes (Bubble, Diffuse, …). */
	edgeWidth(def: number, min = 0.0138): ParamSpec {
		return fxParam.number('edgeWidth', 'Edge Width', def, { min, max: 20, softMax: 4, step: 0.01 });
	},
	/** A Sapphire In / Out (Grow / Shrink) popup. */
	choice(name: string, label: string, values: readonly string[], labels: readonly string[], def?: string) {
		return fxParam.choice(name, label, values, labels, def ?? values[0]!);
	},
	angle(name = 'angle', label = 'Angle', def = 0): ParamSpec {
		return fxParam.angle(name, label, def);
	},
	/** Pattern frequency: pattern elements across the frame width. */
	frequency(def: number, min = 0.1, name = 'frequency', label = 'Frequency'): ParamSpec {
		return fxParam.number(name, label, def, { min, max: 500, softMax: 50, step: 0.01 });
	},
	/** A relative size / frequency factor (Rel Width, Freq Rel X, Rel Wid Pre Rot, …). */
	rel(name: string, label: string, def = 1, min = 0.1): ParamSpec {
		return fxParam.number(name, label, def, { min, max: 100, softMax: 5, step: 0.01 });
	},
	/** Pattern translation in pattern units (1 = one element). */
	shift(name = 'shift', label = 'Shift', def: Vec2 = [0, 0]): ParamSpec {
		return fxParam.vec2(name, label, def, { softMin: -10, softMax: 10, step: 0.01 });
	},
	octaves(def: number): ParamSpec {
		return fxParam.number('octaves', 'Octaves', def, { min: 1, max: 10, step: 1 }, { animatable: false });
	},
	/** Grad Add: adds a gradient to the switching order so the pattern also travels across the frame. */
	gradAdd(def = 0): ParamSpec {
		return fxParam.number('gradAdd', 'Grad Add', def, { min: -10, max: 10, step: 0.01 });
	},
	/** Grad Angle: direction of the Grad Add gradient (0° = left to right, clockwise). */
	gradAngle(def = 0): ParamSpec {
		return fxParam.angle('gradAngle', 'Grad Angle', def);
	},
	seed(): ParamSpec {
		return seedParam();
	},
	/** Wrap (X & Y) of the warping wipes: how pixels beyond the frame edge are fetched. */
	wrap(def: 'none' | 'tile' | 'reflect' = 'reflect'): ParamSpec {
		return fxParam.choice('wrap', 'Wrap', ['none', 'tile', 'reflect'], ['No', 'Tile', 'Reflect'], def);
	},
	/** Sapphire's border + border glow block (in Sapphire's order and defaults; widths in px). */
	border(): ParamSpec[] {
		const factor = (name: string, label: string, def: number) =>
			fxParam.number(name, label, def, { min: 0, max: 20, softMax: 4, step: 0.01 });
		return [
			trParam.borderWidth(0),
			trParam.borderColor(SAPPHIRE_BORDER_COLOR),
			fxParam.number(
				'borderOpacity',
				'Border Opacity',
				1,
				{ min: 0, max: 1, step: 0.01 },
				{ ui: { control: 'slider' } },
			),
			fxParam.pixels('borderSoftness', 'Border Softness', 0, 100),
			fxParam.number(
				'borderShift',
				'Border Shift',
				0,
				{ softMin: -100, softMax: 100, step: 0.1 },
				{ unit: 'px' },
			),
			fxParam.number('borderGlow', 'Border Glow', 0, { min: 0, max: 20, softMax: 4, step: 0.01 }),
			fxParam.pixels('glowWidth', 'Glow Width', 40, 400),
			factor('widthRed', 'Width Red', 1),
			factor('widthGreen', 'Width Green', 1.2),
			factor('widthBlue', 'Width Blue', 1.4),
			fxParam.color('glowColor', 'Glow Color', [1, 1, 1, 1]),
			fxParam.number('noiseAmp', 'Noise Amp', 1, { min: 0, max: 10, softMax: 3, step: 0.01 }),
			fxParam.number('noiseFreq', 'Noise Freq', 16, { min: 0.1, max: 200, softMax: 20, step: 0.1 }),
			fxParam.number('noiseSpeed', 'Noise Speed', 2, { softMin: -10, softMax: 10, step: 0.01 }),
		];
	},
};

/**
 * How far (px) the edge must travel beyond the frame at both ends so that nothing of the soft edge, the border or the
 * glow is left at progress 0 / 1 (`u_swMargin`). Pure; mirrors `sw_composite`.
 */
export function wipeMargin(p: EffectParams): number {
	const soft = Math.max(num(p.edgeSoftness), 1) / 2;
	const bw = Math.max(0, num(p.borderWidth));
	const shift = Math.abs(num(p.borderShift));
	const border = bw > 0 ? shift + bw / 2 + Math.max(num(p.borderSoftness), 1) / 2 : 0;
	const widest = Math.max(num(p.widthRed, 1), num(p.widthGreen, 1.2), num(p.widthBlue, 1.4), 0);
	const glow = num(p.borderGlow) > 0 ? shift + bw / 2 + 3 * Math.max(num(p.glowWidth, 40) * widest, 0.5) : 0;
	return soft + Math.max(border, glow) + 1;
}

// ---------------------------------------------------------------- GLSL

/** Field / pattern helpers (no param uniforms). */
export const GLSL_SW_CORE: GlslChunk = {
	name: 'sapphire-wipes/core',
	deps: [GLSL_TR_WIPE, GLSL_UV],
	source: /* glsl */ `
// Signed px distance (> 0 = B) of a wipe driven by a field v that runs from lo to hi over the frame: B where v is
// below the threshold moving from lo (progress 0) to hi (progress 1). The px distance comes from the screen-space
// gradient of v; margin (px) pushes the edge out of the frame at both ends. Call in uniform control flow (dFdx).
float sw_fieldWipe(float v, float lo, float hi, float margin) {
  float p = tr_progress();
  float g = length(vec2(dFdx(v), dFdy(v)));
  return (mix(lo, hi, p) - v) / max(g, 1e-7) + (2.0 * p - 1.0) * margin;
}
// Position (0..1) of px along a direction (deg, 0° = left to right, clockwise) across the frame.
float sw_gradPos(vec2 px, float deg) {
  vec2 d = fx_dir(deg);
  float ext = abs(d.x) * u_compSize.x + abs(d.y) * u_compSize.y;
  return dot(px - 0.5 * u_compSize, d) / max(ext, 1.0) + 0.5;
}
// A 0..1 pattern field with Sapphire's Grad Add / Grad Angle: (v, lo, hi) for sw_fieldWipe.
vec3 sw_grad(float v01, float gradAdd, float gradAngle) {
  return vec3(v01 + gradAdd * sw_gradPos(tr_px(), gradAngle), min(0.0, gradAdd), 1.0 + max(0.0, gradAdd));
}
// Pattern coordinates: centred on the frame, freq units across the frame width, minus shift (pattern units),
// x / relW (on screen), rotated by angle (deg, clockwise), then x / relPre (along the rotated axis).
vec2 sw_patternUv(vec2 px, float freq, float relW, float angle, float relPre, vec2 shift) {
  vec2 q = (px - 0.5 * u_compSize) / max(u_compSize.x, 1.0) * freq - shift;
  q.x /= max(relW, 1e-3);
  q = fx_rot(-fx_deg(angle)) * q;
  q.x /= max(relPre, 1e-3);
  return q;
}
// Noise (≈ −1..1) → 0..1 with a contrast (spreads the switching times of fbm noise over the transition).
float sw_noise01(float n, float contrast) { return clamp(0.5 + 0.5 * n * contrast, 0.0, 1.0); }
// Grow / Shrink order of shapes growing from their centres (v: 0 at the centre, 1 on the outline, like a radius):
// squared so the revealed area grows about linearly with progress; Shrink grows B from the outlines inwards.
float sw_growShrink(float v, bool shrink) { float a = v * v; return shrink ? 1.0 - a : a; }
// Triangle wave: 0 at the middle of each unit stripe, 1 at its boundaries.
float sw_tri(float x) { return abs(2.0 * fract(x) - 1.0); }
`,
};

/** `sw_composite` — reads Edge Softness and the border / glow params (`swParam.border()`). */
export const GLSL_SW_BORDER: GlslChunk = {
	name: 'sapphire-wipes/border',
	deps: [GLSL_SW_CORE, GLSL_NOISE],
	source: /* glsl */ `
// The Sapphire wipe composite of A and B split by an edge at signed px distance d (> 0 = B side).
vec4 sw_composite(vec4 a, vec4 b, float d) {
  float p = tr_progress();
  if (p <= 0.0) return a;
  if (p >= 1.0) return b;
  vec4 res = mix(a, b, tr_edge(d, u_edgeSoftness, 1.0));
  float e = d - u_borderShift;
  float hw = 0.5 * max(u_borderWidth, 0.0);
  if (u_borderWidth > 0.0) {
    float bs = 0.5 * max(u_borderSoftness, 1.0);
    float cov = clamp(smoothstep(-hw - bs, -hw + bs, e) - smoothstep(hw - bs, hw + bs, e), 0.0, 1.0);
    vec4 bc = tr_premul(vec4(u_borderColor.rgb, clamp(u_borderColor.a * u_borderOpacity, 0.0, 1.0)));
    res = bc * cov + res * (1.0 - cov * bc.a);
  }
  if (u_borderGlow > 0.0) {
    float x = max(abs(e) - hw, 0.0);
    vec3 w = max(u_glowWidth * vec3(u_widthRed, u_widthGreen, u_widthBlue), vec3(0.5));
    vec3 g = exp(-(x * x) / (w * w));
    float n = fx_simplex3(vec3(tr_px() / max(u_compSize.y, 1.0) * u_noiseFreq, u_time * u_noiseSpeed), u_seed);
    vec3 light = g * (u_borderGlow * max(0.0, 1.0 + u_noiseAmp * n)) * u_glowColor.rgb * u_glowColor.a;
    float al = clamp(max(res.a, max(light.r, max(light.g, light.b))), 0.0, 1.0);
    res = vec4(min(res.rgb + light, vec3(al)), al);
  }
  return res;
}
`,
};

/**
 * Shape wipes: the pass defines `float sw_gauge(vec2 px)` (0 at the shape centre, growing outwards like a distance);
 * `sw_shapeWipe(grow)` is the px distance of the shape growing from nothing to the whole frame (`grow`: B inside the
 * shape) or shrinking from the whole frame to nothing (B outside).
 */
export const GLSL_SW_SHAPE: GlslChunk = {
	name: 'sapphire-wipes/shape',
	deps: [GLSL_SW_CORE],
	source: /* glsl */ `
float sw_gauge(vec2 px);
// The largest gauge over the frame (every shape gauge peaks on the frame border), + 2 % for the sampling.
float sw_gaugeCover() {
  vec2 s = u_compSize;
  float m = 0.0;
  for (int i = 0; i <= 48; i++) {
    float t = float(i) / 48.0;
    m = max(m, max(max(sw_gauge(vec2(t * s.x, 0.0)), sw_gauge(vec2(t * s.x, s.y))),
                   max(sw_gauge(vec2(0.0, t * s.y)), sw_gauge(vec2(s.x, t * s.y)))));
  }
  return m * 1.02 + 1e-3;
}
float sw_shapeWipe(bool grow, float margin) {
  float v = sw_gauge(tr_px()) / sw_gaugeCover();
  return sw_fieldWipe(grow ? v : 1.0 - v, 0.0, 1.0, margin);
}
`,
};

// ---------------------------------------------------------------- builder

export type SapphireWipeInit = {
	/** Kebab name: id `jasper.s.<name>`. */
	name: string;
	/** Sapphire's name, e.g. `S_WipeCircle`. */
	label: string;
	description: string;
	keywords?: readonly string[];
	params: readonly ParamSpec[];
	/** Sapphire's Border / Border Glow block (default true): appended after `params`, `u_swMargin` provided. */
	border?: boolean;
	/** A Center point (framework option, `u_center`, normalised to the frame). */
	center?: boolean | Vec2;
	/** Extra derived uniforms. */
	uniforms?(p: EffectParams, ctx: TrFrameContext): Record<string, FxUniformValue>;
	include?: readonly GlslChunk[];
	frag: string;
};

/** One Sapphire wipe entry (Sapphire Transitions ▸ Wipes), a single full-resolution pass. */
export function sapphireWipe(init: SapphireWipeInit): TransitionSpec {
	const border = init.border !== false;
	return defineShaderTransition({
		id: `jasper.s.${init.name}`,
		label: init.label,
		bin: TRANSITION_BINS.sapphire,
		subBin: SAPPHIRE_TRANSITION_SUBBINS.wipes,
		description: init.description,
		keywords: ['sapphire', 'wipe', ...(init.keywords ?? [])],
		params: [...init.params, ...(border ? swParam.border() : [])],
		...(init.center ? { options: { center: init.center } } : {}),
		gpu: {
			uniforms: (p, ctx) => ({ u_swMargin: wipeMargin(p), ...(init.uniforms?.(p, ctx) ?? {}) }),
			passes: [
				{
					include: [GLSL_SW_CORE, ...(border ? [GLSL_SW_BORDER] : []), ...(init.include ?? [])],
					frag: init.frag,
				},
			],
		},
	});
}
