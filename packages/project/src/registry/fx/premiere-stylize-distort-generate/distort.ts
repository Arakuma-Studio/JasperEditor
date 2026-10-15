// Premiere Pro standard effects — Distort (family "premiere-stylize-distort-generate"): Lens Distortion,
// Magnify, Mirror, Offset, Spherize, Turbulent Displace, Twirl, Wave Warp.
// Every warp is an inverse mapping (output pixel → source position) sampled with `fx_sampleLayer` in layer-box
// coordinates, so areas with no source are transparent (or filled, where Premiere fills them). Angles: Mirror's
// Reflection Angle is a plain screen angle (0° = the right half mirrors the left); Wave Warp's Direction is a
// compass angle (90° = waves travel to the right), as in Premiere.
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_SAMPLE } from '../glsl/sample.ts';
import { fxParam } from '../params.ts';
import type { GlslChunk } from '../shader.ts';
import {
	blendWithOriginalParam,
	bool,
	evolutionParams,
	GLSL_PSDG_BLEND,
	GLSL_PSDG_EVOLVE,
	num,
	psdgBlendModeParam,
	randomSeedParam,
	str,
} from './common.ts';
import { GLSL_PSDG_HASH } from './noise-glsl.ts';
import { GLSL_PSDG_COMPASS } from './stylize.ts';

/** Layer-box helpers of the warps: layer size in layer px, sampling at a layer-px position (transparent outside). */
const GLSL_PSDG_WARP: GlslChunk = {
	name: 'psdg/warp',
	deps: [GLSL_SAMPLE],
	source: /* glsl */ `
vec2 warp_size() { return u_box.zw / u_pxScale; }
vec4 warp_at(vec2 layerPx) { return fx_sampleLayer(u_source, layerPx / warp_size(), FX_EDGE_TRANSPARENT); }
`,
};

export const LENS_DISTORTION = defineShaderEffect({
	id: 'jasper.lens-distortion',
	label: 'Lens Distortion',
	category: 'Distort',
	description:
		'Simulates (or removes) lens distortion: barrel (positive Curvature) or pincushion (negative) bending, with decentering and prism effects.',
	keywords: ['fisheye', 'barrel', 'pincushion', 'gopro', 'lens correction', 'optics'],
	params: [
		fxParam.number(
			'curvature',
			'Curvature',
			0,
			{ min: -100, max: 100, step: 0.1 },
			{ ui: { control: 'slider', bipolar: true } },
		),
		fxParam.number(
			'verticalDecentering',
			'Vertical Decentering',
			0,
			{ min: -100, max: 100, step: 0.1 },
			{ ui: { control: 'slider', bipolar: true } },
		),
		fxParam.number(
			'horizontalDecentering',
			'Horizontal Decentering',
			0,
			{ min: -100, max: 100, step: 0.1 },
			{ ui: { control: 'slider', bipolar: true } },
		),
		fxParam.number(
			'verticalPrism',
			'Vertical Prism FX',
			0,
			{ min: -100, max: 100, step: 0.1 },
			{ ui: { control: 'slider', bipolar: true } },
		),
		fxParam.number(
			'horizontalPrism',
			'Horizontal Prism FX',
			0,
			{ min: -100, max: 100, step: 0.1 },
			{ ui: { control: 'slider', bipolar: true } },
		),
		fxParam.toggle('fillAlpha', 'Fill Alpha', false),
		fxParam.color('fillColor', 'Fill Color', [1, 1, 1, 1]),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PSDG_WARP],
				frag: /* glsl */ `
void main() {
  if (!fx_inBox(v_uv)) { fragColor = vec4(0.0); return; }
  vec2 size = warp_size();
  float halfDiag = 0.5 * length(size);
  // Distortion centre moved by the decentering (±100 = ± a quarter of the frame).
  vec2 centre = size * 0.5 + vec2(u_horizontalDecentering, u_verticalDecentering) / 100.0 * size * 0.25;
  vec2 p = (fx_layerPx() - centre) / halfDiag;
  float r2 = dot(p, p);
  float k = u_curvature / 100.0 * 0.6;
  // Barrel (k > 0): the edges show source from further out; pincushion (k < 0): stretched edges.
  vec2 q = p * (1.0 + k * r2);
  // Prism: an asymmetric (one-sided) term — the picture bends towards one side.
  q += vec2(u_horizontalPrism, u_verticalPrism) / 100.0 * 0.25 * r2;
  vec2 src = centre + q * halfDiag;
  vec4 c = warp_at(src);
  if (u_fillAlpha) c = c + fx_premultiply(u_fillColor) * (1.0 - c.a);
  fragColor = c;
}`,
			},
		],
	},
});

export const MAGNIFY = defineShaderEffect({
	id: 'jasper.magnify',
	label: 'Magnify',
	category: 'Distort',
	description: 'Enlarges a circular or square area of the picture, like a magnifying glass over it.',
	keywords: ['zoom', 'loupe', 'magnifying glass', 'enlarge', 'detail'],
	params: [
		fxParam.choice('shape', 'Shape', ['circle', 'square'], ['Circle', 'Square'], 'circle'),
		fxParam.point('center', 'Center', [0.5, 0.5]),
		fxParam.number(
			'magnification',
			'Magnification',
			100,
			{ min: 100, max: 1000, softMax: 600, step: 0.1 },
			{ unit: '%' },
		),
		fxParam.choice(
			'link',
			'Link',
			['none', 'size', 'sizeFeather'],
			['None', 'Size to Magnification', 'Size & Feather to Magnification'],
			'none',
		),
		fxParam.pixels('size', 'Size', 100, 1000),
		fxParam.pixels('feather', 'Feather', 0, 500),
		fxParam.percent('opacity', 'Opacity', 100),
		fxParam.choice(
			'scaling',
			'Scaling',
			['standard', 'soft', 'scatter'],
			['Standard', 'Soft', 'Scatter'],
			'standard',
		),
		psdgBlendModeParam('normal'),
		fxParam.toggle('resizeLayer', 'Resize Layer', false),
	],
	gpu: {
		timeInvariant: true,
		padding: (p) => {
			if (!bool(p.resizeLayer)) return 0;
			const m = Math.max(1, num(p.magnification, 100) / 100);
			const link = str(p.link, 'none');
			const size = num(p.size, 100) * (link === 'none' ? 1 : m);
			const feather = num(p.feather) * (link === 'sizeFeather' ? m : 1);
			return Math.max(0, size + feather);
		},
		passes: [
			{
				include: [GLSL_PSDG_WARP, GLSL_PSDG_BLEND, GLSL_PSDG_HASH],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  float m = max(u_magnification / 100.0, 1.0);
  float size = u_size * (u_link == 0 ? 1.0 : m);
  float feather = u_feather * (u_link == 2 ? m : 1.0);
  vec2 lp = fx_layerPx();
  vec2 c = u_center * warp_size();
  vec2 d = lp - c;
  float dist = u_shape == 0 ? length(d) : max(abs(d.x), abs(d.y));
  float aa = 0.5 / u_pxScale;
  float inside = 1.0 - smoothstep(size - max(feather, aa), size + aa, dist);
  if (inside <= 0.0 || (!u_resizeLayer && !fx_inBox(v_uv))) { fragColor = src; return; }
  vec2 s = c + d / m;
  vec4 mag;
  if (u_scaling == 1) {
    // Soft: average over one magnified pixel.
    float r = 0.5 * m / max(u_pxScale, 1.0e-3);
    mag = (warp_at(s + vec2(-r, -r) / m) + warp_at(s + vec2(r, -r) / m) + warp_at(s + vec2(-r, r) / m) + warp_at(s + vec2(r, r) / m)) * 0.25;
  } else if (u_scaling == 2) {
    // Scatter: each output pixel picks a random point of its magnified source pixel.
    vec2 j = psdg_hash22(ivec2(floor(lp)), 0.37) - 0.5;
    mag = warp_at(s + j * 1.0);
  } else {
    mag = warp_at(s);
  }
  vec4 base = u_resizeLayer || fx_inBox(v_uv) ? src : vec4(0.0);
  fragColor = psdg_blend(u_blendingMode, base, mag * inside, u_opacity / 100.0);
}`,
			},
		],
	},
});

export const MIRROR = defineShaderEffect({
	id: 'jasper.mirror',
	label: 'Mirror',
	category: 'Distort',
	description: 'Splits the picture along a line and reflects one side onto the other.',
	keywords: ['reflect', 'symmetry', 'kaleidoscope', 'flip half'],
	params: [
		fxParam.point('reflectionCenter', 'Reflection Center', [0.5, 0.5]),
		fxParam.angle('reflectionAngle', 'Reflection Angle', 0),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PSDG_WARP],
				frag: /* glsl */ `
void main() {
  if (!fx_inBox(v_uv)) { fragColor = vec4(0.0); return; }
  vec2 lp = fx_layerPx();
  vec2 c = u_reflectionCenter * warp_size();
  float a = radians(u_reflectionAngle);
  vec2 d = vec2(cos(a), sin(a));
  float s = dot(lp - c, d);
  // The side the angle points to shows the reflection of the other side.
  vec2 src = s > 0.0 ? lp - 2.0 * s * d : lp;
  fragColor = warp_at(src);
}`,
			},
		],
	},
});

export const OFFSET = defineShaderEffect({
	id: 'jasper.offset',
	label: 'Offset',
	category: 'Distort',
	description: 'Pans the picture inside the layer; what leaves one edge wraps around to the opposite edge.',
	keywords: ['pan', 'wrap', 'scroll', 'tile', 'shift'],
	params: [fxParam.point('shiftCenterTo', 'Shift Center To', [0.5, 0.5]), blendWithOriginalParam()],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_SAMPLE, GLSL_PSDG_BLEND],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (!fx_inBox(v_uv)) { fragColor = src; return; }
  vec2 n = fract(fx_layerNorm() - (u_shiftCenterTo - 0.5));
  vec4 shifted = fx_sampleLayer(u_source, n, FX_EDGE_REPEAT);
  fragColor = psdg_blendOriginal(shifted, src, u_blendWithOriginal);
}`,
			},
		],
	},
});

export const SPHERIZE = defineShaderEffect({
	id: 'jasper.spherize',
	label: 'Spherize',
	category: 'Distort',
	description: 'Wraps a circular area of the picture around a sphere, bulging it towards the viewer.',
	keywords: ['bulge', 'fisheye', 'bubble', 'ball', 'warp'],
	params: [
		fxParam.number('radius', 'Radius', 0, { min: 0, max: 2500, softMax: 1000, step: 0.1 }, { unit: 'px' }),
		fxParam.point('centerOfSphere', 'Center of Sphere', [0.5, 0.5]),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PSDG_WARP],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_radius <= 0.0 || !fx_inBox(v_uv)) { fragColor = src; return; }
  vec2 lp = fx_layerPx();
  vec2 c = u_centerOfSphere * warp_size();
  vec2 d = lp - c;
  float r = length(d);
  if (r >= u_radius) { fragColor = src; return; }
  // Seen from the front, a point at distance r on the sphere shows the source at the arc length to it.
  float t = r / u_radius;
  float sr = u_radius * asin(t) / 1.5707963;
  fragColor = warp_at(c + (r > 0.0 ? d / r * sr : vec2(0.0)));
}`,
			},
		],
	},
});

const TURB_TYPES = [
	'turbulent',
	'bulge',
	'twist',
	'turbulentSmoother',
	'bulgeSmoother',
	'twistSmoother',
	'vertical',
	'horizontal',
	'cross',
] as const;
const TURB_PINNING = [
	'pinAll',
	'none',
	'pinLeft',
	'pinTop',
	'pinRight',
	'pinBottom',
	'pinHorizontal',
	'pinVertical',
] as const;

export const TURBULENT_DISPLACE = defineShaderEffect({
	id: 'jasper.turbulent-displace',
	label: 'Turbulent Displace',
	category: 'Distort',
	description:
		'Distorts the picture with fractal noise: flowing water, waving flags, heat haze; animate Evolution to make it move.',
	keywords: ['warp', 'noise', 'wobble', 'heat haze', 'flag', 'water', 'organic'],
	expensive: true,
	params: [
		fxParam.choice(
			'displacement',
			'Displacement',
			TURB_TYPES,
			[
				'Turbulent',
				'Bulge',
				'Twist',
				'Turbulent Smoother',
				'Bulge Smoother',
				'Twist Smoother',
				'Vertical Displacement',
				'Horizontal Displacement',
				'Cross Displacement',
			],
			'turbulent',
		),
		fxParam.number('amount', 'Amount', 50, { min: -1000, max: 1000, softMin: -200, softMax: 200, step: 0.1 }),
		fxParam.number('size', 'Size', 100, { min: 2, max: 1000, softMax: 300, step: 0.1 }),
		fxParam.point('offset', 'Offset (Turbulence)', [0.5, 0.5]),
		fxParam.number('complexity', 'Complexity', 1, { min: 1, max: 10, step: 0.1 }),
		...evolutionParams(),
		randomSeedParam(),
		fxParam.choice(
			'pinning',
			'Pinning',
			TURB_PINNING,
			['Pin All', 'None', 'Pin Left', 'Pin Top', 'Pin Right', 'Pin Bottom', 'Pin Horizontal', 'Pin Vertical'],
			'pinAll',
		),
		fxParam.toggle('resizeLayer', 'Resize Layer', false),
		fxParam.choice('antialiasing', 'Antialiasing for Best Quality', ['low', 'high'], ['Low', 'High'], 'low'),
	],
	gpu: {
		timeInvariant: true,
		padding: (p) => (bool(p.resizeLayer) ? Math.min(2048, Math.abs(num(p.amount, 50)) * 1.2) : 0),
		passes: [
			{
				include: [GLSL_PSDG_WARP, GLSL_PSDG_EVOLVE],
				frag: /* glsl */ `
// Displacement (layer px) at a layer position. One noise call site (in a loop over the needed samples).
vec2 displacementAt(vec2 lp) {
  int type = u_displacement;
  bool smoother = type == 3 || type == 4 || type == 5;
  float oct = clamp(u_complexity, 1.0, 10.0);
  if (smoother) oct = max(1.0, oct - 1.0);
  vec2 q = (lp - u_offset * warp_size()) / max(u_size, 1.0) * 1.3;
  bool gradientType = type == 1 || type == 2 || type == 4 || type == 5;
  // Samples: Turbulent: x, y channels; gradient types: n(q), n(q+e.x), n(q+e.y); others: one.
  int count = gradientType ? 3 : (type == 0 || type == 3) ? 2 : 1;
  float e = 0.05;
  float n[3] = float[3](0.0, 0.0, 0.0);
  for (int k = 0; k < count; k++) {
    vec2 qk = gradientType ? q + (k == 1 ? vec2(e, 0.0) : k == 2 ? vec2(0.0, e) : vec2(0.0)) : q + float(k) * 31.7;
    float sk = gradientType ? 0.0 : float(k) * 0.173;
    n[k] = psdg_evolve(qk, oct, u_evolution, u_cycleEvolution, u_cycle, fract(u_seed + sk), false);
  }
  float amt = u_amount * 0.5;
  if (type == 0 || type == 3) return vec2(n[0], n[1]) * amt;
  if (type == 6) return vec2(0.0, n[0]) * amt;
  if (type == 7) return vec2(n[0], 0.0) * amt;
  if (type == 8) return vec2(n[0], n[0]) * amt * 0.75;
  // Bulge / Twist: along / around the gradient of one noise field.
  vec2 g = vec2(n[1] - n[0], n[2] - n[0]) / e * 0.35;
  if (type == 1 || type == 4) return -g * amt;
  return vec2(-g.y, g.x) * amt;
}
float pinWeight(vec2 lp) {
  vec2 s = warp_size();
  float band = max(u_size, 8.0);
  float l = smoothstep(0.0, band, lp.x), r = smoothstep(0.0, band, s.x - lp.x);
  float t = smoothstep(0.0, band, lp.y), b = smoothstep(0.0, band, s.y - lp.y);
  int pin = u_pinning;
  if (pin == 0) return l * r * t * b;
  if (pin == 2) return l;
  if (pin == 3) return t;
  if (pin == 4) return r;
  if (pin == 5) return b;
  if (pin == 6) return l * r;
  if (pin == 7) return t * b;
  return 1.0;
}
void main() {
  if (!u_resizeLayer && !fx_inBox(v_uv)) { fragColor = vec4(0.0); return; }
  vec2 lp = fx_layerPx();
  // The displacement field is smooth: computed once; High antialiasing supersamples the lookup (2×2).
  vec2 disp = displacementAt(lp) * pinWeight(clamp(lp, vec2(0.0), warp_size()));
  int n = u_antialiasing == 1 ? 2 : 1;
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 2; j++)
    for (int i = 0; i < 2; i++) {
      if (i >= n || j >= n) continue;
      vec2 o = n == 1 ? vec2(0.0) : (vec2(float(i), float(j)) - 0.5) * 0.5 / u_pxScale;
      sum += warp_at(lp + o + disp);
    }
  fragColor = sum / float(n * n);
}`,
			},
		],
	},
});

export const TWIRL = defineShaderEffect({
	id: 'jasper.twirl',
	label: 'Twirl',
	category: 'Distort',
	description:
		'Rotates the picture around a centre, more strongly near the centre than at the edge of the radius.',
	keywords: ['swirl', 'spiral', 'vortex', 'whirlpool', 'rotate'],
	params: [
		fxParam.angle('angle', 'Angle', 50),
		fxParam.number(
			'twirlRadius',
			'Twirl Radius',
			75,
			{ min: 0, max: 100, step: 0.1 },
			{ ui: { control: 'slider' } },
		),
		fxParam.point('twirlCenter', 'Twirl Center', [0.5, 0.5]),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PSDG_WARP],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (!fx_inBox(v_uv)) { fragColor = src; return; }
  vec2 size = warp_size();
  // Twirl Radius: % of half the layer's larger side.
  float R = u_twirlRadius / 100.0 * 0.5 * max(size.x, size.y);
  vec2 c = u_twirlCenter * size;
  vec2 d = fx_layerPx() - c;
  float r = length(d);
  if (R <= 0.0 || r >= R) { fragColor = src; return; }
  float t = 1.0 - r / R;
  float a = -radians(u_angle) * t * t;
  float ca = cos(a), sa = sin(a);
  fragColor = warp_at(c + vec2(ca * d.x - sa * d.y, sa * d.x + ca * d.y));
}`,
			},
		],
	},
});

const WAVE_TYPES = [
	'sine',
	'square',
	'triangle',
	'sawtooth',
	'circle',
	'semicircle',
	'uncircle',
	'noise',
	'smoothNoise',
] as const;
const WAVE_PINNING = [
	'none',
	'allEdges',
	'center',
	'leftEdge',
	'topEdge',
	'rightEdge',
	'bottomEdge',
	'horizontalEdges',
	'verticalEdges',
] as const;

/** Padding of Wave Warp: the waves push pixels up to Wave Height outside the layer (none when all edges are pinned). */
function waveWarpPadding(height: number, pinning: string): number {
	return pinning === 'allEdges' ? 0 : Math.ceil(Math.abs(height)) + 1;
}

export const WAVE_WARP = defineShaderEffect({
	id: 'jasper.wave-warp',
	label: 'Wave Warp',
	category: 'Distort',
	description:
		'Makes the picture ripple with travelling waves (sine, square, triangle, sawtooth, circle, noise…), like a flag or water.',
	keywords: ['wave', 'ripple', 'wobble', 'flag', 'wiggle', 'water'],
	params: [
		fxParam.choice(
			'waveType',
			'Wave Type',
			WAVE_TYPES,
			['Sine', 'Square', 'Triangle', 'Sawtooth', 'Circle', 'Semicircle', 'Uncircle', 'Noise', 'Smooth Noise'],
			'sine',
		),
		fxParam.number(
			'waveHeight',
			'Wave Height',
			10,
			{ min: -10000, max: 10000, softMin: 0, softMax: 100, step: 1 },
			{ unit: 'px' },
		),
		fxParam.number(
			'waveWidth',
			'Wave Width',
			40,
			{ min: 1, max: 10000, softMax: 500, step: 1 },
			{ unit: 'px' },
		),
		fxParam.angle('direction', 'Direction', 90),
		fxParam.number('waveSpeed', 'Wave Speed', 1, {
			min: -100,
			max: 100,
			softMin: -5,
			softMax: 5,
			step: 0.01,
		}),
		fxParam.choice(
			'pinning',
			'Pinning',
			WAVE_PINNING,
			[
				'None',
				'All Edges',
				'Center',
				'Left Edge',
				'Top Edge',
				'Right Edge',
				'Bottom Edge',
				'Horizontal Edges',
				'Vertical Edges',
			],
			'none',
		),
		fxParam.angle('phase', 'Phase', 0),
		fxParam.choice(
			'antialiasing',
			'Antialiasing (Best Quality)',
			['low', 'medium', 'high'],
			['Low', 'Medium', 'High'],
			'medium',
		),
	],
	gpu: {
		padding: (p) => waveWarpPadding(num(p.waveHeight, 10), str(p.pinning, 'none')),
		passes: [
			{
				include: [GLSL_PSDG_WARP, GLSL_PSDG_COMPASS, GLSL_PSDG_HASH],
				frag: /* glsl */ `
// Wave shapes over one period x ∈ [0, 1), values −1..1.
float waveShape(int type, float x, float k) {
  x = fract(x);
  if (type == 0) return sin(x * 6.28318530718);
  if (type == 1) return x < 0.5 ? 1.0 : -1.0;
  if (type == 2) return 1.0 - 4.0 * abs(x - 0.5) ;
  if (type == 3) return 2.0 * x - 1.0;
  if (type == 4) { float u = fract(x * 2.0) * 2.0 - 1.0; float s = sqrt(max(0.0, 1.0 - u * u)); return x < 0.5 ? s : -s; }
  if (type == 5) { float u = x * 2.0 - 1.0; return sqrt(max(0.0, 1.0 - u * u)) * 2.0 - 1.0; }
  if (type == 6) { float u = x * 2.0 - 1.0; return 1.0 - sqrt(max(0.0, 1.0 - u * u)) * 2.0; }
  // Noise: a random level per half wave; Smooth Noise: interpolated.
  float h0 = psdg_hash1(int(k), 0.618) * 2.0 - 1.0;
  float h1 = psdg_hash1(int(k) + 1, 0.618) * 2.0 - 1.0;
  if (type == 7) return h0;
  float t = x;
  return mix(h0, h1, t * t * (3.0 - 2.0 * t));
}
float pinWeight(vec2 lp) {
  vec2 s = warp_size();
  float band = max(u_waveWidth, 8.0);
  float l = smoothstep(0.0, band, lp.x), r = smoothstep(0.0, band, s.x - lp.x);
  float t = smoothstep(0.0, band, lp.y), b = smoothstep(0.0, band, s.y - lp.y);
  int pin = u_pinning;
  if (pin == 1) return l * r * t * b;
  if (pin == 2) return smoothstep(0.0, max(s.x, s.y) * 0.25, length(lp - s * 0.5));
  if (pin == 3) return l;
  if (pin == 4) return t;
  if (pin == 5) return r;
  if (pin == 6) return b;
  if (pin == 7) return t * b;
  if (pin == 8) return l * r;
  return 1.0;
}
// The displacement of the wave at a (sub-)pixel position.
vec2 waveDisp(vec2 lp) {
  vec2 travel = psdg_compass(u_direction);
  vec2 across = vec2(-travel.y, travel.x);
  float w = max(u_waveWidth, 1.0);
  float x = dot(lp, travel) / w - u_waveSpeed * u_time + u_phase / 360.0;
  float k = floor(x);
  float v = waveShape(u_waveType, x, k);
  return across * v * u_waveHeight * pinWeight(clamp(lp, vec2(0.0), warp_size()));
}
void main() {
  vec2 lp = fx_layerPx();
  // Antialiasing supersamples the displacement (smooths the steps of square/sawtooth/noise waves); the lookup
  // stays at the pixel so a flat wave is an exact identity.
  int n = u_antialiasing == 0 ? 1 : u_antialiasing == 1 ? 2 : 3;
  vec4 sum = vec4(0.0);
  for (int j = 0; j < n; j++)
    for (int i = 0; i < n; i++) {
      vec2 o = (vec2(float(i), float(j)) + 0.5) / float(n) - 0.5;
      sum += warp_at(lp - waveDisp(lp + o / u_pxScale));
    }
  fragColor = sum / float(n * n);
}`,
			},
		],
	},
});

export const PSDG_DISTORT_EFFECTS: readonly EffectSpec[] = [
	LENS_DISTORTION,
	MAGNIFY,
	MIRROR,
	OFFSET,
	SPHERIZE,
	TURBULENT_DISPLACE,
	TWIRL,
	WAVE_WARP,
];
