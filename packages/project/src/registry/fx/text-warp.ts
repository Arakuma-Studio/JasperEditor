// Spec 19 TL-110, Warp Text: an ordinary effect that follows the look in the stack, drawn as a forward mesh of the
// picture. Decision and reasons: docs/wp-notes/title-looks.md "Text". The warp reads the composited title, so rims,
// glows and shadows bend with the letters; it is a distortion of the layer box, so it holds at any resolution; every
// number is an ordinary keyframable param. Meshes: text-warp/mesh.ts (Patchy).
import type { EffectParams, EffectSpec } from '../effects.ts';
import { defineShaderEffect } from './define.ts';
import { fxParam } from './params.ts';
import type { FxPlanContext, ShaderPass } from './shader.ts';
import {
	WARP_STYLE_LABELS,
	WARP_STYLES,
	type WarpParams,
	type WarpStyle,
	warpBounds,
	warpIsIdentity,
	warpSurface,
} from './text-warp/mesh.ts';

export const TEXT_WARP_EFFECT_ID = 'jasper.warp-text';

/** Cells per side of the mesh over the canvas: a fixed lattice, so the geometry is the same at every resolution. */
const CELLS = 128;
/** Layer px around what the warp may reach, for the antialiased edge. */
const PADDING_GUARD = 2;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function warpParamsOf(p: EffectParams): WarpParams {
	const style = (WARP_STYLES as readonly unknown[]).includes(p.style) ? (p.style as WarpStyle) : 'arc';
	return {
		style,
		bend: num(p.bend),
		horizontal: num(p.horizontalDistortion),
		vertical: num(p.verticalDistortion),
		rotateVertical: p.orientation === 'vertical',
	};
}

const PASS_THROUGH: readonly ShaderPass[] = [
	{ frag: /* glsl */ `void main() { fragColor = texture(u_source, v_uv); }` },
];

// `warpMapPoint` in GLSL: a bicubic patch of 16 points packed in 8 vec4, going on along its tangent past the box.
const VERT = /* glsl */ `
out vec2 v_twUv;
const int TW_CELLS = ${CELLS};
vec2 tw_point(int i) {
  vec4 v = u_twPatch[i / 2];
  return (i & 1) == 0 ? v.xy : v.zw;
}
void tw_basis(float t, out vec4 b, out vec4 d) {
  float s = 1.0 - t;
  b = vec4(s * s * s, 3.0 * s * s * t, 3.0 * s * t * t, t * t * t);
  d = vec4(-3.0 * s * s, 3.0 * s * s - 6.0 * s * t, 6.0 * s * t - 3.0 * t * t, 3.0 * t * t);
}
vec2 tw_map(vec2 n) {
  vec2 c = clamp(n, 0.0, 1.0);
  vec2 e = n - c;
  vec4 bu, du, bv, dv;
  tw_basis(c.x, bu, du);
  tw_basis(c.y, bv, dv);
  vec2 p = vec2(0.0);
  for (int row = 0; row < 4; row++)
    for (int column = 0; column < 4; column++)
      p += (bu[column] * bv[row] + e.x * du[column] * bv[row] + e.y * bu[column] * dv[row]) * tw_point(row * 4 + column);
  return p;
}
void main() {
  int cell = gl_VertexID / 6;
  int k = gl_VertexID % 6;
  int corner = k < 3 ? k : (k == 3 ? 2 : (k == 4 ? 1 : 3));
  ivec2 at = ivec2(cell % TW_CELLS, cell / TW_CELLS) + ivec2(corner & 1, corner >> 1);
  vec2 uv = vec2(at) / float(TW_CELLS);
  v_twUv = uv;
  fx_emit(fx_canvasPxOfLayerNorm(tw_map((uv * u_canvasSize - u_box.xy) / u_box.zw)));
}`;

const FRAG = /* glsl */ `
in vec2 v_twUv;
void main() {
  // The edge of the picture stays antialiased once the mesh turns it (an opaque still fills its canvas to the edge).
  vec2 w = max(fwidth(v_twUv), vec2(1e-6));
  vec2 e = min(v_twUv, 1.0 - v_twUv) / w;
  fragColor = texture(u_source, v_twUv) * clamp(min(e.x, e.y) + 0.5, 0.0, 1.0);
}`;

function padding(p: EffectParams, ctx: FxPlanContext) {
	const w = warpParamsOf(p);
	const surface = warpIsIdentity(w) ? null : warpSurface(w, ctx.width, ctx.height);
	if (!surface) return 0;
	const has = ctx.inputPadding ?? { left: 0, top: 0, right: 0, bottom: 0 };
	const b = warpBounds(surface, {
		x0: -has.left / ctx.width,
		y0: -has.top / ctx.height,
		x1: 1 + has.right / ctx.width,
		y1: 1 + has.bottom / ctx.height,
	});
	// Only what the picture does not reach already: paddings add up along the stack.
	const side = (need: number, have: number) => Math.ceil(Math.max(0, need + PADDING_GUARD - have));
	return {
		left: side(-b.x0 * ctx.width, has.left),
		top: side(-b.y0 * ctx.height, has.top),
		right: side((b.x1 - 1) * ctx.width, has.right),
		bottom: side((b.y1 - 1) * ctx.height, has.bottom),
	};
}

export const TEXT_WARP = defineShaderEffect({
	id: TEXT_WARP_EFFECT_ID,
	label: 'Warp Text',
	category: 'Distort',
	description:
		'Bends the layer with the 15 Warp Text styles of Photoshop. Placed after a look, its rims, glows and shadows bend with the letters.',
	keywords: ['warp', 'text', 'arc', 'arch', 'bulge', 'flag', 'wave', 'fisheye', 'inflate', 'squeeze', 'twist'],
	params: [
		fxParam.choice(
			'style',
			'Style',
			WARP_STYLES,
			WARP_STYLES.map((s) => WARP_STYLE_LABELS[s]),
			'arc',
		),
		fxParam.choice('orientation', 'Orientation', ['horizontal', 'vertical'], ['Horizontal', 'Vertical'], 'horizontal'),
		fxParam.number('bend', 'Bend', 50, { min: -100, max: 100, step: 1 }, { unit: '%' }),
		fxParam.number(
			'horizontalDistortion',
			'Horizontal Distortion',
			0,
			{ min: -100, max: 100, step: 1 },
			{ unit: '%' },
		),
		fxParam.number(
			'verticalDistortion',
			'Vertical Distortion',
			0,
			{ min: -100, max: 100, step: 1 },
			{ unit: '%' },
		),
	],
	gpu: {
		timeInvariant: true,
		sourceMipmaps: true,
		padding,
		uniforms: (p, ctx) => {
			const surface = warpSurface(warpParamsOf(p), ctx.width, ctx.height);
			return { u_twPatch: { vec4s: surface ? [...surface] : new Array<number>(32).fill(0) } };
		},
		passes: (p, ctx) =>
			warpIsIdentity(warpParamsOf(p)) || !(ctx.width > 0 && ctx.height > 0)
				? PASS_THROUGH
				: [{ frag: FRAG, draw: { vert: VERT, vertices: CELLS * CELLS * 6 } }],
	},
});

export const TEXT_WARP_EFFECTS: readonly EffectSpec[] = [TEXT_WARP];
