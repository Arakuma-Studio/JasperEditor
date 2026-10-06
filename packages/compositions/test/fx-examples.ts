// Example GPU shader effects of the fx framework (wave 1) — test-only: they prove the framework (multi-pass glow with
// a downscaled blur and padding, a generator, a padded drop shadow, a time effect with samples and one with a remap)
// and are the worked examples of docs/wp-notes/fx-shader-framework.md. Not registered in the default registry.
import {
	createEffectRegistry,
	defaultEffectRegistry,
	defineShaderEffect,
	type EffectSpec,
	fxParam,
	fxRandom,
	GLSL_BLEND,
	GLSL_COLOR,
	GLSL_COMPOSITE,
	GLSL_UV,
	gaussianBlurPasses,
	sapphireCommonParams,
} from '@jasper/project';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** S_Glow-style: threshold → blur (half resolution) → screen the coloured glow over the source. */
export const TEST_GLOW: EffectSpec = defineShaderEffect({
	id: 'test.s.glow',
	label: 'S_Glow (test)',
	category: 'Stylize',
	bin: 'Sapphire Glows',
	description: 'Bright areas bleed light around them.',
	params: [
		fxParam.percent('threshold', 'Threshold', 60),
		fxParam.pixels('radius', 'Width', 20, 200),
		fxParam.number('brightness', 'Brightness', 1.5, { min: 0, max: 10, step: 0.01 }),
		fxParam.color('glowColor', 'Glow Color', [1, 0.8, 0.5, 1]),
		...sapphireCommonParams(),
	],
	gpu: {
		padding: (p) => 3 * num(p.radius),
		passes: (p, ctx) => [
			{
				output: 'bright',
				include: [GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 c = fx_unpremultiply(texture(u_source, v_uv));
  float m = fx_lumaMatte(c.rgb, u_threshold / 100.0, 0.1) * c.a;
  fragColor = vec4(c.rgb * m, m);
}`,
			},
			...gaussianBlurPasses({
				input: 'bright',
				output: 'glow',
				sigma: num(p.radius) * ctx.pxScale,
				scale: 0.5,
			}),
			{
				include: [GLSL_COMPOSITE, GLSL_BLEND],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 g = texture(u_glow, v_uv);
  vec3 light = g.rgb * u_glowColor.rgb * u_brightness;
  vec4 result = fx_addLight(src, light);
  fragColor = fx_finish(result, src, g.a, u_mixWithOriginal, u_show);
}`,
			},
		],
	},
});

/** A two-colour linear gradient generator over the layer box (blended over the source). */
export const TEST_GRADIENT: EffectSpec = defineShaderEffect({
	id: 'test.s.gradient',
	label: 'S_Gradient (test)',
	category: 'Generate',
	bin: 'Sapphire Render',
	params: [
		fxParam.point('start', 'Start', [0, 0.5]),
		fxParam.point('end', 'End', [1, 0.5]),
		fxParam.color('startColor', 'Start Color', [0, 0, 0, 1]),
		fxParam.color('endColor', 'End Color', [1, 1, 1, 1]),
		fxParam.percent('opacity', 'Opacity', 100),
	],
	gpu: {
		kind: 'generator',
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_BLEND],
				frag: /* glsl */ `
void main() {
  vec2 n = fx_layerNorm();
  vec2 d = u_end - u_start;
  float t = clamp(dot(n - u_start, d) / max(dot(d, d), 1e-6), 0.0, 1.0);
  vec4 g = fx_premultiply(mix(u_startColor, u_endColor, t));
  vec4 src = texture(u_source, v_uv);
  fragColor = fx_inBox(v_uv) ? fx_blend(FX_BLEND_NORMAL, src, g, u_opacity / 100.0) : src;
}`,
			},
		],
	},
});

/** Drop shadow: the alpha offset along a direction, blurred, tinted, under the source; padded so it never clips. */
export const TEST_DROP_SHADOW: EffectSpec = defineShaderEffect({
	id: 'test.drop-shadow',
	label: 'Drop Shadow (test)',
	category: 'Stylize',
	params: [
		fxParam.color('shadowColor', 'Shadow Color', [0, 0, 0, 1]),
		fxParam.percent('opacity', 'Opacity', 50),
		fxParam.angle('direction', 'Direction', 135),
		fxParam.pixels('distance', 'Distance', 10, 200),
		fxParam.pixels('softness', 'Softness', 0, 200),
	],
	gpu: {
		timeInvariant: true,
		padding: (p) => num(p.distance) + 3 * num(p.softness),
		uniforms: (p, ctx) => {
			// Premiere: 135° = down-left… here 0° = right, clockwise on screen (y down).
			const a = (num(p.direction) * Math.PI) / 180;
			const d = num(p.distance) * ctx.pxScale;
			return { u_offsetPx: [Math.cos(a) * d, Math.sin(a) * d] };
		},
		passes: (p, ctx) => [
			{
				output: 'shadow',
				frag: /* glsl */ `
void main() {
  float a = texture(u_source, v_uv - u_offsetPx / u_canvasSize).a;
  fragColor = vec4(a);
}`,
			},
			...gaussianBlurPasses({ input: 'shadow', output: 'soft', sigma: num(p.softness) * ctx.pxScale }),
			{
				include: [GLSL_BLEND],
				frag: /* glsl */ `
void main() {
  float a = texture(u_soft, v_uv).a * u_shadowColor.a * (u_opacity / 100.0);
  vec4 shadow = vec4(u_shadowColor.rgb * a, a);
  fragColor = fx_over(texture(u_source, v_uv), shadow);
}`,
			},
		],
	},
});

/** Trails: the source over N earlier frames with a decay (time samples). */
export const TEST_TRAILS: EffectSpec = defineShaderEffect({
	id: 'test.s.trails',
	label: 'S_Trails (test)',
	category: 'Time',
	bin: 'Sapphire Time',
	params: [
		fxParam.number('count', 'Trail Frames', 3, { min: 1, max: 8, step: 1 }, { animatable: false }),
		fxParam.number('decay', 'Decay', 0.6, { min: 0, max: 1, step: 0.01 }),
	],
	gpu: {
		time: {
			samples: (p) => Array.from({ length: Math.max(1, Math.min(8, num(p.count, 3))) }, (_, i) => -(i + 1)),
		},
		passes: [
			{
				include: [GLSL_BLEND],
				frag: /* glsl */ `
void main() {
  vec4 acc = texture(u_source, v_uv);
  float w = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_sampleCount) break;
    w *= u_decay;
    acc = fx_over(acc, fx_sample(i, v_uv) * w);
  }
  fragColor = acc;
}`,
			},
		],
	},
});

/** Jitter frames: a deterministic random source frame within ±amount (time remap). */
export const TEST_JITTER: EffectSpec = defineShaderEffect({
	id: 'test.s.jitter-frames',
	label: 'S_JitterFrames (test)',
	category: 'Time',
	bin: 'Sapphire Time',
	params: [fxParam.number('amount', 'Jitter Frames', 4, { min: 0, max: 100, step: 1 })],
	gpu: {
		time: {
			remap: (p, ctx) => ctx.frame + Math.round((fxRandom(ctx.seed, ctx.frame) * 2 - 1) * num(p.amount)),
		},
		passes: [
			{ include: [GLSL_UV, GLSL_COLOR], frag: 'void main() { fragColor = texture(u_source, v_uv); }' },
		],
	},
});

/** Freeze frame: the source frame `at` (clip-local) for the whole clip (time remap). */
export const TEST_FREEZE: EffectSpec = defineShaderEffect({
	id: 'test.s.freeze-frame',
	label: 'S_FreezeFrame (test)',
	category: 'Time',
	bin: 'Sapphire Time',
	params: [fxParam.number('at', 'Freeze At Frame', 0, { min: 0, step: 1 }, { animatable: false })],
	gpu: {
		time: { remap: (p) => num(p.at) },
		passes: [{ frag: 'void main() { fragColor = texture(u_source, v_uv); }' }],
	},
});

/** Shows only the source `offset` frames earlier (a time sample): proves samples are decoded for their own frame. */
export const TEST_ECHO: EffectSpec = defineShaderEffect({
	id: 'test.s.echo-only',
	label: 'S_Echo (test, sample only)',
	category: 'Time',
	bin: 'Sapphire Time',
	params: [fxParam.number('offset', 'Offset', -3, { min: -8, max: 8, step: 1 }, { animatable: false })],
	gpu: {
		time: { samples: (p) => [num(p.offset, -3)] },
		passes: [{ frag: 'void main() { fragColor = fx_sample(0, v_uv); }' }],
	},
});

export const TEST_FX: readonly EffectSpec[] = [
	TEST_ECHO,
	TEST_GLOW,
	TEST_GRADIENT,
	TEST_DROP_SHADOW,
	TEST_TRAILS,
	TEST_JITTER,
	TEST_FREEZE,
];

/** The default registry plus the test effects. */
export const testFxRegistry = createEffectRegistry([...defaultEffectRegistry.list(), ...TEST_FX]);
