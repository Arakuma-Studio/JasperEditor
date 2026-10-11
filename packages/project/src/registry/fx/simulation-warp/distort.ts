// Distort ▸ Displacement Map, Optics Compensation, Polar Coordinates, Bezier Warp, Reshape, Smear (sim-warp
// workstream; After Effects' effects of those names). Per-pixel remaps, except Bezier Warp (a Coons-patch mesh drawn
// forward by a draw pass). Reshape and Smear read the layer's masks ("Mask 1…8" popups). Ported from EffectCraft
// crates/effects/src/distort.rs (polar), distort2.rs (displacement_map, optics_compensation, bezier_grid) and
// distort3.rs (smear_setup, reshape_setup; MIT OR Apache-2.0), see licenses/ported/sim-warp.md.
import type { ParamValue } from '../../../schema/common.ts';
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { fxParam } from '../params.ts';
import type { FxFrameContext, FxLayerMask, GlslChunk } from '../shader.ts';
import { n, popup, values } from './common.ts';
import { bool, choice, clamp, num, vec2 } from './core.ts';
import { MASK_CHOICES, maskOf } from './playground.ts';

const DISTORT = 'Distort';

const DM_SOURCES = [
	'Red',
	'Green',
	'Blue',
	'Alpha',
	'Luminance',
	'Hue',
	'Lightness',
	'Saturation',
	'Full',
	'Half',
	'Off',
] as const;

export const DISPLACEMENT_MAP = defineShaderEffect({
	id: 'jasper.displacement-map',
	label: 'Displacement Map',
	category: DISTORT,
	description: "Displaces the layer's pixels by the colours of a map (another picture or the layer itself).",
	keywords: ['displace', 'map', 'distort', 'refract'],
	params: [
		fxParam.media('displacementMapLayer', 'Displacement Map Layer'),
		popup('useForHorizontal', 'Use For Horizontal Displacement', DM_SOURCES, 0),
		n('maxHorizontal', 'Max Horizontal Displacement', 5, -32000, 32000, -100, 100, 0.1, { unit: 'px' }),
		popup('useForVertical', 'Use For Vertical Displacement', DM_SOURCES, 1),
		n('maxVertical', 'Max Vertical Displacement', 5, -32000, 32000, -100, 100, 0.1, { unit: 'px' }),
		popup(
			'displacementMapBehavior',
			'Displacement Map Behavior',
			['Center Map', 'Stretch Map to Fit', 'Tile Map'],
			0,
		),
		fxParam.toggle('wrapPixelsAround', 'Wrap Pixels Around', false),
		fxParam.toggle('expandOutput', 'Expand Output', true),
	],
	gpu: {
		padding: (p) =>
			bool(p.expandOutput, true) && !bool(p.wrapPixelsAround)
				? Math.ceil(
						Math.min(2048, Math.max(Math.abs(num(p.maxHorizontal, 5)), Math.abs(num(p.maxVertical, 5)))),
					)
				: 0,
		passes: [
			{
				include: [GLSL_COLOR],
				frag: /* glsl */ `
float dm_pick(int s, vec4 c) {
  if (s == 0) return c.r;
  if (s == 1) return c.g;
  if (s == 2) return c.b;
  if (s == 3) return c.a;
  if (s == 4) return fx_luma(c.rgb);
  if (s == 5) return fx_rgb2hsl(c.rgb).x;
  if (s == 6) return fx_rgb2hsl(c.rgb).z;
  if (s == 7) return fx_rgb2hsl(c.rgb).y;
  if (s == 8) return 1.0;
  return 0.5;
}
void main() {
  vec2 L = u_box.zw / u_pxScale;
  vec2 lp = fx_layerPx();
  vec4 src = texture(u_source, v_uv);
  vec4 m;
  if (u_displacementMapLayer_size.x > 0.0) {
    vec2 ms = u_displacementMapLayer_size;
    if (u_displacementMapBehavior == 1) m = texture(u_displacementMapLayer, lp / L);
    else if (u_displacementMapBehavior == 2) m = texture(u_displacementMapLayer, fract((lp + (ms - L) * 0.5) / ms));
    else {
      vec2 uv = (lp + (ms - L) * 0.5) / ms;
      if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) { fragColor = src; return; }
      m = texture(u_displacementMapLayer, uv);
    }
  } else m = texture(u_source, fx_uvOfLayerPx(clamp(lp, vec2(0.0), L)));
  vec4 c = fx_unpremultiply(m);
  float dx = u_useForHorizontal == 10 ? 0.0 : (dm_pick(u_useForHorizontal, c) - 0.5) * 2.0 * u_maxHorizontal;
  float dy = u_useForVertical == 10 ? 0.0 : (dm_pick(u_useForVertical, c) - 0.5) * 2.0 * u_maxVertical;
  if (dx == 0.0 && dy == 0.0) { fragColor = src; return; }
  vec2 sp = lp + vec2(dx, dy);
  if (u_wrapPixelsAround) { sp = mod(sp, L); fragColor = texture(u_source, fx_uvOfLayerPx(sp)); return; }
  vec2 uv = fx_uvOfLayerPx(sp);
  fragColor = (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) ? vec4(0.0) : texture(u_source, uv);
}`,
			},
		],
		timeInvariant: true,
	},
});

const FOV_ORIENT = ['Horizontal', 'Vertical', 'Diagonal'] as const;
const RESIZE = ['Off', 'Max 2X', 'Max 4X', 'Unlimited'] as const;

/** Optics Compensation's lens: reference radius (layer px), focal length, half angle. */
function opticsLens(p: EffectParams, lw: number, lh: number) {
	const fov = (clamp(num(p.fieldOfView), 0, 179) * Math.PI) / 180;
	const o = choice(p.fovOrientation, values(FOV_ORIENT));
	const rRef = Math.max(1, o === 1 ? lh / 2 : o === 2 ? Math.hypot(lw, lh) / 2 : lw / 2);
	const half = fov / 2;
	return { fov, rRef, half, f: rRef / Math.tan(Math.max(half, 1e-6)) };
}

export const OPTICS_COMPENSATION = defineShaderEffect({
	id: 'jasper.optics-compensation',
	label: 'Optics Compensation',
	category: DISTORT,
	description: 'Adds or removes lens (barrel / fisheye) distortion of a given field of view.',
	keywords: ['lens', 'fisheye', 'barrel', 'undistort', 'wide angle'],
	params: [
		n('fieldOfView', 'Field Of View (FOV)', 0, 0, 180, 0, 180, 0.1, { unit: 'deg' }),
		fxParam.toggle('reverseLensDistortion', 'Reverse Lens Distortion', false),
		popup('fovOrientation', 'FOV Orientation', FOV_ORIENT, 0),
		fxParam.point('viewCenter', 'View Center', [0.5, 0.5]),
		fxParam.toggle('optimalPixels', 'Optimal Pixels (Invalidates Resize)', false),
		popup('resize', 'Resize', RESIZE, 0),
	],
	gpu: {
		timeInvariant: true,
		padding: (p, ctx) => {
			const lw = ctx.width;
			const lh = ctx.height;
			const resize = bool(p.optimalPixels) ? 0 : choice(p.resize, values(RESIZE));
			if (!bool(p.reverseLensDistortion) || resize === 0) return 0;
			const { rRef, half, f } = opticsLens(p, lw, lh);
			const vc = vec2(p.viewCenter, [0.5, 0.5]);
			const c = [vc[0] * lw, vc[1] * lh];
			const rc = Math.max(
				...[
					[0, 0],
					[lw, 0],
					[0, lh],
					[lw, lh],
				].map(([x, y]) => Math.hypot(x! - c[0]!, y! - c[1]!)),
			);
			const th = (rc / rRef) * half;
			const cap = Math.max(lw, lh) * [0, 0.5, 1.5, 3.5][resize]!;
			const grow = th < Math.PI / 2 - 1e-3 ? Math.max(0, f * Math.tan(th) - rc) : cap;
			return Math.ceil(Math.min(grow, cap, 2048));
		},
		uniforms: (p, ctx) => {
			const lw = ctx.width;
			const lh = ctx.height;
			const { fov, rRef, half, f } = opticsLens(p, lw, lh);
			const reverse = bool(p.reverseLensDistortion);
			const vc = vec2(p.viewCenter, [0.5, 0.5]);
			const c = [vc[0] * lw, vc[1] * lh];
			let fit = 1;
			if (bool(p.optimalPixels) && fov > 1e-6) {
				const rc = Math.max(
					1,
					...[
						[0, 0],
						[lw, 0],
						[0, lh],
						[lw, lh],
					].map(([x, y]) => Math.hypot(x! - c[0]!, y! - c[1]!)),
				);
				if (reverse) {
					const th = Math.min((rc / rRef) * half, Math.PI / 2 - 1e-3);
					fit = Math.max(1, (f * Math.tan(th)) / rc);
				} else fit = Math.min(1, ((Math.atan(rc / f) / half) * rRef) / rc);
			}
			return { u_ocOn: fov > 1e-6, u_ocLens: [rRef, half, f, fit], u_ocCenter: [c[0]!, c[1]!] };
		},
		passes: [
			{
				frag: /* glsl */ `
void main() {
  if (!u_ocOn) { fragColor = texture(u_source, v_uv); return; }
  vec2 lp = fx_layerPx();
  vec2 d = lp - u_ocCenter;
  float r = length(d) * u_ocLens.w;
  if (r < 1e-9) { fragColor = texture(u_source, v_uv); return; }
  float rs;
  if (u_reverseLensDistortion) rs = atan(r / u_ocLens.z) / u_ocLens.y * u_ocLens.x;
  else {
    float th = r / u_ocLens.x * u_ocLens.y;
    if (th >= 1.5706963) { fragColor = vec4(0.0); return; }
    rs = u_ocLens.z * tan(th);
  }
  vec2 uv = fx_uvOfLayerPx(u_ocCenter + d * (rs / r * u_ocLens.w));
  fragColor = (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) ? vec4(0.0) : texture(u_source, uv);
}`,
			},
		],
	},
});

export const POLAR_COORDINATES = defineShaderEffect({
	id: 'jasper.polar-coordinates',
	label: 'Polar Coordinates',
	category: DISTORT,
	description:
		'Wraps the layer around a circle (Rect to Polar) or unrolls a circle into rows (Polar to Rect).',
	keywords: ['polar', 'circle', 'wrap', 'tiny planet', 'unwrap'],
	params: [
		fxParam.percent('interpolation', 'Interpolation', 0),
		popup('conversion', 'Type of Conversion', ['Rect to Polar', 'Polar to Rect'], 0),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				frag: /* glsl */ `
void main() {
  vec2 L = u_box.zw / u_pxScale;
  vec2 lp = fx_layerPx();
  vec2 c = L * 0.5;
  float rmax = min(c.x, c.y);
  vec2 q;
  if (u_conversion == 0) {
    // The output is polar: angle → x, radius → y (radius 0 at the bottom).
    vec2 d = lp - c;
    float a = mod(atan(d.x, -d.y), 6.2831853);
    q = vec2(a / 6.2831853 * L.x, L.y - length(d) / rmax * L.y);
  } else {
    float a = lp.x / L.x * 6.2831853;
    float r = (L.y - lp.y) / L.y * rmax;
    q = vec2(c.x + r * sin(a), c.y - r * cos(a));
  }
  vec2 sp = mix(lp, q, clamp(u_interpolation / 100.0, 0.0, 1.0));
  fragColor = texture(u_source, fx_uvOfLayerPx(mod(sp, L)));
}`,
			},
		],
	},
});

const BW_POINTS = [
	['topLeftVertex', 'Top Left Vertex', [0, 0]],
	['topLeftTangent', 'Top Left Tangent', [1 / 3, 0]],
	['topRightTangent', 'Top Right Tangent', [2 / 3, 0]],
	['rightTopVertex', 'Right Top Vertex', [1, 0]],
	['rightTopTangent', 'Right Top Tangent', [1, 1 / 3]],
	['rightBottomTangent', 'Right Bottom Tangent', [1, 2 / 3]],
	['bottomRightVertex', 'Bottom Right Vertex', [1, 1]],
	['bottomRightTangent', 'Bottom Right Tangent', [2 / 3, 1]],
	['bottomLeftTangent', 'Bottom Left Tangent', [1 / 3, 1]],
	['leftBottomVertex', 'Left Bottom Vertex', [0, 1]],
	['leftBottomTangent', 'Left Bottom Tangent', [0, 2 / 3]],
	['leftTopTangent', 'Left Top Tangent', [0, 1 / 3]],
] as const;

/** Bezier Warp's padding: how far its control points leave the layer box (layer px). */
function bezierPadding(p: EffectParams, lw: number, lh: number) {
	let [x0, y0, x1, y1] = [0, 0, 1, 1];
	for (const [k, , d] of BW_POINTS) {
		const v = vec2(p[k], d as [number, number]);
		x0 = Math.min(x0, v[0]);
		y0 = Math.min(y0, v[1]);
		x1 = Math.max(x1, v[0]);
		y1 = Math.max(y1, v[1]);
	}
	const c = (v: number) => Math.min(2048, Math.ceil(v + 1));
	return { left: c(-x0 * lw), top: c(-y0 * lh), right: c((x1 - 1) * lw), bottom: c((y1 - 1) * lh) };
}

export const BEZIER_WARP = defineShaderEffect({
	id: 'jasper.bezier-warp',
	label: 'Bezier Warp',
	category: DISTORT,
	description:
		'Bends the layer by a closed Bézier outline of four vertices and eight tangents, dragged on the Program monitor.',
	keywords: ['bezier', 'warp', 'bend', 'flag', 'page curl'],
	params: [
		...BW_POINTS.map(([k, label, d]) => fxParam.point(k, label, [d[0], d[1]])),
		n('quality', 'Quality', 8, 1, 10, 1, 10, 1),
	],
	gpu: {
		timeInvariant: true,
		padding: (p, ctx) => bezierPadding(p, ctx.width, ctx.height),
		uniforms: (p) => ({
			u_bw: { vec4s: BW_POINTS.flatMap(([k, , d]) => vec2(p[k], d as [number, number])) },
			u_bwN: { int: clamp(Math.round(num(p.quality, 8)), 1, 10) * 4 },
		}),
		passes: (p) => {
			const nn = clamp(Math.round(num(p.quality, 8)), 1, 10) * 4;
			return [
				{
					draw: {
						vertices: nn * nn * 6,
						instances: 1,
						vert: /* glsl */ `
out vec2 v_t;
vec2 bw_pt(int i) { vec4 q = u_bw[i / 2]; return (i % 2 == 0) ? q.xy : q.zw; }
vec2 bw_bez(vec2 a, vec2 b, vec2 c, vec2 d, float t) {
  float u = 1.0 - t;
  return a * u * u * u + b * 3.0 * u * u * t + c * 3.0 * u * t * t + d * t * t * t;
}
void main() {
  int cell = gl_VertexID / 6;
  int k = gl_VertexID % 6;
  int qi = k < 3 ? k : (k == 3 ? 2 : (k == 4 ? 1 : 3));
  int ci = cell % u_bwN;
  int cj = cell / u_bwN;
  float u = float(ci + ((qi == 1 || qi == 3) ? 1 : 0)) / float(u_bwN);
  float v = float(cj + (qi >= 2 ? 1 : 0)) / float(u_bwN);
  vec2 tl = bw_pt(0), tlt = bw_pt(1), trt = bw_pt(2), tr = bw_pt(3), rtt = bw_pt(4), rbt = bw_pt(5);
  vec2 br = bw_pt(6), brt = bw_pt(7), blt = bw_pt(8), bl = bw_pt(9), lbt = bw_pt(10), ltt = bw_pt(11);
  vec2 d0 = bw_bez(tl, ltt, lbt, bl, v);
  vec2 d1 = bw_bez(tr, rtt, rbt, br, v);
  vec2 c0 = bw_bez(tl, tlt, trt, tr, u);
  vec2 c1 = bw_bez(bl, blt, brt, br, u);
  vec2 bil = (1.0 - u) * (1.0 - v) * tl + u * (1.0 - v) * tr + (1.0 - u) * v * bl + u * v * br;
  vec2 s = (1.0 - v) * c0 + v * c1 + (1.0 - u) * d0 + u * d1 - bil;
  v_t = vec2(u, v);
  fx_emit(fx_canvasPxOfLayerNorm(s));
}`,
					},
					frag: /* glsl */ `
in vec2 v_t;
void main() {
  // Anti-aliased outline: coverage from the distance (in output px) to the patch's border.
  vec2 w = max(fwidth(v_t), vec2(1e-6));
  vec2 e = min(v_t, 1.0 - v_t) / w;
  float cov = clamp(min(e.x, e.y) + 0.5, 0.0, 1.0);
  fragColor = texture(u_source, fx_uvOfLayerNorm(clamp(v_t, 0.0, 1.0))) * cov;
}`,
				},
			];
		},
	},
});

const ELASTICITY = [
	'Stiff',
	'Less Stiff',
	'Below Normal',
	'Absolutely Normal',
	'Above Average',
	'Loose',
	'Liquid',
	'Super Fluid',
] as const;
const ELASTIC_EXP = [1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4.5];
const INTERP = ['Discrete', 'Linear', 'Smooth'] as const;
/** Points Reshape samples each outline at. */
export const RESHAPE_POINTS = 48;
/** Points of a polygon passed to the shader (resampled by arc length). */
const POLY_POINTS = 64;

function polyLength(pts: readonly [number, number][], closed: boolean): number {
	let l = 0;
	const n = pts.length;
	for (let i = 0; i < (closed ? n : n - 1); i++) {
		const a = pts[i]!;
		const b = pts[(i + 1) % n]!;
		l += Math.hypot(b[0] - a[0], b[1] - a[1]);
	}
	return l;
}
function pointAt(pts: readonly [number, number][], closed: boolean, s: number): [number, number] {
	const n = pts.length;
	let acc = 0;
	for (let i = 0; i < (closed ? n : n - 1); i++) {
		const a = pts[i]!;
		const b = pts[(i + 1) % n]!;
		const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
		if (acc + l >= s && l > 0) {
			const t = (s - acc) / l;
			return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
		}
		acc += l;
	}
	return closed ? [pts[0]![0], pts[0]![1]] : [pts[n - 1]![0], pts[n - 1]![1]];
}
/** A polyline resampled to `n` points evenly by arc length. */
export function resample(m: FxLayerMask, n: number): [number, number][] {
	const pts = m.points;
	if (pts.length === 0) return [];
	const len = polyLength(pts, m.closed);
	const div = m.closed ? n : Math.max(1, n - 1);
	return Array.from({ length: n }, (_, i) => pointAt(pts, m.closed, (len * i) / div));
}

/** "s,d s,d …" correspondence pairs (outline fractions), sorted by destination. */
function parseCorrespondence(s: ParamValue | undefined): [number, number][] {
	if (typeof s !== 'string') return [];
	return s
		.split(/\s+/)
		.map((t) => t.split(','))
		.filter((t) => t.length === 2)
		.map((t) => [Number(t[0]), Number(t[1])] as [number, number])
		.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
		.map(([a, b]) => [((a % 1) + 1) % 1, ((b % 1) + 1) % 1] as [number, number])
		.sort((a, b) => a[1] - b[1]);
}
function mapFraction(pairs: [number, number][], u: number, closed: boolean): number {
	const n = pairs.length;
	if (n === 1) return (((pairs[0]![0] + (u - pairs[0]![1])) % 1) + 1) % 1;
	if (!closed) {
		const ext: [number, number][] = [[0, 0], ...pairs, [1, 1]];
		let k = 0;
		for (let i = 0; i < ext.length; i++) if (ext[i]![1] <= u) k = i;
		k = Math.min(k, ext.length - 2);
		const a = ext[k]!;
		const b = ext[k + 1]!;
		const t = b[1] > a[1] ? (u - a[1]) / (b[1] - a[1]) : 0;
		return clamp(a[0] + (b[0] - a[0]) * t, 0, 1);
	}
	let k = n - 1;
	for (let i = 0; i < n; i++) if (pairs[i]![1] <= u) k = i;
	const a = pairs[k]!;
	const b = pairs[(k + 1) % n]!;
	const du = Math.max(1e-9, (((b[1] - a[1]) % 1) + 1) % 1);
	const ds = (((b[0] - a[0]) % 1) + 1) % 1;
	const t = ((((u - a[1]) % 1) + 1) % 1) / du;
	return (((a[0] + ds * t) % 1) + 1) % 1;
}

/** Reshape's set-up (layer px): destination samples and displacements back to the source outline. */
export function reshapeSetup(p: EffectParams, ctx: FxFrameContext) {
	const masks = ctx.structures?.masks;
	const sm = maskOf(p.sourceMask, masks);
	const dm = maskOf(p.destinationMask, masks);
	const pct = num(p.percent, 100) / 100;
	if (!sm || !dm || sm.points.length < 2 || dm.points.length < 2 || pct === 0) return null;
	const N = RESHAPE_POINTS;
	const s = resample(sm, N);
	const d = resample(dm, N);
	let rot = 0;
	if (sm.closed && dm.closed) {
		let best = Number.POSITIVE_INFINITY;
		for (let r = 0; r < N; r++) {
			let cost = 0;
			for (let i = 0; i < N; i++) {
				const a = s[(i + r) % N]!;
				cost += (a[0] - d[i]![0]) ** 2 + (a[1] - d[i]![1]) ** 2;
			}
			if (cost < best) {
				best = cost;
				rot = r;
			}
		}
	}
	const pairs = parseCorrespondence(p.correspondencePoints);
	const len = polyLength(sm.points, sm.closed);
	const src = (i: number): [number, number] =>
		pairs.length === 0
			? s[(i + rot) % N]!
			: pointAt(sm.points, sm.closed, mapFraction(pairs, i / N, sm.closed && dm.closed) * len);
	const bound = maskOf(p.boundaryMask, masks);
	return {
		dest: d.flatMap((q, i) => {
			const a = src(i);
			return [q[0], q[1], a[0] - q[0], a[1] - q[1]];
		}),
		bound: bound && bound.points.length >= 3 ? resample({ ...bound, closed: true }, POLY_POINTS) : null,
		kexp: ELASTIC_EXP[choice(p.elasticity, values(ELASTICITY))]!,
		pct,
		smooth: choice(p.interpolation, values(INTERP), 1) === 2,
	};
}

const GLSL_POLY = /* glsl */ `
vec2 rs_pt(vec4 a[32], int i) { vec4 q = a[i / 2]; return (i % 2 == 0) ? q.xy : q.zw; }
bool rs_inside(vec4 a[32], vec2 p) {
  bool c = false;
  for (int i = 0, j = 63; i < 64; j = i++) {
    vec2 u = rs_pt(a, i), v = rs_pt(a, j);
    if ((u.y > p.y) != (v.y > p.y) && p.x < (v.x - u.x) * (p.y - u.y) / (v.y - u.y) + u.x) c = !c;
  }
  return c;
}
float rs_dist(vec4 a[32], vec2 p) {
  float m = 1e9;
  for (int i = 0; i < 64; i++) {
    vec2 u = rs_pt(a, i), v = rs_pt(a, (i + 1) % 64);
    vec2 uv = v - u;
    float t = clamp(dot(p - u, uv) / max(dot(uv, uv), 1e-9), 0.0, 1.0);
    m = min(m, length(p - u - uv * t));
  }
  return m;
}
`;

const flatPoly = (pts: [number, number][] | null) => (pts ? pts.flat() : new Array(POLY_POINTS * 2).fill(0));

/** The polygon helpers as a chunk (64-point polygons in vec4[32] uniforms: `rs_inside`, `rs_dist`). */
export const GLSL_POLY_CHUNK: GlslChunk = { name: 'sim/poly', source: GLSL_POLY };
/** A mask as a 64-point polygon uniform (zeros without one). */
export const polyUniform = (m: FxLayerMask | null) => ({
	vec4s: flatPoly(m && m.points.length >= 3 ? resample({ ...m, closed: true }, POLY_POINTS) : null),
});

export const RESHAPE = defineShaderEffect({
	id: 'jasper.reshape',
	label: 'Reshape',
	category: DISTORT,
	description:
		"Morphs the area of one mask of the layer into the shape of another, within a boundary mask (the layer's masks, Mask 1…8).",
	keywords: ['morph', 'reshape', 'mask', 'warp'],
	params: [
		popup('sourceMask', 'Source Mask', MASK_CHOICES, 0),
		popup('destinationMask', 'Destination Mask', MASK_CHOICES, 0),
		popup('boundaryMask', 'Boundary Mask', MASK_CHOICES, 0),
		fxParam.percent('percent', 'Percent', 100),
		popup('elasticity', 'Elasticity', ELASTICITY, 0),
		popup('interpolation', 'Interpolation Method', INTERP, 1),
		{
			name: 'correspondencePoints',
			label: 'Correspondence Points',
			type: 'string',
			default: '',
			animatable: false,
		},
	],
	gpu: {
		uniforms: (p, ctx) => {
			const r = reshapeSetup(p, ctx);
			return {
				u_rsOn: !!r,
				u_rsDest: { vec4s: r ? r.dest : new Array(RESHAPE_POINTS * 4).fill(0) },
				u_rsBound: { vec4s: flatPoly(r?.bound ?? null) },
				u_rsHasBound: !!r?.bound,
				u_rsK: [r?.kexp ?? 1, r?.pct ?? 0, r?.smooth ? 1 : 0, 0],
			};
		},
		passes: [
			{
				frag: /* glsl */ `${GLSL_POLY}
void main() {
  if (!u_rsOn) { fragColor = texture(u_source, v_uv); return; }
  vec2 p = fx_layerPx();
  if (u_rsHasBound && !rs_inside(u_rsBound, p)) { fragColor = texture(u_source, v_uv); return; }
  vec2 w = vec2(0.0);
  float ws = 0.0;
  float dmin = 1e18;
  for (int i = 0; i < ${RESHAPE_POINTS}; i++) {
    vec4 q = u_rsDest[i];
    float d2 = dot(p - q.xy, p - q.xy);
    dmin = min(dmin, d2);
    float wt = 1.0 / pow(d2 + 1e-6, u_rsK.x * 0.5);
    w += wt * q.zw;
    ws += wt;
  }
  float fade = 1.0;
  if (u_rsHasBound) {
    float db = rs_dist(u_rsBound, p);
    fade = db / max(db + sqrt(dmin), 1e-9);
    if (u_rsK.z > 0.5) fade = fade * fade * (3.0 - 2.0 * fade);
  }
  vec2 sp = p + w * (fade * u_rsK.y / ws);
  vec2 uv = fx_uvOfLayerPx(sp);
  fragColor = (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) ? vec4(0.0) : texture(u_source, uv);
}`,
			},
		],
	},
});

export const SMEAR = defineShaderEffect({
	id: 'jasper.smear',
	label: 'Smear',
	category: DISTORT,
	description:
		"Moves, rotates and scales the area inside a source mask, smearing the picture up to a boundary mask (the layer's masks).",
	keywords: ['smear', 'stretch', 'mask', 'warp'],
	params: [
		popup('sourceMask', 'Source Mask', MASK_CHOICES, 0),
		popup('boundaryMask', 'Boundary Mask', MASK_CHOICES, 0),
		fxParam.vec2('maskOffset', 'Mask Offset', [0, 0], { step: 0.1 }),
		fxParam.angle('maskRotation', 'Mask Rotation', 0),
		n('maskScale', 'Mask Scale', 100, 1, 1000, 1, 400, 0.1, { unit: '%' }),
		fxParam.percent('percent', 'Percent', 100),
		popup('elasticity', 'Elasticity', ELASTICITY, 3),
		popup('interpolation', 'Interpolation Method', INTERP, 1),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const masks = ctx.structures?.masks;
			const sm = maskOf(p.sourceMask, masks);
			const bm = maskOf(p.boundaryMask, masks);
			const pct = num(p.percent, 100) / 100;
			const on = !!sm && !!bm && sm.points.length >= 3 && bm.points.length >= 3 && pct !== 0;
			const src = on ? resample({ ...sm!, closed: true }, POLY_POINTS) : null;
			const c = src
				? src.reduce((a, q) => [a[0] + q[0] / src.length, a[1] + q[1] / src.length], [0, 0])
				: [0, 0];
			const off = vec2(p.maskOffset, [0, 0]);
			const rot = (num(p.maskRotation) * Math.PI) / 180;
			const scl = Math.max(1e-3, num(p.maskScale, 100) / 100);
			const moved = src
				? src.map(([x, y]) => {
						const dx = (x - c[0]!) * scl;
						const dy = (y - c[1]!) * scl;
						return [
							c[0]! + dx * Math.cos(rot) - dy * Math.sin(rot) + off[0],
							c[1]! + dx * Math.sin(rot) + dy * Math.cos(rot) + off[1],
						] as [number, number];
					})
				: null;
			return {
				u_smOn: on,
				u_smBound: { vec4s: flatPoly(on ? resample({ ...bm!, closed: true }, POLY_POINTS) : null) },
				u_smMoved: { vec4s: flatPoly(moved) },
				u_smXf: [c[0]!, c[1]!, Math.cos(rot), Math.sin(rot)],
				u_smK: [scl, off[0], off[1], pct],
				u_smExp: ELASTIC_EXP[choice(p.elasticity, values(ELASTICITY), 3)]!,
			};
		},
		passes: [
			{
				frag: /* glsl */ `${GLSL_POLY}
void main() {
  if (!u_smOn) { fragColor = texture(u_source, v_uv); return; }
  vec2 p = fx_layerPx();
  if (!rs_inside(u_smBound, p)) { fragColor = texture(u_source, v_uv); return; }
  float w = 1.0;
  if (!rs_inside(u_smMoved, p)) {
    float dm = rs_dist(u_smMoved, p);
    float db = rs_dist(u_smBound, p);
    w = pow(db / max(db + dm, 1e-9), 1.0 / u_smExp);
    if (u_interpolation == 2) w = w * w * (3.0 - 2.0 * w);
    else if (u_interpolation == 0) w = step(0.5, w);
  }
  vec2 d = p - u_smK.yz - u_smXf.xy;
  vec2 inv = u_smXf.xy + vec2(d.x * u_smXf.z + d.y * u_smXf.w, -d.x * u_smXf.w + d.y * u_smXf.z) / u_smK.x;
  float k = clamp(w * u_smK.w, 0.0, 1.0);
  vec2 uv = fx_uvOfLayerPx(p + (inv - p) * k);
  fragColor = (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) ? vec4(0.0) : texture(u_source, uv);
}`,
			},
		],
	},
});

export const DISTORT_EFFECTS: readonly EffectSpec[] = [
	BEZIER_WARP,
	DISPLACEMENT_MAP,
	OPTICS_COMPENSATION,
	POLAR_COORDINATES,
	RESHAPE,
	SMEAR,
];
