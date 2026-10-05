// Premiere Pro standard effects — Stylize, part 2 (family "premiere-stylize-distort-generate", wave 2): Replicate,
// Roughen Edges, Solarize, Strobe Light, Texturize, Threshold.
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { fxParam } from '../params.ts';
import { gaussianBlurPasses } from '../passes.ts';
import { type FxFrameContext, fxRandom } from '../shader.ts';
import {
	blendWithOriginalParam,
	evolutionParams,
	GLSL_PSDG_BLEND,
	GLSL_PSDG_EVOLVE,
	num,
	randomSeedParam,
} from './common.ts';
import { GLSL_PSDG_COMPASS } from './stylize.ts';

// ---------------------------------------------------------------- Replicate

export const REPLICATE = defineShaderEffect({
	id: 'jasper.replicate',
	label: 'Replicate',
	category: 'Stylize',
	description: 'Divides the layer into tiles and shows a scaled-down copy of the whole picture in each one.',
	keywords: ['tile', 'grid', 'repeat', 'copies', 'multiply'],
	params: [fxParam.number('count', 'Count', 2, { min: 2, max: 16, step: 1 })],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				frag: /* glsl */ `
void main() {
  if (!fx_inBox(v_uv)) { fragColor = vec4(0.0); return; }
  float n = clamp(floor(u_count), 1.0, 64.0);
  vec2 t = fract(fx_layerNorm() * n);
  // Keep the copies' outer texels inside the layer (no bleeding from the canvas padding).
  vec2 half_ = 0.5 / u_box.zw;
  fragColor = texture(u_source, fx_uvOfLayerNorm(clamp(t, half_, 1.0 - half_)));
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Roughen Edges

const ROUGHEN_TYPES = [
	'roughen',
	'roughenColor',
	'cut',
	'spiky',
	'rusty',
	'rustyColor',
	'photocopy',
	'photocopyColor',
] as const;

export const ROUGHEN_EDGES = defineShaderEffect({
	id: 'jasper.roughen-edges',
	label: 'Roughen Edges',
	category: 'Stylize',
	description:
		'Erodes the edges of the layer’s alpha channel with fractal noise for a corroded, torn or photocopied look (optionally coloured).',
	keywords: ['grunge', 'torn', 'rough', 'erode', 'distress', 'edge'],
	expensive: true,
	params: [
		fxParam.choice(
			'edgeType',
			'Edge Type',
			ROUGHEN_TYPES,
			['Roughen', 'Roughen Color', 'Cut', 'Spiky', 'Rusty', 'Rusty Color', 'Photocopy', 'Photocopy Color'],
			'roughen',
		),
		fxParam.color('edgeColor', 'Edge Color', [0.73, 0.4, 0.13, 1]),
		fxParam.number('border', 'Border', 8, { min: 0, max: 500, softMax: 100, step: 0.1 }, { unit: 'px' }),
		fxParam.number('edgeSharpness', 'Edge Sharpness', 1, { min: 0, max: 10, softMax: 2, step: 0.01 }),
		fxParam.number('fractalInfluence', 'Fractal Influence', 1, { min: 0, max: 1, step: 0.01 }),
		fxParam.number('scale', 'Scale', 100, { min: 10, max: 2000, softMax: 300, step: 0.1 }),
		fxParam.number('stretch', 'Stretch Width or Height', 0, {
			min: -10,
			max: 10,
			softMin: -5,
			softMax: 5,
			step: 0.01,
		}),
		fxParam.point('offset', 'Offset (Turbulence)', [0, 0]),
		fxParam.number('complexity', 'Complexity', 2, { min: 1, max: 10, step: 1 }),
		...evolutionParams(),
		randomSeedParam(),
	],
	gpu: {
		timeInvariant: true,
		// A transparent margin so the layer box's own edges are edges of the matte (not clamped to the inside).
		padding: (p) => Math.min(64, Math.max(2, num(p.border, 8) * 0.5)),
		passes: (p, ctx) => {
			const border = Math.max(0, num(p.border, 8)) * ctx.pxScale;
			return [
				{ output: 'matte', frag: 'void main() { fragColor = vec4(texture(u_source, v_uv).a); }' },
				...gaussianBlurPasses({
					input: 'matte',
					output: 'dist',
					sigma: border * 0.45,
					scale: border > 30 ? 0.5 : 1,
				}),
				{
					include: [GLSL_PSDG_EVOLVE],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (src.a <= 0.0 || u_border <= 0.0) { fragColor = src; return; }
  // Depth inside the shape: 0 at the alpha edge, 1 about one Border inside (from the blurred matte).
  float m = texture(u_dist, v_uv).a;
  float depth = clamp((m - 0.5) * 2.2, -1.0, 1.0);
  // Fractal noise in layer px (Scale 100 ≈ 1.5 × Border features), stretched, offset, evolving.
  vec2 lp = fx_layerPx() - u_offset * u_box.zw / u_pxScale;
  float st = u_stretch;
  vec2 stretch = st >= 0.0 ? vec2(1.0 + st, 1.0) : vec2(1.0, 1.0 - st);
  float feature = max(u_border, 1.0) * 1.5 * u_scale / 100.0;
  int type = u_edgeType;
  if (type == 6 || type == 7) stretch *= vec2(3.0, 0.4); // photocopy: streaky
  vec2 q = lp / (feature * stretch);
  int oct = int(clamp(u_complexity, 1.0, 10.0));
  float n = psdg_evolveFbm(q, oct, u_evolution, u_cycleEvolution, u_cycle, u_seed);
  if (type == 3) n = 1.0 - 2.0 * pow(abs(n), 0.5); // spiky: sharp ridges
  n *= u_fractalInfluence;
  // The eroded edge: keep where depth beats the noise.
  float field = depth - n * 0.75 - 0.05;
  if (type == 4 || type == 5) {
    // Rusty: also holes inside the border band.
    float holes = psdg_evolveTurb(q * 2.3 + 17.0, oct, u_evolution, u_cycleEvolution, u_cycle, u_seed);
    field = min(field, (holes - 0.18) * 3.0 + depth * 1.2);
  }
  float soft = 0.25 / max(u_edgeSharpness, 0.02);
  if (type == 2) soft = 0.01; // cut: hard
  float keep = smoothstep(-soft * 0.5, soft * 0.5, field);
  vec3 c = src.rgb / src.a;
  bool colored = type == 1 || type == 5 || type == 7;
  if (colored) {
    // Edge colour fills the border band, fading inward.
    float band = 1.0 - smoothstep(0.0, 0.55, field);
    c = mix(c, u_edgeColor.rgb, clamp(band, 0.0, 1.0) * u_edgeColor.a);
  }
  float a = src.a * keep;
  fragColor = vec4(c * a, a);
}`,
				},
			];
		},
	},
});

// ---------------------------------------------------------------- Solarize

export const SOLARIZE = defineShaderEffect({
	id: 'jasper.solarize',
	label: 'Solarize',
	category: 'Stylize',
	description:
		'Blends a negative and a positive of the picture: channel values above Threshold are inverted.',
	keywords: ['sabattier', 'invert', 'negative', 'psychedelic'],
	params: [fxParam.percent('threshold', 'Threshold', 50)],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (src.a <= 0.0) { fragColor = src; return; }
  vec3 c = src.rgb / src.a;
  float t = u_threshold / 100.0;
  c = mix(c, 1.0 - c, vec3(greaterThan(c, vec3(t))));
  fragColor = vec4(c * src.a, src.a);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Strobe Light

const STROBE_OPERATORS = [
	'copy',
	'add',
	'subtract',
	'multiply',
	'difference',
	'and',
	'or',
	'xor',
	'lighter',
	'darker',
	'minimum',
	'maximum',
	'screen',
] as const;

/**
 * Whether the strobe fires at a frame (pure): during the first Strobe Duration seconds of every Strobe Period, or —
 * with Random Strobe Probability — on frames picked by a seeded draw per frame.
 */
export function strobeOn(p: EffectParams, ctx: Pick<FxFrameContext, 'frame' | 'fps' | 'seed'>): boolean {
	const fps = ctx.fps > 0 ? ctx.fps : 30;
	const t = ctx.frame / fps;
	const period = Math.max(1 / fps, num(p.strobePeriod, 1));
	const duration = Math.max(0, num(p.strobeDuration, 0.05));
	const phase = t - Math.floor(t / period) * period;
	// A strobe of at least one frame when Duration > 0 (sub-frame durations still flash once per period).
	const periodic = duration > 0 && phase < Math.max(duration, 1 / fps - 1e-9);
	const prob = Math.min(1, Math.max(0, num(p.probability, 0) / 100));
	const random = prob > 0 && fxRandom(ctx.seed, ctx.frame) < prob;
	return periodic || random;
}

export const STROBE_LIGHT = defineShaderEffect({
	id: 'jasper.strobe-light',
	label: 'Strobe Light',
	category: 'Stylize',
	description:
		'Flashes the layer with a colour (or makes it transparent) at regular or random intervals, like a strobe light.',
	keywords: ['flash', 'flicker', 'blink', 'club', 'lightning'],
	params: [
		fxParam.color('strobeColor', 'Strobe Color', [1, 1, 1, 1]),
		blendWithOriginalParam(),
		fxParam.number(
			'strobeDuration',
			'Strobe Duration (secs)',
			0.05,
			{ min: 0, max: 30, softMax: 1, step: 0.01 },
			{ unit: 's' },
		),
		fxParam.number(
			'strobePeriod',
			'Strobe Period (secs)',
			1,
			{ min: 0, max: 30, softMax: 5, step: 0.01 },
			{ unit: 's' },
		),
		fxParam.percent('probability', 'Random Strobe Probability', 0),
		fxParam.choice(
			'strobe',
			'Strobe',
			['colorOnly', 'transparent'],
			['Operates On Color Only', 'Makes Layer Transparent'],
			'colorOnly',
		),
		fxParam.choice(
			'operator',
			'Strobe Operator',
			STROBE_OPERATORS,
			[
				'Copy',
				'Add',
				'Subtract',
				'Multiply',
				'Difference',
				'And',
				'Or',
				'Xor',
				'Lighter',
				'Darker',
				'Minimum',
				'Maximum',
				'Screen',
			],
			'copy',
		),
		randomSeedParam(),
	],
	gpu: {
		uniforms: (p, ctx) => ({ u_strobeOn: strobeOn(p, ctx) }),
		passes: [
			{
				include: [GLSL_PSDG_BLEND],
				frag: /* glsl */ `
vec3 strobeOp(int op, vec3 b, vec3 s) {
  if (op == 1) return min(b + s, 1.0);
  if (op == 2) return max(b - s, 0.0);
  if (op == 3) return b * s;
  if (op == 4) return abs(b - s);
  if (op >= 5 && op <= 7) {
    uvec3 x = uvec3(clamp(b, 0.0, 1.0) * 255.0 + 0.5);
    uvec3 y = uvec3(clamp(s, 0.0, 1.0) * 255.0 + 0.5);
    uvec3 r = op == 5 ? (x & y) : op == 6 ? (x | y) : (x ^ y);
    return vec3(r) / 255.0;
  }
  if (op == 8 || op == 11) return max(b, s);
  if (op == 9 || op == 10) return min(b, s);
  if (op == 12) return b + s - b * s;
  return s;
}
void main() {
  vec4 src = texture(u_source, v_uv);
  if (!u_strobeOn) { fragColor = src; return; }
  vec4 result;
  if (u_strobe == 1) result = vec4(0.0);
  else {
    vec3 b = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
    vec3 c = mix(b, strobeOp(u_operator, b, u_strobeColor.rgb), u_strobeColor.a);
    result = vec4(c * src.a, src.a);
  }
  fragColor = psdg_blendOriginal(result, src, u_blendWithOriginal);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Texturize

export const TEXTURIZE = defineShaderEffect({
	id: 'jasper.texturize',
	label: 'Texturize',
	category: 'Stylize',
	description:
		'Embosses the relief of another picture (Texture Layer) onto the layer, lit from Light Direction.',
	keywords: ['texture', 'canvas', 'paper', 'relief', 'emboss', 'surface'],
	params: [
		fxParam.media('textureLayer', 'Texture Layer', ['image', 'video']),
		fxParam.angle('lightDirection', 'Light Direction', 135),
		fxParam.number('textureContrast', 'Texture Contrast', 1, { min: 0, max: 2, step: 0.01 }),
		fxParam.choice(
			'texturePlacement',
			'Texture Placement',
			['tile', 'center', 'stretch'],
			['Tile Texture', 'Center Texture', 'Stretch Texture to Fit'],
			'tile',
		),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_COLOR, GLSL_PSDG_COMPASS],
				frag: /* glsl */ `
// Texture luminance at a layer-px position (placement), 0.5 where there is no texture.
float texLum(vec2 lp) {
  vec2 ts = u_textureLayer_size;
  vec2 box = u_box.zw / u_pxScale;
  vec2 uv;
  if (u_texturePlacement == 2) uv = lp / box;
  else if (u_texturePlacement == 1) {
    uv = (lp - (box - ts) * 0.5) / ts;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.5;
  } else uv = fract(lp / ts);
  vec4 t = texture(u_textureLayer, uv);
  return t.a > 0.0 ? fx_luma(t.rgb / t.a) : 0.5;
}
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_textureLayer_size.x <= 0.0 || src.a <= 0.0) { fragColor = src; return; }
  vec2 lp = fx_layerPx();
  vec2 d = psdg_compass(u_lightDirection);
  // Slope of the texture towards the light (1 px apart): positive faces the light.
  float slope = texLum(lp + d) - texLum(lp - d);
  vec3 c = src.rgb / src.a;
  c = clamp(c + slope * u_textureContrast * 1.5, 0.0, 1.0);
  fragColor = vec4(c * src.a, src.a);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Threshold

export const THRESHOLD = defineShaderEffect({
	id: 'jasper.threshold',
	label: 'Threshold',
	category: 'Stylize',
	description: 'Converts the picture to pure black and white: pixels brighter than Level become white.',
	keywords: ['black and white', 'binary', 'high contrast', '1-bit', 'stencil'],
	params: [fxParam.number('level', 'Level', 128, { min: 0, max: 255, step: 1 })],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (src.a <= 0.0) { fragColor = src; return; }
  float l = fx_luma(src.rgb / src.a) * 255.0;
  float v = l >= u_level ? 1.0 : 0.0;
  fragColor = vec4(vec3(v) * src.a, src.a);
}`,
			},
		],
	},
});

export const PSDG_STYLIZE_2_EFFECTS: readonly EffectSpec[] = [
	REPLICATE,
	ROUGHEN_EDGES,
	SOLARIZE,
	STROBE_LIGHT,
	TEXTURIZE,
	THRESHOLD,
];
