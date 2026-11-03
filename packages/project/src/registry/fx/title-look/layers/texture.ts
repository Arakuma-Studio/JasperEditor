// `texture` (§5.1): noise, grain, a motif or dry-brush erosion over everything below it in the stack. Sizes are in the look's
// unit and anchored to the layer box, so a texture stays on the title and has the same grain at every resolution (TL-034):
// where a grain is finer than a pixel its contrast falls with its share of the pixel, as if the pixel averaged it, instead of
// sampling at render pixels.
//
// Dry-brush erosion is Pachislop's dry-brush keep-mask on the look's shape field: bristle lanes run along the drag, dry ones
// lose ink over a random length measured along the drag from the silhouette (a third as much where the brush lands), split
// off stray bristles at side edges and catch ink again in dashes. It takes ink away, so it cuts the composite in a prepass;
// what is above the layer in the stack keeps its ink.
import { GLSL_NOISE } from '../../glsl/noise.ts';
import {
	GLSL_TL_PATTERN_BASE,
	TL_PATTERN_KINDS,
	TL_PATTERN_LABELS,
	tlPatternProgram,
} from '../../glsl/title-pattern.ts';
import { fmtDistance, fmtNumber, lp, type TitleLayerInit } from '../contract.ts';
import { MOTIF_GLSL } from '../finishes/pattern.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const TEXTURE_KINDS = ['noise', 'grain', 'pattern', 'erosion'] as const;

/** A value 0..1 around 0.5 over what is below, in the signal, as an amount of `blend`. */
const BLEND = /* glsl */ `
vec3 tl_texBlend(vec3 b, float v) {
  if (u_blend == 1) return (1.0 - 2.0 * v) * b * b + 2.0 * v * b;
  if (u_blend == 2) { float s = 2.0 * max(v - 0.5, 0.0); return 1.0 - (1.0 - b) * (1.0 - s); }
  if (u_blend == 3) { float m = 1.0 - 2.0 * max(0.5 - v, 0.0); return b * m; }
  return mix(2.0 * b * v, 1.0 - 2.0 * (1.0 - b) * (1.0 - v), step(0.5, b));
}
vec4 tl_texOver(vec4 under, float v, float amount) {
  vec3 o = under.rgb / under.a;
  vec3 b = fx_linearToSrgb(clamp(o, 0.0, 1.0));
  vec3 r = mix(b, clamp(tl_texBlend(b, v), 0.0, 1.0), amount);
  return vec4((tl_linear(r) - clamp(o, 0.0, 1.0)) * under.a, 0.0);
}
vec2 tl_texCoord(TlSurface s, float px) {
  float a = radians(u_angle), c = cos(a), n = sin(a);
  vec2 q = (s.px - u_box.xy) / max(px, 1.0e-3);
  return vec2(c * q.x + n * q.y, -n * q.x + c * q.y);
}
float tl_texSeed() { return fract(u_tlSeed + u_noiseSeed * 0.0137); }
// Frames of boil: a new pattern this many times a second, a closed form of the content time.
float tl_texFrame() { return u_boil > 0.0 ? floor(u_tlTime * u_boil) : 0.0; }
`;

const GLSL_OF: Record<string, string> = {
	noise: /* glsl */ `
vec4 tl_layer(TlSurface s) {
  vec4 under = texture(u_tlComp, s.uv);
  if (under.a <= 0.0) return vec4(0.0);
  float px = tl_px(max(u_scale, 0.05));
  vec2 q = tl_texCoord(s, px);
  float n = 0.5 + 0.45 * fx_fbm(q + tl_texFrame() * 13.0, 4, 2.0, 0.5, tl_texSeed());
  return tl_texOver(under, clamp(n, 0.0, 1.0), u_amount * 0.01);
}`,
	grain: /* glsl */ `
vec4 tl_layer(TlSurface s) {
  vec4 under = texture(u_tlComp, s.uv);
  if (under.a <= 0.0) return vec4(0.0);
  float px = tl_px(max(u_scale, 0.05));
  vec2 q = tl_texCoord(s, px);
  float g = fx_valueNoise3(vec3(q, tl_texFrame()), tl_texSeed());
  // Below two pixels a cell is averaged by the pixel: the contrast falls as the mean of (cell / pixel)² cells would.
  float fine = clamp(px * 0.5, 0.0, 1.0);
  return tl_texOver(under, 0.5 + g * 0.5 * fine, u_amount * 0.01);
}`,
	pattern: /* glsl */ `
vec4 tl_layer(TlSurface s) {
  vec4 under = texture(u_tlComp, s.uv);
  if (under.a <= 0.0) return vec4(0.0);
  float scale = tl_px(max(u_scale, 0.1));
  float a = radians(u_angle);
  vec2 p = tl_motifAt(s.px, scale, a);
  vec4 m = tlp_sample(p, tl_motifAt(s.px + vec2(1.0, 0.0), scale, a) - p, tl_motifAt(s.px + vec2(0.0, 1.0), scale, a) - p, tl_texSeed());
  float op = u_amount * 0.01;
  vec4 ink = tlPaint_paint(s), alt = tlPaint_paintAlt(s);
  vec3 o = under.rgb / under.a;
  vec3 c = mix(o, ink.a > 0.0 ? ink.rgb / ink.a : o, m.x * op * ink.a);
  c = mix(c, alt.a > 0.0 ? alt.rgb / alt.a : c, m.y * op * alt.a);
  return vec4((c - o) * under.a, 0.0);
}`,
	erosion: /* glsl */ `
vec4 tl_layer(TlSurface s) { return vec4(0.0); }`,
};

const ERODE = /* glsl */ `
// Distance from p along dir to the silhouette, capped at maxD: the field says how far is safe to step.
float tl_exit(vec2 p, vec2 dir, float outer, float maxD) {
  float t = 0.0;
  for (int i = 0; i < 24; i++) {
    float room = outer - texture(u_tlField, (p + dir * t) / u_canvasSize).x;
    if (room <= 0.0) return t;
    t += max(room, maxD / 48.0);
    if (t >= maxD) return maxD;
  }
  return min(t, maxD);
}
float tl_v(vec2 p, float seed) { return 0.5 + 0.5 * fx_valueNoise(p, seed); }
// Brush state at canvas px p: x lane dryness (0 inked, 1 driest), y ink lost from the silhouette along the drag (px), z skip.
vec3 tl_brush(vec2 p, vec2 dir, float lanePx, float lenPx, float amount, float seed) {
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 q = p - u_box.xy;
  float lane = dot(q, perp) / lanePx;
  float along = dot(q, dir) / lenPx;
  float dry = 0.55 * tl_v(vec2(lane, along * 0.15), seed)
    + 0.3 * tl_v(vec2(lane * 0.21, 3.7 + along * 0.1), seed)
    + 0.15 * tl_v(vec2(lane * 2.7, along * 0.8), seed);
  float x = clamp((amount - dry) / max(amount, 1.0e-3), 0.0, 1.0);
  float gap = lenPx * x * (0.45 + 0.8 * tl_v(vec2(lane * 0.37 + 11.0, along * 1.7), seed));
  return vec3(x, gap, tl_v(vec2(lane * 0.9 + 5.0, along * 4.0), seed));
}
// Cut where e crosses 0, antialiased over its own slope.
float tl_cut(float e) { float w = max(fwidth(e) * 0.7, 1.0e-3); return smoothstep(-w, w, e); }
void main() {
  TlSurface s = tl_surface();
  vec4 under = texture(u_tlComp, s.uv);
  float amount = clamp(u_amount * 0.01, 0.0, 1.0);
  float outer = tl_px(u_tlpOuter);
  float edge = max(tl_px(u_edge), 1.0);
  float lenPx = max(tl_px(u_length), 1.0);
  float depth = outer - s.d;
  vec2 dir = fx_dir(u_angle);
  vec3 b = tl_brush(s.px, dir, max(tl_px(u_scale), 0.5), lenPx, amount, fract(u_tlSeed + u_noiseSeed * 0.0137));
  float maxD = min(lenPx * 1.3, edge * 3.0);
  float forward = tl_exit(s.px, dir, outer, maxD);
  float back = tl_exit(s.px, -dir, outer, maxD);
  float eat = max(tl_cut(b.y - forward), tl_cut(b.y * 0.35 - back));
  // Stray bristles along side edges.
  eat = max(eat, tl_cut(b.x * b.x * edge * 0.3 - depth));
  // Dry lanes skip: ink catches again in dashes along the drag, so gaps are broken streaks.
  eat *= mix(1.0, smoothstep(0.2, 0.45, b.z), 0.45 * (1.0 - b.x));
  eat *= 1.0 - smoothstep(edge * 0.55, edge, depth);
  fragColor = under * (1.0 - (b.x > 0.0 ? eat : 0.0));
}`;

const shaderOf = (p: Record<string, unknown>) => {
	const kind = String(p.kind);
	const body = GLSL_OF[kind] ?? GLSL_OF.noise!;
	if (kind === 'pattern') return `${BLEND}${tlPatternProgram(p.motif, 'u_motifImage')}${MOTIF_GLSL}${body}`;
	return kind === 'erosion' ? body : `${BLEND}${body}`;
};

export const TEXTURE_LAYER: TitleLayerInit = {
	type: 'texture',
	label: 'Texture',
	description: 'Noise, grain, a motif or dry-brush erosion over what is below it.',
	finish: false,
	params: [
		lp.choice('kind', 'Kind', TEXTURE_KINDS, ['Noise', 'Grain', 'Pattern', 'Dry-Brush Erosion'], 'noise'),
		lp.distance('scale', 'Scale', 3, { softMax: 40 }),
		lp.percent('amount', 'Amount', 45),
		lp.number('noiseSeed', 'Seed', 0, { min: 0, max: 100000, softMax: 1000, step: 1 }),
		lp.angle('angle', 'Angle', 0),
		lp.choice(
			'blend',
			'Blend',
			['overlay', 'softLight', 'screen', 'multiply'],
			['Overlay', 'Soft Light', 'Screen', 'Multiply'],
			'overlay',
		),
		lp.number('boil', 'Boil', 0, { min: 0, max: 60, softMax: 24, step: 1 }, { unit: 'Hz' }),
		lp.choice('motif', 'Motif', TL_PATTERN_KINDS, TL_PATTERN_LABELS, 'dots'),
		lp.media('motifImage', 'Tile', ['image']),
		...lp.paint('paint', 'Marks', { kind: 'role', role: 'accent1' }),
		...lp.paint('paintAlt', 'Second Colour', { kind: 'role', role: 'accent2' }),
		lp.distance('length', 'Stroke Length', 45, { softMax: 150 }),
		lp.distance('edge', 'Edge Band', 18, { softMax: 60 }),
	],
	shader: (p) => ({
		glsl: shaderOf(p),
		include: [GLSL_NOISE, ...(p.kind === 'pattern' ? [GLSL_TL_PATTERN_BASE] : [])],
	}),
	prepass(p, ctx) {
		if (p.kind !== 'erosion') return [];
		return [
			{
				output: 'tlComp',
				update: true,
				format: 'rgba16f',
				include: [...ctx.include, GLSL_NOISE],
				uniforms: { ...ctx.uniforms, u_tlpOuter: ctx.outer },
				frag: `${ctx.defines}${ERODE}`,
			},
		];
	},
	fieldReach: (p) =>
		p.kind === 'erosion'
			? { inside: num(p.edge) * 3 + 2, outside: Math.min(num(p.length) * 1.3, num(p.edge) * 3) + 2 }
			: {},
	timeDependent: (p) => p.kind !== 'erosion' && num(p.boil) > 0,
	handles: [
		{ kind: 'distance', params: ['scale'], from: 'centre' },
		{ kind: 'angle', params: ['angle'] },
	],
	summary(p) {
		return {
			swatch: null,
			text: `${String(p.kind)}, ${fmtDistance(p.scale)}, ${fmtNumber(p.amount)} %`,
			primary: 'amount',
		};
	},
};
