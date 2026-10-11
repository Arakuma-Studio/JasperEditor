// Distort ▸ Mesh Warp, Liquify (After Effects' effects of those names). Both keep a keyframable
// Distortion Mesh (`mesh` param, layouts in meshes.ts) edited on the Program monitor (Mesh Warp's vertex and tangent
// handles, Liquify's brushes) or by commands (`meshWarp.setVertex`, `liquify.stroke`). Mesh Warp draws the layer
// through Coons patches of cubic Bézier edges (a forward mesh of a draw pass); Liquify is a backward displacement map.
import type { EffectParams, EffectSpec, ParamSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_DATA } from '../glsl/data.ts';
import { fxParam } from '../params.ts';
import { n, popup, values } from './common.ts';
import { choice, clamp, num } from './core.ts';
import { GLSL_POLY_CHUNK, polyUniform } from './distort.ts';
import {
	LIQUIFY_TOOL_LABELS,
	liquifyGrid,
	liquifyOf,
	MW_STRIDE,
	meshWarpIsRest,
	meshWarpOf,
} from './meshes.ts';
import { MASK_CHOICES, maskOf } from './playground.ts';

const meshParam = (name: string, label: string): ParamSpec => ({
	name,
	label,
	type: 'mesh',
	default: [],
	animatable: true,
});

const gridOf = (p: EffectParams) => ({
	cols: clamp(Math.round(num(p.columns, 7)), 1, 31),
	rows: clamp(Math.round(num(p.rows, 7)), 1, 31),
});

export const MESH_WARP = defineShaderEffect({
	id: 'jasper.mesh-warp',
	label: 'Mesh Warp',
	category: 'Distort',
	description:
		'Distorts the layer with a grid of Bézier patches: drag vertices and tangents on the Program monitor; the Distortion Mesh is keyframable.',
	keywords: ['mesh', 'warp', 'grid', 'bezier', 'distort'],
	params: [
		n('rows', 'Rows', 7, 1, 31, 1, 31, 1, { animatable: false }),
		n('columns', 'Columns', 7, 1, 31, 1, 31, 1, { animatable: false }),
		n('quality', 'Quality', 8, 1, 10, 1, 10, 1, { animatable: false }),
		meshParam('distortionMesh', 'Distortion Mesh'),
	],
	gpu: {
		timeInvariant: false,
		padding: (p, ctx) => {
			const { cols, rows } = gridOf(p);
			const m = meshWarpOf(p.distortionMesh, cols, rows);
			let [x0, y0, x1, y1] = [0, 0, 1, 1];
			for (let k = 3; k < m.length; k += MW_STRIDE)
				for (let t = 0; t < 5; t++) {
					const x = m[k]! + (t ? m[k + t * 2]! : 0);
					const y = m[k + 1]! + (t ? m[k + t * 2 + 1]! : 0);
					x0 = Math.min(x0, x);
					y0 = Math.min(y0, y);
					x1 = Math.max(x1, x);
					y1 = Math.max(y1, y);
				}
			const c = (v: number) => Math.min(2048, Math.ceil(Math.max(0, v) + 1));
			return {
				left: c(-x0 * ctx.width),
				top: c(-y0 * ctx.height),
				right: c((x1 - 1) * ctx.width),
				bottom: c((y1 - 1) * ctx.height),
			};
		},
		uniforms: (p) => {
			const { cols, rows } = gridOf(p);
			const m = meshWarpOf(p.distortionMesh, cols, rows);
			const texels: number[] = [];
			for (let k = 3; k < m.length; k += MW_STRIDE) texels.push(...m.slice(k, k + MW_STRIDE), 0, 0);
			return {
				u_mw: { texels },
				u_mwGrid: { ivec2: [cols, rows] },
				u_mwQ: { int: clamp(Math.round(num(p.quality, 8)), 1, 10) },
				u_mwRest: meshWarpIsRest(m),
			};
		},
		passes: (p) => {
			const { cols, rows } = gridOf(p);
			const q = clamp(Math.round(num(p.quality, 8)), 1, 10);
			return [
				{
					include: [GLSL_DATA],
					draw: {
						vertices: cols * rows * q * q * 6,
						instances: 1,
						vert: /* glsl */ `
out vec2 v_t;
// Vertex (i, j): position and its tangent handles (left, right, up, down), layer-normalised absolute.
void mw_v(int i, int j, out vec2 p, out vec2 l, out vec2 r, out vec2 u, out vec2 d) {
  int k = (j * (u_mwGrid.x + 1) + i) * 3;
  vec4 a = fx_texel(u_mw, k), b = fx_texel(u_mw, k + 1), c = fx_texel(u_mw, k + 2);
  p = a.xy; l = p + a.zw; r = p + b.xy; u = p + b.zw; d = p + c.xy;
}
vec2 mw_bez(vec2 a, vec2 b, vec2 c, vec2 e, float t) {
  float s = 1.0 - t;
  return a * s * s * s + b * 3.0 * s * s * t + c * 3.0 * s * t * t + e * t * t * t;
}
void main() {
  int Q = u_mwQ;
  int quad = gl_VertexID / 6;
  int k = gl_VertexID % 6;
  int qi = k < 3 ? k : (k == 3 ? 2 : (k == 4 ? 1 : 3));
  int sub = Q * u_mwGrid.x;
  int gi = quad % sub + ((qi == 1 || qi == 3) ? 1 : 0);
  int gj = quad / sub + (qi >= 2 ? 1 : 0);
  int ci = min(gi / Q, u_mwGrid.x - 1);
  int cj = min(gj / Q, u_mwGrid.y - 1);
  float u = float(gi - ci * Q) / float(Q);
  float v = float(gj - cj * Q) / float(Q);
  vec2 p00, l00, r00, u00, d00, p10, l10, r10, u10, d10, p01, l01, r01, u01, d01, p11, l11, r11, u11, d11;
  mw_v(ci, cj, p00, l00, r00, u00, d00);
  mw_v(ci + 1, cj, p10, l10, r10, u10, d10);
  mw_v(ci, cj + 1, p01, l01, r01, u01, d01);
  mw_v(ci + 1, cj + 1, p11, l11, r11, u11, d11);
  vec2 top = mw_bez(p00, r00, l10, p10, u);
  vec2 bot = mw_bez(p01, r01, l11, p11, u);
  vec2 lef = mw_bez(p00, d00, u01, p01, v);
  vec2 rig = mw_bez(p10, d10, u11, p11, v);
  vec2 bil = (1.0 - u) * (1.0 - v) * p00 + u * (1.0 - v) * p10 + (1.0 - u) * v * p01 + u * v * p11;
  vec2 s = (1.0 - v) * top + v * bot + (1.0 - u) * lef + u * rig - bil;
  v_t = vec2((float(ci) + u) / float(u_mwGrid.x), (float(cj) + v) / float(u_mwGrid.y));
  if (u_mwRest) s = v_t;
  fx_emit(fx_canvasPxOfLayerNorm(s));
}`,
					},
					frag: /* glsl */ `
in vec2 v_t;
void main() {
  vec2 w = max(fwidth(v_t), vec2(1e-6));
  vec2 e = min(v_t, 1.0 - v_t) / w;
  float cov = u_mwRest ? 1.0 : clamp(min(e.x, e.y) + 0.5, 0.0, 1.0);
  fragColor = texture(u_source, fx_uvOfLayerNorm(clamp(v_t, 0.0, 1.0))) * cov;
}`,
				},
			];
		},
	},
});

const MESH_SIZES = ['Small', 'Medium', 'Large'] as const;

export const LIQUIFY = defineShaderEffect({
	id: 'jasper.liquify',
	label: 'Liquify',
	category: 'Distort',
	description:
		'Push, twirl, pucker, bloat, shift, reflect, clone or reconstruct the picture with brushes on the Program monitor; the Distortion Mesh is keyframable.',
	keywords: ['liquify', 'warp', 'brush', 'push', 'bloat', 'pucker', 'twirl', 'retouch'],
	params: [
		popup('tool', 'Tool', LIQUIFY_TOOL_LABELS, 0),
		n('brushSize', 'Brush Size', 64, 1, 600, 1, 600, 1, {
			group: 'Warp Tool Options',
			animatable: false,
			unit: 'px',
		}),
		n('brushPressure', 'Brush Pressure', 50, 1, 100, 1, 100, 1, {
			group: 'Warp Tool Options',
			animatable: false,
		}),
		popup('freezeAreaMask', 'Freeze Area Mask', MASK_CHOICES, 0, 'Warp Tool Options'),
		n('turbulentJitter', 'Turbulent Jitter', 70, 1, 100, 1, 100, 1, {
			group: 'Warp Tool Options',
			animatable: false,
		}),
		fxParam.vec2(
			'cloneOffset',
			'Clone Offset',
			[0, 0],
			{ step: 0.1 },
			{ group: 'Warp Tool Options', animatable: false },
		),
		popup(
			'reconstructionMode',
			'Reconstruction Mode',
			['Revert', 'Displace', 'Amplitwist', 'Affine'],
			0,
			'Warp Tool Options',
		),
		fxParam.toggle('viewMesh', 'View Mesh', false, { group: 'View Options' }),
		popup('meshSize', 'Mesh Size', MESH_SIZES, 1, 'View Options'),
		fxParam.color('meshColor', 'Mesh Color', [0.5, 0.5, 0.5, 1], { group: 'View Options' }),
		fxParam.toggle('viewFreezeAreaMask', 'View Freeze Area Mask', false, { group: 'View Options' }),
		meshParam('distortionMesh', 'Distortion Mesh'),
		fxParam.vec2('distortionMeshOffset', 'Distortion Mesh Offset', [0, 0], { step: 0.1 }),
		n('distortionPercentage', 'Distortion Percentage', 100, 0, 200, 0, 200, 0.1, { unit: '%' }),
		popup('distortionDisplayQuality', 'Distortion Display Quality', ['Draft', 'Smooth'], 1),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const w = ctx.width;
			const h = ctx.height;
			const g = liquifyGrid(w, h);
			const m = liquifyOf(p.distortionMesh, w, h);
			const texels = new Float32Array(g.nx * g.ny * 4);
			let any = false;
			for (let i = 0; i < g.nx * g.ny; i++) {
				// Stored in cells (meshes.ts); the shader wants layer px.
				texels[i * 4] = m[3 + i * 2]! * g.cell;
				texels[i * 4 + 1] = m[3 + i * 2 + 1]! * g.cell;
				if (texels[i * 4] !== 0 || texels[i * 4 + 1] !== 0) any = true;
			}
			const freeze = maskOf(p.freezeAreaMask, ctx.structures?.masks);
			return {
				u_lq: { texels },
				u_lqGrid: { ivec2: [g.nx, g.ny] },
				u_lqCell: g.cell,
				u_lqAny: any,
				u_lqFreeze: polyUniform(freeze),
				u_lqHasFreeze: !!freeze && freeze.points.length >= 3,
				u_lqFreezeInv: !!freeze?.inverted,
				u_lqMeshStep: g.cell * [2, 4, 8][choice(p.meshSize, values(MESH_SIZES), 1)]!,
			};
		},
		passes: [
			{
				include: [GLSL_DATA, GLSL_POLY_CHUNK],
				frag: /* glsl */ `
void main() {
  vec2 lp = fx_layerPx();
  vec2 off = u_distortionMeshOffset;
  vec2 d = vec2(0.0);
  if (u_lqAny) d = fx_texelGrid(u_lq, u_lqGrid.x, u_lqGrid.y, (lp - off) / u_lqCell).xy;
  // Outside the mesh: no distortion.
  vec2 g = (lp - off) / u_lqCell;
  if (any(lessThan(g, vec2(0.0))) || any(greaterThan(g, vec2(u_lqGrid - 1)))) d = vec2(0.0);
  vec2 sp = lp + d * u_distortionPercentage / 100.0;
  vec4 c = d == vec2(0.0) ? texture(u_source, v_uv) : texture(u_source, fx_uvOfLayerPx(sp));
  if (u_viewFreezeAreaMask && u_lqHasFreeze && (rs_inside(u_lqFreeze, lp) != u_lqFreezeInv))
    c = vec4(mix(c.rgb, vec3(c.a), 0.5) * vec3(1.0, 0.5, 0.5), max(c.a, 0.5));
  if (u_viewMesh) {
    vec2 q = mod(sp - off, u_lqMeshStep);
    float lw = 0.75 / u_pxScale;
    if (q.x < lw || q.y < lw) c = vec4(u_meshColor.rgb, 1.0);
  }
  fragColor = c;
}`,
			},
		],
	},
});

export const MESH_WARP_EFFECTS: readonly EffectSpec[] = [LIQUIFY, MESH_WARP];
