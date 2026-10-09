// Dissolve ▸ Morph Cut (workstream gaps, docs/wp-notes/gaps.md §AI-2). Premiere smooths a jump cut between two
// takes of a talking head by tracking the subject and interpolating optical flow between the shots. Here the stage
// runs the time workstream's optical flow (time-remap/flow.ts; GPU port compositions/retime/flow-gl.ts) between side A
// and side B at every frame of the span, then draws the motion-compensated picture at the transition's progress with
// the same multi-hypothesis, occlusion-aware interpolation as Time Interpolation ▸ Optical Flow:
//   analysis luma (k×k box, long side ≤ 1024) → 2×2 pyramid (≤ 4 levels) → hierarchical block matching on 8×8 tiles
//   (SAD ±4 at the coarsest level, ±1 around the de-duplicated seeds of the tile and its neighbours below) → sub-pixel
//   parabola → 3×3 median → per pixel ten motion hypotheses checked forward and backward, weighted by agreement.
// The passes are the retime shaders adapted to the fx framework (uv-addressed texels, sides read with tr_from/tr_to,
// premultiplied pictures). Exactly A at progress 0 and B at 1 (the interpolation weights vanish at the ends).

import {
	analysisFactor,
	analysisSize,
	FLOW_BLOCK,
	FLOW_CHOICE_SHARPNESS,
	FLOW_CONSISTENCY_BASE,
	FLOW_CONSISTENCY_SLOPE,
	FLOW_DELTA,
	FLOW_PHOTO_WEIGHT,
	FLOW_RADIUS,
	FLOW_SLOW_BIAS,
	pyramidLevels,
} from '../../../time-remap/flow.ts';
import type { ShaderPass } from '../../fx/shader.ts';
import { defineShaderTransition, TRANSITION_BINS } from '../define.ts';
import { GLSL_TR_EASE } from '../glsl.ts';

const f6 = (x: number) => x.toFixed(6);

/** Texel `q` of a `size` target, addressed like v_uv (row 0 = top). */
const FETCH = /* glsl */ `
vec4 mc_at(sampler2D t, ivec2 q, ivec2 size) {
  q = clamp(q, ivec2(0), size - 1);
  return texture(t, (vec2(q) + 0.5) / vec2(size));
}
ivec2 mc_q() { return ivec2(floor(v_uv * u_resolution)); }`;

const LUMA = /* glsl */ `${FETCH}
float mc_L(vec4 p) { return 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b + 0.25 * p.a; }
void main() {
  ivec2 q = mc_q();
  vec2 src = u_canvasSize;
  float sa = 0.0, sb = 0.0;
  for (int j = 0; j < 16; j++) {
    if (j >= u_mcK) break;
    float yy = min(src.y - 1.0, float(q.y * u_mcK + j));
    for (int i = 0; i < 16; i++) {
      if (i >= u_mcK) break;
      float xx = min(src.x - 1.0, float(q.x * u_mcK + i));
      vec2 uv = (vec2(xx, yy) + 0.5) / src;
      sa += mc_L(tr_from(uv));
      sb += mc_L(tr_to(uv));
    }
  }
  float inv = 1.0 / float(u_mcK * u_mcK);
  fragColor = vec4(sa * inv, sb * inv, 0.0, 1.0);
}`;

const half = (prev: string) => /* glsl */ `${FETCH}
void main() {
  ivec2 q = mc_q();
  ivec2 s = u_mcPrevSize;
  int x0 = min(s.x - 1, q.x * 2), x1 = min(s.x - 1, q.x * 2 + 1);
  int y0 = min(s.y - 1, q.y * 2), y1 = min(s.y - 1, q.y * 2 + 1);
  fragColor = (mc_at(${prev}, ivec2(x0, y0), s) + mc_at(${prev}, ivec2(x1, y0), s)
     + mc_at(${prev}, ivec2(x0, y1), s) + mc_at(${prev}, ivec2(x1, y1), s)) * 0.25;
}`;

/** SAD of a block on a level texture; dir 0 = A→B (r = A, g = B), 1 = B→A. */
const sad = (level: string) => /* glsl */ `
float mc_sad(int dir, int bx, int by, int bs, int dx, int dy) {
  float s = 0.0;
  for (int y = 0; y < 16; y++) {
    if (y >= bs) break;
    int ya = by + y;
    int yb = by + y + dy;
    for (int x = 0; x < 16; x++) {
      if (x >= bs) break;
      vec2 pa = mc_at(${level}, ivec2(bx + x, ya), u_mcLevelSize).rg;
      vec2 pb = mc_at(${level}, ivec2(bx + x + dx, yb), u_mcLevelSize).rg;
      float a = dir == 0 ? pa.r : pa.g;
      float b = dir == 0 ? pb.g : pb.r;
      s += abs(a - b);
    }
  }
  return s;
}`;

const match = (level: string, top: boolean) => /* glsl */ `${FETCH}
${sad(level)}
ivec2 mc_search(int dir, int c, int rr) {
  int bx = (c * ${FLOW_BLOCK}) / u_mcLevelK;
  int by = (rr * ${FLOW_BLOCK}) / u_mcLevelK;
  ivec2 seeds[6];
  int n = 0;
  seeds[n++] = ivec2(0);
  ${
		top
			? ''
			: `ivec2 nb[5] = ivec2[5](ivec2(0, 0), ivec2(-1, 0), ivec2(1, 0), ivec2(0, -1), ivec2(0, 1));
  for (int i = 0; i < 5; i++) {
    ivec2 g = ivec2(c, rr) + nb[i];
    if (g.x < 0 || g.y < 0 || g.x >= u_mcGrid.x || g.y >= u_mcGrid.y) continue;
    vec4 pv = mc_at(u_mcVec, g, u_mcGrid);
    vec2 v = dir == 0 ? pv.xy : pv.zw;
    seeds[n++] = ivec2(round(v)) * 2;
  }`
	}
  for (int i = 1; i < 6; i++) {
    if (i >= n) break;
    ivec2 key = seeds[i];
    int j = i - 1;
    while (j >= 0 && (seeds[j].x > key.x || (seeds[j].x == key.x && seeds[j].y > key.y))) {
      seeds[j + 1] = seeds[j];
      j--;
    }
    seeds[j + 1] = key;
  }
  ivec2 best = ivec2(0);
  float bestE = 3.0e38;
  for (int s = 0; s < 6; s++) {
    if (s >= n) break;
    if (s > 0 && seeds[s] == seeds[s - 1]) continue;
    for (int dy = -4; dy <= 4; dy++) {
      if (dy < -u_mcR || dy > u_mcR) continue;
      for (int dx = -4; dx <= 4; dx++) {
        if (dx < -u_mcR || dx > u_mcR) continue;
        ivec2 d = seeds[s] + ivec2(dx, dy);
        float e = mc_sad(dir, bx, by, u_mcLbs, d.x, d.y) + 1.0e-4 * float(abs(d.x) + abs(d.y));
        if (e < bestE) { bestE = e; best = d; }
      }
    }
  }
  return best;
}
void main() {
  ivec2 q = mc_q();
  fragColor = vec4(vec2(mc_search(0, q.x, q.y)), vec2(mc_search(1, q.x, q.y)));
}`;

const FINE = /* glsl */ `${FETCH}
${sad('u_mcL0')}
float mc_fit(float em, float e0, float ep) {
  float den = em - 2.0 * e0 + ep;
  return den > 1.0e-6 ? clamp((0.5 * (em - ep)) / den, -0.5, 0.5) : 0.0;
}
vec2 mc_refine(int dir, ivec2 t, vec2 dv) {
  int bs = ${FLOW_BLOCK};
  int bx = t.x * bs, by = t.y * bs;
  int dx = int(round(dv.x)), dy = int(round(dv.y));
  float e0 = mc_sad(dir, bx, by, bs, dx, dy);
  float sx = mc_fit(mc_sad(dir, bx, by, bs, dx - 1, dy), e0, mc_sad(dir, bx, by, bs, dx + 1, dy));
  float sy = mc_fit(mc_sad(dir, bx, by, bs, dx, dy - 1), e0, mc_sad(dir, bx, by, bs, dx, dy + 1));
  return vec2(float(dx) + sx, float(dy) + sy);
}
void main() {
  ivec2 q = mc_q();
  vec4 v = mc_at(u_mcVec, q, u_mcGrid);
  fragColor = vec4(mc_refine(0, q, v.xy), mc_refine(1, q, v.zw));
}`;

const MEDIAN = /* glsl */ `${FETCH}
float mc_med(float v[9], int n) {
  for (int i = 1; i < 9; i++) {
    if (i >= n) break;
    float key = v[i];
    int j = i - 1;
    while (j >= 0 && v[j] > key) { v[j + 1] = v[j]; j--; }
    v[j + 1] = key;
  }
  return v[n >> 1];
}
void main() {
  ivec2 q = mc_q();
  float a[9]; float b[9]; float c[9]; float d[9];
  int n = 0;
  for (int dr = -1; dr <= 1; dr++)
    for (int dc = -1; dc <= 1; dc++) {
      ivec2 g = q + ivec2(dc, dr);
      if (g.x < 0 || g.y < 0 || g.x >= u_mcGrid.x || g.y >= u_mcGrid.y) continue;
      vec4 v = mc_at(u_mcVec, g, u_mcGrid);
      a[n] = v.x; b[n] = v.y; c[n] = v.z; d[n] = v.w;
      n++;
    }
  fragColor = u_mcOk ? vec4(mc_med(a, n), mc_med(b, n), mc_med(c, n), mc_med(d, n)) : vec4(0.0);
}`;

const INTERP = /* glsl */ `${FETCH}
vec4 mc_side(int s, vec2 p) {
  vec2 uv = clamp(p, vec2(0.5), u_canvasSize - 0.5) / u_canvasSize;
  return s == 0 ? tr_from(uv) : tr_to(uv);
}
// Bilinear between tile centres; dir 0 = A→B (xy), 1 = B→A (zw). Analysis px in, canvas px out.
vec2 mc_flowAt(int dir, vec2 p) {
  vec2 a = p / float(u_mcK);
  vec2 f = clamp(a / float(${FLOW_BLOCK}) - 0.5, vec2(0.0), vec2(u_mcGrid - 1));
  ivec2 i0 = ivec2(floor(f));
  ivec2 i1 = min(i0 + 1, u_mcGrid - 1);
  vec2 w = f - vec2(i0);
  vec4 v00 = mc_at(u_mcFlow, i0, u_mcGrid), v10 = mc_at(u_mcFlow, ivec2(i1.x, i0.y), u_mcGrid);
  vec4 v01 = mc_at(u_mcFlow, ivec2(i0.x, i1.y), u_mcGrid), v11 = mc_at(u_mcFlow, i1, u_mcGrid);
  vec4 top = v00 + (v10 - v00) * w.x;
  vec4 bot = v01 + (v11 - v01) * w.x;
  vec4 v = top + (bot - top) * w.y;
  return (dir == 0 ? v.xy : v.zw) * float(u_mcK);
}
vec2 mc_tile(int dir, ivec2 g) {
  vec4 v = mc_at(u_mcFlow, g, u_mcGrid);
  return (dir == 0 ? v.xy : v.zw) * float(u_mcK);
}
float mc_match(vec2 u, vec2 v) {
  float err = length(u - v);
  float t0 = ${f6(FLOW_CONSISTENCY_BASE)} + ${f6(FLOW_CONSISTENCY_SLOPE)} * length(v);
  return clamp(2.0 - err / t0, 0.0, 1.0);
}
void main() {
  float uW = tr_progress();
  vec2 p = v_uv * u_canvasSize;
  if (uW <= 0.0) { fragColor = tr_from(v_uv); return; }
  if (uW >= 1.0) { fragColor = tr_to(v_uv); return; }
  vec2 cand[10];
  cand[0] = mc_flowAt(0, p);
  cand[1] = -mc_flowAt(1, p);
  vec2 a = p / float(u_mcK);
  vec2 f = clamp(a / float(${FLOW_BLOCK}) - 0.5, vec2(0.0), vec2(u_mcGrid - 1));
  ivec2 g0 = ivec2(floor(f));
  cand[2] = mc_tile(0, g0); cand[3] = mc_tile(0, g0 + ivec2(1, 0));
  cand[4] = mc_tile(0, g0 + ivec2(0, 1)); cand[5] = mc_tile(0, g0 + ivec2(1, 1));
  cand[6] = -mc_tile(1, g0); cand[7] = -mc_tile(1, g0 + ivec2(1, 0));
  cand[8] = -mc_tile(1, g0 + ivec2(0, 1)); cand[9] = -mc_tile(1, g0 + ivec2(1, 1));
  vec4 cols[10];
  float scores[10];
  float best = -3.0e38;
  for (int h = 0; h < 10; h++) {
    vec2 v = cand[h];
    vec2 qa = p - uW * v;
    vec2 qb = p + (1.0 - uW) * v;
    float ca = mc_match(mc_flowAt(0, qa), v);
    float cb = mc_match(-mc_flowAt(1, qb), v);
    vec4 sa = mc_side(0, qa);
    vec4 sb = mc_side(1, qb);
    float wa = (1.0 - uW) * (ca + ${f6(FLOW_DELTA)});
    float wb = uW * (cb + ${f6(FLOW_DELTA)});
    cols[h] = (sa * wa + sb * wb) / (wa + wb);
    vec3 dd = abs(sa.rgb - sb.rgb);
    float photo = dd.r + dd.g + dd.b;
    float s = ca + cb - ${f6(FLOW_PHOTO_WEIGHT)} * photo * ca * cb - ${f6(FLOW_SLOW_BIAS)} * length(v);
    scores[h] = s;
    best = max(best, s);
  }
  vec4 acc = vec4(0.0);
  float sum = 0.0;
  for (int h = 0; h < 10; h++) {
    float e = exp(${f6(FLOW_CHOICE_SHARPNESS)} * (scores[h] - best));
    sum += e;
    acc += cols[h] * e;
  }
  fragColor = acc / sum;
}`;

/** The flow passes for a stage of `width × height` (exported for tests). */
export function morphCutPasses(width: number, height: number): ShaderPass[] {
	const k = Math.min(16, analysisFactor(width, height));
	const A = analysisSize(width, height, k);
	const cols = Math.max(1, Math.ceil(A.w / FLOW_BLOCK));
	const rows = Math.max(1, Math.ceil(A.h / FLOW_BLOCK));
	const grid = { ivec2: [cols, rows] as [number, number] };
	const nLevels = pyramidLevels(A.w, A.h);
	const sizes = [{ w: A.w, h: A.h }];
	for (let i = 1; i < nLevels; i++)
		sizes.push({
			w: Math.max(1, Math.floor(sizes[i - 1]!.w / 2)),
			h: Math.max(1, Math.floor(sizes[i - 1]!.h / 2)),
		});
	const passes: ShaderPass[] = [
		{
			output: 'mcL0',
			size: { width: A.w, height: A.h },
			format: 'rgba32f',
			filter: 'nearest',
			uniforms: { u_mcK: { int: k } },
			frag: LUMA,
		},
	];
	for (let i = 1; i < nLevels; i++)
		passes.push({
			output: `mcL${i}`,
			size: { width: sizes[i]!.w, height: sizes[i]!.h },
			format: 'rgba32f',
			filter: 'nearest',
			uniforms: { u_mcPrevSize: { ivec2: [sizes[i - 1]!.w, sizes[i - 1]!.h] } },
			frag: half(`u_mcL${i - 1}`),
		});
	const top = nLevels - 1;
	let first = true;
	for (let level = top; level >= 0; level--) {
		const lk = 2 ** level;
		passes.push({
			output: 'mcVec',
			...(first ? {} : { update: true }),
			size: { width: cols, height: rows },
			format: 'rgba32f',
			filter: 'nearest',
			uniforms: {
				u_mcLevelSize: { ivec2: [sizes[level]!.w, sizes[level]!.h] },
				u_mcGrid: grid,
				u_mcLevelK: { int: lk },
				u_mcLbs: { int: Math.max(Math.floor(FLOW_BLOCK / lk), 4) },
				u_mcR: { int: level === top ? FLOW_RADIUS : 1 },
			},
			frag: match(`u_mcL${level}`, level === top),
		});
		first = false;
	}
	passes.push(
		{
			output: 'mcVec',
			update: true,
			size: { width: cols, height: rows },
			format: 'rgba32f',
			filter: 'nearest',
			uniforms: { u_mcLevelSize: { ivec2: [A.w, A.h] }, u_mcGrid: grid },
			frag: FINE,
		},
		{
			output: 'mcFlow',
			size: { width: cols, height: rows },
			format: 'rgba32f',
			filter: 'nearest',
			uniforms: { u_mcGrid: grid, u_mcOk: A.w >= FLOW_BLOCK && A.h >= FLOW_BLOCK },
			frag: MEDIAN,
		},
		{
			include: [GLSL_TR_EASE],
			uniforms: { u_mcGrid: grid, u_mcK: { int: k } },
			frag: INTERP,
		},
	);
	return passes;
}

export const MORPH_CUT = defineShaderTransition({
	id: 'jasper.morph-cut',
	expensive: true,
	label: 'Morph Cut',
	bin: TRANSITION_BINS.dissolve,
	description:
		'Smooths a jump cut between two takes of the same shot (a talking head): optical flow between the clips, then a motion-compensated morph from one into the other.',
	keywords: ['morph', 'jump cut', 'interview', 'optical flow', 'smooth', 'warp'],
	options: { reverse: false },
	gpu: {
		passes: (_p, ctx) => morphCutPasses(ctx.width, ctx.height),
	},
});
