// Premiere Pro standard effects — Stylize, part 1 (family "premiere-stylize-distort-generate"): Alpha Glow,
// Brush Strokes, Color Emboss, Emboss, Find Edges, Mosaic, Posterize.
// Angles of these After Effects-derived controls are compass angles (0° = up, clockwise), as in Premiere: an Emboss
// Direction of 45° lights the picture from the upper right. GLSL: `psdg_compass(deg)` (screen vector, y down).
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_BLEND } from '../glsl/blend.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { fxParam } from '../params.ts';
import { gaussianBlurPasses } from '../passes.ts';
import type { GlslChunk } from '../shader.ts';
import { blendWithOriginalParam, GLSL_PSDG_BLEND, num } from './common.ts';
import { GLSL_PSDG_HASH } from './noise-glsl.ts';

/** Compass direction (0° = up, clockwise) as a screen vector (y down). */
export const GLSL_PSDG_COMPASS: GlslChunk = {
	name: 'psdg/compass',
	source: /* glsl */ `
vec2 psdg_compass(float deg) { float a = radians(deg); return vec2(sin(a), -cos(a)); }
`,
};

export const ALPHA_GLOW = defineShaderEffect({
	id: 'jasper.alpha-glow',
	label: 'Alpha Glow',
	category: 'Stylize',
	description:
		'Adds a coloured glow around the edges of the layer’s alpha channel, fading from Start Color to End Color outward.',
	keywords: ['outer glow', 'halo', 'edge', 'aura', 'alpha'],
	expensive: true,
	params: [
		fxParam.number('glow', 'Glow', 10, { min: 0, max: 255, softMax: 100, step: 1 }),
		fxParam.number('brightness', 'Brightness', 255, { min: 0, max: 255, step: 1 }),
		fxParam.color('startColor', 'Start Color', [1, 1, 1, 1]),
		fxParam.color('endColor', 'End Color', [0, 0, 0, 1]),
		fxParam.toggle('useEndColor', 'Use End Color', false),
		fxParam.toggle('fadeOut', 'Fade Out', true),
	],
	gpu: {
		timeInvariant: true,
		padding: (p) => Math.max(0, num(p.glow, 10)) * 1.2 + 2,
		passes: (p, ctx) => {
			const g = Math.max(0, num(p.glow, 10)) * ctx.pxScale;
			return [
				{
					output: 'matte',
					frag: 'void main() { float a = texture(u_source, v_uv).a; fragColor = vec4(a); }',
				},
				...gaussianBlurPasses({
					input: 'matte',
					output: 'spread',
					sigma: g * 0.4,
					scale: g > 24 ? 0.5 : 1,
				}),
				{
					include: [GLSL_BLEND],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_glow <= 0.0) { fragColor = src; return; }
  // Spread ≈ how close to the shape: 0.5 at the alpha edge, → 0 one Glow away.
  float s = clamp(texture(u_spread, v_uv).a * 2.0, 0.0, 1.0);
  float a;
  if (u_fadeOut) a = s;
  else a = smoothstep(0.02, 0.08, s);
  a *= u_brightness / 255.0;
  vec3 c = u_useEndColor ? mix(u_endColor.rgb, u_startColor.rgb, u_fadeOut ? s : smoothstep(0.02, 1.0, s)) : u_startColor.rgb;
  vec4 glow = vec4(c * a, a);
  fragColor = fx_over(src, glow);
}`,
				},
			];
		},
	},
});

export const BRUSH_STROKES = defineShaderEffect({
	id: 'jasper.brush-strokes',
	label: 'Brush Strokes',
	category: 'Stylize',
	description:
		'Gives the picture a painted look: short directional brush strokes, each carrying the colour beneath it.',
	keywords: ['paint', 'painterly', 'artistic', 'impressionist', 'oil'],
	expensive: true,
	params: [
		fxParam.angle('strokeAngle', 'Stroke Angle', 135),
		fxParam.number('brushSize', 'Brush Size', 2, { min: 0, max: 5, step: 0.1 }),
		fxParam.number('strokeLength', 'Stroke Length', 8, { min: 0, max: 40, step: 1 }),
		fxParam.number('strokeDensity', 'Stroke Density', 1, { min: 0, max: 2, step: 0.01 }),
		fxParam.number('strokeRandomness', 'Stroke Randomness', 1, { min: 0, max: 2, step: 0.01 }),
		fxParam.choice(
			'paintSurface',
			'Paint Surface',
			['original', 'transparent', 'white', 'black'],
			['Paint On Original Image', 'Paint On Transparent', 'Paint On White', 'Paint On Black'],
			'original',
		),
		blendWithOriginalParam(),
	],
	gpu: {
		timeInvariant: true,
		// Neighbour cells searched (±2) and strokes per cell (2), as uniforms so the loops are not unrolled.
		uniforms: () => ({ u_reach: { int: 2 }, u_layers: { int: 2 } }),
		passes: [
			{
				include: [GLSL_PSDG_HASH, GLSL_PSDG_COMPASS, GLSL_PSDG_BLEND],
				frag: /* glsl */ `
// Strokes live on a grid aligned with the stroke direction; each cell owns a few strokes (density) with a jittered
// centre, angle, length and width. A pixel takes the colour of the topmost stroke covering it.
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 lp = fx_layerPx();
  float width = max(u_brushSize, 0.2) * 1.6 + 0.6;
  float len = max(u_strokeLength, 1.0) + width;
  float dens = clamp(u_strokeDensity, 0.0, 2.0);
  float rnd = clamp(u_strokeRandomness, 0.0, 2.0);
  vec2 dir = psdg_compass(u_strokeAngle);
  vec2 nrm = vec2(-dir.y, dir.x);
  // Rotated coordinates: x along the stroke, y across.
  vec2 q = vec2(dot(lp, dir), dot(lp, nrm));
  vec2 cell = vec2(len * 0.6, width * 1.4) / max(sqrt(max(dens, 0.05)), 0.3);
  ivec2 c0 = ivec2(floor(q / cell));
  float best = -1.0;
  vec4 col = vec4(0.0);
  float shade = 1.0;
  for (int j = -u_reach; j <= u_reach; j++)
    for (int i = -u_reach; i <= u_reach; i++) {
      ivec2 c = c0 + ivec2(i, j);
      for (int k = 0; k < u_layers; k++) {
        ivec3 h = ivec3(c, k);
        vec3 r = psdg_hash33(h, u_seed);
        if (k == 1 && r.z > dens - 1.0) continue; // second stroke per cell only above density 1
        if (k == 0 && r.z > dens * 1.5) continue; // sparse strokes at low density
        vec2 centre = (vec2(c) + 0.5 + (r.xy - 0.5) * 0.9) * cell;
        float ang = (psdg_hash3(h + ivec3(11, 0, 0), u_seed) - 0.5) * 0.6 * rnd;
        float l = len * (1.0 + (psdg_hash3(h + ivec3(0, 13, 0), u_seed) - 0.5) * 0.8 * rnd) * 0.5;
        vec2 d = q - centre;
        float ca = cos(ang), sa = sin(ang);
        d = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y);
        // Capsule: |across| < width/2, |along| < l, rounded tips.
        vec2 e = vec2(max(abs(d.x) - l, 0.0), d.y);
        float dist = length(e) - width * 0.5;
        if (dist > 0.5) continue;
        float pri = psdg_hash3(h + ivec3(5, 5, 5), u_seed);
        if (pri <= best) continue;
        best = pri;
        // The stroke's paint: the picture at the stroke centre (in layer px → canvas uv).
        vec2 cl = centre.x * dir + centre.y * nrm;
        col = texture(u_source, fx_uvOfLayerPx(cl));
        // Bristle shading across the stroke and a soft edge.
        shade = (0.88 + 0.12 * cos(d.y / max(width * 0.5, 0.1) * 1.5708)) * (0.94 + 0.06 * psdg_hash3(ivec3(floor(d.y * 2.0), c), u_seed));
        col.rgb *= shade;
        col *= clamp(0.5 - dist, 0.0, 1.0);
      }
    }
  vec4 surface = u_paintSurface == 0 ? src : u_paintSurface == 1 ? vec4(0.0) : u_paintSurface == 2 ? vec4(1.0) : vec4(0.0, 0.0, 0.0, 1.0);
  if (!fx_inBox(v_uv)) { fragColor = src; return; }
  vec4 painted = col + surface * (1.0 - col.a);
  // Keep the layer's alpha footprint when painting on the original.
  if (u_paintSurface == 0) painted *= src.a > 0.0 ? 1.0 : 0.0;
  fragColor = psdg_blendOriginal(painted, src, u_blendWithOriginal);
}`,
			},
		],
	},
});

const embossParams = () => [
	fxParam.angle('direction', 'Direction', 45),
	fxParam.number('relief', 'Relief', 1, { min: 0, max: 10, step: 0.01 }),
	fxParam.number('contrast', 'Contrast', 100, { min: 0, max: 500, softMax: 200, step: 1 }),
	blendWithOriginalParam(),
];

const embossFrag = (color: boolean) => /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (src.a <= 0.0) { fragColor = src; return; }
  // Relief: offset of the two samples (canvas px); light comes from Direction (compass).
  vec2 o = psdg_compass(u_direction) * max(u_relief, 0.0) * u_pxScale / u_canvasSize;
  vec4 a = texture(u_source, v_uv + o);
  vec4 b = texture(u_source, v_uv - o);
  float d = fx_luma(a.rgb) - fx_luma(b.rgb);
  float k = u_contrast / 100.0;
  vec3 c = ${color ? 'clamp(src.rgb / src.a + d * k, 0.0, 1.0)' : 'vec3(clamp(0.5 + d * k, 0.0, 1.0))'};
  fragColor = psdg_blendOriginal(vec4(c * src.a, src.a), src, u_blendWithOriginal);
}`;

export const COLOR_EMBOSS = defineShaderEffect({
	id: 'jasper.color-emboss',
	label: 'Color Emboss',
	category: 'Stylize',
	description: 'Sharpens the edges of objects as if lit from Direction, keeping the original colours.',
	keywords: ['relief', 'bevel', 'raised', 'texture'],
	params: embossParams(),
	gpu: {
		timeInvariant: true,
		passes: [{ include: [GLSL_COLOR, GLSL_PSDG_COMPASS, GLSL_PSDG_BLEND], frag: embossFrag(true) }],
	},
});

export const EMBOSS = defineShaderEffect({
	id: 'jasper.emboss',
	label: 'Emboss',
	category: 'Stylize',
	description: 'Turns the picture into a grey relief: edges are raised as if lit from Direction.',
	keywords: ['relief', 'bevel', 'stamp', 'grey'],
	params: embossParams(),
	gpu: {
		timeInvariant: true,
		passes: [{ include: [GLSL_COLOR, GLSL_PSDG_COMPASS, GLSL_PSDG_BLEND], frag: embossFrag(false) }],
	},
});

export const FIND_EDGES = defineShaderEffect({
	id: 'jasper.find-edges',
	label: 'Find Edges',
	category: 'Stylize',
	description:
		'Outlines the edges of the picture: dark coloured lines on white like a drawing (Invert: bright edges on black).',
	keywords: ['outline', 'sketch', 'sobel', 'contour', 'line art'],
	params: [fxParam.toggle('invert', 'Invert', false), blendWithOriginalParam()],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PSDG_BLEND],
				frag: /* glsl */ `
vec3 rgbAt(vec2 uv) { vec4 c = texture(u_source, uv); return c.a > 0.0 ? c.rgb / c.a * min(c.a * 4.0, 1.0) : vec3(0.0); }
void main() {
  vec4 src = texture(u_source, v_uv);
  if (src.a <= 0.0) { fragColor = src; return; }
  vec2 t = u_texel;
  vec3 tl = rgbAt(v_uv + vec2(-t.x, -t.y)), tc = rgbAt(v_uv + vec2(0.0, -t.y)), tr = rgbAt(v_uv + vec2(t.x, -t.y));
  vec3 ml = rgbAt(v_uv + vec2(-t.x, 0.0)), mr = rgbAt(v_uv + vec2(t.x, 0.0));
  vec3 bl = rgbAt(v_uv + vec2(-t.x, t.y)), bc = rgbAt(v_uv + vec2(0.0, t.y)), br = rgbAt(v_uv + vec2(t.x, t.y));
  vec3 gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  vec3 gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
  vec3 e = clamp(sqrt(gx * gx + gy * gy) * 0.75, 0.0, 1.0);
  vec3 c = u_invert ? e : 1.0 - e;
  fragColor = psdg_blendOriginal(vec4(c * src.a, src.a), src, u_blendWithOriginal);
}`,
			},
		],
	},
});

export const MOSAIC = defineShaderEffect({
	id: 'jasper.mosaic',
	label: 'Mosaic',
	category: 'Stylize',
	description: 'Divides the layer into rectangular blocks filled with the average colour of each block.',
	keywords: ['pixelate', 'pixelation', 'censor', 'blocks', 'blur faces'],
	params: [
		fxParam.number('horizontalBlocks', 'Horizontal Blocks', 10, { min: 1, max: 4000, softMax: 200, step: 1 }),
		fxParam.number('verticalBlocks', 'Vertical Blocks', 10, { min: 1, max: 4000, softMax: 200, step: 1 }),
		fxParam.toggle('sharpColors', 'Sharp Colors', false),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				frag: /* glsl */ `
void main() {
  if (!fx_inBox(v_uv)) { fragColor = texture(u_source, v_uv); return; }
  vec2 n = vec2(max(floor(u_horizontalBlocks), 1.0), max(floor(u_verticalBlocks), 1.0));
  vec2 ln = fx_layerNorm();
  vec2 b0 = floor(ln * n) / n;
  vec2 bs = 1.0 / n;
  if (u_sharpColors) { fragColor = texture(u_source, fx_uvOfLayerNorm(b0 + bs * 0.5)); return; }
  // Average of an 8×8 grid of bilinear taps over the block (each tap averages 2×2 texels).
  vec4 sum = vec4(0.0);
  for (int y = 0; y < 8; y++)
    for (int x = 0; x < 8; x++)
      sum += texture(u_source, fx_uvOfLayerNorm(b0 + bs * (vec2(float(x), float(y)) + 0.5) / 8.0));
  fragColor = sum / 64.0;
}`,
			},
		],
	},
});

export const POSTERIZE = defineShaderEffect({
	id: 'jasper.posterize',
	label: 'Posterize',
	category: 'Stylize',
	description: 'Reduces each colour channel to a number of tonal levels, giving flat bands of colour.',
	keywords: ['levels', 'bands', 'flat color', 'reduce colors', 'cartoon'],
	params: [fxParam.number('level', 'Level', 7, { min: 2, max: 255, softMax: 32, step: 1 })],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (src.a <= 0.0) { fragColor = src; return; }
  float l = max(floor(u_level), 2.0) - 1.0;
  vec3 c = floor(src.rgb / src.a * l + 0.5) / l;
  fragColor = vec4(c * src.a, src.a);
}`,
			},
		],
	},
});

export const PSDG_STYLIZE_EFFECTS: readonly EffectSpec[] = [
	ALPHA_GLOW,
	BRUSH_STROKES,
	COLOR_EMBOSS,
	EMBOSS,
	FIND_EDGES,
	MOSAIC,
	POSTERIZE,
];
