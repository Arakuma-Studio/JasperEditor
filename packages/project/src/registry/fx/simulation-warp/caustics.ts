// Simulation ▸ Caustics (sim-warp workstream; After Effects' Caustics): the layer (or the Bottom image) seen through
// a water surface whose heights are the luminance of the Water Surface image (e.g. a Wave World height map), smoothed:
// the surface refracts the bottom, focuses light into caustics, reflects a Sky image and is lit by a distant or point
// light. Pure per-pixel passes (no state). Ported from EffectCraft crates/effects/src/sim2.rs (caustics_setup,
// caustics; MIT OR Apache-2.0), see licenses/ported/sim-warp.md.
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { fxParam } from '../params.ts';
import { gaussianBlurPasses } from '../passes.ts';
import type { GlslChunk } from '../shader.ts';
import { n, popup } from './common.ts';
import { num } from './core.ts';
import { LIGHT_TYPES } from './pieces.ts';

const REPEAT = ['Once', 'Tiled', 'Reflected'] as const;
const DIFFERS = ['Center', 'Stretch to Fit'] as const;

const GLSL_CAUSTICS: GlslChunk = {
	name: 'sim/caustics',
	source: /* glsl */ `
// A picture of size tsize (px) placed on the layer: stretched (fit 1) or centred at its own size (fit 0), scaled
// about the layer centre by 1/scaling, repeated per mode (0 Once, 1 Tiled, 2 Reflected). lp = layer px.
vec4 ca_place(highp sampler2D t, vec2 tsize, vec2 lp, vec2 L, float scaling, int mode, int fit) {
  vec2 c = L * 0.5;
  vec2 q = c + (lp - c) / max(scaling, 0.01);
  vec2 uv = fit == 1 ? q / L : (q - c) / max(tsize, vec2(1.0)) + 0.5;
  if (mode == 1) uv = fract(uv);
  else if (mode == 2) uv = 1.0 - abs(mod(uv, 2.0) - 1.0);
  else if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
  return texture(t, uv);
}
`,
};

export const CAUSTICS = defineShaderEffect({
	id: 'jasper.caustics',
	label: 'Caustics',
	category: 'Simulation',
	description:
		'Simulates looking through water: the bottom refracts through a height-map surface, light focuses into caustics, the surface reflects a sky.',
	keywords: ['water', 'pool', 'underwater', 'refraction', 'light'],
	params: [
		fxParam.media('bottom', 'Bottom', ['image', 'video'], { group: 'Bottom' }),
		n('bottomScaling', 'Scaling', 1, 0.01, 10, 0.1, 3, 0.001, { group: 'Bottom' }),
		popup('bottomRepeatMode', 'Repeat Mode', REPEAT, 2, 'Bottom'),
		popup('bottomSizeDiffers', 'If Layer Size Differs', DIFFERS, 1, 'Bottom'),
		n('bottomBlur', 'Blur', 0, 0, 100, 0, 20, 0.1, { group: 'Bottom', unit: 'px' }),
		fxParam.media('waterSurface', 'Water Surface', ['image', 'video'], { group: 'Water' }),
		n('waveHeight', 'Wave Height', 0.2, -1, 1, -1, 1, 0.001, { group: 'Water' }),
		n('smoothing', 'Smoothing', 5, 0, 100, 0, 50, 0.1, { group: 'Water', unit: 'px' }),
		n('waterDepth', 'Water Depth', 0.1, 0, 1, 0, 1, 0.001, { group: 'Water' }),
		n('refractiveIndex', 'Refractive Index', 1.2, 1, 3, 1, 2, 0.001, { group: 'Water' }),
		fxParam.color('surfaceColor', 'Surface Color', [1, 1, 1, 1], { group: 'Water' }),
		n('surfaceOpacity', 'Surface Opacity', 0.3, 0, 1, 0, 1, 0.001, { group: 'Water' }),
		n('causticsStrength', 'Caustics Strength', 0, 0, 1, 0, 1, 0.001, { group: 'Water' }),
		fxParam.media('sky', 'Sky', ['image', 'video'], { group: 'Sky' }),
		n('skyScaling', 'Scaling', 1, 0.01, 10, 0.1, 3, 0.001, { group: 'Sky' }),
		popup('skyRepeatMode', 'Repeat Mode', REPEAT, 2, 'Sky'),
		popup('skySizeDiffers', 'If Layer Size Differs', DIFFERS, 1, 'Sky'),
		n('skyIntensity', 'Intensity', 0.3, 0, 1, 0, 1, 0.001, { group: 'Sky' }),
		n('skyConvergence', 'Convergence', 0.5, 0, 1, 0, 1, 0.001, { group: 'Sky' }),
		popup('lightType', 'Light Type', LIGHT_TYPES, 0, 'Lighting'),
		n('lightIntensity', 'Light Intensity', 1, 0, 4, 0, 2, 0.01, { group: 'Lighting' }),
		fxParam.color('lightColor', 'Light Color', [1, 1, 1, 1], { group: 'Lighting' }),
		fxParam.point('lightPosition', 'Light Position', [0, 0], { group: 'Lighting' }),
		n('lightHeight', 'Light Height', 1, 0, 10, 0, 4, 0.01, { group: 'Lighting' }),
		n('ambientLight', 'Ambient Light', 0.35, 0, 2, 0, 1, 0.01, { group: 'Lighting' }),
		n('diffuseReflection', 'Diffuse Reflection', 0.75, 0, 2, 0, 1, 0.01, { group: 'Material' }),
		n('specularReflection', 'Specular Reflection', 0.2, 0, 2, 0, 1, 0.01, { group: 'Material' }),
		n('highlightSharpness', 'Highlight Sharpness', 15, 1, 100, 1, 100, 0.1, { group: 'Material' }),
	],
	expensive: true,
	gpu: {
		uniforms: (p, ctx) => ({
			u_hSigma: Math.max(0, num(p.smoothing, 5)) * 0.5 * ctx.pxScale,
			u_bSigma: Math.max(0, num(p.bottomBlur)) * 0.5 * ctx.pxScale,
		}),
		passes: [
			{
				// Water heights: the surface image's luminance (flat without one).
				output: 'height',
				format: 'rgba16f',
				include: [GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  if (u_waterSurface_size.x <= 0.0) { fragColor = vec4(0.0); return; }
  vec4 c = fx_unpremultiply(texture(u_waterSurface, fx_layerNorm()));
  fragColor = vec4(fx_luma(c.rgb), 0.0, 0.0, 1.0);
}`,
			},
			...gaussianBlurPasses({
				input: 'height',
				output: 'hb',
				sigma: { uniform: 'u_hSigma' },
				format: 'rgba16f',
			}),
			{
				output: 'bottomPic',
				include: [GLSL_CAUSTICS],
				frag: /* glsl */ `
void main() {
  vec2 L = u_box.zw / u_pxScale;
  vec2 lp = fx_layerPx();
  if (u_bottom_size.x <= 0.0) {
    // The layer itself (a picture of the layer's size, already in place).
    vec2 c = L * 0.5;
    vec2 q = c + (lp - c) / max(u_bottomScaling, 0.01);
    vec2 uv = q / L;
    if (u_bottomRepeatMode == 1) uv = fract(uv);
    else if (u_bottomRepeatMode == 2) uv = 1.0 - abs(mod(uv, 2.0) - 1.0);
    fragColor = (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) ? vec4(0.0) : texture(u_source, fx_uvOfLayerNorm(uv));
    return;
  }
  fragColor = ca_place(u_bottom, u_bottom_size, lp, L, u_bottomScaling, u_bottomRepeatMode, u_bottomSizeDiffers);
}`,
			},
			...gaussianBlurPasses({ input: 'bottomPic', output: 'bottomSoft', sigma: { uniform: 'u_bSigma' } }),
			{
				include: [GLSL_CAUSTICS],
				frag: /* glsl */ `
vec2 ca_grad(vec2 uv) {
  vec2 e = u_texel;
  return vec2(texture(u_hb, uv + vec2(e.x, 0.0)).r - texture(u_hb, uv - vec2(e.x, 0.0)).r,
              texture(u_hb, uv + vec2(0.0, e.y)).r - texture(u_hb, uv - vec2(0.0, e.y)).r) * 0.5;
}
void main() {
  vec2 L = u_box.zw / u_pxScale;
  float lw = u_box.z;
  float k = u_waveHeight * u_waterDepth * (1.0 - 1.0 / max(u_refractiveIndex, 1.0)) * lw * 2.0;
  vec2 e = u_texel;
  vec2 g = ca_grad(v_uv);
  vec2 disp = -g * k;
  float dxr = -ca_grad(v_uv + vec2(e.x, 0.0)).x * k, dxl = -ca_grad(v_uv - vec2(e.x, 0.0)).x * k;
  float dyd = -ca_grad(v_uv + vec2(0.0, e.y)).y * k, dyu = -ca_grad(v_uv - vec2(0.0, e.y)).y * k;
  float jac = (1.0 + (dxr - dxl) * 0.5) * (1.0 + (dyd - dyu) * 0.5);
  float focus = clamp(1.0 / max(abs(jac), 0.2) - 1.0, -1.0, 4.0);
  // The bottom is already placed and scaled on the layer: refract by sampling it displaced.
  vec4 bp = texture(u_bottomSoft, clamp(v_uv + disp / u_canvasSize, vec2(0.0), vec2(1.0)));
  vec4 b = fx_unpremultiply(bp);
  vec3 n = normalize(vec3(-g * u_waveHeight * 20.0, 1.0));
  vec2 lp = u_lightPosition * L;
  vec3 lv = u_lightType == 1
    ? normalize(vec3((lp - fx_layerPx()) / max(L.x, 1.0), max(u_lightHeight, 0.01)))
    : normalize(vec3((lp - L * 0.5) / max(L.x, 1.0), max(u_lightHeight, 0.01)));
  float li = u_lightIntensity;
  float nl = max(dot(n, lv), 0.0);
  vec3 hv = normalize(lv + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, hv), 0.0), max(u_highlightSharpness, 1.0)) * u_specularReflection * li;
  float light = u_ambientLight + u_diffuseReflection * li * nl + u_causticsStrength * focus * li;
  vec3 surface;
  if (u_sky_size.x > 0.0) {
    float reach = (1.0 - clamp(u_skyConvergence, 0.0, 1.0)) * L.x * 0.5;
    vec2 rp = fx_layerPx() + n.xy * reach;
    vec4 sk = fx_unpremultiply(ca_place(u_sky, u_sky_size, rp, L, u_skyScaling, u_skyRepeatMode, u_skySizeDiffers));
    surface = sk.rgb * u_skyIntensity * 3.0 * u_surfaceColor.rgb;
  } else surface = u_surfaceColor.rgb * (u_ambientLight + u_diffuseReflection * li * nl);
  vec3 cc = b.rgb * light * u_lightColor.rgb * (1.0 - u_surfaceOpacity) + surface * u_surfaceOpacity + spec * u_lightColor.rgb;
  float a = min(b.a + u_surfaceOpacity * (1.0 - b.a), 1.0);
  fragColor = vec4(cc * a, a);
}`,
			},
		],
	},
});

export const CAUSTICS_EFFECTS: readonly EffectSpec[] = [CAUSTICS];
