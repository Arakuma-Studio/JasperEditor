// Premiere Pro standard effects — Generate, part 2 (family "premiere-stylize-distort-generate"): Lens Flare,
// Lightning, Paint Bucket, Write-on.
// - Lens Flare: additive light — core, glow, rays, a rainbow halo and a chain of ghosts along the line from the flare
//   centre through the layer centre; each Lens Type has its own element set. Padded.
// - Lightning: a jagged bolt (piecewise-linear value noise along the bolt = midpoint-displacement look) with
//   branches, glow (Outside Color) and core (Inside Color), animated deterministically by Speed/Stability.
// - Paint Bucket: GPU flood fill approximation — a tolerance mask at ⅛ and ¼ resolution, then propagation passes in
//   which every matching pixel looks along 8 directions (through matching pixels only) for a pixel filled by the
//   previous pass; the region grows along connected paths from the Fill Point. Connectivity is limited to the reach
//   of the passes (≈ 8 × 20 steps); very long, thin corridors may stay unfilled.
// - Write-on: the framework gives effects their params at the current frame only, so the accumulated stroke of the
//   animated Brush Position (the real effect paints every position up to now) cannot be drawn; this draws the brush
//   dab at the current position (see the family report: a `paramAt(frame)` context would allow the full stroke).
import type { ParamValue } from '../../../schema/common.ts';
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { numberParam as wNum } from '../../param-values.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_BLEND } from '../glsl/blend.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { fxParam } from '../params.ts';
import type { ShaderPass } from '../shader.ts';
import {
	blendWithOriginalParam,
	GLSL_PSDG_BLEND,
	num,
	psdgBlendModeParam,
	randomSeedParam,
	str,
} from './common.ts';
import { GLSL_PSDG_HASH } from './noise-glsl.ts';

/** Padding of Lens Flare: a quarter of the layer diagonal (glow, halo and ghosts spill past the edges). */
export const lensFlarePadding = (w: number, h: number) => Math.ceil(0.25 * Math.hypot(w, h));

export const LENS_FLARE = defineShaderEffect({
	id: 'jasper.lens-flare',
	label: 'Lens Flare',
	category: 'Generate',
	description:
		'Simulates the flare of a bright light shining into a camera lens (three lens types), added over the picture.',
	keywords: ['flare', 'sun', 'light leak', 'glare', 'anamorphic', 'optical'],
	params: [
		fxParam.point('flareCenter', 'Flare Center', [0.25, 0.25]),
		fxParam.number(
			'flareBrightness',
			'Flare Brightness',
			100,
			{ min: 0, max: 300, softMin: 10, step: 1 },
			{ unit: '%', ui: { control: 'slider' } },
		),
		fxParam.choice(
			'lensType',
			'Lens Type',
			['zoom50to300', 'prime35', 'prime105'],
			['50-300mm Zoom', '35mm Prime', '105mm Prime'],
			'zoom50to300',
		),
		blendWithOriginalParam(),
	],
	gpu: {
		kind: 'generator',
		timeInvariant: true,
		padding: (_p, ctx) => lensFlarePadding(ctx.width, ctx.height),
		passes: [
			{
				include: [GLSL_BLEND, GLSL_COLOR, GLSL_PSDG_BLEND],
				frag: /* glsl */ `
vec3 spectrum(float x) { return clamp(fx_hsv2rgb(vec3(fract(x), 0.85, 1.0)), 0.0, 1.0); }
// A ghost: a soft disc (shape 0), ring (1) or hexagon (2) of radius r at c, with a chromatic edge.
vec3 ghost(vec2 p, vec2 c, float r, vec3 col, float intensity, int shape) {
  vec2 d = p - c;
  float dist;
  if (shape == 2) {
    vec2 a = abs(d);
    dist = max(a.x * 0.866025 + a.y * 0.5, a.y);
  } else dist = length(d);
  float x = dist / max(r, 1.0);
  float body = shape == 1 ? exp(-pow((x - 0.9) / 0.12, 2.0)) : (1.0 - smoothstep(0.75, 1.0, x)) * (0.55 + 0.45 * x * x);
  vec3 tint = col * (0.85 + 0.15 * spectrum(x * 0.35 + 0.6));
  return tint * body * intensity * 2.5;
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 size = u_box.zw / u_pxScale;
  float diag = length(size);
  vec2 p = fx_layerPx();
  vec2 f = u_flareCenter * size;
  vec2 c = size * 0.5;
  vec2 axis = c - f;
  vec2 d = p - f;
  float r = length(d);
  float ang = atan(d.y, d.x);
  int lt = u_lensType;
  vec3 light = vec3(0.0);
  // Core and glow (warm white).
  float coreR = diag * (lt == 2 ? 0.018 : 0.014);
  light += vec3(1.0, 0.97, 0.9) * exp(-pow(r / coreR, 2.0)) * 1.6;
  float glowR = diag * (lt == 1 ? 0.11 : 0.07);
  light += vec3(1.0, 0.75, 0.45) * 0.55 / (1.0 + pow(r / glowR, 2.0));
  // Rays.
  float nRays = lt == 0 ? 14.0 : lt == 1 ? 6.0 : 10.0;
  float rays = pow(abs(cos(ang * nRays * 0.5 + 0.3)), lt == 2 ? 24.0 : 40.0) * exp(-r / (diag * (lt == 2 ? 0.16 : 0.1)));
  rays += pow(abs(cos(ang * 3.0 + 1.1)), 60.0) * exp(-r / (diag * 0.22)) * 0.6;
  light += vec3(1.0, 0.9, 0.75) * rays * (lt == 1 ? 0.35 : 0.75);
  // Rainbow halo ring around the light.
  float haloR = diag * (lt == 0 ? 0.2 : lt == 1 ? 0.12 : 0.3);
  float hw = diag * (lt == 2 ? 0.018 : 0.012);
  float hx = (r - haloR) / hw;
  light += spectrum(0.75 - hx * 0.12) * exp(-hx * hx) * (lt == 1 ? 0.12 : 0.22);
  // Ghost chain along the axis (t = 0 at the flare, 1 at the layer centre, 2 = mirrored across it).
  if (lt == 0) {
    light += ghost(p, f + axis * 0.45, diag * 0.012, vec3(0.6, 0.8, 1.0), 0.35, 0);
    light += ghost(p, f + axis * 0.7, diag * 0.04, vec3(0.3, 0.9, 0.5), 0.12, 2);
    light += ghost(p, f + axis * 1.1, diag * 0.02, vec3(1.0, 0.6, 0.3), 0.25, 0);
    light += ghost(p, f + axis * 1.3, diag * 0.07, vec3(0.5, 0.6, 1.0), 0.08, 2);
    light += ghost(p, f + axis * 1.55, diag * 0.03, vec3(1.0, 0.4, 0.6), 0.2, 0);
    light += ghost(p, f + axis * 1.8, diag * 0.11, vec3(0.6, 1.0, 0.7), 0.06, 1);
    light += ghost(p, f + axis * 2.05, diag * 0.05, vec3(1.0, 0.85, 0.4), 0.14, 2);
  } else if (lt == 1) {
    light += ghost(p, f + axis * 0.6, diag * 0.06, vec3(1.0, 0.7, 0.4), 0.1, 0);
    light += ghost(p, f + axis * 1.25, diag * 0.1, vec3(0.5, 0.7, 1.0), 0.07, 0);
    light += ghost(p, f + axis * 1.8, diag * 0.16, vec3(0.7, 1.0, 0.6), 0.05, 1);
  } else {
    light += ghost(p, f + axis * 0.5, diag * 0.02, vec3(1.0, 0.5, 0.3), 0.25, 0);
    light += ghost(p, f + axis * 0.85, diag * 0.035, vec3(0.6, 0.6, 1.0), 0.16, 0);
    light += ghost(p, f + axis * 1.45, diag * 0.06, vec3(1.0, 0.8, 0.5), 0.1, 0);
    light += ghost(p, f + axis * 1.9, diag * 0.09, vec3(0.5, 1.0, 0.8), 0.07, 1);
  }
  light *= u_flareBrightness / 100.0;
  vec4 result = fx_addLight(src, light);
  fragColor = psdg_blendOriginal(result, src, u_blendWithOriginal);
}`,
			},
		],
	},
});

/** Padding of Lightning: the bolt's width/glow plus its sideways amplitude may leave the start–end box. */
export function lightningPadding(p: EffectParams, w: number, h: number): number {
	const width = Math.max(0, num(p.width as number, 10));
	const amp = Math.max(0, num(p.amplitude as number, 10));
	return Math.min(1024, Math.ceil(width * 3 + (amp / 100) * Math.hypot(w, h) * 0.5));
}

export const LIGHTNING = defineShaderEffect({
	id: 'jasper.lightning',
	label: 'Lightning',
	category: 'Generate',
	description:
		'Draws an animated electric bolt with branches between two points: glowing outside colour around a bright core.',
	keywords: ['electricity', 'bolt', 'zap', 'energy', 'storm', 'arc'],
	expensive: true,
	params: [
		fxParam.point('startPoint', 'Start Point', [0.2, 0.15]),
		fxParam.point('endPoint', 'End Point', [0.8, 0.85]),
		fxParam.number('segments', 'Segments', 7, { min: 3, max: 32, step: 1 }),
		fxParam.number('amplitude', 'Amplitude', 10, { min: 0, max: 100, softMax: 50, step: 0.1 }),
		fxParam.number('detailLevel', 'Detail Level', 2, { min: 0, max: 5, step: 1 }),
		fxParam.number('detailAmplitude', 'Detail Amplitude', 0.3, { min: 0, max: 1, step: 0.01 }),
		fxParam.number('branching', 'Branching', 0.4, { min: 0, max: 1, step: 0.01 }),
		fxParam.number('rebranching', 'Rebranching', 0.3, { min: 0, max: 1, step: 0.01 }),
		fxParam.angle('branchAngle', 'Branch Angle', 20),
		fxParam.number('branchSegLength', 'Branch Seg. Length', 0.5, { min: 0, max: 1, step: 0.01 }),
		fxParam.number('branchSegments', 'Branch Segments', 4, { min: 1, max: 10, step: 1 }),
		fxParam.number('branchWidth', 'Branch Width', 0.7, { min: 0, max: 1, step: 0.01 }),
		fxParam.number('speed', 'Speed', 10, { min: 0, max: 100, softMax: 50, step: 0.1 }),
		fxParam.number('stability', 'Stability', 0.3, { min: 0, max: 1, step: 0.01 }),
		fxParam.toggle('fixedEndpoint', 'Fixed Endpoint', false),
		fxParam.pixels('width', 'Width', 10, 100),
		fxParam.number('widthVariation', 'Width Variation', 0.25, { min: 0, max: 1, step: 0.01 }),
		fxParam.number('coreWidth', 'Core Width', 0.4, { min: 0, max: 1, step: 0.01 }),
		fxParam.color('outsideColor', 'Outside Color', [0.45, 0.35, 1, 1]),
		fxParam.color('insideColor', 'Inside Color', [1, 1, 1, 1]),
		fxParam.number('pullForce', 'Pull Force', 0, { min: 0, max: 100, softMax: 20, step: 0.1 }),
		fxParam.angle('pullDirection', 'Pull Direction', 0),
		randomSeedParam(1),
		psdgBlendModeParam('normal'),
	],
	gpu: {
		kind: 'generator',
		padding: (p, ctx) => lightningPadding(p, ctx.width, ctx.height),
		// A uniform trip count (3) keeps the key loop a loop (compile time in software GL).
		uniforms: () => ({ u_three: { int: 3 } }),
		passes: [
			{
				include: [GLSL_PSDG_HASH, GLSL_PSDG_BLEND],
				frag: /* glsl */ `
// Jagged 1D noise: piecewise-linear value noise (a polyline with n segments), octaves = detail levels, evolving in
// time keys (Speed) with Stability keeping part of the shape fixed.
float jag1(float s, float n, int key, int chan) {
  float x = s * n;
  int i = int(floor(x));
  float f = x - float(i);
  float a = psdg_hash3(ivec3(i, key, chan), u_seed) * 2.0 - 1.0;
  float b = psdg_hash3(ivec3(i + 1, key, chan), u_seed) * 2.0 - 1.0;
  return mix(a, b, f);
}
float jag(float s, float n, int chan) {
  float t = u_time * u_speed * 0.5;
  int k = int(floor(t));
  float w = t - float(k);
  w = w * w * (3.0 - 2.0 * w);
  // Keys k, k + 1 (moving) and a fixed key (Stability), one jag1 call site.
  float v[3] = float[3](0.0, 0.0, 0.0);
  for (int j = 0; j < u_three; j++) v[j] = jag1(s, n, j == 2 ? -7 : k + j, chan);
  return mix(mix(v[0], v[1], w), v[2], clamp(u_stability, 0.0, 1.0));
}
float boltOffset(float s, float n, int chan) {
  float v = 0.0;
  float amp = 1.0;
  float freq = n;
  int levels = int(clamp(u_detailLevel, 0.0, 5.0));
  for (int l = 0; l <= levels; l++) {
    v += jag(s, freq, chan + 10 * l) * amp;
    freq *= 2.0;
    amp *= clamp(u_detailAmplitude, 0.0, 1.0);
  }
  return v;
}
// Distance from p to a jagged bolt from a to b (layer px); returns (distance, s at the nearest point).
vec2 boltDistance(vec2 p, vec2 a, vec2 b, float n, float ampPx, int chan, bool pinnedEnd, int samples) {
  vec2 dir = b - a;
  float len = max(length(dir), 1.0e-3);
  vec2 nrm = vec2(-dir.y, dir.x) / len;
  vec2 pull = vec2(cos(radians(u_pullDirection)), sin(radians(u_pullDirection))) * u_pullForce / 100.0 * len;
  float best = 1.0e9, bs = 0.0;
  vec2 prev = a;
  for (int i = 1; i <= samples; i++) {
    float s = float(i) / float(samples);
    float taper = pinnedEnd ? sin(s * 3.14159265) : sin(min(s, 0.5) * 3.14159265);
    vec2 q = a + dir * s + nrm * boltOffset(s, n, chan) * ampPx * taper + pull * s * s;
    vec2 e = q - prev;
    float h = clamp(dot(p - prev, e) / max(dot(e, e), 1.0e-6), 0.0, 1.0);
    float d = length(p - prev - e * h);
    if (d < best) { best = d; bs = s; }
    prev = q;
  }
  return vec2(best, bs);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 size = u_box.zw / u_pxScale;
  vec2 p = fx_layerPx();
  vec2 a = u_startPoint * size, b = u_endPoint * size;
  float len = max(length(b - a), 1.0);
  float n = max(floor(u_segments), 1.0);
  float ampPx = u_amplitude / 100.0 * len;
  // One loop over every bolt (0 = main, 1..nb = branches, nb+1..2nb = their sub-branches) with a single
  // boltDistance call site; trip counts come from uniforms, so compilers do not unroll the heavy bodies.
  int nb = int(floor(clamp(u_branching, 0.0, 1.0) * 8.0 + 0.5));
  vec2 dirMain = (b - a) / len;
  vec2 nrm = vec2(-dirMain.y, dirMain.x);
  float glow = 0.0, core = 0.0, w = max(u_width, 0.5);
  for (int k = 0; k <= 2 * nb; k++) {
    vec2 ba = a, bb = b;
    float bn = n, bamp = ampPx, bwScale = 1.0;
    int chan = 0, samples = 96;
    bool pinned = u_fixedEndpoint;
    if (k > 0) {
      int j = (k - 1) % max(nb, 1);
      bool sub = k > nb;
      if (sub && psdg_hash1(j * 7 + 9, u_seed) >= u_rebranching) continue;
      float s0 = 0.12 + 0.7 * psdg_hash1(j * 7 + 3, u_seed);
      vec2 o = a + (b - a) * s0 + nrm * boltOffset(s0, n, 0) * ampPx * sin(s0 * 3.14159265);
      float side = psdg_hash1(j * 7 + 5, u_seed) < 0.5 ? -1.0 : 1.0;
      float ang = radians(u_branchAngle) * side * (0.7 + 0.6 * psdg_hash1(j * 7 + 6, u_seed));
      vec2 bd = vec2(cos(ang) * dirMain.x - sin(ang) * dirMain.y, sin(ang) * dirMain.x + cos(ang) * dirMain.y);
      float bl = len * clamp(u_branchSegLength, 0.0, 1.0) * (1.0 - s0) * (0.6 + 0.5 * psdg_hash1(j * 7 + 8, u_seed));
      if (bl < 2.0) continue;
      ba = o;
      bb = o + bd * bl;
      bn = max(floor(u_branchSegments), 1.0);
      bamp = ampPx * 1.2 * bl / len;
      bwScale = clamp(u_branchWidth, 0.05, 1.0);
      chan = 20 + j;
      samples = 32;
      pinned = false;
      if (sub) {
        // Rebranching: a sub-branch from the middle of the branch, turning back the other way.
        vec2 bd2 = vec2(cos(-ang) * bd.x - sin(-ang) * bd.y, sin(-ang) * bd.x + cos(-ang) * bd.y);
        ba = mix(o, bb, 0.5);
        bb = ba + bd2 * bl * 0.5;
        bamp = ampPx * 0.3;
        bwScale *= 0.6;
        chan = 40 + j;
        samples = 16;
      }
    }
    vec2 m = boltDistance(p, ba, bb, bn, bamp, chan, pinned, samples);
    float bw = k == 0 ? w * (1.0 + jag(m.y, n * 3.0, 99) * u_widthVariation) : w * bwScale * (1.0 - m.y * 0.7);
    bw = max(bw, 0.3);
    glow = max(glow, exp(-pow(m.x / (bw * 0.9), 2.0)) + 0.35 * exp(-m.x / (bw * 2.2)) * (k == 0 ? 1.0 : 0.7));
    core = max(core, 1.0 - smoothstep(bw * u_coreWidth * 0.35, bw * u_coreWidth * 0.5 + 0.75, m.x));
  }
  glow = clamp(glow, 0.0, 1.0);
  vec3 col = mix(u_outsideColor.rgb, u_insideColor.rgb, core);
  float alpha = clamp(max(glow * u_outsideColor.a, core), 0.0, 1.0);
  vec4 bolt = vec4(col * alpha, alpha);
  fragColor = psdg_blend(u_blendingMode, src, bolt, 1.0);
}`,
			},
		],
	},
});

const FILL_SELECTORS = ['colorAlpha', 'straightColor', 'transparency', 'opacity', 'alphaChannel'] as const;

/** Tolerance-match GLSL shared by the mask passes and the final pass. */
const PAINT_MATCH = /* glsl */ `
float matchAt(vec2 uv) {
  vec4 s = texture(u_source, fx_uvOfLayerNorm(u_fillPoint));
  vec4 c = texture(u_source, uv);
  float tol = u_tolerance / 255.0;
  float d;
  int sel = u_fillSelector;
  if (sel == 0) d = max(max(abs(c.r - s.r), abs(c.g - s.g)), max(abs(c.b - s.b), abs(c.a - s.a)));
  else if (sel == 1) {
    vec3 a = c.a > 0.0 ? c.rgb / c.a : vec3(0.0), b = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
    d = max(max(abs(a.r - b.r), abs(a.g - b.g)), abs(a.b - b.b));
  } else if (sel == 2) d = c.a;                // transparent areas
  else if (sel == 3) d = 1.0 - c.a;            // opaque areas
  else d = abs(c.a - s.a);
  return d <= tol + 0.5 / 255.0 ? 1.0 : 0.0;
}`;

/**
 * Coarse tolerance masks are conservative: a coarse texel (u_sub × u_sub canvas pixels) matches only if every pixel
 * of its footprint matches, so walls thinner than a coarse texel still stop the fill.
 */
const CONSERVATIVE_MATCH = /* glsl */ `
${PAINT_MATCH}
void main() {
  float m = 1.0;
  float h = float(u_sub - 1) * 0.5;
  for (int y = 0; y < u_sub; y++)
    for (int x = 0; x < u_sub; x++) m = min(m, matchAt(v_uv + (vec2(float(x), float(y)) - h) / u_canvasSize));
  fragColor = vec4(m);
}`;

/** Paint Bucket passes: masks at ⅛ and ¼, 4 + 4 propagation passes, then the full-resolution fill. */
function paintBucketPasses(): ShaderPass[] {
	const passes: ShaderPass[] = [
		{
			output: 'tol8',
			scale: 0.125,
			filter: 'nearest',
			frag: CONSERVATIVE_MATCH,
			uniforms: { u_sub: { int: 8 } },
		},
		{
			output: 'tol4',
			scale: 0.25,
			filter: 'nearest',
			frag: CONSERVATIVE_MATCH,
			uniforms: { u_sub: { int: 4 } },
		},
	];
	const prop = (prev: string | null, tol: string, step: string) => /* glsl */ `
void main() {
  float m = texture(${tol}, v_uv).r;
  vec2 fp = fx_uvOfLayerNorm(u_fillPoint);
  if (m < 0.5) { fragColor = vec4(0.0); return; }
  // The seed: the pixel holding the Fill Point.
  if (all(lessThan(abs(v_uv - fp), ${step} * 0.75))) { fragColor = vec4(1.0); return; }
  ${prev ? `if (texture(${prev}, v_uv).r > 0.5) { fragColor = vec4(1.0); return; }` : ''}
  for (int d = 0; d < 8; d++) {
    float a = float(d) * 0.78539816;
    vec2 dir = vec2(cos(a), sin(a)) * ${step};
    for (int i = 1; i <= u_steps; i++) {
      vec2 q = v_uv + dir * float(i);
      if (texture(${tol}, q).r < 0.5) break;
      if (all(lessThan(abs(q - fp), ${step} * 0.75))${prev ? ` || texture(${prev}, q).r > 0.5` : ''}) { fragColor = vec4(1.0); return; }
    }
  }
  fragColor = vec4(0.0);
}`;
	let prev: string | null = null;
	for (let i = 0; i < 8; i++) {
		const coarse = i < 4;
		const out = `fill${i}`;
		passes.push({
			output: out,
			scale: coarse ? 0.125 : 0.25,
			filter: 'nearest',
			frag: prop(
				prev ? `u_${prev}` : null,
				coarse ? 'u_tol8' : 'u_tol4',
				coarse ? '(8.0 / u_canvasSize)' : '(4.0 / u_canvasSize)',
			),
			// Uniform trip counts (not literals): the march loops stay loops instead of being unrolled.
			uniforms: { u_steps: { int: 20 } },
		});
		prev = out;
	}
	// Full-resolution refinement: a matching pixel is filled if the coarse region covers it or is reachable within a
	// few pixels through matching pixels (edge-aware: never across a wall).
	passes.push({
		output: 'fillFull',
		filter: 'nearest',
		uniforms: { u_steps: { int: 6 } },
		frag: /* glsl */ `
${PAINT_MATCH}
void main() {
  if (matchAt(v_uv) < 0.5) { fragColor = vec4(0.0); return; }
  if (texture(u_fill7, v_uv).r > 0.5) { fragColor = vec4(1.0); return; }
  for (int d = 0; d < 8; d++) {
    float a = float(d) * 0.78539816;
    vec2 dir = vec2(cos(a), sin(a)) / u_canvasSize;
    for (int i = 1; i <= u_steps; i++) {
      vec2 q = v_uv + dir * float(i);
      if (matchAt(q) < 0.5) break;
      if (texture(u_fill7, q).r > 0.5) { fragColor = vec4(1.0); return; }
    }
  }
  fragColor = vec4(0.0);
}`,
	});
	passes.push({
		include: [GLSL_PSDG_BLEND],
		uniforms: { u_ring: { int: 12 } },
		frag: /* glsl */ `
${PAINT_MATCH}
float filledAt(vec2 uv) { return texture(u_fillFull, uv).r; }
float ringMax(vec2 uv, float rpx) {
  float m = filledAt(uv);
  for (int i = 0; i < u_ring; i++) {
    float a = float(i) * 0.5235988;
    m = max(m, filledAt(uv + vec2(cos(a), sin(a)) * rpx / u_canvasSize));
  }
  return m;
}
float ringMin(vec2 uv, float rpx) {
  float m = filledAt(uv);
  for (int i = 0; i < u_ring; i++) {
    float a = float(i) * 0.5235988;
    m = min(m, filledAt(uv + vec2(cos(a), sin(a)) * rpx / u_canvasSize));
  }
  return m;
}
float ringAvg(vec2 uv, float rpx) {
  float m = filledAt(uv);
  for (int i = 0; i < u_ring; i++) {
    float a = float(i) * 0.5235988;
    m += filledAt(uv + vec2(cos(a), sin(a)) * rpx / u_canvasSize) + filledAt(uv + vec2(cos(a + 0.26), sin(a + 0.26)) * rpx * 0.5 / u_canvasSize);
  }
  return m / 25.0;
}
void main() {
  vec4 src = texture(u_source, v_uv);
  if (!fx_inBox(v_uv)) { fragColor = src; return; }
  float r = max(u_spreadRadius, 0.0) * u_pxScale;
  float mask;
  int st = u_stroke;
  if (st == 1) mask = ringAvg(v_uv, max(u_featherSoftness * u_pxScale, 1.0));        // Feather
  else if (st == 2) mask = ringMax(v_uv, max(r, 1.0));                               // Spread
  else if (st == 3) mask = ringMin(v_uv, max(r, 1.0));                               // Choke
  else if (st == 4) mask = clamp(ringMax(v_uv, max(r, 1.0)) - ringMin(v_uv, max(r, 1.0)), 0.0, 1.0); // Stroke
  else mask = ringAvg(v_uv, 0.75);                                                    // Antialias
  if (u_invertFill) mask = 1.0 - mask;
  if (u_viewThreshold) { fragColor = vec4(vec3(mask), 1.0); return; }
  vec4 fill = fx_premultiply(u_color) * mask;
  fragColor = psdg_blend(u_blendingMode, src, fill, u_opacity / 100.0);
}`,
	});
	return passes;
}

export const PAINT_BUCKET = defineShaderEffect({
	id: 'jasper.paint-bucket',
	label: 'Paint Bucket',
	category: 'Generate',
	description:
		'Fills the contiguous area around Fill Point whose colour is within Tolerance with a colour (flood fill), e.g. to colour cartoon outlines.',
	keywords: ['flood fill', 'fill', 'colorize', 'cartoon', 'bucket'],
	expensive: true,
	params: [
		fxParam.point('fillPoint', 'Fill Point', [0.5, 0.5]),
		fxParam.choice(
			'fillSelector',
			'Fill Selector',
			FILL_SELECTORS,
			['Color & Alpha', 'Straight Color', 'Transparency', 'Opacity', 'Alpha Channel'],
			'colorAlpha',
		),
		fxParam.number('tolerance', 'Tolerance', 10, { min: 0, max: 255, step: 0.1 }),
		fxParam.toggle('viewThreshold', 'View Threshold', false),
		fxParam.choice(
			'stroke',
			'Stroke',
			['antialias', 'feather', 'spread', 'choke', 'stroke'],
			['Antialias', 'Feather', 'Spread', 'Choke', 'Stroke'],
			'antialias',
		),
		fxParam.pixels('spreadRadius', 'Spread Radius', 3, 100),
		fxParam.pixels('featherSoftness', 'Feather Softness', 3, 100),
		fxParam.toggle('invertFill', 'Invert Fill', false),
		fxParam.color('color', 'Color', [1, 0, 0, 1]),
		fxParam.percent('opacity', 'Opacity', 100),
		psdgBlendModeParam('normal'),
	],
	gpu: {
		kind: 'generator',
		timeInvariant: true,
		passes: paintBucketPasses(),
	},
});

/** Most brush positions of the accumulated Write-on stroke (sampled evenly in time; consecutive ones joined). */
export const WRITE_ON_POINTS = 64;

const wPt = (v: ParamValue | undefined): [number, number] =>
	Array.isArray(v) && v.length === 2 ? [wNum(v[0], 0.5), wNum(v[1], 0.5)] : [0.5, 0.5];
const wColor = (v: ParamValue | undefined): number[] =>
	Array.isArray(v) && v.length === 4 ? v.map((x, i) => wNum(x, i === 3 ? 1 : 0)) : [1, 1, 1, 1];

/**
 * The accumulated Write-on stroke at a frame: the brush path from the clip start (or the last Stroke Length
 * seconds) to now, sampled every Brush Spacing (at most WRITE_ON_POINTS, newest first) from the params at those
 * times (`ctx.paramsAt`); Paint/Brush Time Properties take colour/opacity and size/hardness from each sample's time,
 * else from now. `connect` = samples closer than a frame are joined into a continuous stroke. n = 1 (the brush at
 * its current position only, the original drawing) without `paramsAt`, at the first frame or for a still brush.
 */
export function writeOnStroke(
	p: EffectParams,
	ctx: { frame: number; fps: number; width: number; height: number; paramsAt?: (f: number) => EffectParams },
): { n: number; connect: boolean; pos: number[]; color: number[]; opacity: number[] } {
	const N = WRITE_ON_POINTS;
	const out = {
		n: 1,
		connect: true,
		pos: new Array<number>(N * 4).fill(0),
		color: new Array<number>(N * 4).fill(0),
		opacity: new Array<number>(N).fill(0),
	};
	const fps = ctx.fps > 0 ? ctx.fps : 30;
	if (!ctx.paramsAt || !(ctx.frame > 0)) return out;
	const lenFrames = Math.max(0, wNum(p.strokeLength)) * fps;
	const start = lenFrames > 0 ? Math.max(0, ctx.frame - lenFrames) : 0;
	const span = ctx.frame - start;
	const spacing = Math.max(0.001, wNum(p.brushSpacing, 0.001)) * fps;
	const step = Math.max(spacing, span / (N - 1));
	const count = Math.min(N, Math.floor(span / step + 1e-9) + 1);
	const paintTime = str(p.paintTimeProperties, 'none');
	const brushTime = str(p.brushTimeProperties, 'none');
	const rows: number[][] = [];
	for (let k = 0; k < count; k++) {
		const q = k === 0 ? p : ctx.paramsAt(ctx.frame - k * step);
		const [x, y] = wPt(q.brushPosition);
		const sizeQ = brushTime === 'size' || brushTime === 'sizeHardness' ? q : p;
		const hardQ = brushTime === 'hardness' || brushTime === 'sizeHardness' ? q : p;
		const c = wColor((paintTime === 'color' ? q : p).color);
		const op = wNum((paintTime === 'opacity' ? q : p).brushOpacity, 100) / 100;
		rows.push([
			x * ctx.width,
			y * ctx.height,
			Math.max(0, wNum(sizeQ.brushSize, 10)) * 0.5,
			Math.min(1, Math.max(0, wNum(hardQ.brushHardness, 75) / 100)),
			c[0]! * c[3]!,
			c[1]! * c[3]!,
			c[2]! * c[3]!,
			c[3]!,
			op,
		]);
	}
	if (rows.every((r) => r.every((v, i) => v === rows[0]![i]))) return out;
	rows.forEach((r, k) => {
		for (let i = 0; i < 4; i++) {
			out.pos[k * 4 + i] = r[i]!;
			out.color[k * 4 + i] = r[4 + i]!;
		}
		out.opacity[k] = r[8]!;
	});
	return { ...out, n: rows.length, connect: step < 1 + 1e-9 || spacing < 1 };
}

export const WRITE_ON = defineShaderEffect({
	id: 'jasper.write-on',
	label: 'Write-on',
	category: 'Generate',
	description:
		'Paints with a brush at Brush Position: animate it to write — the stroke accumulates along the brush path since the clip start (or the last Stroke Length seconds).',
	keywords: ['handwriting', 'paint', 'brush', 'reveal', 'signature', 'draw on'],
	params: [
		fxParam.point('brushPosition', 'Brush Position', [0.5, 0.5]),
		fxParam.color('color', 'Color', [1, 1, 1, 1]),
		fxParam.number(
			'brushSize',
			'Brush Size',
			10,
			{ min: 0, max: 1000, softMax: 50, step: 0.1 },
			{ unit: 'px' },
		),
		fxParam.percent('brushHardness', 'Brush Hardness', 75),
		fxParam.percent('brushOpacity', 'Brush Opacity', 100),
		fxParam.number('strokeLength', 'Stroke Length (secs)', 0, { min: 0, max: 30, step: 0.01 }, { unit: 's' }),
		fxParam.number(
			'brushSpacing',
			'Brush Spacing (secs)',
			0.001,
			{ min: 0.001, max: 1, step: 0.001 },
			{ unit: 's' },
		),
		fxParam.choice(
			'paintTimeProperties',
			'Paint Time Properties',
			['none', 'opacity', 'color'],
			['None', 'Opacity', 'Color'],
			'none',
		),
		fxParam.choice(
			'brushTimeProperties',
			'Brush Time Properties',
			['none', 'size', 'hardness', 'sizeHardness'],
			['None', 'Size', 'Hardness', 'Size & Hardness'],
			'none',
		),
		fxParam.choice(
			'paintStyle',
			'Paint Style',
			['onOriginal', 'onTransparent', 'revealOriginal'],
			['On Original Image', 'On Transparent', 'Reveal Original Image'],
			'onOriginal',
		),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => {
			const st = writeOnStroke(p, ctx);
			return {
				u_woN: { int: st.n },
				u_woConnect: st.connect,
				u_woP: { vec4s: st.pos },
				u_woC: { vec4s: st.color },
				u_woO: { vec4s: st.opacity },
			};
		},
		passes: [
			{
				include: [GLSL_BLEND],
				frag: /* glsl */ `
float wo_dab(float d, float r, float hard) {
  float aa = 0.5 / u_pxScale;
  return r <= 0.0 ? 0.0 : 1.0 - smoothstep(r * hard - aa, r + aa, d);
}
float wo_op(int k) { return u_woO[k / 4][k - (k / 4) * 4]; }
void main() {
  vec4 src = texture(u_source, v_uv);
  if (!fx_inBox(v_uv)) { fragColor = src; return; }
  if (u_woN > 1) {
    // The accumulated stroke: the strongest dab (or joined segment) of the brush path covers each pixel.
    vec2 q = fx_layerPx();
    float best = 0.0, bestMask = 0.0;
    vec4 col = vec4(0.0);
    for (int k = 0; k < ${WRITE_ON_POINTS}; k++) {
      if (k >= u_woN) break;
      vec4 a = u_woP[k];
      vec4 ca = u_woC[k];
      float oa = wo_op(k);
      float dab;
      vec4 c;
      float o;
      if (u_woConnect && k + 1 < u_woN) {
        vec4 b = u_woP[k + 1];
        vec2 pa = q - a.xy, ba = b.xy - a.xy;
        float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
        dab = wo_dab(length(pa - ba * h), mix(a.z, b.z, h), mix(a.w, b.w, h));
        c = mix(ca, u_woC[k + 1], h);
        o = mix(oa, wo_op(k + 1), h);
      } else {
        dab = wo_dab(length(q - a.xy), a.z, a.w);
        c = ca;
        o = oa;
      }
      float m = dab * o;
      if (m * c.a > best) { best = m * c.a; col = c * m; }
      bestMask = max(bestMask, m);
    }
    if (u_paintStyle == 0) fragColor = fx_over(col, src);
    else if (u_paintStyle == 1) fragColor = col;
    else fragColor = src * bestMask;
    return;
  }
  vec2 c = u_brushPosition * u_box.zw / u_pxScale;
  float r = max(u_brushSize, 0.0) * 0.5;
  float d = length(fx_layerPx() - c);
  float hard = clamp(u_brushHardness / 100.0, 0.0, 1.0);
  float aa = 0.5 / u_pxScale;
  float dab = r <= 0.0 ? 0.0 : 1.0 - smoothstep(r * hard - aa, r + aa, d);
  dab *= u_brushOpacity / 100.0;
  vec4 paint = fx_premultiply(u_color) * dab;
  if (u_paintStyle == 0) fragColor = fx_over(paint, src);
  else if (u_paintStyle == 1) fragColor = paint;
  else fragColor = src * dab;
}`,
			},
		],
	},
});

export const PSDG_GENERATE_RENDER_EFFECTS: readonly EffectSpec[] = [
	LENS_FLARE,
	LIGHTNING,
	PAINT_BUCKET,
	WRITE_ON,
];
