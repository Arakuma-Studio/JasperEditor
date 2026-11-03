// Spec 19 §5.1: the relief every lit finish stands on. A finish's prepass turns the layer's own shape into a height field
// (`tlHeight`), as Pachislop's materialPass does from a vector mask's distance field: profile → optional Fit cover → blur.
// Ours starts from the look's shape field, so it works on any alpha, and every size is a percentage of the look's unit,
// including the blur that hides the field's creases: nothing is clamped in pixels (TL-034). Fit (to stroke width) measures
// each pixel's local half-thickness by flooding inscribed circles, so a thin stroke and a thick one both dome to their
// centre line; a ring knows its width and needs no flood. Port map: licenses/ported/pachislop-finishes.md.
import type { CurveValue } from '../../../schema/common.ts';
import { CurveValueSchema } from '../../../schema/common.ts';
import { type FxUniformValue, type GlslChunk, hashFloats, type ShaderPass } from '../shader.ts';
import type { PrepassContext, TitleParamSpec } from '../title-look/contract.ts';
import { GLSL_TL_SURFACE, tlBlurAxis } from '../title-look/glsl.ts';
import { GLSL_DATA } from './data.ts';

/** Option values of a bevel profile param, in the order of `tl_profile`. */
export const TL_PROFILES = ['round', 'chamfer', 'ridge', 'cove', 'custom'] as const;
export const TL_PROFILE_LABELS = ['Round', 'Chamfer', 'Ridge', 'Cove', 'Custom Curve'] as const;

/** Height at t in 0..1 from the edge: 0 at the edge, 1 on top. Formulas of Pachislop's HEIGHT_FRAG. */
const PROFILE = /* glsl */ `
float tl_profile(float t) {
  if (u_tlrProfile == 1) return t;
  if (u_tlrProfile == 2) return 1.0 - abs(2.0 * t - 1.0);
  if (u_tlrProfile == 3) return t * t;
  return sin(t * 1.5707963);
}`;

const CURVE_PROFILE = /* glsl */ `
float tl_profile(float t) { return tl_curveAt(u_tlrCurve, t); }`;

/** A 256-entry curve in a data texture, read with linear interpolation. */
export const GLSL_TL_CURVE: GlslChunk = {
	name: 'title-look/curve',
	deps: [GLSL_DATA],
	source: /* glsl */ `
float tl_curveAt(highp sampler2D lut, float x) {
  float f = clamp(x, 0.0, 1.0) * 255.0;
  int i = int(floor(f));
  return mix(fx_texel(lut, i).x, fx_texel(lut, min(i + 1, 255)).x, f - float(i));
}
`,
};

/** Colour helpers of finishes. */
export const GLSL_TL_SHADE: GlslChunk = {
	name: 'title-look/shade',
	deps: [GLSL_TL_SURFACE],
	source: /* glsl */ `
// A painted colour straight, for finishes that relight it; premultiply the result by the paint's alpha.
vec3 tl_straight(vec4 paint) { return paint.a > 0.0 ? paint.rgb / paint.a : vec3(0.0); }
vec3 tl_screen(vec3 b, vec3 s) { return 1.0 - (1.0 - clamp(b, 0.0, 1.0)) * (1.0 - clamp(s, 0.0, 1.0)); }
`,
};

/** Reads of the height field and what lit finishes share. Needs a finish prepass (`reliefPasses`). */
export const GLSL_TL_RELIEF: GlslChunk = {
	name: 'title-look/relief',
	deps: [GLSL_TL_SHADE],
	source: /* glsl */ `
float tl_height(vec2 uv) { return texture(u_tlHeight, uv).r; }
// The height's slope per canvas px, over one texel of the height field either way.
vec2 tl_heightSlope(vec2 uv) {
  vec2 e = 1.0 / vec2(textureSize(u_tlHeight, 0));
  vec2 g = vec2(tl_height(uv + vec2(e.x, 0.0)) - tl_height(uv - vec2(e.x, 0.0)),
                tl_height(uv + vec2(0.0, e.y)) - tl_height(uv - vec2(0.0, e.y)));
  return g * 0.5 / (e * u_canvasSize);
}
// Radians a mirrored ray turns per canvas px, for a height of k canvas px at height 1. From the slope field, which is smooth:
// fwidth is constant over each 2 × 2 quad, and a width that steps every two pixels draws stripes along a sharp reflection.
float tl_reliefFootprint(TlSurface s, float k) {
  vec2 e = 1.0 / u_canvasSize;
  vec2 dx = tl_heightSlope(s.uv + vec2(e.x, 0.0)) - tl_heightSlope(s.uv - vec2(e.x, 0.0));
  vec2 dy = tl_heightSlope(s.uv + vec2(0.0, e.y)) - tl_heightSlope(s.uv - vec2(0.0, e.y));
  // A third of the turn: enough to stop a horizon breaking into dots, and the mirror stays sharp.
  return length(vec4(dx, dy)) * k * 0.3;
}
// The surface normal for a height of k canvas px at height 1. x right, y down, z to the viewer.
vec3 tl_reliefNormal(TlSurface s, float k) { return normalize(vec3(-tl_heightSlope(s.uv) * k, 1.0)); }
// The view ray (straight into the screen) mirrored off a surface with normal n.
vec3 tl_mirror(vec3 n) { return vec3(2.0 * n.z * n.xy, 2.0 * n.z * n.z - 1.0); }
// How far n turns towards (x) and away from (y) the look's light, 0..1 of what a surface can.
vec2 tl_lit(vec3 n) {
  float l = dot(n, u_tlLight) - u_tlLight.z;
  return vec2(max(l, 0.0) / max(1.0 - u_tlLight.z, 0.05), max(-l, 0.0) / max(u_tlLight.z, 0.05));
}
`,
};

export type ReliefShape = {
	/** Reach of the bevel from the edge, percent of the unit. */
	size: number;
	/** Blur of the height, percent of the unit (the visible radius, ≈ 2σ, as Pachislop and Photoshop). */
	softness: number;
	/** Index in `TL_PROFILES`. */
	profile: number;
	/** Fit to stroke width: the size follows the local thickness. */
	fit: boolean;
	/** The curve of a `custom` profile, from `curveLut`. */
	curve?: FxUniformValue;
	/** Draw this shape instead of the profile: GLSL `float tl_reliefRaw(TlSurface s)` (satin's silhouette). */
	raw?: string;
};

/** Sigma in percent of the unit below which a height field shows the field's creases. */
const MIN_SIGMA = 0.8;
/** How far a Fit bevel's flood reaches, percent of the unit: the half-thickness of the heaviest display weights. */
const FIT_REACH = 60;
/** Sigma in texels the blurs run at, as the framework's (`BLUR_TARGET_SIGMA`). */
const TARGET_SIGMA = 2;
const CUSTOM_PROFILE = TL_PROFILES.indexOf('custom');

/** Without a known unit `pxPerPercent` is an upper bound: three levels finer keep a small logo in a big box sharp. */
const reduced = (texels: number, ctx: PrepassContext) =>
	1 / 2 ** Math.max(0, Math.floor(Math.log2(Math.max(1, texels))) - (ctx.unitKnown ? 0 : 3));

/** Field reach of a relief, percent of the unit. */
export const reliefReach = (size: number, fit: boolean) => ({ inside: fit ? FIT_REACH : size + 1 });

/** Local half-thickness of a filled shape: `u_tlCover` (r), smoothed so the seams between strokes do not crease. */
function coverPasses(ctx: PrepassContext): ShaderPass[] {
	const scale = reduced((ctx.pxPerPercent * 100) / 64, ctx);
	const fmt = { format: 'rgba32f', filter: 'nearest', scale } as const;
	const out: ShaderPass[] = [
		{
			output: 'tlCoverFlood',
			...fmt,
			...ctx.write('tlCoverFlood'),
			include: ctx.include,
			uniforms: ctx.uniforms,
			frag: `${ctx.defines}${ctx.depth.glsl}
void main() {
  TlSurface s = tl_surface();
  float d = tl_depth(s);
  fragColor = d > 0.0 ? vec4(s.px, d, 1.0) : vec4(0.0);
}`,
		},
	];
	const texels = Math.max(4, Math.ceil(FIT_REACH * ctx.pxPerPercent * scale) + 2);
	for (let step = 2 ** Math.ceil(Math.log2(texels)) / 2; step >= 1; step /= 2)
		out.push({
			output: 'tlCoverFlood',
			update: true,
			...fmt,
			uniforms: { u_tlrStep: step },
			frag: /* glsl */ `
void main() {
  ivec2 res = textureSize(u_tlCoverFlood, 0);
  ivec2 ip = ivec2(floor(v_uv * vec2(res)));
  vec2 p = v_uv * u_canvasSize;
  float slack = u_canvasSize.x / float(res.x);
  int stride = int(u_tlrStep);
  vec4 best = texelFetch(u_tlCoverFlood, ip, 0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      ivec2 q = ip + ivec2(x, y) * stride;
      if (q.x < 0 || q.y < 0 || q.x >= res.x || q.y >= res.y) continue;
      vec4 c = texelFetch(u_tlCoverFlood, q, 0);
      if (c.w > 0.5 && c.z > best.z && length(c.xy - p) <= c.z + slack) best = c;
    }
  fragColor = best;
}`,
		});
	const sigma = 2.5;
	const blur = { format: 'rgba16f', scale } as const;
	out.push(
		{
			output: 'tlCover',
			...blur,
			...ctx.write('tlCover'),
			frag: `void main() { fragColor = vec4(texture(u_tlCoverFlood, v_uv).z); }`,
		},
		{
			output: 'tlReliefH',
			...blur,
			...ctx.write('tlReliefH'),
			include: ctx.include,
			uniforms: { ...ctx.uniforms, u_tlBlurSigma: sigma, u_tlBlurDir: [1, 0] },
			frag: tlBlurAxis('u_tlCover'),
		},
		{
			output: 'tlCover',
			update: true,
			...blur,
			include: ctx.include,
			uniforms: { ...ctx.uniforms, u_tlBlurSigma: sigma, u_tlBlurDir: [0, 1] },
			frag: tlBlurAxis('u_tlReliefH'),
		},
	);
	return out;
}

/** The passes that leave a layer's relief in `u_tlHeight` (r, 0..1): a finish's `prepass`. */
export function reliefPasses(ctx: PrepassContext, o: ReliefShape): ShaderPass[] {
	const fit = o.fit && !o.raw;
	const cover = fit && !ctx.depth.ring;
	const sigma = Math.max(MIN_SIGMA, o.softness / 2);
	const scale = reduced((sigma * ctx.pxPerPercent) / TARGET_SIGMA, ctx);
	const custom = o.profile === CUSTOM_PROFILE && !o.raw && !!o.curve;
	const uniforms = {
		...ctx.uniforms,
		u_tlrSize: Math.max(0.05, o.size),
		u_tlrProfile: { int: o.profile },
		...(custom ? { u_tlrCurve: o.curve! } : {}),
	};
	const raw =
		o.raw ??
		`${ctx.depth.glsl}${custom ? CURVE_PROFILE : PROFILE}
float tl_reliefRaw(TlSurface s) {
  float inside = tl_depth(s);
  float size = tl_px(u_tlrSize);
  ${fit ? 'float band = tl_bandPx(s);\n  if (band > 0.0) { inside = min(inside, band - inside); size = 0.5 * band; }' : ''}
  ${cover ? 'else size = texture(u_tlCover, s.uv).r;' : ''}
  return tl_profile(clamp(inside / max(size, 1.0e-3), 0.0, 1.0));
}`;
	const fmt = { format: 'rgba16f', scale } as const;
	return [
		...(cover ? coverPasses(ctx) : []),
		{
			output: 'tlHeightRaw',
			...fmt,
			...ctx.write('tlHeightRaw'),
			include: [...ctx.include, ...(custom ? [GLSL_TL_CURVE] : [])],
			uniforms,
			frag: `${ctx.defines}${raw}
void main() { fragColor = vec4(tl_reliefRaw(tl_surface())); }`,
		},
		{
			output: 'tlReliefH',
			...fmt,
			...ctx.write('tlReliefH'),
			include: ctx.include,
			uniforms: { ...ctx.uniforms, u_tlBlurSigma: sigma, u_tlBlurDir: [1, 0] },
			frag: tlBlurAxis('u_tlHeightRaw'),
		},
		{
			output: 'tlHeight',
			...fmt,
			...ctx.write('tlHeight'),
			include: ctx.include,
			uniforms: { ...ctx.uniforms, u_tlBlurSigma: sigma, u_tlBlurDir: [0, 1] },
			frag: tlBlurAxis('u_tlReliefH'),
		},
	];
}

export const IDENTITY_CURVE: CurveValue = {
	curve: [
		[0, 0],
		[1, 1],
	],
};

/** A curve param (`{curve: [x, y][]}`, hold-only): the builders have none. */
export const curveParam = (
	name: string,
	label: string,
	def: CurveValue = IDENTITY_CURVE,
): TitleParamSpec => ({
	name,
	label,
	type: 'curve',
	default: def,
	animatable: false,
	ui: { control: 'curve' },
});

/**
 * Curve points to a 256-entry data texture: monotone cubic Hermite (Fritsch–Butland tangents, so nothing overshoots), as
 * Pachislop's `curveFn`. An invalid value reads as the identity: stored curves are validated on load, this only keeps the
 * renderer total.
 */
export function curveLut(v: unknown): FxUniformValue {
	const parsed = CurveValueSchema.safeParse(v);
	const raw = parsed.success ? (parsed.data as CurveValue).curve : IDENTITY_CURVE.curve;
	const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
	const p = raw.map(([x, y]) => [clamp01(x), clamp01(y)] as const).sort((a, b) => a[0] - b[0]);
	if (p[0]![0] > 0) p.unshift([0, p[0]![1]]);
	if (p[p.length - 1]![0] < 1) p.push([1, p[p.length - 1]![1]]);
	const n = p.length;
	const h: number[] = [];
	const d: number[] = [];
	for (let k = 0; k < n - 1; k++) {
		h.push(p[k + 1]![0] - p[k]![0]);
		d.push(h[k]! > 1e-6 ? (p[k + 1]![1] - p[k]![1]) / h[k]! : 0);
	}
	const t = new Array<number>(n).fill(0);
	t[0] = d[0]!;
	t[n - 1] = d[n - 2]!;
	for (let k = 1; k < n - 1; k++) {
		if (d[k - 1]! * d[k]! <= 0) continue;
		const w1 = 2 * h[k]! + h[k - 1]!;
		const w2 = h[k]! + 2 * h[k - 1]!;
		t[k] = (w1 + w2) / (w1 / d[k - 1]! + w2 / d[k]!);
	}
	const out = new Float32Array(256 * 4);
	for (let i = 0; i < 256; i++) {
		const x = i / 255;
		let k = 0;
		while (k < n - 2 && x > p[k + 1]![0]) k++;
		let y = p[k + 1]![1];
		if (h[k]! > 1e-6) {
			const u = (x - p[k]![0]) / h[k]!;
			const u2 = u * u;
			const u3 = u2 * u;
			y =
				(2 * u3 - 3 * u2 + 1) * p[k]![1] +
				(u3 - 2 * u2 + u) * h[k]! * t[k]! +
				(-2 * u3 + 3 * u2) * p[k + 1]![1] +
				(u3 - u2) * h[k]! * t[k + 1]!;
		}
		out[i * 4] = clamp01(y);
	}
	return { texels: out, key: hashFloats(out) };
}
