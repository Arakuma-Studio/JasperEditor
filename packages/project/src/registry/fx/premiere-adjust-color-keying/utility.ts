// Premiere Pro "Utility" video effects (fx family premiere-adjust-color-keying): Cineon Converter.
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_PACG, popup, slider } from './common.ts';

/**
 * Kodak Cineon log ↔ linear (printing density 0.002 per 10-bit code value, negative gamma 0.6). Reference TS
 * implementation of the shader maths (tests): `code` is the 10-bit value 0..1023, the result linear 0..1 (before
 * the display gamma).
 */
export function cineonLogToLinear(code: number, black: number, white: number): number {
	const k = 0.002 / 0.6;
	const offset = 10 ** ((black - white) * k);
	return (10 ** ((code - white) * k) - offset) / (1 - offset);
}

export const CINEON_CONVERTER = defineShaderEffect({
	id: 'jasper.cineon-converter',
	label: 'Cineon Converter',
	category: 'Utility',
	description:
		'Converts Cineon (Kodak 10-bit log) footage to linear display colour, or linear to log, with black/white points and highlight rolloff.',
	keywords: ['cineon', 'log', 'dpx', 'film', 'linearize', 'log to lin'],
	params: [
		popup(
			'conversionType',
			'Conversion Type',
			[
				['linearToLog', 'Linear to Log'],
				['logToLinear', 'Log to Linear'],
				['logToLog', 'Log to Log'],
			],
			'logToLinear',
		),
		slider('tenBitBlackPoint', '10 Bit Black Point', 95, 0, 1023, { step: 1 }),
		slider('internalBlackPoint', 'Internal Black Point', 0, 0, 255, { step: 1 }),
		slider('tenBitWhitePoint', '10 Bit White Point', 685, 0, 1023, { step: 1 }),
		slider('internalWhitePoint', 'Internal White Point', 255, 0, 255, { step: 1 }),
		slider('gamma', 'Gamma', 1.7, 0.1, 5, { step: 0.01 }),
		slider('highlightRolloff', 'Highlight Rolloff', 0, 0, 100, { step: 1 }),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
const float K = 0.002 / 0.6;
float logToLin(float code) {
  float off = pow(10.0, (u_tenBitBlackPoint - u_tenBitWhitePoint) * K);
  return (pow(10.0, (code - u_tenBitWhitePoint) * K) - off) / (1.0 - off);
}
float linToLog(float lin) {
  float off = pow(10.0, (u_tenBitBlackPoint - u_tenBitWhitePoint) * K);
  return u_tenBitWhitePoint + log(max(lin * (1.0 - off) + off, 1.0e-6)) / log(10.0) / K;
}
// Highlight rolloff: compresses the top of the range instead of clipping (0 = none).
float rolloff(float v, float r) {
  if (r <= 0.0) return v;
  float k0 = 1.0 - r;
  return v <= k0 ? v : k0 + r * (1.0 - exp(-(v - k0) / r));
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src);
  float ib = u_internalBlackPoint / 255.0, iw = u_internalWhitePoint / 255.0;
  float g = max(u_gamma, 0.1);
  float ro = u_highlightRolloff / 100.0;
  vec3 r;
  if (u_conversionType == 1) {
    // log → linear: 10-bit code → scene linear → display (1 / gamma) → internal range.
    for (int i = 0; i < 3; i++) {
      float lin = max(logToLin(c[i] * 1023.0), 0.0);
      float d = rolloff(pow(lin, 1.0 / g), ro);
      r[i] = ib + clamp(d, 0.0, 1.0) * (iw - ib);
    }
  } else if (u_conversionType == 0) {
    for (int i = 0; i < 3; i++) {
      float d = clamp((c[i] - ib) / max(iw - ib, 1.0e-4), 0.0, 1.0);
      r[i] = linToLog(pow(d, g)) / 1023.0;
    }
  } else {
    // log → log: re-map the 10-bit black/white points onto the internal ones.
    r = ib + (c * 1023.0 - u_tenBitBlackPoint) / max(u_tenBitWhitePoint - u_tenBitBlackPoint, 1.0) * (iw - ib);
  }
  fragColor = fx_premultiply(vec4(clamp(r, 0.0, 1.0), src.a));
}`,
			},
		],
	},
});

export const UTILITY_EFFECTS: readonly EffectSpec[] = [CINEON_CONVERTER];
