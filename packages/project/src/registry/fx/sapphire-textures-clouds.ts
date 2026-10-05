// Effect family "sapphire-textures-clouds" (fx catalogue, wave 2): Sapphire Render ▸ procedural textures
// (S_Texture*) and fractal clouds (S_Clouds*). Generators (`gpu.kind: 'generator'`): each draws its texture over the
// layer box and combines it with the layer picture (the Sapphire "Background") through Bg Brightness + Combine
// (Texture/Clouds Only, Mult, Add, Screen, Difference, Overlay), with Output Opacity (All Opaque / Copy From Input,
// Sapphire's default), Show and Mix with Orig. Parameter names, order, defaults and ranges follow Boris FX's public
// Sapphire documentation (Mocha, mask inputs and Input Opacity are not part of the editor's effect model).
// Animation: every speed is per second of clip time (`u_time`), every pattern is a pure function of
// (params, frame, seed) — continuous over time, deterministic in the Player, stills and parallel renders.
// Conventions (sapphire-textures-clouds/glsl.ts): texture space is centred on the layer, 1 unit = layer height;
// X & Y vectors are y-up like Sapphire's; centres are layer-normalised point params (on-canvas handles).
// Authoring guide: docs/wp-notes/fx-shader-framework.md.
import type { EffectParams, EffectSpec, ParamSpec } from '../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from './define.ts';
import { GLSL_BLUR } from './glsl/blur.ts';
import { fxParam } from './params.ts';
import { STC_CORE, STC_FINISH, STC_GLOW, STC_RAMP } from './sapphire-textures-clouds/glsl.ts';
import {
	finishParams,
	rampParams,
	sAny,
	sColor,
	sFreq,
	sInt,
	sPos,
	sRange,
	sSeed,
	sVec,
} from './sapphire-textures-clouds/params.ts';
import { glowPasses, sharpenPasses, sharpenSigma } from './sapphire-textures-clouds/passes.ts';
import type { FxPlanContext, GpuEffect, ShaderPass } from './shader.ts';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** A one-pass generator whose `main` writes `fragColor = stc_finish(<texture rgb>)`. */
const single = (frag: string, timeInvariant = false): GpuEffect => ({
	kind: 'generator',
	...(timeInvariant ? { timeInvariant: true } : {}),
	// The ramp chunk reads the Color0/Color1 uniforms: only effects that use it declare them.
	passes: [{ include: frag.includes('stc_ramp') ? [STC_CORE, STC_RAMP, STC_FINISH] : [STC_CORE, STC_FINISH], frag }],
});

function texture(init: {
	id: string;
	label: string;
	description: string;
	keywords: readonly string[];
	params: ParamSpec[];
	gpu: GpuEffect;
	expensive?: boolean;
}): EffectSpec {
	return defineShaderEffect({ ...init, category: 'Generate', bin: SAPPHIRE_BINS.render });
}

// ================================================================ fractal clouds

/** Frequency, Frequency Rel X, Octaves, Seed (clouds head). */
const cloudsHead = (freq: number, relX: number, octaves: number, seed: number) => [
	sFreq('frequency', 'Frequency', freq),
	sFreq('frequencyRelX', 'Frequency Rel X', relX, 4),
	sInt('octaves', 'Octaves', octaves, 1, 10),
	sSeed(seed),
];
const boilParams = () => [
	fxParam.toggle('boilingMode', 'Boiling Mode', false),
	sRange('boilDetails', 'Boil Details', 0.55, 0, 1),
	sAny('boilSpeed', 'Boil Speed', 1),
];
const shiftParams = () => [sVec('shiftStart', 'Shift Start', [0, 0]), sVec('shiftSpeed', 'Shift Speed', [0.5, 0])];

/** GLSL: `vec2 q` (texture space minus the animated shift) and `vec2 fq` (frequency vector). */
const CLOUDS_COORDS = /* glsl */ `
  vec2 q = stc_screen() - stc_yUp(u_shiftStart + u_shiftSpeed * u_time);
  vec2 fq = vec2(u_frequency * u_frequencyRelX, u_frequency);`;
const CLOUDS_NOISE = 'stc_clouds(q * fq, u_octaves, u_boilingMode, u_boilDetails, u_boilSpeed * u_time, u_seed)';

export const S_CLOUDS = texture({
	id: 'jasper.s.clouds',
	label: 'S_Clouds',
	description:
		'Procedural fractal noise clouds between Color0 and Color1. Frequency zooms; Shift Speed drifts the clouds, Boiling Mode makes them evolve.',
	keywords: ['clouds', 'noise', 'fractal', 'fbm', 'smoke', 'sky', 'texture'],
	params: [
		...cloudsHead(2, 0.4, 8, 0.234),
		...boilParams(),
		...shiftParams(),
		...rampParams(),
		...finishParams({ only: 'Clouds' }),
	],
	gpu: single(/* glsl */ `
void main() {${CLOUDS_COORDS}
  fragColor = stc_finish(stc_ramp1(stc_unit(${CLOUDS_NOISE})));
}`),
});

export const S_CLOUDS_COLOR_SMOOTH = texture({
	id: 'jasper.s.clouds-color-smooth',
	label: 'S_CloudsColorSmooth',
	description:
		'Full-colour smooth clouds: independent fractal noise in each of the red, green and blue channels, drifting with Shift Speed.',
	keywords: ['clouds', 'color', 'rgb', 'noise', 'smooth', 'gradient', 'texture'],
	params: [
		...cloudsHead(8, 0.2, 1, 0.6),
		...shiftParams(),
		sPos('brightness', 'Brightness', 1),
		sColor('scaleColors', 'Scale Colors', [1, 1, 1]),
		sRange('saturation', 'Saturation', 1, 0, 10),
		sRange('offset', 'Offset', 0, -8, 2),
		...finishParams({ only: 'Clouds' }),
	],
	gpu: single(/* glsl */ `
void main() {${CLOUDS_COORDS}
  vec2 p = q * fq;
  vec3 c = vec3(stc_fbm(p, u_octaves, 0.5, stc_seed(u_seed, 1.0)),
                stc_fbm(p, u_octaves, 0.5, stc_seed(u_seed, 2.0)),
                stc_fbm(p, u_octaves, 0.5, stc_seed(u_seed, 3.0)));
  c = 0.5 + 0.55 * c;
  c = fx_saturate(c, u_saturation);
  fragColor = stc_finish(c * u_brightness * u_scaleColors.rgb + u_offset);
}`),
});

export const S_CLOUDS_MULT_COLOR = texture({
	id: 'jasper.s.clouds-mult-color',
	label: 'S_CloudsMultColor',
	description:
		'S_Clouds tinted by a second, independent colour-noise texture (Color Amount, Color Freq, Color Seed).',
	keywords: ['clouds', 'color', 'tint', 'noise', 'fractal', 'texture'],
	params: [
		...cloudsHead(2, 0.4, 8, 0.234),
		...boilParams(),
		sPos('colorAmount', 'Color Amount', 0.5),
		sFreq('colorFreq', 'Color Freq', 1, 20),
		sFreq('colorFreqRelX', 'Color Freq Relx', 0.4, 4),
		sInt('colorOctaves', 'Color Octaves', 1, 1, 10),
		sSeed(0.345, 'colorSeed', 'Color Seed'),
		...shiftParams(),
		sPos('brightness', 'Brightness', 1),
		sColor('color', 'Color', [1, 1, 1]),
		sColor('colorNoiseColor', 'Color Noise Color', [1, 1, 1]),
		sAny('offset', 'Offset', 0, 1),
		...finishParams({ only: 'Clouds' }),
	],
	gpu: single(/* glsl */ `
void main() {${CLOUDS_COORDS}
  float v = stc_unit(${CLOUDS_NOISE});
  float cs = fx_hash1(int(floor(u_colorSeed * 1000.0 + 0.5)), u_seed);
  vec2 pc = q * vec2(u_colorFreq * u_colorFreqRelX, u_colorFreq);
  vec3 cn = vec3(stc_fbm(pc, u_colorOctaves, 0.5, stc_seed(cs, 1.0)),
                 stc_fbm(pc, u_colorOctaves, 0.5, stc_seed(cs, 2.0)),
                 stc_fbm(pc, u_colorOctaves, 0.5, stc_seed(cs, 3.0)));
  vec3 tint = max(vec3(0.0), 1.0 + u_colorAmount * 1.6 * cn * u_colorNoiseColor.rgb);
  fragColor = stc_finish(v * tint * u_brightness * u_color.rgb + u_offset);
}`),
});

/** GLSL: clouds value `v` on plane coordinates `pl` with distance anti-aliasing (fades to the mean far away). */
const PLANE_CLOUDS = /* glsl */ `
  vec2 p = pl * fq;
  float fp = length(fwidth(p));
  float octEff = clamp(log2(0.5 / max(fp, 1.0e-6)) + 1.0, 0.0, u_octaves);
  float n = stc_clouds(p, max(octEff, 1.0), u_boilingMode, u_boilDetails, u_boilSpeed * u_time, u_seed);
  n *= clamp(octEff, 0.0, 1.0) * step(0.0, facing);
  float v = stc_unit(n);`;

export const S_CLOUDS_PERSPECTIVE = texture({
	id: 'jasper.s.clouds-perspective',
	label: 'S_CloudsPerspective',
	description:
		'Fractal clouds on a 3D plane seen in perspective: Latitude tilts it toward a horizon, Swing and Roll rotate it, Z Dist and Tele Lens Width set distance and lens.',
	keywords: ['clouds', 'perspective', 'sky', 'plane', '3d', 'horizon', 'noise'],
	params: [
		...cloudsHead(2, 0.4, 6, 0.234),
		sPos('zDist', 'Z Dist', 1, 4),
		sRange('latitude', 'Latitude', -35, -80, 80),
		fxParam.angle('swing', 'Swing', 0),
		fxParam.angle('roll', 'Roll', 0),
		sRange('teleLensWidth', 'Tele Lens Width', 1, 0.2, 3),
		...boilParams(),
		...shiftParams(),
		...rampParams(),
		...finishParams({ only: 'Clouds' }),
	],
	gpu: single(/* glsl */ `
void main() {
  vec2 fq = vec2(u_frequency * u_frequencyRelX, u_frequency);
  float facing;
  vec2 pl = stc_plane(fx_rot(fx_deg(u_roll)) * stc_screen(), u_zDist, u_latitude, u_teleLensWidth, facing);
  pl = fx_rot(fx_deg(u_swing)) * pl - stc_yUp(u_shiftStart + u_shiftSpeed * u_time);${PLANE_CLOUDS}
  fragColor = stc_finish(stc_ramp1(v));
}`),
});

export const S_CLOUDS_PSYKO = texture({
	id: 'jasper.s.clouds-psyko',
	label: 'S_CloudsPsyko',
	description:
		'Fractal clouds passed through a cycling psychedelic colouriser: Color Freq and Freq Red/Green/Blue set the colour bands, Phase Speed rotates them.',
	keywords: ['clouds', 'psychedelic', 'rainbow', 'color cycle', 'noise', 'trippy'],
	params: [
		...cloudsHead(2, 0.4, 8, 0.23),
		...boilParams(),
		sFreq('colorFreq', 'Color Freq', 4, 20),
		sPos('freqRed', 'Freq Red', 1),
		sPos('freqGreen', 'Freq Green', 1.1),
		sPos('freqBlue', 'Freq Blue', 1.2),
		...shiftParams(),
		sAny('phaseStart', 'Phase Start', -0.5),
		sAny('phaseSpeed', 'Phase Speed', 0.3),
		sPos('brightness', 'Brightness', 1),
		sColor('scaleColor', 'Scale Color', [1, 1, 1]),
		sPos('saturation', 'Saturation', 1),
		sAny('offset', 'Offset', 0, 1),
		...finishParams({ only: 'Clouds' }),
	],
	gpu: single(/* glsl */ `
void main() {${CLOUDS_COORDS}
  float v = stc_unit(${CLOUDS_NOISE});
  vec3 fr = vec3(u_freqRed, u_freqGreen, u_freqBlue);
  float ph = u_phaseStart + u_phaseSpeed * u_time;
  vec3 c = 0.5 + 0.5 * cos(FX_TAU * (v * u_colorFreq * 0.5 * fr + ph));
  c = fx_saturate(c, u_saturation);
  fragColor = stc_finish(c * u_brightness * u_scaleColor.rgb + u_offset);
}`),
});

export const S_CLOUDS_VORTEX = texture({
	id: 'jasper.s.clouds-vortex',
	label: 'S_CloudsVortex',
	description:
		'Fractal clouds twisting into a vortex around Center, optionally tilted in perspective; Vortex Speed spins it over time.',
	keywords: ['clouds', 'vortex', 'swirl', 'twist', 'whirlpool', 'tornado', 'noise'],
	params: [
		...cloudsHead(2, 1, 6, 0.234),
		fxParam.point('center', 'Center', [0.5, 0.5]),
		sPos('zDist', 'Z Dist', 1, 4),
		sRange('latitude', 'Latitude', 30, -80, 80),
		...boilParams(),
		sAny('vortexStart', 'Vortex Start', 72, 720),
		sAny('vortexSpeed', 'Vortex Speed', 30, 360),
		fxParam.angle('angleOffset', 'Angle Offset', 0),
		sPos('innerRadius', 'Inner Radius', 0.04, 1),
		...rampParams(),
		...finishParams({ only: 'Clouds' }),
	],
	gpu: single(/* glsl */ `
void main() {
  vec2 fq = vec2(u_frequency * u_frequencyRelX, u_frequency);
  float facing;
  vec2 pl = stc_plane(stc_screen() - stc_screenOfNorm(u_center), u_zDist, u_latitude, 1.0, facing);
  float r = length(pl);
  float ri = max(u_innerRadius, 1.0e-3);
  float rr = max(r, ri);
  // Rotation ∝ 1/√r outside the inner radius (Vortex Start/Speed = degrees at the frame edge), phased in inside it.
  float edge = 0.5 * stc_aspect();
  float ang = fx_deg(u_vortexStart + u_vortexSpeed * u_time) * sqrt(edge / rr) * (r / rr) + fx_deg(u_angleOffset);
  pl = fx_rot(ang) * pl;${PLANE_CLOUDS}
  fragColor = stc_finish(stc_ramp1(v));
}`),
});

// ================================================================ procedural textures

/** Frequency, Frequency Rel X (most textures). */
const freqHead = (freq: number, relX: number, softMax = 40) => [
	sFreq('frequency', 'Frequency', freq, softMax),
	sFreq('frequencyRelX', 'Frequency Rel X', relX, 4),
];
/** GLSL: `vec2 q` (texture space minus Shift) and `vec2 p` (in frequency cells). */
const SHIFTED = /* glsl */ `
  vec2 q = stc_screen() - stc_yUp(u_shift);
  vec2 p = q * vec2(u_frequency * u_frequencyRelX, u_frequency);`;

export const S_TEXTURE_CELLS = texture({
	id: 'jasper.s.texture-cells',
	label: 'S_TextureCells',
	description:
		'Procedural cellular shapes (Worley cells); Rotate Speed spins each cell centre inside its cell so the cells continuously reshape.',
	keywords: ['cells', 'cellular', 'worley', 'voronoi', 'organic', 'texture'],
	params: [
		...freqHead(16, 1, 80),
		sSeed(0.234),
		fxParam.angle('rotateCenters', 'Rotate Centers', 0),
		sAny('rotateSpeed', 'Rotate Speed', 90, 360),
		sVec('shift', 'Shift', [0, 0]),
		...rampParams(),
		fxParam.toggle('invert', 'Invert', false),
		...finishParams(),
	],
	gpu: single(/* glsl */ `
void main() {${SHIFTED}
  ivec2 c = ivec2(floor(p));
  vec2 f = fract(p);
  float rot = fx_deg(u_rotateCenters + u_rotateSpeed * u_time);
  float f1 = 8.0, f2 = 8.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      ivec2 o = ivec2(x, y);
      vec3 h = fx_hash33(ivec3(c + o, 0), u_seed);
      float a = FX_TAU * h.y + rot * (h.z < 0.5 ? -1.0 : 1.0) * (0.6 + 0.8 * h.z);
      vec2 pt = vec2(o) + 0.5 + (0.1 + 0.3 * h.x) * vec2(cos(a), sin(a));
      float d = length(pt - f);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  float v = smoothstep(0.0, 0.85, f2 - f1);
  if (u_invert) v = 1.0 - v;
  fragColor = stc_finish(stc_ramp1(v));
}`),
});

export const S_TEXTURE_CHROMA_SPIRAL = texture({
	id: 'jasper.s.texture-chroma-spiral',
	label: 'S_TextureChromaSpiral',
	description:
		'A noise texture through a chromatic spiral warp: spectrum-coloured copies zoom (Z Dist) and rotate (Rotate) toward Center, splitting edges into rainbows.',
	keywords: ['chroma', 'spiral', 'rainbow', 'prism', 'warp', 'noise', 'texture'],
	expensive: true,
	params: [
		sFreq('noiseFrequency', 'Noise Frequency', 6),
		sInt('noiseOctaves', 'Noise Octaves', 3, 1, 10),
		sVec('noiseShift', 'Noise Shift', [0, 0]),
		sSeed(0.23, 'seed', 'Noise Seed'),
		fxParam.point('center', 'Center', [0.5, 0.5]),
		sPos('zDist', 'Z Dist', 0.7, 4),
		fxParam.angle('rotate', 'Rotate', -8),
		sInt('steps', 'Steps', 12, 3, 100),
		sPos('brightness', 'Brightness', 1),
		sColor('color', 'Color', [1, 1, 1]),
		sAny('offset', 'Offset', 0, 1),
		...finishParams(),
	],
	gpu: {
		kind: 'generator',
		timeInvariant: true,
		passes: [
			{
				output: 'noise',
				format: 'rgba16f',
				include: [STC_CORE],
				frag: /* glsl */ `
void main() {
  vec2 p = (stc_screen() - stc_yUp(u_noiseShift)) * u_noiseFrequency;
  fragColor = vec4(stc_unit(stc_fbm(p, u_noiseOctaves, 0.5, u_seed)), 0.0, 0.0, 1.0);
}`,
			},
			{
				include: [STC_CORE, STC_FINISH],
				frag: /* glsl */ `
void main() {
  vec2 c = stc_screenOfNorm(u_center);
  vec2 d = stc_screen() - c;
  float n = floor(clamp(u_steps, 3.0, 100.0) + 0.5);
  vec3 acc = vec3(0.0), ws = vec3(0.0);
  for (int i = 0; i < 100; i++) {
    if (float(i) >= n) break;
    float s = float(i) / (n - 1.0);
    vec2 qs = c + fx_rot(fx_deg(u_rotate) * s) * d / (1.0 + u_zDist * 0.5 * s);
    vec3 w = stc_spectrum(s);
    acc += w * texture(u_noise, stc_uvOfScreen(qs)).r;
    ws += w;
  }
  fragColor = stc_finish(acc / max(ws, vec3(1.0e-4)) * u_brightness * u_color.rgb + u_offset);
}`,
			},
		],
	},
});

export const S_TEXTURE_FLUX = texture({
	id: 'jasper.s.texture-flux',
	label: 'S_TextureFlux',
	description:
		'Fluctuating liquid or cellular patterns: noise warped along its own gradient into bubble shapes; Morph Speed makes them undulate.',
	keywords: ['flux', 'liquid', 'bubbles', 'cells', 'organic', 'warp', 'texture'],
	params: [
		sFreq('frequency', 'Frequency', 4),
		sFreq('frequencyRelX', 'Frequency Rel X', 1, 4),
		sInt('octaves', 'Octaves', 2, 1, 10),
		sSeed(0.234),
		sVec('shift', 'Shift', [0, 0]),
		sAny('bubbleAmount', 'Bubble Amount', 1),
		sFreq('bubbleSmooth', 'Bubble Smooth', 0.25, 2, 0.008),
		fxParam.angle('rotateWarpDir', 'Rotate Warp Dir', 0),
		sAny('morphSpeed', 'Morph Speed', 0.3),
		sVec('morph', 'Morph', [0, 1]),
		...rampParams([0, 0.12, 0.15]),
		fxParam.toggle('filter', 'Filter', false),
		...finishParams(),
	],
	gpu: {
		kind: 'generator',
		passes: [
			{
				output: 'tex',
				format: 'rgba16f',
				include: [STC_CORE],
				frag: /* glsl */ `
float flux(vec2 p, vec2 m) { return stc_fbm(p + m, u_octaves, 0.5, u_seed); }
void main() {${SHIFTED}
  vec2 m = stc_yUp(u_morph) * u_morphSpeed * u_time;
  float h = max(u_bubbleSmooth, 0.008);
  vec2 g = vec2(flux(p + vec2(h, 0.0), m) - flux(p - vec2(h, 0.0), m),
                flux(p + vec2(0.0, h), m) - flux(p - vec2(0.0, h), m)) / (2.0 * h);
  vec2 w = fx_rot(fx_deg(u_rotateWarpDir)) * g;
  fragColor = vec4(stc_unit(flux(p - u_bubbleAmount * 0.3 * w, m)), 0.0, 0.0, 1.0);
}`,
			},
			{
				include: [STC_CORE, STC_RAMP, STC_FINISH, GLSL_BLUR],
				frag: /* glsl */ `
void main() {
  float v = u_filter ? fx_blur9(u_tex, v_uv, u_texel).r : texture(u_tex, v_uv).r;
  fragColor = stc_finish(stc_ramp1(v));
}`,
			},
		],
	},
});

export const S_TEXTURE_FOLDED = texture({
	id: 'jasper.s.texture-folded',
	label: 'S_TextureFolded',
	description:
		'Folded cloth or liquid: a noise texture folded by a second, slower noise field (Fold Amp, Fold Freq); Fold Speed animates the folds.',
	keywords: ['folded', 'cloth', 'fabric', 'liquid', 'silk', 'turbulent', 'texture'],
	params: [
		...freqHead(4, 1),
		sInt('octaves', 'Octaves', 1, 1, 10),
		sSeed(0.432),
		sAny('foldAmp', 'Fold Amp', 72, 720),
		sFreq('foldFreq', 'Fold Freq', 0.5, 4),
		sInt('foldOctaves', 'Fold Octaves', 1, 1, 10),
		sVec('shift', 'Shift', [0, 0]),
		sVec('foldStart', 'Fold Start', [0, 0]),
		sVec('foldSpeed', 'Fold Speed', [1, 0]),
		...rampParams(),
		...finishParams(),
	],
	gpu: single(/* glsl */ `
void main() {${SHIFTED}
  vec2 fp = (p + stc_yUp(u_foldStart + u_foldSpeed * u_time)) * u_foldFreq;
  // The fold field turns a displacement direction by up to ±Fold Amp; neighbouring regions fold over each other.
  float th = fx_deg(u_foldAmp) * 1.5 * stc_fbm(fp, u_foldOctaves, 0.5, stc_seed(u_seed, 7.0));
  vec2 off = 1.2 * vec2(cos(th), sin(th));
  float n = stc_fbm(p + off, u_octaves, 0.5, u_seed);
  fragColor = stc_finish(stc_ramp1(stc_unit(n)));
}`),
});

export const S_TEXTURE_LOOPS = texture({
	id: 'jasper.s.texture-loops',
	label: 'S_TextureLoops',
	description:
		'Overlapping loop shapes: three sets of concentric contour loops of noise, separately sized, coloured and combined; Phase Speed moves the loops.',
	keywords: ['loops', 'rings', 'contours', 'topographic', 'lines', 'texture'],
	params: [
		...freqHead(3, 1),
		sFreq('loopFreq', 'Loop Freq', 4, 20, 1),
		sAny('phaseStart', 'Phase Start', 0),
		sAny('phaseSpeed', 'Phase Speed', 0.1),
		sSeed(1),
		sRange('thickness', 'Thickness', 0.1, -1, 2),
		sFreq('softness', 'Softness', 0.2, 2),
		sPos('smooth', 'Smooth', 0, 2),
		sVec('shift', 'Shift', [0, 0]),
		...rampParams(),
		sAny('saturation', 'Saturation', 1),
		sFreq('loops1Freq', 'Loops1 Freq', 1, 4),
		sFreq('loops2Freq', 'Loops2 Freq', 1, 4),
		sFreq('loops3Freq', 'Loops3 Freq', 1, 4),
		sRange('loops1Thick', 'Loops1 Thick', 0, -1, 1),
		sRange('loops2Thick', 'Loops2 Thick', 0, -1, 1),
		sRange('loops3Thick', 'Loops3 Thick', 0, -1, 1),
		sPos('loops1Bright', 'Loops1 Bright', 1),
		sPos('loops2Bright', 'Loops2 Bright', 1),
		sPos('loops3Bright', 'Loops3 Bright', 1),
		sColor('loops1Color', 'Loops1 Color', [1, 1, 1]),
		sColor('loops2Color', 'Loops2 Color', [1, 1, 1]),
		sColor('loops3Color', 'Loops3 Color', [1, 1, 1]),
		fxParam.toggle('invert', 'Invert', false),
		fxParam.choice(
			'combineLoops',
			'Combine Loops',
			['add', 'screen', 'diff', 'comp'],
			['Add', 'Screen', 'Diff', 'Comp'],
			'diff',
		),
		...finishParams(),
	],
	gpu: single(/* glsl */ `
// Line along the integer contours of x: half-width Thickness/2 (in contour spacings), soft edges, anti-aliased.
float loopLine(float x, float thick, float soft) {
  float c = abs(x - floor(x + 0.5));
  float hw = clamp(thick, -1.0, 2.0) * 0.5;
  float s = max(soft, 0.0) * 0.25 + fwidth(x) + 1.0e-4;
  return 1.0 - smoothstep(hw - 0.5 * s, hw + 0.5 * s, c);
}
float loopSet(vec2 p, float freq, float thick, float k, float ph) {
  float n = stc_fbm(p * 0.5 * freq + vec2(17.3, -9.1) * k, 2.0, 0.5, stc_seed(u_seed, k));
  return loopLine(n * u_loopFreq * 0.4 + ph, u_thickness + thick, u_softness + u_smooth);
}
void main() {${SHIFTED}
  float ph = u_phaseStart + u_phaseSpeed * u_time;
  float l1 = loopSet(p, u_loops1Freq, u_loops1Thick, 1.0, ph);
  float l2 = loopSet(p, u_loops2Freq, u_loops2Thick, 2.0, ph);
  float l3 = loopSet(p, u_loops3Freq, u_loops3Thick, 3.0, ph);
  vec3 a = u_loops1Color.rgb * u_loops1Bright * l1;
  vec3 b = u_loops2Color.rgb * u_loops2Bright * l2;
  vec3 c = u_loops3Color.rgb * u_loops3Bright * l3;
  vec3 v;
  if (u_combineLoops == 0) v = a + b + c;
  else if (u_combineLoops == 1) v = 1.0 - (1.0 - clamp(a, 0.0, 1.0)) * (1.0 - clamp(b, 0.0, 1.0)) * (1.0 - clamp(c, 0.0, 1.0));
  else if (u_combineLoops == 2) v = abs(abs(a - b) - c);
  else v = a + (1.0 - l1) * (b + (1.0 - l2) * c);
  v = fx_saturate(v, u_saturation);
  if (u_invert) v = 1.0 - v;
  fragColor = stc_finish(stc_ramp(v));
}`),
});

export const S_TEXTURE_MICRO = texture({
	id: 'jasper.s.texture-micro',
	label: 'S_TextureMicro',
	description:
		'A rough, many-octave surface like an object under an electron microscope; Boil Speed evolves it, Threshold darkens and intensifies it.',
	keywords: ['micro', 'microscope', 'rough', 'surface', 'grain', 'boil', 'texture'],
	expensive: true,
	params: [
		...freqHead(1, 0.6),
		sInt('octaves', 'Octaves', 12, 1, 12),
		sSeed(0.234),
		sRange('details', 'Details', 0.43, 0, 1),
		sAny('boilSpeed', 'Boil Speed', 1),
		sVec('shiftStart', 'Shift Start', [0, 0]),
		sVec('shiftSpeed', 'Shift Speed', [0, 0]),
		sPos('threshold', 'Threshold', 0.35, 1),
		...rampParams(),
		...finishParams(),
	],
	gpu: single(/* glsl */ `
// Turbulence (sum of |noise|) with continuous octaves; creases where the noise crosses zero.
float turb3(vec3 p, float octaves, float gain, float seed) {
  float n = clamp(octaves, 1.0, 12.0);
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int k = 0; k < 12; k++) {
    float w = clamp(n - float(k), 0.0, 1.0);
    if (w <= 0.0) break;
    sum += w * amp * abs(fx_simplex3(p, stc_octSeed(seed, k)));
    norm += w * amp;
    p = vec3(STC_OCT * p.xy, p.z * 2.0);
    amp *= gain;
  }
  return sum / max(norm, 1.0e-6);
}
void main() {
  vec2 q = stc_screen() - stc_yUp(u_shiftStart + u_shiftSpeed * u_time);
  vec2 p = q * vec2(u_frequency * u_frequencyRelX, u_frequency) * 6.0;
  float t = turb3(vec3(p, u_boilSpeed * u_time * 0.35), u_octaves, 0.35 + 0.6 * clamp(u_details, 0.0, 1.0), u_seed);
  // Creases (|noise| ≈ 0) are the dark grooves between rounded grains; Threshold cuts the low values to black.
  float g = 1.0 - pow(max(1.0 - t * 2.2, 0.0), 2.0);
  float v = max(g - u_threshold, 0.0) / max(1.0 - u_threshold, 0.05);
  fragColor = stc_finish(stc_ramp1(v));
}`),
});

/** GLSL ring pattern of S_TextureMoire. */
const MOIRE_RINGS = /* glsl */ `
float ring(float x) {
  float r = 0.5 + 0.5 * cos(FX_TAU * x);
  return (u_doubleSpaceRings && mod(floor(x + 0.5), 2.0) > 0.5) ? -r : r;
}
vec3 rings(vec2 q, vec2 c, float relW, float rotDeg, float f, float phase, vec3 relFreq, vec3 phaseRgb) {
  vec2 d = fx_rot(-fx_deg(rotDeg)) * (q - c);
  d.x /= max(relW, 0.2);
  vec3 x = length(d) * f * relFreq - (phase + phaseRgb);
  return vec3(ring(x.r), ring(x.g), ring(x.b));
}`;

export const S_TEXTURE_MOIRE = texture({
	id: 'jasper.s.texture-moire',
	label: 'S_TextureMoire',
	description:
		'A moiré of two concentric ring patterns (A and B) with per-channel frequency and phase; Phase Speed and Moire Speed animate the rings.',
	keywords: ['moire', 'rings', 'interference', 'concentric', 'circles', 'op art', 'texture'],
	params: [
		fxParam.point('aCenter', 'A Center', [0.4167, 0.5926]),
		fxParam.point('bCenter', 'B Center', [0.5833, 0.4074]),
		sFreq('frequency', 'Frequency', 20, 80, 0.5),
		sFreq('relFreqRed', 'Rel Freq Red', 1, 4, 0.1),
		sFreq('relFreqGreen', 'Rel Freq Green', 1, 4, 0.1),
		sFreq('relFreqBlue', 'Rel Freq Blue', 1, 4, 0.1),
		fxParam.toggle('doubleSpaceRings', 'Double Space Rings', false),
		sAny('phaseStart', 'Phase Start', 0),
		sAny('phaseSpeed', 'Phase Speed', 1),
		sAny('phaseRed', 'Phase Red', 0.2, 1),
		sAny('phaseGreen', 'Phase Green', 0.1, 1),
		sAny('phaseBlue', 'Phase Blue', 0, 1),
		sAny('moirePhase', 'Moire Phase', 0),
		sAny('moireSpeed', 'Moire Speed', 1),
		sPos('aBrightness', 'A Brightness', 1),
		sColor('aColor', 'A Color', [0.5, 0.5, 0.5]),
		sFreq('aRelFreq', 'A Rel Freq', 1, 4, 0.1),
		sFreq('aRelWidth', 'A Rel Width', 1, 4, 0.2),
		fxParam.angle('aRotate', 'A Rotate', 0),
		sPos('bBrightness', 'B Brightness', 1),
		sColor('bColor', 'B Color', [0.5, 0.5, 0.5]),
		sFreq('bRelFreq', 'B Rel Freq', 1, 4, 0.1),
		sFreq('bRelWidth', 'B Rel Width', 1, 4, 0.2),
		fxParam.angle('bRotate', 'B Rotate', 0),
		...rampParams(),
		sRange('saturation', 'Saturation', 1, 0, 10),
		...finishParams(),
	],
	gpu: single(/* glsl */ `${MOIRE_RINGS}
void main() {
  vec2 q = stc_screen();
  float ph = u_phaseStart + u_phaseSpeed * u_time;
  float mo = u_moirePhase + u_moireSpeed * u_time;
  vec3 rf = vec3(u_relFreqRed, u_relFreqGreen, u_relFreqBlue);
  vec3 pr = vec3(u_phaseRed, u_phaseGreen, u_phaseBlue);
  vec3 a = rings(q, stc_screenOfNorm(u_aCenter), u_aRelWidth, u_aRotate, u_frequency * u_aRelFreq, ph + mo, rf, pr);
  vec3 b = rings(q, stc_screenOfNorm(u_bCenter), u_bRelWidth, u_bRotate, u_frequency * u_bRelFreq, ph - mo, rf, pr);
  vec3 v = u_aBrightness * u_aColor.rgb * a + u_bBrightness * u_bColor.rgb * b;
  fragColor = stc_finish(stc_ramp(fx_saturate(v, u_saturation)));
}`),
});

/** Glow tail shared by S_TexturePlasma and S_TextureNeurons (Brightness, Color, Glow Brightness/Color/Widths). */
const glowParams = (glowBright: number, glowColor: [number, number, number], rgbWidths: [number, number, number]) => [
	sPos('brightness', 'Brightness', 1),
	sColor('color', 'Color', [1, 1, 1]),
	sPos('glowBrightness', 'Glow Brightness', glowBright, 10),
	sColor('glowColor', 'Glow Color', glowColor),
	sPos('glowWidth', 'Glow Width', 1, 4),
	sPos('glowWidthRed', 'Glow Width Red', rgbWidths[0]),
	sPos('glowWidthGrn', 'Glow Width Grn', rgbWidths[1]),
	sPos('glowWidthBlue', 'Glow Width Blue', rgbWidths[2]),
];
/** Last pass of the glow textures: core lines (u_lines .r) + chromatic glow. Glow widths are % of the height. */
const GLOW_FINAL = {
	include: [STC_CORE, STC_GLOW, STC_FINISH],
	frag: /* glsl */ `
void main() {
  float l = texture(u_lines, v_uv).r;
  vec3 radius = u_glowWidth * vec3(u_glowWidthRed, u_glowWidthGrn, u_glowWidthBlue) * 0.012 * stc_heightPx();
  vec3 glow = stc_glow(v_uv, radius);
  fragColor = stc_finish(u_brightness * u_color.rgb * l + u_glowBrightness * 0.35 * u_glowColor.rgb * glow);
}`,
};

export const S_TEXTURE_NEURONS = texture({
	id: 'jasper.s.texture-neurons',
	label: 'S_TextureNeurons',
	description:
		'Glowing nerve-cell tendrils: arms radiating from random centres, wiggled by noise and connecting their neighbours; Phase and Morph Speed animate them.',
	keywords: ['neurons', 'nerves', 'synapse', 'tendrils', 'organic', 'glow', 'texture'],
	expensive: true,
	params: [
		...freqHead(3, 1),
		sInt('arms', 'Arms', 9, 0, 50),
		sFreq('softness', 'Softness', 0.5, 2),
		sPos('thickness', 'Thickness', 1.1),
		sRange('outerBright', 'Outer Bright', 0.4, 0.01, 1),
		sSeed(1),
		sVec('shift', 'Shift', [0, 0]),
		sAny('phaseStart', 'Phase Start', 0, 1),
		sAny('phaseSpeed', 'Phase Speed', 0.05, 1),
		sAny('morphSpeed', 'Morph Speed', 0.05, 1),
		sVec('morph', 'Morph', [1, 0]),
		sAny('twist', 'Twist', 0),
		sPos('wiggleAmp', 'Wiggle Amp', 0.1, 1),
		sPos('wiggleFreqRel', 'Wiggle Freq Rel', 2, 8),
		sInt('wiggleOctaves', 'Wiggle Octaves', 4, 1, 10),
		sPos('smooth', 'Smooth', 0, 2),
		...glowParams(2, [1, 0.8, 0.8], [0.4, 0.6, 0.8]),
		...finishParams(),
	],
	gpu: {
		kind: 'generator',
		passes: [
			{
				output: 'lines',
				format: 'rgba16f',
				include: [STC_CORE],
				frag: /* glsl */ `
void main() {${SHIFTED}
  float morphT = u_morphSpeed * u_time;
  float wig = u_wiggleAmp * 6.0 *
    stc_fbm(p * u_wiggleFreqRel + stc_yUp(u_morph) * morphT, u_wiggleOctaves, 0.5, stc_seed(u_seed, 3.0));
  float arms = floor(clamp(u_arms, 0.0, 50.0) + 0.5);
  float seg = FX_TAU / max(arms, 1.0);
  float ph = FX_TAU * (u_phaseStart + u_phaseSpeed * u_time);
  float sigma = 0.012 * (0.3 + u_softness) * max(u_thickness, 0.0) + 0.015 * u_smooth + 1.0e-4;
  float bright = min(u_thickness, 1.0);
  ivec2 c = ivec2(floor(p));
  vec2 f = fract(p);
  float acc = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      ivec2 o = ivec2(x, y);
      vec3 h = fx_hash33(ivec3(c + o, 0), u_seed);
      vec2 d = f - (vec2(o) + 0.5 + (h.xy - 0.5) * 0.7);
      float r = length(d);
      float a = atan(d.y, d.x) + (h.z < 0.5 ? -1.0 : 1.0) * ph + 2.0 * u_twist * r + wig + FX_TAU * h.z;
      float ad = abs(mod(a + 0.5 * seg, seg) - 0.5 * seg) * r;
      float line = arms > 0.5 ? exp(-0.5 * ad * ad / (sigma * sigma)) * bright : 0.0;
      float fall = mix(1.0, u_outerBright, smoothstep(0.0, 0.45, r)) * (1.0 - smoothstep(0.55, 1.1, r));
      float nucleus = exp(-r * r / (2.0 * 0.03 * 0.03)) * bright;
      float k = clamp(line * fall + nucleus, 0.0, 1.0);
      acc = 1.0 - (1.0 - acc) * (1.0 - k);
    }
  fragColor = vec4(fx_inBox(v_uv) ? acc : 0.0, 0.0, 0.0, 1.0);
}`,
			},
			...glowPasses('lines'),
			GLOW_FINAL,
		],
	},
});

export const S_TEXTURE_NOISE_EMBOSS = texture({
	id: 'jasper.s.texture-noise-emboss',
	label: 'S_TextureNoiseEmboss',
	description:
		'A noise texture embossed into a shiny relief: Bumps Scale/Threshold/Smooth shape the bumps, Light Dir lights them with a specular highlight.',
	keywords: ['emboss', 'relief', 'bump', 'metal', 'shiny', 'noise', 'texture'],
	params: [
		sFreq('frequency', 'Frequency', 2, 40, 0.1),
		sFreq('frequencyRelX', 'Frequency Rel X', 1.5, 4),
		sInt('octaves', 'Octaves', 5, 1, 10),
		sSeed(0.23),
		sAny('bumpsScale', 'Bumps Scale', 2.5, 10),
		sPos('bumpsThreshold', 'Bumps Threshold', 0, 1),
		sPos('bumpsSmooth', 'Bumps Smooth', 0, 2),
		sVec('shift', 'Shift', [0, 0]),
		sVec('lightDir', 'Light Dir', [0.389, 0.33]),
		sRange('hilightBrightness', 'Hilight Brightness', 0.5, 0, 1),
		sFreq('hilightSize', 'Hilight Size', 0.5, 2, 0.1),
		sPos('brightness', 'Brightness', 1),
		sColor('surfaceColor', 'Surface Color', [0.75, 0.75, 0.75]),
		sColor('lightColor', 'Light Color', [1, 1, 1]),
		...finishParams(),
	],
	gpu: single(
		/* glsl */ `
float bump(vec2 p) { return u_bumpsScale * max(0.5 + 0.5 * stc_fbm(p, u_octaves, 0.5, u_seed) - u_bumpsThreshold, 0.0); }
void main() {${SHIFTED}
  vec2 fq = vec2(u_frequency * u_frequencyRelX, u_frequency);
  float e = 0.015 + 0.25 * u_bumpsSmooth;
  vec2 g = vec2(bump(p + vec2(e, 0.0)) - bump(p - vec2(e, 0.0)), bump(p + vec2(0.0, e)) - bump(p - vec2(0.0, e))) / (2.0 * e);
  // Slope in texture space (heights are in units of 1/50 frame height per Bumps Scale unit).
  vec3 nrm = normalize(vec3(-g * fq * 0.02, 1.0));
  vec2 ld = stc_yUp(u_lightDir);
  vec3 l = normalize(vec3(ld, sqrt(max(0.0, 1.0 - dot(ld, ld))) + 0.05));
  float diffuse = max(dot(nrm, l), 0.0);
  float shin = 6.0 / max(u_hilightSize * u_hilightSize, 0.01);
  float spec = pow(max(dot(nrm, normalize(l + vec3(0.0, 0.0, 1.0))), 0.0), shin) * u_hilightBrightness;
  vec3 tex = u_brightness * (u_surfaceColor.rgb * u_lightColor.rgb * diffuse + u_lightColor.rgb * spec);
  fragColor = stc_finish(tex);
}`,
		true,
	),
});

const noisePaintPasses = (p: EffectParams, ctx: FxPlanContext): ShaderPass[] => [
	{
		output: 'noise',
		format: 'rgba16f',
		include: [STC_CORE],
		frag: /* glsl */ `
void main() {
  vec2 p = (stc_screen() - stc_yUp(u_noiseShift)) * vec2(u_noiseFrequency * u_noiseFreqRelX, u_noiseFrequency);
  // A luminance noise plus a softer chroma noise (a painting, not a rainbow).
  float l = stc_fbm(p, u_noiseOctaves, 0.5, stc_seed(u_seed, 1.0));
  vec3 ch = vec3(stc_fbm(p * 0.7, u_noiseOctaves, 0.5, stc_seed(u_seed, 2.0)),
                 stc_fbm(p * 0.7, u_noiseOctaves, 0.5, stc_seed(u_seed, 3.0)),
                 stc_fbm(p * 0.7, u_noiseOctaves, 0.5, stc_seed(u_seed, 4.0)));
  fragColor = vec4(clamp(0.5 + 0.8 * l + 0.6 * (ch - dot(ch, vec3(1.0 / 3.0))), 0.0, 1.0), 1.0);
}`,
	},
	{
		// Stroke orientation field: luminance gradient as a double angle (orientation, not direction), at half size;
		// Stroke Align widens the gradient (smoother, more parallel strokes).
		output: 'orient',
		scale: 0.5,
		include: [STC_CORE],
		frag: /* glsl */ `
float lum(vec2 q) { return fx_luma(texture(u_noise, stc_uvOfScreen(q)).rgb); }
void main() {
  vec2 q = stc_screen();
  float r = (0.6 + 2.0 * u_strokeAlign) / max(u_strokeFrequency, 0.1);
  vec2 g = vec2(lum(q + vec2(r, 0.0)) - lum(q - vec2(r, 0.0)), lum(q + vec2(0.0, r)) - lum(q - vec2(0.0, r)));
  vec2 t = vec2(g.x * g.x - g.y * g.y, 2.0 * g.x * g.y);
  float m = length(t);
  fragColor = vec4(0.5 + 0.5 * (m > 1.0e-10 ? t / m : vec2(1.0, 0.0)), 0.0, 1.0);
}`,
	},
	{
		output: 'paint',
		format: 'rgba16f',
		include: [STC_CORE],
		frag: /* glsl */ `
void main() {
  vec2 q = stc_screen();
  float cs = 1.0 / max(u_strokeFrequency, 0.1);
  vec2 g = q / cs;
  ivec2 c = ivec2(floor(g));
  float jf = floor(u_jitterFrames + 0.5);
  int epoch = jf >= 1.0 ? int(floor(u_frame / jf)) : 0;
  float halfW = 0.34;
  float halfLen = clamp(0.45 + abs(u_strokeLength) * 0.22, halfW, 1.6);
  float px = 1.0 / max(cs * stc_heightPx(), 1.0);
  vec3 col = texture(u_noise, v_uv).rgb;
  for (int y = -2; y <= 2; y++)
    for (int x = -2; x <= 2; x++) {
      ivec2 id = c + ivec2(x, y);
      vec3 h = fx_hash33(ivec3(id, epoch), u_seed);
      vec2 ctr = (vec2(id) + 0.15 + 0.7 * h.xy) * cs;
      vec2 uvc = stc_uvOfScreen(ctr);
      vec2 o = texture(u_orient, uvc).rg * 2.0 - 1.0;
      float th = 0.5 * atan(o.y, o.x) + (u_strokeLength > 0.0 ? 0.5 * FX_PI : 0.0) + (h.z - 0.5) * 0.35;
      vec2 dir = vec2(cos(th), sin(th));
      vec2 rel = (q - ctr) / cs;
      vec2 lc = vec2(dot(rel, dir), dot(rel, vec2(-dir.y, dir.x)));
      float sd = length(vec2(max(abs(lc.x) - (halfLen - halfW), 0.0), lc.y)) - halfW * (0.85 + 0.3 * h.z);
      float cover = 1.0 - smoothstep(-px, px, sd);
      if (cover <= 0.0) continue;
      float bristle = 0.86 + 0.14 * fx_valueNoise(vec2(lc.x * 1.5, lc.y * 9.0) + h.xy * 50.0, u_seed);
      col = mix(col, texture(u_noise, uvc).rgb * bristle, cover);
    }
  fragColor = vec4(col, 1.0);
}`,
	},
	...sharpenPasses('paint', sharpenSigma(num(p.sharpenWidth, 0.1), num(p.strokeFrequency, 30), ctx)),
	{
		include: [STC_CORE, STC_FINISH],
		frag: /* glsl */ `
void main() {
  vec3 c = texture(u_paint, v_uv).rgb;
  c += u_sharpen * (c - texture(u_soft, v_uv).rgb);
  c = fx_saturate(c, u_saturation);
  fragColor = stc_finish(c * u_brightness * u_color.rgb + u_offset);
}`,
	},
];

export const S_TEXTURE_NOISE_PAINT = texture({
	id: 'jasper.s.texture-noise-paint',
	label: 'S_TextureNoisePaint',
	description:
		'A colour noise texture repainted with brush strokes that follow (or cross) its edges, then sharpened; Jitter Frames re-randomises the strokes.',
	keywords: ['paint', 'brush', 'strokes', 'painterly', 'impressionist', 'noise', 'texture'],
	expensive: true,
	params: [
		sFreq('noiseFrequency', 'Noise Frequency', 5, 40, 0.1),
		sFreq('noiseFreqRelX', 'Noise Freq Rel X', 1, 4),
		sInt('noiseOctaves', 'Noise Octaves', 1, 1, 10),
		sSeed(0.23, 'seed', 'Noise Seed'),
		sVec('noiseShift', 'Noise Shift', [0, 0]),
		sFreq('strokeFrequency', 'Stroke Frequency', 30, 120, 0.1),
		sAny('strokeLength', 'Stroke Length', -5, 10),
		sPos('strokeAlign', 'Stroke Align', 0, 2),
		sAny('sharpen', 'Sharpen', 2, 5),
		sPos('sharpenWidth', 'Sharpen Width', 0.1, 1),
		fxParam.number('jitterFrames', 'Jitter Frames', 0, { min: 0, max: 1000, softMax: 30, step: 1 }),
		sPos('brightness', 'Brightness', 1),
		sColor('color', 'Color', [1, 1, 1]),
		sRange('saturation', 'Saturation', 0.8, 0, 10),
		sRange('offset', 'Offset', 0, -8, 2),
		...finishParams(),
	],
	gpu: { kind: 'generator', passes: noisePaintPasses },
});

export const S_TEXTURE_PLASMA = texture({
	id: 'jasper.s.texture-plasma',
	label: 'S_TexturePlasma',
	description:
		'Glowing electrical plasma lines along the contours of a noise texture, with a chromatic glow; Phase Speed makes the lines undulate.',
	keywords: ['plasma', 'electric', 'energy', 'lines', 'glow', 'neon', 'texture'],
	params: [
		sFreq('noiseFrequency', 'Noise Frequency', 1.2, 20),
		sFreq('noiseFreqRelX', 'Noise Freq Rel X', 1, 4),
		sInt('noiseOctaves', 'Noise Octaves', 4, 1, 10),
		sSeed(0.12, 'seed', 'Noise Seed'),
		sVec('addGrad', 'Add Grad', [0.1, 0]),
		sPos('layers', 'Layers', 4.5, 20),
		sPos('threshold', 'Threshold', 0.5, 2),
		sVec('shift', 'Shift', [0, 0]),
		sAny('phaseStart', 'Phase Start', 0),
		sAny('phaseSpeed', 'Phase Speed', 1),
		...glowParams(3, [0.6, 0.8, 1], [0.6, 1.2, 1.8]),
		...finishParams(),
	],
	gpu: {
		kind: 'generator',
		passes: [
			{
				output: 'lines',
				format: 'rgba16f',
				include: [STC_CORE],
				frag: /* glsl */ `
void main() {
  vec2 q = stc_screen() - stc_yUp(u_shift);
  vec2 p = q * vec2(u_noiseFrequency * u_noiseFreqRelX, u_noiseFrequency);
  float n = stc_fbm(p, u_noiseOctaves, 0.5, u_seed) + dot(stc_yUp(u_addGrad), q);
  float x = n * u_layers + (u_phaseStart + u_phaseSpeed * u_time) / FX_TAU;
  float d = abs(x - floor(x + 0.5));
  float w = max(0.02 / max(u_threshold, 0.01), 0.5 * fwidth(x));
  float line = w / (d + w);
  fragColor = vec4(fx_inBox(v_uv) ? line * line : 0.0, 0.0, 0.0, 1.0);
}`,
			},
			...glowPasses('lines'),
			GLOW_FINAL,
		],
	},
});

export const S_TEXTURE_RIDGES = texture({
	id: 'jasper.s.texture-ridges',
	label: 'S_TextureRidges',
	description:
		'A ridged fractal noise: bright low-frequency swirls over subtler, detailed high-frequency ones; Boil Speed evolves it, Shift Speed drifts it.',
	keywords: ['ridges', 'ridged', 'fractal', 'swirls', 'marble', 'noise', 'texture'],
	expensive: true,
	params: [
		sFreq('frequency', 'Frequency', 1, 20, 0.001),
		sPos('relFreqX', 'Rel Freq X', 1),
		sPos('relFreqY', 'Rel Freq Y', 1),
		sInt('noiseOctaves', 'Noise Octaves', 3, 1, 8),
		sPos('noiseDetails', 'Noise Details', 0.7, 2),
		sAny('boilSpeed', 'Boil Speed', 1),
		sInt('ridgedFractalOctaves', 'Ridged Fractal Octaves', 4, 1, 8),
		sPos('octaveFreqScale', 'Octave Freq Scale', 1.5, 4),
		sRange('octaveGain', 'Octave Gain', 0.8, 0, 2),
		sVec('shiftStart', 'Shift Start', [0, 0]),
		sVec('shiftSpeed', 'Shift Speed', [0, 0.5]),
		sColor('color1', 'Color1', [0, 0, 0]),
		sColor('color2', 'Color2', [1, 1, 1]),
		sRange('inversionThreshold', 'Inversion Threshold', 0.7, -2, 2),
		sPos('scaleLights', 'Scale Lights', 1.2),
		sRange('offsetDarks', 'Offset Darks', 0, -8, 2),
		sSeed(0.123),
		...finishParams({ only: 'Noise', modes: 4 }),
	],
	gpu: single(/* glsl */ `
void main() {
  vec2 q = stc_screen() - stc_yUp(u_shiftStart + u_shiftSpeed * u_time);
  vec3 pp = vec3(q * u_frequency * vec2(u_relFreqX, u_relFreqY) * 1.2, u_boilSpeed * u_time * 0.3);
  float inv = u_inversionThreshold;
  float sharp = 1.0 + 3.0 * max(abs(inv) - 1.0, 0.0);
  float n = clamp(u_ridgedFractalOctaves, 1.0, 8.0);
  // Ridged multifractal: each pass is weighted by the previous one, so finer swirls grow along the bright ridges.
  float acc = 0.0, ws = 0.0, amp = 1.0, weight = 1.0;
  for (int k = 0; k < 8; k++) {
    float w = clamp(n - float(k), 0.0, 1.0);
    if (w <= 0.0) break;
    float s = stc_fbm3(pp, u_noiseOctaves, clamp(u_noiseDetails, 0.0, 2.0), stc_seed(u_seed, float(k)));
    float u = clamp(0.5 + 0.5 * s, 0.0, 1.0);
    float ridge = 1.0 - min(abs(s) * 1.4, 1.0);
    ridge *= ridge * ridge;
    float v = inv >= 0.0 ? mix(u, ridge, min(inv, 1.0)) : mix(u, 1.0 - ridge, min(-inv, 1.0));
    float sig = pow(v, sharp) * weight;
    acc += w * amp * sig;
    ws += w * amp;
    weight = clamp(sig * 2.0, 0.0, 1.0);
    amp *= u_octaveGain;
    pp = vec3(STC_OCT * pp.xy * (0.5 * u_octaveFreqScale), pp.z * u_octaveFreqScale);
  }
  float v = acc / max(ws, 1.0e-4);
  v = v * u_scaleLights + u_offsetDarks * (1.0 - v);
  fragColor = stc_finish(mix(u_color1.rgb, u_color2.rgb, v));
}`),
});

export const S_TEXTURE_SPOTS = texture({
	id: 'jasper.s.texture-spots',
	label: 'S_TextureSpots',
	description:
		'A field of spots distorted by a random bubble warp; Warp Speed makes the spots wiggle over time.',
	keywords: ['spots', 'dots', 'polka', 'halftone', 'circles', 'warp', 'texture'],
	params: [
		sFreq('frequency', 'Frequency', 8, 60),
		sRange('radius', 'Radius', 1, 0, 2),
		sSeed(0.23),
		sPos('randWarpAmp', 'Rand Warp Amp', 0.2, 2),
		sFreq('randWarpFreq', 'Rand Warp Freq', 1, 8),
		sVec('shift', 'Shift', [0, 0]),
		sVec('warpStart', 'Warp Start', [0, 0]),
		sVec('warpSpeed', 'Warp Speed', [0.5, 0]),
		...rampParams(),
		fxParam.toggle('invert', 'Invert', false),
		...finishParams(),
	],
	gpu: single(/* glsl */ `
void main() {
  vec2 p = (stc_screen() - stc_yUp(u_shift)) * u_frequency;
  vec2 wp = p * u_randWarpFreq * 0.25 + stc_yUp(u_warpStart + u_warpSpeed * u_time);
  vec2 g = p + u_randWarpAmp * 2.0 *
    vec2(stc_fbm(wp, 2.0, 0.5, stc_seed(u_seed, 1.0)), stc_fbm(wp + vec2(31.7, 11.3), 2.0, 0.5, stc_seed(u_seed, 2.0)));
  vec2 c = floor(g);
  float d = 8.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) d = min(d, length(g - (c + vec2(float(x), float(y)) + 0.5)));
  float rad = 0.36 * u_radius;
  float aa = 0.7 * length(fwidth(g)) + 0.01;
  float v = 1.0 - smoothstep(rad - aa, rad + aa, d);
  if (u_invert) v = 1.0 - v;
  fragColor = stc_finish(stc_ramp1(v));
}`),
});

/** GLSL: hexagon-lattice cell (local coords, spacing 1) and the morphing tile shapes of S_TextureTiles. */
const TILE_SHAPES = /* glsl */ `
vec2 hexLocal(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec2 a = p - s * floor(p / s + 0.5);
  vec2 b = p - s * (floor((p - 0.5 * s) / s + 0.5) + 0.5);
  return dot(a, a) < dot(b, b) ? a : b;
}
// Regular-polygon metric (apothem units): max over the face normals of dot(l, n).
float ngon(vec2 l, float n, float rot) {
  float seg = FX_TAU / n;
  float a = atan(l.y, l.x) - rot;
  return length(l) * cos(mod(a + 0.5 * seg, seg) - 0.5 * seg);
}
// Shapes, normalised so that 1 just covers the hexagonal cell: hexagon, triangle, diamond, six-point star.
float tileShape(vec2 l, int i) {
  if (i == 0) return ngon(l, 6.0, 0.0) / 0.5;
  if (i == 1) return ngon(l, 3.0, -0.5 * FX_PI) / 0.57735;
  if (i == 2) return max(abs(dot(l, vec2(0.8660254, 0.5))), abs(dot(l, vec2(0.8660254, -0.5)))) / 0.57735;
  return min(ngon(l, 3.0, -0.5 * FX_PI), ngon(l, 3.0, 0.5 * FX_PI)) / 0.4330127;
}
float tileMetric(vec2 l, float morph) {
  float m = mod(morph, 4.0);
  int i = int(floor(m));
  float t = smoothstep(0.0, 1.0, fract(m));
  return mix(tileShape(l, i), tileShape(l, (i + 1) - 4 * ((i + 1) / 4)), t);
}`;

export const S_TEXTURE_TILES = texture({
	id: 'jasper.s.texture-tiles',
	label: 'S_TextureTiles',
	description:
		'A repeating pattern of tiles that morph between hexagons, triangles, diamonds and stars, with size and shape gradients; Morph Speed animates the shapes.',
	keywords: ['tiles', 'hexagons', 'triangles', 'stars', 'pattern', 'geometric', 'texture'],
	params: [
		sPos('size', 'Size', 0.5, 1.5),
		sFreq('frequency', 'Frequency', 5, 40),
		fxParam.angle('angle', 'Angle', 0),
		sFreq('relWidth', 'Rel Width', 1, 4, 0.2),
		sFreq('relWidPreRot', 'Rel Wid Pre Rot', 1, 4, 0.1),
		sVec('shift', 'Shift', [0, 0]),
		sAny('morphShapes', 'Morph Shapes', 0),
		sAny('morphSpeed', 'Morph Speed', 0.5),
		sAny('morphGradAdd', 'Morph Grad Add', 0),
		fxParam.angle('morphGradAngle', 'Morph Grad Angle', 0),
		sAny('morphRadial', 'Morph Radial', 0),
		sRange('sizeGradAdd', 'Size Grad Add', 0, -10, 10),
		fxParam.angle('sizeGradAngle', 'Size Grad Angle', 0),
		sAny('sizeRadial', 'Size Radial', 0),
		sPos('edgeSoftness', 'Edge Softness', 0.17, 1),
		sPos('softnessRed', 'Softness Red', 0),
		sPos('softnessGreen', 'Softness Green', 1),
		sPos('softnessBlue', 'Softness Blue', 2),
		fxParam.toggle('invert', 'Invert', false),
		...rampParams(),
		...finishParams(),
	],
	gpu: single(/* glsl */ `${TILE_SHAPES}
void main() {
  vec2 q = stc_screen() - stc_yUp(u_shift);
  vec2 s = q;
  s.x /= max(u_relWidth, 0.2);
  s = fx_rot(-fx_deg(u_angle)) * s;
  s.x /= max(u_relWidPreRot, 0.1);
  vec2 l = hexLocal(s * u_frequency);
  float r = length(q);
  float morph = u_morphShapes + u_morphSpeed * u_time + u_morphGradAdd * dot(q, fx_dir(u_morphGradAngle)) + u_morphRadial * r;
  float size = u_size + u_sizeGradAdd * dot(q, fx_dir(u_sizeGradAngle)) + u_sizeRadial * r;
  float m = tileMetric(l, morph);
  vec3 soft = u_edgeSoftness * 0.5 * vec3(u_softnessRed, u_softnessGreen, u_softnessBlue) + fwidth(m) + 1.0e-4;
  vec3 v = 1.0 - smoothstep(size - soft, size + soft, vec3(m));
  if (u_invert) v = 1.0 - v;
  fragColor = stc_finish(stc_ramp(v));
}`),
});

export const S_TEXTURE_WEAVE = texture({
	id: 'jasper.s.texture-weave',
	label: 'S_TextureWeave',
	description:
		'Perpendicular woven strands: horizontal and vertical stretched-noise fibres with their own frequency, octaves and crawl speed, then sharpened.',
	keywords: ['weave', 'woven', 'fabric', 'cloth', 'fibres', 'strands', 'texture'],
	params: [
		sFreq('frequency', 'Frequency', 20, 80),
		sFreq('hFreqRelX', 'H Freq Rel X', 0.2, 2),
		sInt('hOctaves', 'H Octaves', 2, 1, 10),
		sAny('hSpeedX', 'H Speed X', 0),
		sFreq('vFrequency', 'V Frequency', 1, 4),
		sFreq('vFreqRelY', 'V Freq Rel Y', 0.2, 2),
		sInt('vOctaves', 'V Octaves', 2, 1, 10),
		sAny('vSpeedY', 'V Speed Y', 0),
		sSeed(0.123),
		sVec('shift', 'Shift', [0, 0]),
		sVec('shiftSpeed', 'Shift Speed', [0, 0]),
		sAny('sharpen', 'Sharpen', 1, 5),
		sPos('sharpenWidth', 'Sharpen Width', 0.1, 1),
		...rampParams(),
		...finishParams(),
	],
	gpu: {
		kind: 'generator',
		passes: (p, ctx) => [
			{
				output: 'tex',
				format: 'rgba16f',
				include: [STC_CORE],
				frag: /* glsl */ `
void main() {
  vec2 q = stc_screen() - stc_yUp(u_shift + u_shiftSpeed * u_time);
  float f = u_frequency;
  vec2 ph = vec2(q.x * f * u_hFreqRelX - u_hSpeedX * u_time, q.y * f);
  vec2 pv = vec2(q.x * f * u_vFrequency, q.y * f * u_vFrequency * u_vFreqRelY + u_vSpeedY * u_time);
  float h = stc_unit(stc_fbm(ph, u_hOctaves, 0.5, stc_seed(u_seed, 1.0)));
  float v = stc_unit(stc_fbm(pv, u_vOctaves, 0.5, stc_seed(u_seed, 2.0)));
  fragColor = vec4(max(h, v), 0.0, 0.0, 1.0);
}`,
			},
			...sharpenPasses('tex', sharpenSigma(num(p.sharpenWidth, 0.1), num(p.frequency, 20), ctx)),
			{
				include: [STC_CORE, STC_RAMP, STC_FINISH],
				frag: /* glsl */ `
void main() {
  float v = texture(u_tex, v_uv).r;
  v += u_sharpen * (v - texture(u_soft, v_uv).r);
  fragColor = stc_finish(stc_ramp1(v));
}`,
			},
		],
	},
});

/** Effects-panel order: alphabetical like Sapphire's Render menu (clouds, then textures). */
export const SAPPHIRE_TEXTURES_CLOUDS_EFFECTS: readonly EffectSpec[] = [
	S_CLOUDS,
	S_CLOUDS_COLOR_SMOOTH,
	S_CLOUDS_MULT_COLOR,
	S_CLOUDS_PERSPECTIVE,
	S_CLOUDS_PSYKO,
	S_CLOUDS_VORTEX,
	S_TEXTURE_CELLS,
	S_TEXTURE_CHROMA_SPIRAL,
	S_TEXTURE_FLUX,
	S_TEXTURE_FOLDED,
	S_TEXTURE_LOOPS,
	S_TEXTURE_MICRO,
	S_TEXTURE_MOIRE,
	S_TEXTURE_NEURONS,
	S_TEXTURE_NOISE_EMBOSS,
	S_TEXTURE_NOISE_PAINT,
	S_TEXTURE_PLASMA,
	S_TEXTURE_RIDGES,
	S_TEXTURE_SPOTS,
	S_TEXTURE_TILES,
	S_TEXTURE_WEAVE,
];
