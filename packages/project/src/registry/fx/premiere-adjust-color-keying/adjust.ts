// Premiere Pro "Adjust" video effects (fx family premiere-adjust-color-keying).
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { fxParam } from '../params.ts';
import { GLSL_PACG, slider } from './common.ts';

/** ProcAmp: a broadcast processing amplifier (brightness, contrast, hue, saturation), with a split-screen preview. */
export const PROC_AMP = defineShaderEffect({
	id: 'jasper.proc-amp',
	label: 'ProcAmp',
	category: 'Adjust',
	description: 'Broadcast-style processing amplifier: brightness, contrast, hue and saturation, with a split view.',
	keywords: ['brightness', 'contrast', 'hue', 'saturation', 'proc amp'],
	params: [
		slider('brightness', 'Brightness', 0, -100, 100, { step: 0.1 }),
		slider('contrast', 'Contrast', 100, 0, 200, { step: 0.1 }),
		fxParam.angle('hue', 'Hue', 0),
		slider('saturation', 'Saturation', 100, 0, 200, { step: 0.1 }),
		fxParam.toggle('splitScreen', 'Split Screen', false),
		fxParam.percent('splitPercent', 'Split Percent', 50),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_splitScreen && fx_layerNorm().x > u_splitPercent / 100.0) { fragColor = src; return; }
  vec3 c = pacg_straight(src);
  vec3 yiq = pacg_rgb2yiq(c);
  yiq.x = (yiq.x - 0.5) * (u_contrast / 100.0) + 0.5 + u_brightness / 255.0;
  float a = radians(u_hue);
  yiq.yz = mat2(cos(a), -sin(a), sin(a), cos(a)) * yiq.yz * (u_saturation / 100.0);
  fragColor = fx_premultiply(vec4(pacg_clamp01(pacg_yiq2rgb(yiq)), src.a));
}`,
			},
		],
	},
});

export const ADJUST_EFFECTS: readonly EffectSpec[] = [PROC_AMP];
