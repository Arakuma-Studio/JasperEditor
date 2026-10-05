// Premiere Pro standard effects — Time (family "premiere-stylize-distort-generate", wave 2): Echo (time samples) and
// Posterize Time (time remap). Echo reads up to 8 earlier/later frames of the raw layer source (framework limit
// FX_MAX_TIME_SAMPLES): put it first in the stack, as in Premiere. DOM layers (text, shapes) have no samples.
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { fxParam } from '../params.ts';
import { FX_MAX_TIME_SAMPLES, type FxTimeContext } from '../shader.ts';
import { num } from './common.ts';

const ECHO_OPERATORS = [
	'add',
	'maximum',
	'minimum',
	'screen',
	'compositeInBack',
	'compositeInFront',
	'blend',
] as const;

/** Number of echoes actually drawn (0…8). */
export const echoCount = (p: EffectParams) =>
	Math.max(0, Math.min(FX_MAX_TIME_SAMPLES, Math.floor(num(p.numberOfEchoes, 1))));

/** Frame offsets of the echoes: k × Echo Time (seconds → frames), k = 1…count (pure). */
export function echoOffsets(p: EffectParams, ctx: Pick<FxTimeContext, 'fps'>): number[] {
	const fps = ctx.fps > 0 ? ctx.fps : 30;
	const step = num(p.echoTime, -1 / 30) * fps;
	const out: number[] = [];
	for (let k = 1; k <= echoCount(p); k++) out.push(Math.round(k * step));
	return out;
}

/** Intensity of echo k (0 = the current frame): Starting Intensity × Decay^k. */
export const echoIntensity = (p: EffectParams, k: number) =>
	Math.max(0, num(p.startingIntensity, 1)) * Math.max(0, num(p.decay, 1)) ** k;

export const ECHO = defineShaderEffect({
	id: 'jasper.echo',
	label: 'Echo',
	category: 'Time',
	description:
		'Combines the frame with earlier (or later) frames of the clip: motion trails, ghosting and repeated echoes of moving objects.',
	keywords: ['trails', 'ghost', 'motion trail', 'onion skin', 'streak', 'time'],
	expensive: true,
	params: [
		fxParam.number(
			'echoTime',
			'Echo Time (seconds)',
			-1 / 30,
			{ min: -30, max: 30, softMin: -2, softMax: 2, step: 0.001 },
			{ unit: 's' },
		),
		fxParam.number('numberOfEchoes', 'Number of Echoes', 1, { min: 0, max: FX_MAX_TIME_SAMPLES, step: 1 }),
		fxParam.number('startingIntensity', 'Starting Intensity', 1, { min: 0, max: 1, step: 0.01 }),
		fxParam.number('decay', 'Decay', 1, { min: 0, max: 1, step: 0.01 }),
		fxParam.choice(
			'echoOperator',
			'Echo Operator',
			ECHO_OPERATORS,
			['Add', 'Maximum', 'Minimum', 'Screen', 'Composite In Back', 'Composite In Front', 'Blend'],
			'add',
		),
	],
	gpu: {
		time: { samples: (p, ctx) => echoOffsets(p, ctx) },
		uniforms: (p) => ({
			u_intensity: { floats: Array.from({ length: FX_MAX_TIME_SAMPLES + 1 }, (_, k) => echoIntensity(p, k)) },
			u_echoes: { int: echoCount(p) },
		}),
		passes: [
			{
				frag: /* glsl */ `
vec4 frameAt(int k) { return k == 0 ? texture(u_source, v_uv) : fx_sample(k - 1, v_uv); }
void main() {
  int n = min(u_echoes, u_sampleCount);
  int op = u_echoOperator;
  vec4 acc;
  if (op == 4) {
    // Composite In Back: the current frame on top, each echo behind the previous one.
    acc = vec4(0.0);
    for (int k = 0; k <= 8; k++) { if (k > n) break; acc += frameAt(k) * u_intensity[k] * (1.0 - acc.a); }
  } else if (op == 5) {
    // Composite In Front: the oldest echo at the back, the current frame behind… echoes stack towards the front.
    acc = vec4(0.0);
    for (int k = 8; k >= 0; k--) { if (k > n) continue; vec4 c = frameAt(k) * u_intensity[k]; acc = acc + c * (1.0 - acc.a); }
  } else if (op == 6) {
    vec4 sum = vec4(0.0); float w = 0.0;
    for (int k = 0; k <= 8; k++) { if (k > n) break; sum += frameAt(k) * u_intensity[k]; w += u_intensity[k]; }
    acc = w > 0.0 ? sum / max(w, 1.0) : vec4(0.0);
  } else {
    acc = frameAt(0) * u_intensity[0];
    for (int k = 1; k <= 8; k++) {
      if (k > n) break;
      vec4 c = frameAt(k) * u_intensity[k];
      if (op == 0) acc += c;
      else if (op == 1) acc = max(acc, c);
      else if (op == 2) acc = min(acc, c);
      else acc = acc + c - acc * c;
    }
  }
  acc.a = clamp(acc.a, 0.0, 1.0);
  fragColor = vec4(min(acc.rgb, vec3(acc.a)), acc.a);
}`,
			},
		],
	},
});

/** Source frame shown by Posterize Time at a clip-local frame: the start of its held frame (pure). */
export function posterizeTimeFrame(p: EffectParams, ctx: Pick<FxTimeContext, 'frame' | 'fps'>): number {
	const fps = ctx.fps > 0 ? ctx.fps : 30;
	const rate = num(p.frameRate, 12);
	if (rate <= 0) return 0;
	if (rate >= fps) return ctx.frame;
	const held = Math.floor((ctx.frame / fps) * rate + 1e-6);
	return Math.ceil((held / rate) * fps - 1e-6) + 0; // + 0: no −0
}

export const POSTERIZE_TIME = defineShaderEffect({
	id: 'jasper.posterize-time',
	label: 'Posterize Time',
	category: 'Time',
	description: 'Locks the clip to a lower frame rate: each frame is held, for a choppy, stop-motion look.',
	keywords: ['frame rate', 'stutter', 'choppy', 'stop motion', 'hold frames'],
	params: [fxParam.number('frameRate', 'Frame Rate', 12, { min: 0.1, max: 99, softMax: 60, step: 0.01 })],
	gpu: {
		time: { remap: (p, ctx) => posterizeTimeFrame(p, ctx) },
		passes: [{ frag: 'void main() { fragColor = texture(u_source, v_uv); }' }],
	},
});

export const PSDG_TIME_EFFECTS: readonly EffectSpec[] = [ECHO, POSTERIZE_TIME];
