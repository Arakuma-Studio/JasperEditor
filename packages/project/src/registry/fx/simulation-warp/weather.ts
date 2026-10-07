// Simulation ▸ Rainfall, Snowfall, Bubbles, Drizzle, Star Burst (sim-warp workstream; After Effects' CC Rainfall,
// CC Snowfall, CC Bubbles, CC Drizzle, CC Star Burst under neutral names). Closed-form functions of time: every
// item's position is a hash of its index and the clip time, computed in the vertex shader of an instanced draw pass
// (no state, any frame renders directly). Ported from EffectCraft crates/effects/src/sim.rs (rainfall_plan,
// snowfall_plan, bubble_list, drizzle_drops, star_burst_plan; MIT OR Apache-2.0), see licenses/ported/sim-warp.md.
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_DATA } from '../glsl/data.ts';
import { fxParam } from '../params.ts';
import { combinePass, n, pick, popup, randomSeedParam } from './common.ts';
import { choice, h01, num } from './core.ts';
import { GLSL_SPRITES, SPRITE_FRAG_MAIN, SPRITE_VERT_DECLS } from './sprites.ts';

const SIM = 'Simulation';
const TRANSFER = ['composite', 'lighten'] as const;
const TRANSFER_LABELS = ['Composite', 'Lighten'] as const;

/** Weather post: with the original → Composite (0) or Lighten (3); without → the drops only (5). */
const weatherPost = (mode: unknown, withOrig: unknown) =>
	withOrig === false ? 5 : choice(mode, TRANSFER) === 1 ? 3 : 0;

// ---------------------------------------------------------------- Rainfall

export const RAINFALL = defineShaderEffect({
	id: 'jasper.rainfall',
	label: 'Rainfall',
	category: SIM,
	description:
		'Rain streaks falling through the layer with depth, wind and refraction of the picture behind each drop.',
	keywords: ['rain', 'weather', 'drops', 'storm', 'cc rainfall'],
	params: [
		n('drops', 'Drops', 5000, 0, 100000, 0, 20000, 1),
		n('size', 'Size', 1, 0, 50, 0, 10),
		n('sceneDepth', 'Scene Depth', 5000, 0, 20000, 0, 10000, 1),
		n('speed', 'Speed', 4000, 0, 20000, 0, 10000, 1),
		n('wind', 'Wind', 0, -10000, 10000, -2000, 2000, 1),
		fxParam.percent('windVariation', 'Variation % (Wind)', 0),
		n('spread', 'Spread', 0, 0, 1000, 0, 100, 0.1),
		fxParam.color('color', 'Color', [0.8, 0.8, 0.8, 1]),
		fxParam.percent('opacity', 'Opacity', 25),
		pick('transferMode', 'Transfer Mode', TRANSFER, TRANSFER_LABELS, 'lighten'),
		fxParam.toggle('compositeWithOriginal', 'Composite With Original', true),
		popup('appearance', 'Appearance', ['Refracting', 'Soft Solid'], 0, 'Extras'),
		fxParam.point('offset', 'Offset', [0.5, 0.5], { group: 'Extras' }),
		randomSeedParam(),
	],
	expensive: true,
	gpu: {
		kind: 'generator',
		uniforms: (p) => ({
			u_count: { int: Math.max(0, Math.min(100000, Math.floor(num(p.drops, 5000)))) },
			u_post: { int: weatherPost(p.transferMode, p.compositeWithOriginal) },
		}),
		passes: [
			{
				output: 'sprites',
				include: [GLSL_SPRITES],
				draw: {
					vertices: 6,
					instances: { uniform: 'u_count' },
					vert: /* glsl */ `${SPRITE_VERT_DECLS}
void main() {
  int i = gl_InstanceID;
  uint s = fx_pcg(fx_seedBits(u_seed) ^ 0x9e37u);
  float sc = u_pxScale;
  vec2 L = u_box.zw / sc;
  float z = sp_h(i, 1, s);
  float k = 1.0 / (1.0 + z * max(u_sceneDepth, 0.0) / 2500.0);
  float vy = u_speed / 4000.0 * L.y * 2.2 * k;
  float w = u_wind / 1000.0 * L.y * (1.0 + u_windVariation / 100.0 * sp_hs(i, 2, s)) * k + u_spread * sp_hs(i, 7, s) * k;
  float sz = max(u_size, 0.2);
  float len = max(vy * 0.04 * sz, 1.0);
  float lenx = w * 0.04 * sz;
  float m = len + abs(lenx) + 4.0;
  vec2 off = u_offset * L - L * 0.5;
  float y = sp_wrap(sp_h(i, 3, s) * (L.y + 2.0 * m) + vy * u_time + off.y, -m, L.y + 2.0 * m);
  float x = sp_wrap(sp_h(i, 4, s) * (L.x + 2.0 * m) + w * u_time + off.x, -m, L.x + 2.0 * m);
  vec2 p = u_box.xy + vec2(x, y) * sc;
  vec4 c = vec4(u_color.rgb, u_opacity / 100.0 * (0.35 + 0.65 * k));
  if (u_appearance == 0) {
    // Refracting drops show the scene behind them, brightened and offset.
    vec4 b = textureLod(u_source, (p + vec2(2.0 * sc, 0.0)) / u_canvasSize, 0.0);
    if (b.a > 0.0) c.rgb *= (b.rgb / b.a) * 0.6 + 0.5;
  }
  sp_emitSprite(gl_VertexID, p, 8, max(u_size * 0.6 * k * sc, 0.25), 0.0, vec2(-lenx, -len) * sc, c);
}`,
				},
				frag: SPRITE_FRAG_MAIN,
			},
			combinePass(),
		],
	},
});

// ---------------------------------------------------------------- Snowfall

export const SNOWFALL = defineShaderEffect({
	id: 'jasper.snowfall',
	label: 'Snowfall',
	category: SIM,
	description: 'Snowflakes drifting down with depth, wind and wiggle.',
	keywords: ['snow', 'weather', 'flakes', 'winter', 'cc snowfall'],
	params: [
		n('flakes', 'Flakes', 10000, 0, 200000, 0, 50000, 1),
		n('size', 'Size', 3, 0, 50, 0, 20),
		fxParam.percent('sizeVariation', 'Variation % (Size)', 50),
		n('sceneDepth', 'Scene Depth', 5000, 0, 20000, 0, 10000, 1),
		n('speed', 'Speed', 100, 0, 5000, 0, 1000, 0.1),
		fxParam.percent('speedVariation', 'Variation % (Speed)', 50),
		n('wind', 'Wind', 25, -5000, 5000, -500, 500, 0.1),
		fxParam.percent('windVariation', 'Variation % (Wind)', 50),
		n('spread', 'Spread', 0, 0, 1000, 0, 100, 0.1),
		n('wiggleAmount', 'Amount', 2, 0, 100, 0, 20, 0.01, { group: 'Wiggle' }),
		fxParam.percent('wiggleAmountVariation', 'Variation % (Amount)', 50, { group: 'Wiggle' }),
		n('wiggleFrequency', 'Frequency', 1, 0, 20, 0, 5, 0.01, { group: 'Wiggle' }),
		fxParam.percent('wiggleFrequencyVariation', 'Variation % (Frequency)', 50, { group: 'Wiggle' }),
		fxParam.color('color', 'Color', [1, 1, 1, 1]),
		fxParam.percent('opacity', 'Opacity', 100),
		pick('transferMode', 'Transfer Mode', TRANSFER, TRANSFER_LABELS, 'composite'),
		fxParam.toggle('compositeWithOriginal', 'Composite With Original', true),
		fxParam.point('offset', 'Offset', [0.5, 0.5], { group: 'Extras' }),
		randomSeedParam(),
	],
	expensive: true,
	gpu: {
		kind: 'generator',
		uniforms: (p) => ({
			u_count: { int: Math.max(0, Math.min(200000, Math.floor(num(p.flakes, 10000)))) },
			u_post: { int: weatherPost(p.transferMode, p.compositeWithOriginal) },
		}),
		passes: [
			{
				output: 'sprites',
				include: [GLSL_SPRITES],
				draw: {
					vertices: 6,
					instances: { uniform: 'u_count' },
					vert: /* glsl */ `${SPRITE_VERT_DECLS}
void main() {
  int i = gl_InstanceID;
  uint s = fx_pcg(fx_seedBits(u_seed) ^ 0x85ebu);
  float sc = u_pxScale;
  vec2 L = u_box.zw / sc;
  float t = u_time;
  float z = sp_h(i, 1, s);
  float k = 1.0 / (1.0 + z * max(u_sceneDepth, 0.0) / 2500.0);
  float r = max(u_size * 0.5 * k * (1.0 + u_sizeVariation / 100.0 * sp_hs(i, 2, s)), 0.05);
  float vy = u_speed * (L.y / 600.0) * k * (1.0 + u_speedVariation / 100.0 * sp_hs(i, 3, s));
  float vx = u_wind * (L.y / 1200.0) * k * (1.0 + u_windVariation / 100.0 * sp_hs(i, 4, s)) + u_spread * sp_hs(i, 8, s) * k;
  float amp = u_wiggleAmount * 2.0 * k * (1.0 + u_wiggleAmountVariation / 100.0 * sp_hs(i, 5, s));
  float fr = u_wiggleFrequency * (1.0 + u_wiggleFrequencyVariation / 100.0 * sp_hs(i, 6, s));
  float ph = sp_h(i, 9, s) * 6.2831853;
  float m = r + abs(amp) + 2.0;
  vec2 off = u_offset * L - L * 0.5;
  float y = sp_wrap(sp_h(i, 10, s) * (L.y + 2.0 * m) + vy * t + off.y, -m, L.y + 2.0 * m);
  float x = sp_wrap(sp_h(i, 11, s) * (L.x + 2.0 * m) + vx * t + off.x, -m, L.x + 2.0 * m) + amp * sin(fr * t * 6.2831853 + ph);
  vec2 p = u_box.xy + vec2(x, y) * sc;
  sp_emitSprite(gl_VertexID, p, 0, r * sc, 0.0, vec2(0.0), vec4(u_color.rgb, u_opacity / 100.0 * (0.4 + 0.6 * k)));
}`,
				},
				frag: SPRITE_FRAG_MAIN,
			},
			combinePass(),
		],
	},
});

// ---------------------------------------------------------------- Bubbles

const SHADING = ['None', 'Lighten', 'Darken', 'Fade Inwards', 'Fade Outwards'] as const;

export const BUBBLES = defineShaderEffect({
	id: 'jasper.bubbles',
	label: 'Bubbles',
	category: SIM,
	description: 'Turns the layer into rising, wobbling bubbles that refract (liquid) or reflect (metal) its picture.',
	keywords: ['bubble', 'liquid', 'soap', 'cc bubbles'],
	params: [
		n('bubbleAmount', 'Bubble Amount', 100, 0, 10000, 0, 1000, 1),
		n('bubbleSpeed', 'Bubble Speed', 0.5, -10, 10, -2, 2),
		n('wobbleAmplitude', 'Wobble Amplitude', 5, 0, 500, 0, 100, 0.1),
		n('wobbleFrequency', 'Wobble Frequency', 1, 0, 50, 0, 10),
		n('bubbleSize', 'Bubble Size', 1, 0, 20, 0, 5),
		popup('reflectionType', 'Reflection Type', ['Liquid', 'Metal']),
		popup('shadingType', 'Shading Type', SHADING),
		randomSeedParam(),
	],
	gpu: {
		kind: 'generator',
		uniforms: (p) => ({ u_count: { int: Math.max(0, Math.min(10000, Math.floor(num(p.bubbleAmount, 100)))) } }),
		passes: [
			{
				include: [GLSL_SPRITES],
				draw: {
					vertices: 6,
					instances: { uniform: 'u_count' },
					vert: /* glsl */ `
out vec2 v_q;
flat out vec4 v_b; // centre (canvas px), radius, unused
flat out vec2 v_src;
void main() {
  int i = gl_InstanceID;
  uint s = fx_pcg(fx_seedBits(u_seed) ^ 0x27d4u);
  float sc = u_pxScale;
  vec2 L = u_box.zw / sc;
  float t = u_time;
  float base = min(L.x, L.y) * 0.035 * max(u_bubbleSize, 0.0);
  float r = base * (0.5 + sp_h(i, 1, s));
  float travel = L.y + 2.0 * r;
  float v = u_bubbleSpeed * L.y * 0.3 * (0.6 + 0.8 * sp_h(i, 2, s));
  float y = L.y + r - mod(sp_h(i, 3, s) * travel + v * t, max(travel, 1e-3));
  float x0 = sp_h(i, 4, s) * L.x;
  float x = x0 + u_wobbleAmplitude * (r / max(base, 1e-3)) * sin(t * u_wobbleFrequency * 6.2831853 + sp_h(i, 5, s) * 6.2831853);
  vec2 p = u_box.xy + vec2(x, y) * sc;
  float rp = r * sc;
  if (rp <= 0.05) { fx_cull(); v_q = vec2(0.0); v_b = vec4(0.0); v_src = vec2(0.0); return; }
  vec2 q = p + sp_corner(gl_VertexID) * (rp + 1.5);
  v_q = q;
  v_b = vec4(p, rp, 0.0);
  v_src = u_box.xy + vec2(x0, y) * sc;
  fx_emit(q);
}`,
				},
				frag: /* glsl */ `
in vec2 v_q;
flat in vec4 v_b;
flat in vec2 v_src;
void main() {
  float r = max(v_b.z, 0.5);
  vec2 d = (v_q - v_b.xy) / r;
  float d2 = dot(d, d);
  float cov = sp_aa((1.0 - sqrt(d2)) * v_b.z);
  if (cov <= 0.0) { fragColor = vec4(0.0); return; }
  // Liquid refracts (inverted, magnified), metal reflects (wide-angle mirror).
  float k = u_reflectionType == 1 ? 1.6 : -0.7;
  float nz = sqrt(max(1.0 - d2, 0.0));
  vec4 px = texture(u_source, (v_src + d * v_b.z * k) / u_canvasSize);
  vec3 c = px.a > 0.0 ? px.rgb / px.a : vec3(0.6, 0.7, 0.8);
  float a = cov;
  if (u_shadingType == 1) c = c * 0.7 + 0.3 * (1.0 - nz);
  else if (u_shadingType == 2) c = c * (0.5 + 0.5 * nz);
  else if (u_shadingType == 3) a *= sqrt(nz);
  else if (u_shadingType == 4) a *= 1.0 - nz * 0.8;
  vec2 hp = d + 0.35;
  c += max(1.0 - dot(hp, hp) / 0.05, 0.0) * 0.8;
  fragColor = vec4(c * a, a);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Drizzle

/** Most drops Drizzle draws at once (the most recent ones). */
export const DRIZZLE_MAX_DROPS = 4096;

/** Drizzle's live drops at a time: [x, y (layer px), ring radius (layer px), amplitude] per drop. */
export function drizzleDrops(
	p: Record<string, unknown>,
	t: number,
	layer: { width: number; height: number },
	seed: number,
): number[] {
	const rate = Math.max(0, num(p.dripRate, 10));
	const life = Math.max(0.01, num(p.longevity, 1));
	const spreading = num(p.spreading, 100);
	const height = num(p.rippleHeight, 30) / 100;
	const out: number[] = [];
	if (rate <= 0 || t < 0) return out;
	const k1 = Math.floor(t * rate);
	const k0 = Math.max(0, Math.floor((t - life) * rate), k1 - DRIZZLE_MAX_DROPS + 1);
	for (let k = k0; k <= k1; k++) {
		const age = t - k / rate;
		if (age < 0 || age >= life) continue;
		out.push(
			h01(k, 1, seed) * layer.width,
			h01(k, 2, seed) * layer.height,
			(spreading * age * layer.height) / 400,
			height * (1 - age / life) * (0.6 + 0.4 * h01(k, 3, seed)),
		);
	}
	return out;
}

export const DRIZZLE = defineShaderEffect({
	id: 'jasper.drizzle',
	label: 'Drizzle',
	category: SIM,
	description: 'Raindrops hitting a water surface: expanding ripples displace and light the layer.',
	keywords: ['ripple', 'rain', 'water', 'drops', 'cc drizzle'],
	params: [
		n('dripRate', 'Drip Rate', 10, 0, 200, 0, 50),
		n('longevity', 'Longevity (sec)', 1, 0, 30, 0, 5, 0.01, { unit: 's' }),
		fxParam.angle('rippling', 'Rippling', 360),
		n('displacement', 'Displacement', 5, 0, 100, 0, 30),
		n('rippleHeight', 'Ripple Height', 30, 0, 200, 0, 100, 0.1),
		n('spreading', 'Spreading', 100, 0, 1000, 0, 300, 0.1),
		n('lightIntensity', 'Light Intensity', 100, 0, 400, 0, 200, 0.1, { group: 'Light' }),
		fxParam.color('lightColor', 'Light Color', [1, 1, 1, 1], { group: 'Light' }),
		n('lightHeight', 'Light Height', 25, -100, 100, -100, 100, 0.1, { group: 'Light' }),
		fxParam.angle('lightDirection', 'Light Direction', -45, { group: 'Light' }),
		n('ambient', 'Ambient', 0, -200, 200, -100, 100, 0.1, { group: 'Shading' }),
		n('diffuse', 'Diffuse', 0, 0, 200, 0, 100, 0.1, { group: 'Shading' }),
		n('specular', 'Specular', 20, 0, 200, 0, 100, 0.1, { group: 'Shading' }),
		n('roughness', 'Roughness', 0.05, 0.001, 1, 0.001, 0.5, 0.001, { group: 'Shading' }),
		randomSeedParam(),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const seed = Math.floor(ctx.seed * 4294967296) ^ 0x165667b1;
			const drops = drizzleDrops(p, ctx.frame / (ctx.fps > 0 ? ctx.fps : 30), ctx, seed);
			return {
				u_drops: { texels: drops.length ? drops : [0, 0, 0, 0] },
				u_count: { int: drops.length / 4 },
			};
		},
		passes: [
			{
				// The water surface height field, drop by drop (additive, signed: rgba16f).
				output: 'field',
				format: 'rgba16f',
				include: [GLSL_DATA],
				draw: {
					vertices: 6,
					instances: { uniform: 'u_count' },
					blend: 'add',
					vert: /* glsl */ `
out vec2 v_q;
flat out vec4 v_drop; // centre (canvas px), ring radius (px), amplitude
flat out vec2 v_wave; // wavelength, ring width (px)
vec2 dz_corner(int v) {
  int c = v == 3 ? 2 : v == 4 ? 1 : v == 5 ? 3 : v;
  return vec2(c == 1 || c == 3 ? 1.0 : -1.0, c >= 2 ? 1.0 : -1.0);
}
void main() {
  vec4 d = fx_texel(u_drops, gl_InstanceID);
  float sc = u_pxScale;
  float rippling = max(u_rippling / 360.0, 0.05);
  float wavelen = max(u_box.w / sc * 0.04 * sc, 2.0) / clamp(rippling, 0.25, 4.0);
  float width = wavelen * (1.0 + rippling * 2.0);
  vec2 c = u_box.xy + d.xy * sc;
  float r = d.z * sc;
  vec2 q = c + dz_corner(gl_VertexID) * (r + width + 2.0);
  v_q = q;
  v_drop = vec4(c, r, d.w);
  v_wave = vec2(wavelen, width);
  fx_emit(q);
}`,
				},
				frag: /* glsl */ `
in vec2 v_q;
flat in vec4 v_drop;
flat in vec2 v_wave;
void main() {
  float dd = length(v_q - v_drop.xy);
  float u = (dd - v_drop.z) / v_wave.y;
  float v = 0.0;
  if (abs(u) < 1.0) v = v_drop.w * (0.5 + 0.5 * cos(u * 3.14159265)) * cos((dd - v_drop.z) / v_wave.x * 6.2831853);
  fragColor = vec4(v, 0.0, 0.0, 0.0);
}`,
			},
			{
				frag: /* glsl */ `
float dz_f(vec2 uv) { return texture(u_field, uv).r; }
void main() {
  vec2 e = u_texel;
  float gx = dz_f(v_uv + vec2(e.x, 0.0)) - dz_f(v_uv - vec2(e.x, 0.0));
  float gy = dz_f(v_uv + vec2(0.0, e.y)) - dz_f(v_uv - vec2(0.0, e.y));
  vec4 src = texture(u_source, v_uv);
  if (u_count == 0 || (gx == 0.0 && gy == 0.0)) { fragColor = src; return; }
  float sc = u_pxScale;
  vec2 pxp = fx_canvasPx() - vec2(gx, gy) * u_displacement * sc * 4.0;
  vec4 p = texture(u_source, clamp(pxp / u_canvasSize, vec2(0.0), vec2(1.0)));
  vec3 n = normalize(vec3(-gx * 6.0, -gy * 6.0, 1.0));
  float ld = radians(u_lightDirection);
  vec3 l = normalize(vec3(cos(ld), sin(ld), max(u_lightHeight / 100.0, 0.05)));
  float li = u_lightIntensity / 100.0;
  float nl = max(dot(n, l), 0.0);
  vec3 hv = normalize(vec3(l.xy * 0.5, (l.z + 1.0) * 0.5));
  float sp = pow(max(dot(n, hv), 0.0), 1.0 / max(u_roughness, 0.001)) * u_specular / 100.0 * li;
  float shade = 1.0 + (u_ambient / 100.0 + u_diffuse / 100.0 * nl - u_diffuse / 100.0 * l.z) * li;
  fragColor = vec4(p.rgb * shade + sp * u_lightColor.rgb * p.a, p.a);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Star Burst

export const STAR_BURST = defineShaderEffect({
	id: 'jasper.star-burst',
	label: 'Star Burst',
	category: SIM,
	description: 'The layer becomes a field of dots flying toward the viewer, like a starfield warp.',
	keywords: ['stars', 'warp', 'starfield', 'hyperspace', 'cc star burst'],
	params: [
		n('scatter', 'Scatter', 100, 0, 1000, 0, 300, 0.1),
		n('speed', 'Speed', 1, -10, 10, -4, 4),
		fxParam.angle('phase', 'Phase', 0),
		n('gridSpacing', 'Grid Spacing', 2, 1, 100, 1, 20, 1, { unit: 'px' }),
		n('size', 'Size', 100, 0, 1000, 0, 300, 0.1),
		fxParam.percent('blendWithOriginal', 'Blend w. Original', 0),
		randomSeedParam(),
	],
	expensive: true,
	gpu: {
		uniforms: (p, ctx) => {
			const sp = Math.max(1, num(p.gridSpacing, 2));
			const nx = Math.max(1, Math.ceil(ctx.width / sp));
			const ny = Math.max(1, Math.ceil(ctx.height / sp));
			const count = Math.min(nx * ny, 1 << 20);
			// Depth cycles as frac(h_i + T): with the stars sorted by h once, far-to-near order at time T is a rotation.
			const T = (ctx.frame / (ctx.fps > 0 ? ctx.fps : 30)) * num(p.speed, 1) * 0.25 + num(p.phase, 0) / 360;
			const order = starOrder(count, Math.floor(ctx.seed * 4294967296) ^ 0x3c6e);
			const f = T - Math.floor(T);
			// First sorted index whose z = frac(h + f) is smallest: h ≥ 1 − f.
			let lo = 0;
			let hi = count;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (order.h[mid]! < 1 - f) lo = mid + 1;
				else hi = mid;
			}
			return {
				u_count: { int: count },
				u_nx: { int: nx },
				u_rot: { int: lo % Math.max(1, count) },
				u_tz: f,
				u_stars: { texels: order.texels, key: order.key },
			};
		},
		passes: [
			{
				output: 'sprites',
				include: [GLSL_SPRITES, GLSL_DATA],
				draw: {
					vertices: 6,
					instances: { uniform: 'u_count' },
					vert: /* glsl */ `${SPRITE_VERT_DECLS}
void main() {
  int j = (gl_InstanceID + u_rot) % max(u_count, 1);
  vec4 st = fx_texel(u_stars, j); // h, id
  int i = int(st.y + 0.5);
  float sc = u_pxScale;
  vec2 L = u_box.zw / sc;
  float spc = max(u_gridSpacing, 1.0);
  vec2 g = vec2(float(i % u_nx), float(i / u_nx)) * spc + spc * 0.5;
  uint s = fx_pcg(fx_seedBits(u_seed) ^ 0x3c6eu);
  float z = fract(st.x + u_tz);
  float persp = 1.0 / (1.0 - 0.9 * z);
  vec2 cc = L * 0.5;
  vec2 jit = vec2(sp_hs(i, 2, s) * u_scatter * 0.01 * L.x * 0.5, sp_hs(i, 3, s) * u_scatter * 0.01 * L.y * 0.5);
  vec2 q = cc + (g - cc + jit) * persp;
  vec4 src = textureLod(u_source, (u_box.xy + g * sc) / u_canvasSize, 0.0);
  float fade = min(z * 8.0, 1.0) * min((1.0 - z) * 6.0, 1.0);
  vec4 c = src.a > 0.0 ? vec4(src.rgb / src.a, src.a * fade) : vec4(0.0);
  sp_emitSprite(gl_VertexID, u_box.xy + q * sc, 1, spc * 0.5 * u_size / 100.0 * persp * sc, 0.0, vec2(0.0), c);
}`,
				},
				frag: SPRITE_FRAG_MAIN,
			},
			{
				frag: /* glsl */ `
void main() {
  fragColor = mix(texture(u_sprites, v_uv), texture(u_source, v_uv), clamp(u_blendWithOriginal / 100.0, 0.0, 1.0));
}`,
			},
		],
	},
});

/** Stars sorted by their depth phase h (cached per count and seed): texels (h, id), plus the sorted h list. */
const starCache = new Map<string, { h: Float64Array; texels: Float32Array; key: string }>();
export function starOrder(count: number, seed: number) {
	const key = `stars:${count}:${seed}`;
	const hit = starCache.get(key);
	if (hit) return hit;
	const hs = new Float64Array(count);
	for (let i = 0; i < count; i++) hs[i] = Math.fround(h01(i, 1, seed));
	const ids = Array.from({ length: count }, (_, i) => i).sort((a, b) => hs[a]! - hs[b]! || a - b);
	const h = new Float64Array(count);
	const texels = new Float32Array(count * 4);
	ids.forEach((id, j) => {
		h[j] = hs[id]!;
		texels[j * 4] = hs[id]!;
		texels[j * 4 + 1] = id;
	});
	const out = { h, texels, key };
	starCache.set(key, out);
	if (starCache.size > 4) starCache.delete(starCache.keys().next().value!);
	return out;
}

export const WEATHER_EFFECTS: readonly EffectSpec[] = [RAINFALL, SNOWFALL, BUBBLES, DRIZZLE, STAR_BURST];
