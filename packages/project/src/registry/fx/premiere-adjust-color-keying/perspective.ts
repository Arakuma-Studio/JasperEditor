// Premiere Pro "Perspective" video effects (fx family premiere-adjust-color-keying): Basic 3D, Bevel Alpha, Bevel
// Edges, Drop Shadow, Radial Shadow. Angles follow Premiere: 0° = up, clockwise (Drop Shadow's default 135° casts
// the shadow to the lower right; Bevel light angle −60° lights from the upper left). Shadows draw into padding.
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_BLEND } from '../glsl/blend.ts';
import { fxParam } from '../params.ts';
import { gaussianBlurPasses } from '../passes.ts';
import type { FxPlanContext, ShaderPass } from '../shader.ts';
import { blurScale, premiereDirection } from './blur-sharpen.ts';
import { bool, GLSL_PACG, num, popup, slider } from './common.ts';

/** Softness (layer px, blur radius) → Gaussian σ. */
const softnessSigma = (softness: number) => Math.max(0, softness) * 0.4;

// ---------------------------------------------------------------- Basic 3D

/** Basic 3D camera: focal length (layer px) for a layer box, and the plane's distance offset. */
export function basic3dCamera(p: EffectParams, ctx: Pick<FxPlanContext, 'width' | 'height'>) {
	const f = Math.hypot(ctx.width, ctx.height) * 1.2;
	const dz = (Math.max(-90, Math.min(1000, num(p.distanceToImage))) / 100) * f;
	return { f, dz };
}

/** Rotation (swivel about y, then tilt about x) as a column-major mat3. */
export function basic3dRotation(p: EffectParams): number[] {
	const s = (num(p.swivel) * Math.PI) / 180;
	const t = (num(p.tilt) * Math.PI) / 180;
	const cs = Math.cos(s);
	const ss = Math.sin(s);
	const ct = Math.cos(t);
	const st = Math.sin(t);
	// R = Rx(tilt) · Ry(swivel); rows: [cs, 0, ss], [st·ss, ct, −st·cs], [−ct·ss, st, ct·cs]
	const r = [
		[cs, 0, ss],
		[st * ss, ct, -st * cs],
		[-ct * ss, st, ct * cs],
	];
	return [r[0]![0]!, r[1]![0]!, r[2]![0]!, r[0]![1]!, r[1]![1]!, r[2]![1]!, r[0]![2]!, r[1]![2]!, r[2]![2]!];
}

/** Layer px the projected plane may reach outside the box (corners projected through the pinhole camera). */
export function basic3dPadding(p: EffectParams, ctx: Pick<FxPlanContext, 'width' | 'height'>): number {
	const { f, dz } = basic3dCamera(p, ctx);
	const m = basic3dRotation(p);
	let reach = 0;
	for (const [x, y] of [
		[-1, -1],
		[1, -1],
		[-1, 1],
		[1, 1],
	] as const) {
		const lx = (x * ctx.width) / 2;
		const ly = (y * ctx.height) / 2;
		// world = R · local + (0, 0, f + dz)
		const wx = m[0]! * lx + m[3]! * ly;
		const wy = m[1]! * lx + m[4]! * ly;
		const wz = m[2]! * lx + m[5]! * ly + f + dz;
		if (wz < f * 0.05) return 2048;
		const sx = (wx * f) / wz;
		const sy = (wy * f) / wz;
		reach = Math.max(reach, Math.abs(sx) - ctx.width / 2, Math.abs(sy) - ctx.height / 2);
	}
	return Math.ceil(Math.max(0, reach) + 2);
}

export const BASIC_3D = defineShaderEffect({
	id: 'jasper.basic-3d',
	label: 'Basic 3D',
	category: 'Perspective',
	description:
		'Swivels and tilts the clip in 3D space and moves it nearer or farther, with perspective and an optional specular highlight.',
	keywords: ['3d', 'perspective', 'rotate', 'swivel', 'tilt', 'flip'],
	params: [
		fxParam.angle('swivel', 'Swivel', 0),
		fxParam.angle('tilt', 'Tilt', 0),
		slider('distanceToImage', 'Distance to Image', 0, -90, 1000, { softMax: 100, step: 0.1 }),
		fxParam.toggle('specularHighlight', 'Specular Highlight', false),
		fxParam.toggle('drawPreviewWireframe', 'Preview: Draw Preview Wireframe', false),
	],
	gpu: {
		timeInvariant: true,
		padding: (p, ctx) => basic3dPadding(p, ctx),
		uniforms: (p, ctx) => {
			const { f, dz } = basic3dCamera(p, ctx);
			return { u_b3dRot: { mat3: basic3dRotation(p) }, u_b3dF: f, u_b3dDz: dz };
		},
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec2 box = u_box.zw / u_pxScale;
  // Ray through this pixel (layer px relative to the box centre; camera at the origin looking down +z).
  vec3 dir = vec3(fx_layerPx() - box * 0.5, u_b3dF);
  vec3 C = vec3(0.0, 0.0, u_b3dF + u_b3dDz);
  vec3 n = u_b3dRot * vec3(0.0, 0.0, 1.0);
  float den = dot(dir, n);
  if (abs(den) < 1.0e-6) { fragColor = vec4(0.0); return; }
  float t = dot(C, n) / den;
  if (t <= 0.0) { fragColor = vec4(0.0); return; }
  vec3 X = dir * t;
  vec2 local = (transpose(u_b3dRot) * (X - C)).xy;
  vec2 ln = local / box + 0.5;
  vec4 c = vec4(0.0);
  if (all(greaterThanEqual(ln, vec2(0.0))) && all(lessThanEqual(ln, vec2(1.0)))) c = texture(u_source, fx_uvOfLayerNorm(ln));
  if (u_specularHighlight && c.a > 0.0) {
    // A light above-left of the camera: the highlight slides across the plane as it turns.
    vec3 L = normalize(vec3(-0.6, -0.8, 0.0) * u_b3dF - X);
    vec3 V = normalize(-X);
    vec3 nf = dot(n, V) < 0.0 ? -n : n;
    float s = pow(max(dot(nf, normalize(L + V)), 0.0), 80.0);
    c.rgb = min(c.rgb + vec3(s) * c.a, vec3(c.a));
  }
  if (u_drawPreviewWireframe) {
    vec2 px = local + box * 0.5;
    float e = min(min(px.x, box.x - px.x), min(px.y, box.y - px.y));
    float w = 1.5 * t / u_b3dF;
    if (e > -w && e < w && all(greaterThan(px, vec2(-w))) && all(lessThan(px, box + w))) c = vec4(1.0);
  }
  fragColor = c;
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Bevel Alpha

export const BEVEL_ALPHA = defineShaderEffect({
	id: 'jasper.bevel-alpha',
	label: 'Bevel Alpha',
	category: 'Perspective',
	description: 'Gives the alpha edges of the clip (titles, logos, keyed shapes) a chiselled, lit 3D bevel.',
	keywords: ['bevel', 'emboss', 'chisel', '3d edge', 'title'],
	params: [
		slider('edgeThickness', 'Edge Thickness', 2, 0, 200, { softMax: 20, unit: 'px' }),
		fxParam.angle('lightAngle', 'Light Angle', -60),
		fxParam.color('lightColor', 'Light Color', [1, 1, 1, 1]),
		slider('lightIntensity', 'Light Intensity', 0.4, 0, 1, { step: 0.01 }),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p) => ({ u_lightDir: premiereDirection(num(p.lightAngle, -60)) }),
		passes: (p, ctx) => {
			const sigma = Math.max(0.5, num(p.edgeThickness, 2)) * ctx.pxScale * 0.7;
			return [
				{ output: 'alpha', frag: 'void main() { float a = texture(u_source, v_uv).a; fragColor = vec4(a, a, a, 1.0); }' },
				...gaussianBlurPasses({ input: 'alpha', output: 'height', sigma, scale: blurScale(sigma) }),
				{
					include: [GLSL_PACG],
					uniforms: { u_bevelSigma: sigma },
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (src.a <= 0.0) { fragColor = src; return; }
  vec2 e = u_texel * 1.5;
  float hx = texture(u_height, v_uv + vec2(e.x, 0.0)).r - texture(u_height, v_uv - vec2(e.x, 0.0)).r;
  float hy = texture(u_height, v_uv + vec2(0.0, e.y)).r - texture(u_height, v_uv - vec2(0.0, e.y)).r;
  // Slope towards the light → lit; away → shaded. The gradient points up the bevel (into the shape).
  // ≈ 1 on the steepest part of the blurred alpha edge (slope ≈ 1 / (2.5 σ) per texel).
  vec2 g = vec2(hx, hy) / 3.0 * u_bevelSigma * 2.5;
  float slope = clamp(length(g), 0.0, 1.0);
  float facing = length(g) > 1.0e-5 ? dot(normalize(g), -u_lightDir) : 0.0;
  float k = facing * slope * u_lightIntensity * 2.0;
  vec3 c = pacg_straight(src);
  vec3 r = k > 0.0 ? mix(c, u_lightColor.rgb, clamp(k, 0.0, 1.0)) : c * (1.0 + k);
  fragColor = fx_premultiply(vec4(clamp(r, 0.0, 1.0), src.a));
}`,
				},
			];
		},
	},
});

// ---------------------------------------------------------------- Bevel Edges

export const BEVEL_EDGES = defineShaderEffect({
	id: 'jasper.bevel-edges',
	label: 'Bevel Edges',
	category: 'Perspective',
	description: 'Gives the edges of the clip a lit, chiselled 3D look (a rectangular bevel around the frame).',
	keywords: ['bevel', 'frame', 'button', '3d edge', 'emboss'],
	params: [
		slider('edgeThickness', 'Edge Thickness', 0.1, 0, 0.5, { step: 0.001 }),
		fxParam.angle('lightAngle', 'Light Angle', -60),
		fxParam.color('lightColor', 'Light Color', [1, 1, 1, 1]),
		slider('lightIntensity', 'Light Intensity', 0.4, 0, 1, { step: 0.01 }),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p) => ({ u_lightDir: premiereDirection(num(p.lightAngle, -60)) }),
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (src.a <= 0.0 || !fx_inBox(v_uv)) { fragColor = src; return; }
  vec2 box = u_box.zw / u_pxScale;
  vec2 p = fx_layerPx();
  float w = u_edgeThickness * min(box.x, box.y);
  // Distance to each edge; the nearest edge within the bevel width decides the facet's outward normal.
  float dl = p.x, dr = box.x - p.x, dt = p.y, db = box.y - p.y;
  float d = min(min(dl, dr), min(dt, db));
  if (d >= w || w <= 0.0) { fragColor = src; return; }
  vec2 nrm = d == dl ? vec2(-1.0, 0.0) : d == dr ? vec2(1.0, 0.0) : d == dt ? vec2(0.0, -1.0) : vec2(0.0, 1.0);
  float facing = dot(nrm, u_lightDir);
  float k = facing * u_lightIntensity * 1.5;
  vec3 c = pacg_straight(src);
  vec3 r = k > 0.0 ? mix(c, u_lightColor.rgb, clamp(k, 0.0, 1.0)) : c * (1.0 + k);
  fragColor = fx_premultiply(vec4(clamp(r, 0.0, 1.0), src.a));
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- Drop Shadow

/** Drop Shadow offset (layer px) along Premiere's direction (0° = up, clockwise). */
export function dropShadowOffset(p: EffectParams): [number, number] {
	const [x, y] = premiereDirection(num(p.direction, 135));
	const d = Math.max(0, num(p.distance, 5));
	return [x * d, y * d];
}

/** Padding (layer px) per side so the shadow is never clipped. */
export function dropShadowPadding(p: EffectParams) {
	const [x, y] = dropShadowOffset(p);
	const blur = 3 * softnessSigma(num(p.softness)) + 1;
	return {
		left: Math.max(0, -x) + blur,
		right: Math.max(0, x) + blur,
		top: Math.max(0, -y) + blur,
		bottom: Math.max(0, y) + blur,
	};
}

export const DROP_SHADOW = defineShaderEffect({
	id: 'jasper.drop-shadow',
	label: 'Drop Shadow',
	category: 'Perspective',
	description:
		"Adds a soft shadow behind the clip, cast from its alpha channel (direction 0° = up, 135° = lower right).",
	keywords: ['shadow', 'depth', 'title', 'outline'],
	params: [
		fxParam.color('shadowColor', 'Shadow Color', [0, 0, 0, 1]),
		fxParam.percent('opacity', 'Opacity', 50),
		fxParam.angle('direction', 'Direction', 135),
		slider('distance', 'Distance', 5, 0, 4000, { softMax: 120, unit: 'px' }),
		slider('softness', 'Softness', 0, 0, 1000, { softMax: 250, unit: 'px' }),
		fxParam.toggle('shadowOnly', 'Shadow Only', false),
	],
	gpu: {
		timeInvariant: true,
		padding: (p) => dropShadowPadding(p),
		uniforms: (p, ctx) => {
			const [x, y] = dropShadowOffset(p);
			return { u_offsetPx: [x * ctx.pxScale, y * ctx.pxScale] };
		},
		passes: (p, ctx) => {
			const sigma = softnessSigma(num(p.softness)) * ctx.pxScale;
			return [
				{
					output: 'shadow',
					frag: /* glsl */ `
void main() { float a = texture(u_source, v_uv - u_offsetPx / u_canvasSize).a; fragColor = vec4(a); }`,
				},
				...gaussianBlurPasses({ input: 'shadow', output: 'soft', sigma, scale: blurScale(sigma) }),
				{
					include: [GLSL_BLEND],
					frag: /* glsl */ `
void main() {
  float a = texture(u_soft, v_uv).a * u_shadowColor.a * (u_opacity / 100.0);
  vec4 shadow = vec4(u_shadowColor.rgb * a, a);
  fragColor = u_shadowOnly ? shadow : fx_over(texture(u_source, v_uv), shadow);
}`,
				},
			];
		},
	},
});

// ---------------------------------------------------------------- Radial Shadow

/** Radial Shadow's projection scale about the light (1 + distance / 100). */
export const radialShadowScale = (p: EffectParams) => 1 + Math.max(0, num(p.projectionDistance, 10)) / 100;

export function radialShadowPadding(p: EffectParams, ctx: Pick<FxPlanContext, 'width' | 'height'>): number {
	if (!bool(p.resizeLayer)) return 0;
	const s = radialShadowScale(p);
	const light = Array.isArray(p.lightSource) ? (p.lightSource as number[]) : [0.33, 0.25];
	const lx = num(light[0], 0.33) * ctx.width;
	const ly = num(light[1], 0.25) * ctx.height;
	// Farthest box corner from the light, pushed out by the projection.
	const far = Math.max(
		...[
			[0, 0],
			[ctx.width, 0],
			[0, ctx.height],
			[ctx.width, ctx.height],
		].map(([x, y]) => Math.hypot(x! - lx, y! - ly)),
	);
	return Math.ceil(far * (s - 1) + 3 * softnessSigma(num(p.softness)) + 2);
}

export const RADIAL_SHADOW = defineShaderEffect({
	id: 'jasper.radial-shadow',
	label: 'Radial Shadow',
	category: 'Perspective',
	description:
		'Casts a shadow from a point light source onto a surface behind the clip; the shadow grows with the projection distance.',
	keywords: ['shadow', 'light', 'perspective', 'glass'],
	params: [
		fxParam.color('shadowColor', 'Shadow Color', [0, 0, 0, 1]),
		fxParam.percent('opacity', 'Opacity', 50),
		fxParam.point('lightSource', 'Light Source', [0.33, 0.25]),
		slider('projectionDistance', 'Projection Distance', 10, 1, 2000, { softMax: 100, step: 0.1 }),
		slider('softness', 'Softness', 0, 0, 1000, { softMax: 100, unit: 'px' }),
		popup('render', 'Render', [
			['regular', 'Regular'],
			['glassEdge', 'Glass Edge'],
		]),
		fxParam.percent('colorInfluence', 'Color Influence', 100),
		fxParam.toggle('shadowOnly', 'Shadow Only', false),
		fxParam.toggle('resizeLayer', 'Resize Layer', false),
	],
	gpu: {
		timeInvariant: true,
		padding: (p, ctx) => radialShadowPadding(p, ctx),
		uniforms: (p) => ({ u_rsScale: radialShadowScale(p) }),
		passes: (p, ctx) => {
			const sigma = softnessSigma(num(p.softness)) * ctx.pxScale;
			const passes: ShaderPass[] = [
				{
					// The layer projected from the light: shadow pixel S shows layer point L + (S − L) / scale.
					output: 'shadow',
					include: [GLSL_PACG],
					frag: /* glsl */ `
void main() {
  vec2 L = fx_uvOfLayerNorm(u_lightSource);
  vec2 uv = L + (v_uv - L) / max(u_rsScale, 1.0e-3);
  vec4 s = fx_inBox(uv) ? texture(u_source, uv) : vec4(0.0);
  if (!u_resizeLayer && !fx_inBox(v_uv)) s = vec4(0.0);
  fragColor = s;
}`,
				},
			];
			let shadow = 'shadow';
			if (sigma >= 0.05) {
				passes.push(...gaussianBlurPasses({ input: 'shadow', output: 'soft', sigma, scale: blurScale(sigma) }));
				shadow = 'soft';
			}
			passes.push({
				include: [GLSL_PACG, GLSL_BLEND],
				frag: /* glsl */ `
void main() {
  vec4 s = texture(u_${shadow}, v_uv);
  vec3 col = u_shadowColor.rgb;
  float a = s.a;
  if (u_render == 1) {
    // Glass Edge: the shadow takes the clip's colours (like light through stained glass), stronger at its edges.
    col = mix(col, pacg_straight(s), u_colorInfluence / 100.0);
    a = s.a * (0.6 + 0.4 * (1.0 - s.a * s.a));
  }
  a *= u_shadowColor.a * u_opacity / 100.0;
  vec4 shadow = vec4(col * a, a);
  vec4 src = texture(u_source, v_uv);
  fragColor = u_shadowOnly ? shadow : fx_over(src, shadow);
}`,
			});
			return passes;
		},
	},
});

export const PERSPECTIVE_EFFECTS: readonly EffectSpec[] = [
	BASIC_3D,
	BEVEL_ALPHA,
	BEVEL_EDGES,
	DROP_SHADOW,
	RADIAL_SHADOW,
];
