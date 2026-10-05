// Sapphire Flicker tools: S_Flicker (adds flicker) and the measuring family — S_FlickerRemove(Color)(Matte) scale
// each frame so the average brightness/colour inside a rectangle or matte equals the Hold Level/Color, and
// S_FlickerMatch(Color)(Matte) copy the brightness/colour changes measured on a Match clip. The measurement is a
// deterministic in-shader reduction of the CURRENT frame only (48×48 taps over the region into a tiny stats
// texture), so every frame is independent of the frames drawn before it. Sapphire's "Set Hold Level/Color" push
// button (copy the measurement at the current frame into the param) has no equivalent in the param model; the
// Remove variants offer "Hold From Frame" + "Hold Frame" instead: the target is measured on that frame of the clip
// (a time sample), which is what the button is used for.
import type { EffectParams, EffectSpec, ParamSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { fxParam } from '../params.ts';
import type { FxTimeContext, ShaderPass } from '../shader.ts';
import { intParam, sapphireSeedParam } from './common.ts';
import { bool, flickerGains, inSpan, int } from './time-math.ts';

const time = { category: 'Time' as const, bin: SAPPHIRE_BINS.time };

/** Taps per side of the region average (48 × 48 = 2304 taps into a ~1 px stats texture). */
export const FLICKER_STATS_TAPS = 48;

export const S_FLICKER = defineShaderEffect({
	...time,
	id: 'jasper.s.flicker',
	label: 'S_Flicker',
	description:
		'Scales the colours by a different amount every frame: smooth random luma/colour flicker and/or a periodic wave.',
	keywords: ['flicker', 'strobe', 'old film', 'light', 'pulse', 'random'],
	params: [
		fxParam.number('amplitude', 'Amplitude', 0.2, { min: 0, softMax: 2, step: 0.001 }),
		fxParam.number('randLumaAmp', 'Rand Luma Amp', 1, { min: 0, softMax: 4, step: 0.01 }),
		fxParam.number('randColorAmp', 'Rand Color Amp', 0, { min: 0, softMax: 4, step: 0.01 }),
		fxParam.number('randFreq', 'Rand Freq', 30, { min: 0, softMax: 100, step: 0.1 }),
		fxParam.number('waveAmp', 'Wave Amp', 0, { min: 0, softMax: 4, step: 0.01 }),
		fxParam.number('waveFreq', 'Wave Freq', 5, { min: 0, softMax: 30, step: 0.01 }),
		fxParam.number('waveRPhase', 'Wave R Phase', 0, { softMin: -1, softMax: 1, step: 0.001 }),
		fxParam.number('waveGPhase', 'Wave G Phase', 0, { softMin: -1, softMax: 1, step: 0.001 }),
		fxParam.number('waveBPhase', 'Wave B Phase', 0, { softMin: -1, softMax: 1, step: 0.001 }),
		fxParam.number('redAmp', 'Red Amp', 1, { min: 0, softMax: 4, step: 0.01 }),
		fxParam.number('greenAmp', 'Green Amp', 1, { min: 0, softMax: 4, step: 0.01 }),
		fxParam.number('blueAmp', 'Blue Amp', 1, { min: 0, softMax: 4, step: 0.01 }),
		fxParam.number('brightness', 'Brightness', 1, { min: 0, softMax: 4, step: 0.01 }),
		sapphireSeedParam(),
	],
	gpu: {
		uniforms: (p, ctx) => ({ u_gain: flickerGains(p, ctx.frame, ctx.fps, ctx.seed) }),
		passes: [
			{
				frag: /* glsl */ `
void main() {
  vec4 c = texture(u_source, v_uv);
  fragColor = vec4(c.rgb * u_gain, c.a);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- measuring flicker tools

type Variant = { kind: 'remove' | 'match'; color: boolean; matte: boolean };

/** Sapphire's default rectangle (screen coords ±0.583 × ±0.441) as layer-normalised corners. */
export const FLICKER_RECT_DEFAULT: readonly [[number, number], [number, number]] = [
	[0.17, 0.06],
	[0.83, 0.94],
];

function variantParams(v: Variant): ParamSpec[] {
	const out: ParamSpec[] = [];
	if (v.kind === 'match') out.push(fxParam.media('match', 'Match'));
	if (v.matte) out.push(fxParam.media('matte', 'Matte'));
	if (!v.matte)
		out.push(
			fxParam.point('rectCorner1', 'Rect Corner1', [...FLICKER_RECT_DEFAULT[0]]),
			fxParam.point('rectCorner2', 'Rect Corner2', [...FLICKER_RECT_DEFAULT[1]]),
		);
	if (v.kind === 'remove') {
		out.push(
			v.color
				? fxParam.color('holdColor', 'Hold Color', [0.5, 0.5, 0.5, 1])
				: fxParam.number('holdLevel', 'Hold Level', 0.5, { min: 0.01, softMax: 1, step: 0.001 }),
			fxParam.toggle('holdFromFrame', 'Hold From Frame', false),
			intParam('holdFrame', 'Hold Frame', 0, { softMin: 0, softMax: 300 }),
		);
	} else {
		out.push(
			v.color
				? fxParam.color('matchColor', 'Match Color', [0.5, 0.5, 0.5, 1])
				: fxParam.number('matchLevel', 'Match Level', 0.5, { min: 0.01, softMax: 1, step: 0.001 }),
		);
	}
	if (v.matte)
		out.push(
			fxParam.choice('matteUse', 'Matte Use', ['luma', 'alpha'], ['Luma', 'Alpha'], 'alpha'),
			fxParam.toggle('invertMatte', 'Invert Matte', false),
		);
	return out;
}

const MATTE_GLSL = /* glsl */ `
float fl_matte(vec2 n) {
  if (u_matte_size.x <= 0.0) return 1.0;
  vec4 m = texture(u_matte, n);
  float k = u_matteUse == 1 ? m.a : fx_luma(m.rgb);
  return u_invertMatte ? 1.0 - k : k;
}`;

/** A reduction pass: the alpha-weighted mean straight colour of `tap(n)` over the region (rect or whole box). */
function statsPass(output: string, v: Variant, tap: string): ShaderPass {
	const region = v.matte
		? 'vec2 lo = vec2(0.0); vec2 hi = vec2(1.0);'
		: 'vec2 lo = clamp(min(u_rectCorner1, u_rectCorner2), 0.0, 1.0); vec2 hi = clamp(max(u_rectCorner1, u_rectCorner2), 0.0, 1.0);';
	return {
		output,
		scale: 0.001,
		format: 'rgba16f',
		filter: 'nearest',
		include: [GLSL_COLOR],
		frag: /* glsl */ `${v.matte ? MATTE_GLSL : ''}
vec4 fl_tap(vec2 n) { ${tap} }
void main() {
  ${region}
  vec4 s = vec4(0.0);
  const float N = ${FLICKER_STATS_TAPS}.0;
  for (int j = 0; j < ${FLICKER_STATS_TAPS}; j++)
    for (int i = 0; i < ${FLICKER_STATS_TAPS}; i++)
      s += fl_tap(mix(lo, hi, (vec2(float(i), float(j)) + 0.5) / N));
  fragColor = s.a > 1.0e-3 ? vec4(s.rgb / s.a, 1.0) : vec4(0.0);
}`,
	};
}

function flickerSamples(p: EffectParams, ctx: FxTimeContext): number[] {
	if (!bool(p.holdFromFrame)) return [];
	return inSpan([int(p.holdFrame, 0) - ctx.frame], ctx.frame, ctx);
}

function measuringEffect(init: {
	id: string;
	label: string;
	description: string;
	keywords: string[];
	variant: Variant;
}): EffectSpec {
	const v = init.variant;
	const weight = v.matte ? ' * fl_matte(n)' : '';
	const image = v.kind === 'match' ? 'texture(u_match, n)' : 'texture(u_source, fx_uvOfLayerNorm(n))';
	const target =
		v.kind === 'remove'
			? v.color
				? 'vec3 target = u_holdColor.rgb;'
				: 'vec3 target = vec3(u_holdLevel);'
			: '';
	const gain =
		v.kind === 'remove'
			? v.color
				? 'target / max(st.rgb, vec3(1.0e-3))'
				: 'vec3(target.x / max(fx_luma(st.rgb), 1.0e-3))'
			: v.color
				? 'st.rgb / max(u_matchColor.rgb, vec3(1.0e-3))'
				: 'vec3(fx_luma(st.rgb) / max(u_matchLevel, 1.0e-3))';
	return defineShaderEffect({
		...time,
		id: init.id,
		label: init.label,
		description: init.description,
		keywords: init.keywords,
		params: variantParams(v),
		gpu: {
			...(v.kind === 'remove' ? { time: { samples: flickerSamples } } : {}),
			passes: (p) => {
				const ref = v.kind === 'remove' && bool(p.holdFromFrame);
				const out: ShaderPass[] = [statsPass('flStats', v, `return ${image}${weight};`)];
				if (ref)
					out.push(
						statsPass(
							'flRef',
							v,
							`return (u_sampleCount > 0 ? fx_sample(0, fx_uvOfLayerNorm(n)) : vec4(0.0))${weight};`,
						),
					);
				const refGlsl = ref
					? `if (u_sampleCount > 0) { vec4 r = texture(u_flRef, vec2(0.5)); if (r.a > 0.0) target = ${
							v.color ? 'r.rgb' : 'vec3(fx_luma(r.rgb))'
						}; }`
					: '';
				out.push({
					include: [GLSL_COLOR],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  ${v.kind === 'match' ? 'if (u_match_size.x <= 0.0) { fragColor = src; return; }' : ''}
  vec4 st = texture(u_flStats, vec2(0.5));
  if (st.a <= 0.0) { fragColor = src; return; }
  ${target}
  ${refGlsl}
  vec3 gain = min(${gain}, vec3(20.0));
  fragColor = vec4(src.rgb * gain, src.a);
}`,
				});
				return out;
			},
		},
	});
}

export const S_FLICKER_MATCH = measuringEffect({
	id: 'jasper.s.flicker-match',
	label: 'S_FlickerMatch',
	description:
		'Adds the brightness flicker of a Match clip (measured inside a rectangle, relative to Match Level) to the source.',
	keywords: ['flicker', 'match', 'brightness', 'light', 'composite'],
	variant: { kind: 'match', color: false, matte: false },
});

export const S_FLICKER_MATCH_COLOR = measuringEffect({
	id: 'jasper.s.flicker-match-color',
	label: 'S_FlickerMatchColor',
	description:
		'Adds the colour changes of a Match clip (measured inside a rectangle, relative to Match Color) to the source.',
	keywords: ['flicker', 'match', 'color', 'light', 'composite'],
	variant: { kind: 'match', color: true, matte: false },
});

export const S_FLICKER_MATCH_MATTE = measuringEffect({
	id: 'jasper.s.flicker-match-matte',
	label: 'S_FlickerMatchMatte',
	description:
		'Adds the brightness flicker of a Match clip, measured inside a Matte (or the Match alpha), to the source.',
	keywords: ['flicker', 'match', 'matte', 'brightness', 'composite'],
	variant: { kind: 'match', color: false, matte: true },
});

export const S_FLICKER_MCH_MATTE_COLOR = measuringEffect({
	id: 'jasper.s.flicker-mch-matte-color',
	label: 'S_FlickerMchMatteColor',
	description:
		'Adds the colour changes of a Match clip, measured inside a Matte (or the Match alpha), to the source.',
	keywords: ['flicker', 'match', 'matte', 'color', 'composite'],
	variant: { kind: 'match', color: true, matte: true },
});

export const S_FLICKER_REMOVE = measuringEffect({
	id: 'jasper.s.flicker-remove',
	label: 'S_FlickerRemove',
	description:
		'Removes brightness flicker: scales every frame so the average brightness inside a rectangle equals Hold Level.',
	keywords: ['deflicker', 'flicker', 'stabilize', 'brightness', 'timelapse', 'repair'],
	variant: { kind: 'remove', color: false, matte: false },
});

export const S_FLICKER_REMOVE_COLOR = measuringEffect({
	id: 'jasper.s.flicker-remove-color',
	label: 'S_FlickerRemoveColor',
	description:
		'Removes colour flicker: scales every channel so the average colour inside a rectangle equals Hold Color.',
	keywords: ['deflicker', 'flicker', 'color', 'white balance', 'timelapse', 'repair'],
	variant: { kind: 'remove', color: true, matte: false },
});

export const S_FLICKER_REMOVE_MATTE = measuringEffect({
	id: 'jasper.s.flicker-remove-matte',
	label: 'S_FlickerRemoveMatte',
	description:
		'Removes brightness flicker measured inside a Matte (or the source alpha): the average there is held at Hold Level.',
	keywords: ['deflicker', 'flicker', 'matte', 'brightness', 'repair'],
	variant: { kind: 'remove', color: false, matte: true },
});

export const S_FLICKER_RM_MATTE_COLOR = measuringEffect({
	id: 'jasper.s.flicker-rm-matte-color',
	label: 'S_FlickerRmMatteColor',
	description:
		'Removes colour flicker measured inside a Matte (or the source alpha): the average colour there is held at Hold Color.',
	keywords: ['deflicker', 'flicker', 'matte', 'color', 'repair'],
	variant: { kind: 'remove', color: true, matte: true },
});
