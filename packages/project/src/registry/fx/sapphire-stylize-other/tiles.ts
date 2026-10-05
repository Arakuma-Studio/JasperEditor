// "Sapphire other stylize" family — tiling effects: S_Mosaic (block averages), S_RomanTile (lit mosaic tesserae with
// grout) and S_StripSlide (strips sliding off to reveal a Background). Parameters follow Boris FX's public Sapphire
// documentation (AE/Premiere host), minus Mocha/preset/Opacity-handling/crop params. Clean-room implementations.
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_BLEND } from '../glsl/blend.ts';
import { GLSL_BLUR } from '../glsl/blur.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { GLSL_HASH } from '../glsl/hash.ts';
import { GLSL_NOISE } from '../glsl/noise.ts';
import { GLSL_UV } from '../glsl/sample.ts';
import { fxParam, sapphireCommonParams } from '../params.ts';
import type { FxPlanContext, ShaderPass } from '../shader.ts';
import {
	blurPasses,
	clamp,
	GLSL_SSO_COMMON,
	GLSL_SSO_MASK,
	maskParams,
	num,
	sapphireBlurPx,
	sapphirePoint,
	sNum,
} from './common.ts';

const BIN = SAPPHIRE_BINS.stylize;

// ---------------------------------------------------------------- S_Mosaic

/** Block size of S_Mosaic in canvas px: Pixel Frequency blocks across the layer width, Pixel Rel Height tall. */
export function mosaicBlockPx(
	p: { pixelFrequency?: unknown; pixelRelHeight?: unknown },
	ctx: Pick<FxPlanContext, 'width' | 'pxScale'>,
): [number, number] {
	const w = (ctx.width * ctx.pxScale) / Math.max(1, num(p.pixelFrequency, 40));
	return [w, w * Math.max(0.01, num(p.pixelRelHeight, 1))];
}

export const S_MOSAIC: EffectSpec = defineShaderEffect({
	id: 'jasper.s.mosaic',
	label: 'S_Mosaic',
	category: 'Stylize',
	bin: BIN,
	description:
		'Pixelates the picture into blocks of their average colour. Pixel Frequency = blocks across the layer width; Pixel Shift moves the grid (Sapphire units: 1.0 = half the width).',
	keywords: ['pixelate', 'pixelize', 'censor', 'blocks', '8-bit', 'retro'],
	params: [
		sNum('pixelFrequency', 'Pixel Frequency', 40, { min: 1, softMax: 200, step: 0.1 }),
		sNum('pixelRelHeight', 'Pixel Rel Height', 1, { min: 0.01, softMax: 4 }),
		fxParam.vec2('pixelShift', 'Pixel Shift', [0, 0], { softMin: -1, softMax: 1, step: 0.001 }),
		sNum('smoothColors', 'Smooth Colors', 0, { min: 0, softMax: 1 }),
		...sapphireCommonParams(),
		...maskParams(),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => ({ u_blockPx: mosaicBlockPx(p, ctx) }),
		passes: (p, ctx) => {
			const [bw, bh] = mosaicBlockPx(p, ctx);
			const smooth = sapphireBlurPx(p.smoothColors, ctx);
			const out: ShaderPass[] =
				smooth > 0.05 ? blurPasses({ input: 'source', output: 'smooth', sigmaX: smooth }) : [];
			const input = smooth > 0.05 ? 'u_smooth' : 'u_source';
			// Separable box filter of exactly one block, read at the block centre = the block's average colour.
			const scale = Math.max(bw, bh) > 32 ? 0.5 : 1;
			const box = (tex: string, dir: [number, number], r: number, output: string): ShaderPass => ({
				output,
				include: [GLSL_BLUR],
				scale,
				uniforms: { u_dir: dir, u_r: r * scale },
				frag: /* glsl */ `
void main() {
  vec2 size = vec2(textureSize(${tex}, 0));
  float r = u_r * dot(u_dir, size / u_resolution);
  fragColor = fx_box1d(${tex}, v_uv, u_dir, 1.0 / size, r);
}`,
			});
			return [
				...out,
				box(input, [1, 0], bw / 2, 'avgH'),
				box('u_avgH', [0, 1], bh / 2, 'avg'),
				{
					include: [GLSL_SSO_COMMON, GLSL_SSO_MASK],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 shift = u_pixelShift * sso_unit() * vec2(1.0, -1.0);
  vec2 p = sso_boxPx() - shift;
  vec2 c = (floor(p / u_blockPx) + 0.5) * u_blockPx + shift;
  c = clamp(c, vec2(0.5), u_box.zw - 0.5);
  vec4 m = texture(u_avg, sso_uvOfBoxPx(c));
  fragColor = sso_finish(fx_inBox(v_uv) ? m : src, src, -1.0);
}`,
				},
			];
		},
	},
});

// ---------------------------------------------------------------- S_RomanTile

/** Tile width of S_RomanTile in canvas px (Tile Size 1.0 = 6 % of the layer width; the default 0.5 ≈ 33 tiles across). */
export function romanTilePx(
	p: { tileSize?: unknown },
	ctx: Pick<FxPlanContext, 'width' | 'pxScale'>,
): number {
	return Math.max(2, num(p.tileSize, 0.5) * 0.06 * ctx.width * ctx.pxScale);
}

export const S_ROMAN_TILE: EffectSpec = defineShaderEffect({
	id: 'jasper.s.roman-tile',
	label: 'S_RomanTile',
	category: 'Stylize',
	bin: BIN,
	description:
		'A Roman mosaic of the picture: square or hexagonal tesserae of the local colour, bumpy and lit from a 3D light, set in textured grout.',
	keywords: ['mosaic', 'tiles', 'tesserae', 'roman', 'stained', 'grout'],
	expensive: true,
	params: [
		sNum('tileSize', 'Tile Size', 0.5, { min: 0.05, softMax: 2 }),
		fxParam.choice('tileShape', 'Tile Shape', ['square', 'hexagon'], ['Square', 'Hexagon'], 'square'),
		sNum('varyShape', 'Vary Shape', 0.2, { min: 0, max: 1 }),
		fxParam.vec2('tileShift', 'Tile Shift', [0, 0], { softMin: -1, softMax: 1, step: 0.001 }),
		sNum('tileEdgeSharpness', 'Tile Edge Sharpness', 0.9, { min: 0, max: 1 }),
		sNum('tileTextureFreq', 'Tile Texture Freq', 50, { min: 0, softMax: 300 }),
		sNum('tileRoughness', 'Tile Roughness', 0.75, { min: 0, max: 1 }),
		sNum('tileHeight', 'Tile Height', 0.5, { min: 0, softMax: 2 }),
		sNum('tileOpacity', 'Tile Opacity', 0.9, { min: 0, max: 1 }),
		sNum('crackedTiles', 'Cracked Tiles', 0, { min: 0, max: 1 }),
		sNum('smoothColors', 'Smooth Colors', 0.2, { min: 0, softMax: 2 }),
		sNum('edgeAttract', 'Edge Attract', 0.2, { min: 0, max: 1 }),
		fxParam.color('groutColor', 'Grout Color', [0.4, 0.4, 0.4, 1]),
		sNum('groutWidth', 'Grout Width', 0.1, { min: 0, max: 1 }),
		sNum('groutTextureFreq', 'Grout Texture Freq', 150, { min: 0, softMax: 600 }),
		sNum('groutRoughness', 'Grout Roughness', 0.5, { min: 0, max: 1 }),
		sNum('groutOpacity', 'Grout Opacity', 1, { min: 0, max: 1 }),
		fxParam.point('lightPosition', 'Light Position', sapphirePoint(0.9, 0.5)),
		sNum('lightBrightness', 'Light Brightness', 1, { min: 0, softMax: 4 }),
		fxParam.color('lightColor', 'Light Color', [0.5, 0.5, 0.5, 1]),
		sNum('lightZ', 'Light Z', 5, { min: 1, softMax: 20 }),
		fxParam.toggle('cropToAlpha', 'Crop To Alpha', false),
		sNum('bgBrightness', 'Bg Brightness', 1, { min: 0, max: 1 }),
		...sapphireCommonParams({ seed: true }),
		...maskParams(),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => ({ u_tilePx: romanTilePx(p, ctx) }),
		passes: (p, ctx) => {
			const tile = romanTilePx(p, ctx);
			return [
				// Tile colours: the picture averaged over about a tile (more with Smooth Colors); the local colour
				// for cracked tiles and the edge field for Edge Attract come from a smaller blur.
				...blurPasses({
					input: 'source',
					output: 'tileAvg',
					sigmaX: tile * (0.3 + 0.5 * Math.max(0, num(p.smoothColors, 0.2))),
				}),
				...blurPasses({ input: 'source', output: 'local', sigmaX: Math.max(1, tile * 0.12) }),
				{
					include: [GLSL_SSO_COMMON, GLSL_SSO_MASK, GLSL_HASH, GLSL_NOISE],
					frag: ROMAN_TILE_FRAG,
				},
			];
		},
	},
});

const ROMAN_TILE_FRAG = /* glsl */ `
// Tile lattice coordinates (1 = one tile) → nearest site, its id and the distance to the cell border (tile units).
struct Cell { vec2 site; ivec2 id; float border; };
vec2 rt_sitePos(ivec2 id, bool hex, float jitter) {
  vec2 base = hex ? vec2(float(id.x) + 0.5 * float(id.y & 1), float(id.y) * 0.8660254) : vec2(id);
  return base + (fx_hash22(id, u_seed) - 0.5) * jitter;
}
ivec2 rt_cellOf(vec2 q, bool hex) {
  if (!hex) return ivec2(floor(q + 0.5));
  int j = int(floor(q.y / 0.8660254 + 0.5));
  return ivec2(int(floor(q.x - 0.5 * float(j & 1) + 0.5)), j);
}
Cell rt_cell(vec2 q, bool hex, float jitter) {
  ivec2 c = rt_cellOf(q, hex);
  float best = 1e9; ivec2 bid = c; vec2 bs = vec2(0.0);
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
    ivec2 id = c + ivec2(x, y);
    vec2 s = rt_sitePos(id, hex, jitter);
    float d = dot(q - s, q - s);
    if (d < best) { best = d; bid = id; bs = s; }
  }
  float border = 1e9;
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
    ivec2 id = c + ivec2(x, y);
    if (id == bid) continue;
    vec2 s = rt_sitePos(id, hex, jitter);
    vec2 n = s - bs;
    float l = length(n);
    if (l < 1e-4) continue;
    border = min(border, dot(q - 0.5 * (s + bs), -n / l));
  }
  return Cell(bs, bid, border);
}
float rt_luma(vec2 boxPx) { return fx_luma(fx_unpremultiply(texture(u_local, sso_uvOfBoxPx(boxPx))).rgb); }
// Height of the tiled surface at a point (tile units): bevelled tiles with a bumpy top, grout at 0 with its own grain.
float rt_height(vec2 q, out Cell cell, out float grout) {
  bool hex = u_tileShape == 1;
  cell = rt_cell(q, hex, clamp(u_varyShape, 0.0, 1.0) * 0.9);
  float halfGrout = clamp(u_groutWidth, 0.0, 1.0) * 0.25;
  float e = cell.border - halfGrout;                       // distance into the tile from its grout line
  grout = 1.0 - smoothstep(-0.01, 0.01, e);
  float bevel = mix(0.35, 0.03, clamp(u_tileEdgeSharpness, 0.0, 1.0));
  float prof = sin(clamp(e / bevel, 0.0, 1.0) * 1.5707963);
  float tex = fx_noise01(fx_fbm(q * u_tileTextureFreq / max(u_box.z / u_tilePx, 1.0), 3, 2.0, 0.5, u_seed + 0.37));
  float gtex = fx_noise01(fx_fbm(q * u_groutTextureFreq / max(u_box.z / u_tilePx, 1.0), 2, 2.0, 0.5, u_seed + 0.71));
  float h = prof * (1.0 + (tex - 0.5) * u_tileRoughness * 0.6);
  return mix(h, gtex * u_groutRoughness * 0.3, grout) * u_tileHeight;
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 px = sso_boxPx();
  // Edge Attract: pull the lattice towards the picture's edges (corners settle on edges).
  vec2 e = vec2(1.0, 0.0) * u_tilePx * 0.25;
  vec2 grad = vec2(rt_luma(px + e.xy) - rt_luma(px - e.xy), rt_luma(px + e.yx) - rt_luma(px - e.yx));
  vec2 shift = u_tileShift * sso_unit() * vec2(1.0, -1.0);
  vec2 q = (px - shift) / u_tilePx - grad * u_edgeAttract * 1.5;

  Cell cell; float grout;
  float h = rt_height(q, cell, grout);
  Cell c2; float g2;
  float d = 0.75 / u_tilePx;                               // ~1 px in tile units
  float hx = rt_height(q + vec2(d, 0.0), c2, g2);
  float hy = rt_height(q + vec2(0.0, d), c2, g2);
  vec3 n = normalize(vec3(-(hx - h) / d, -(hy - h) / d, 6.0));

  // Tile colour: the averaged picture at the tile's site; cracked tiles split along the picture's edges.
  vec2 sitePx = cell.site * u_tilePx + shift;
  vec3 tc = fx_unpremultiply(texture(u_tileAvg, sso_uvOfBoxPx(clamp(sitePx, vec2(0.5), u_box.zw - 0.5)))).rgb;
  float edge = length(grad) * 4.0;
  if (fx_hash2(cell.id, u_seed + 0.13) < u_crackedTiles * clamp(edge * 2.0, 0.0, 1.0)) {
    tc = fx_unpremultiply(texture(u_local, v_uv)).rgb;
  }
  tc *= 0.94 + 0.12 * fx_hash2(cell.id, u_seed + 0.29);  // each tessera's own tone
  vec3 base = mix(tc, u_groutColor.rgb, grout);

  // Lighting: a point light above the frame (Light Z in Sapphire units); flat surfaces keep their colour.
  vec3 lp = vec3(fx_uvOfLayerNorm(u_lightPosition) * u_canvasSize - u_box.xy, u_lightZ * sso_unit());
  vec3 l = normalize(lp - vec3(px, 0.0));
  float diff = dot(n, l) - l.z;
  vec3 lit = base * (1.0 + diff * u_lightBrightness * u_lightColor.rgb * 4.0);
  vec3 nh = normalize(l + vec3(0.0, 0.0, 1.0));
  lit += pow(max(dot(n, nh), 0.0), 40.0) * u_lightBrightness * u_lightColor.rgb * 0.35 * (1.0 - grout);

  float op = mix(u_tileOpacity, u_groutOpacity, grout);
  vec3 bg = fx_unpremultiply(src).rgb * u_bgBrightness;
  float bgA = src.a;
  vec3 col = mix(bg, clamp(lit, 0.0, 1.0), op);
  float a = u_cropToAlpha ? src.a : max(bgA, op);
  vec4 result = fx_inBox(v_uv) ? vec4(col * a, a) : vec4(0.0);
  fragColor = sso_finish(result, src, -1.0);
}`;

// ---------------------------------------------------------------- S_StripSlide

export const STRIP_SLIDE_ORDERS = ['topDown', 'bottomUp', 'random', 'centerOut', 'edgesIn'] as const;

/**
 * Timing of one strip of S_StripSlide (pure, also used by the shader's maths): each strip moves for a window of
 * `min(1, 3 / Speed)` of the Amount, windows start in Order rank, and Slow Start eases the motion in.
 * Returns the strip's eased progress 0..1 (1 = fully off the layer).
 */
export function stripSlideProgress(amount: number, rank: number, speed: number, slowStart: number): number {
	const d = Math.min(1, 3 / Math.max(1, speed));
	const start = clamp(rank, 0, 1) * (1 - d);
	const t = clamp((amount - start) / d, 0, 1);
	return t + (t * t - t) * clamp(slowStart, 0, 1);
}

export const S_STRIP_SLIDE: EffectSpec = defineShaderEffect({
	id: 'jasper.s.strip-slide',
	label: 'S_StripSlide',
	category: 'Stylize',
	bin: BIN,
	description:
		'Breaks the picture into strips and slides them off one at a time (Amount 0 → 1) to reveal the Background (or what lies below). Strip Size in Sapphire units (1.0 = half the width).',
	keywords: ['strips', 'slats', 'slide', 'wipe', 'transition', 'blinds'],
	params: [
		sNum('amount', 'Amount', 0.5, { min: 0, max: 1 }),
		sNum('motionBlur', 'Motion Blur', 0.3, { min: 0, softMax: 2 }),
		sNum('stripSize', 'Strip Size', 0.1, { min: 0.01, softMax: 1 }),
		sNum('randomizeSize', 'Randomize Size', 0, { min: 0, softMax: 1 }),
		fxParam.angle('stripAngle', 'Strip Angle', 0),
		sNum('stripShift', 'Strip Shift', 0, { softMin: -1, softMax: 1 }),
		sNum('speed', 'Speed', 10, { min: 1, softMax: 50 }),
		sNum('slowStart', 'Slow Start', 1, { min: 0, max: 1 }),
		fxParam.choice(
			'order',
			'Order',
			STRIP_SLIDE_ORDERS,
			['Top Down', 'Bottom Up', 'Random', 'Center Out', 'Edges In'],
			'topDown',
		),
		fxParam.media('background', 'Background'),
		...sapphireCommonParams({ seed: true }),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_SSO_COMMON, GLSL_HASH, GLSL_UV, GLSL_BLEND, GLSL_COMPOSITE],
				frag: /* glsl */ `
// Strip k spans [ss_edge(k), ss_edge(k + 1)) across the slide direction (strip units, jittered by Randomize Size).
float ss_edge(int k) { return float(k) + (fx_hash1(k, u_seed) - 0.5) * min(u_randomizeSize, 0.9); }
float ss_progress(float amount, float rank) {
  float d = min(1.0, 3.0 / max(1.0, u_speed));
  float t = clamp((amount - clamp(rank, 0.0, 1.0) * (1.0 - d)) / d, 0.0, 1.0);
  return t + (t * t - t) * clamp(u_slowStart, 0.0, 1.0);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 half_ = u_box.zw * 0.5;
  vec2 p = sso_boxPx() - half_;
  float a = fx_deg(u_stripAngle);
  vec2 along = vec2(cos(a), sin(a));                        // slide direction
  vec2 across = vec2(-along.y, along.x);
  float size = max(u_stripSize, 0.01) * sso_unit();
  // Extent of the layer box along both axes (its corners projected).
  float extU = abs(along.x) * half_.x + abs(along.y) * half_.y;
  float extV = abs(across.x) * half_.x + abs(across.y) * half_.y;
  float v = dot(p, across) / size + u_stripShift;
  int k = int(floor(v));
  if (v < ss_edge(k)) k -= 1; else if (v >= ss_edge(k + 1)) k += 1;
  int kMin = int(floor(-extV / size + u_stripShift)) - 1;
  int kMax = int(floor(extV / size + u_stripShift)) + 1;
  float rank = float(k - kMin) / float(max(1, kMax - kMin));
  float mid = (0.5 * (ss_edge(k) + ss_edge(k + 1)) - u_stripShift) * size;
  float dist = abs(mid) / max(extV, 1.0);
  if (u_order == 1) rank = 1.0 - rank;
  else if (u_order == 2) rank = fx_hash1(k, fract(u_seed + 0.5));
  else if (u_order == 3) rank = dist;
  else if (u_order == 4) rank = 1.0 - dist;
  float travel = 2.0 * extU + 2.0;
  float d1 = ss_progress(u_amount, rank) * travel;
  float d0 = ss_progress(u_amount - 0.04 * u_motionBlur, rank) * travel;
  vec4 strip = vec4(0.0);
  const int N = 12;
  int n = abs(d1 - d0) > 0.5 ? N : 1;
  for (int i = 0; i < N; i++) {
    if (i >= n) break;
    float d = n == 1 ? d1 : mix(d0, d1, (float(i) + 0.5) / float(n));
    vec2 q = p - along * d;
    vec4 s = vec4(0.0);
    if (abs(dot(q, along)) <= extU && fx_inBox(sso_uvOfBoxPx(q + half_))) s = texture(u_source, sso_uvOfBoxPx(q + half_));
    strip += s;
  }
  strip /= float(n);
  vec4 bg = u_background_size.x > 0.0 && fx_inBox(v_uv) ? texture(u_background, clamp(fx_layerNorm(), 0.0, 1.0)) : vec4(0.0);
  vec4 result = fx_over(strip, bg);
  fragColor = fx_finish(result, src, strip.a, u_mixWithOriginal, u_show);
}`,
			},
		],
	},
});
