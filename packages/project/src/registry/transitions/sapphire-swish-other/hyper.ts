// S_HyperPull / S_HyperPush: the outgoing clip is pulled away (or pushed towards the camera) in Z, then dissolves to
// the incoming clip arriving from the other depth; with a zoom/rotation motion blur, chroma warp (spectral smear
// along the move), fish-eye distortion with RGB separation, glowing brights and optional camera shake. Two
// variants of one spec builder (they only differ in their Z defaults). The glow is a downscaled bright pass + blur.
import type { TransitionSpec } from '../../../transitions.ts';
import type { EffectParams } from '../../effects.ts';
import { GLSL_BLUR } from '../../fx/glsl/blur.ts';
import { fxParam } from '../../fx/params.ts';
import type { ShaderPass } from '../../fx/shader.ts';
import { defineShaderTransition, SAPPHIRE_TRANSITION_SUBBINS, TRANSITION_BINS } from '../define.ts';
import { bool, check, GLSL_SW, num, shakeOffset, sInt, slowParams, sNum, wrapParam } from './common.ts';

/** Camera shake of the Hyper transitions at a frame (frame heights), scaled by the bell of the transition. */
export function hyperShake(
	p: EffectParams,
	ctx: { frame: number; fps: number; seed: number; progress: number },
) {
	if (!bool(p.cameraShake, false)) return [0, 0] as [number, number];
	const [x, y] = shakeOffset(ctx.seed, ctx.frame / Math.max(1, ctx.fps), {
		amplitude: num(p.amplitude, 2),
		frequency: num(p.frequency, 2),
		jumpiness: 0.3,
	});
	const bell = Math.sin(Math.PI * Math.min(1, Math.max(0, ctx.progress)));
	return [x * bell, y * bell] as [number, number];
}

const RES_FRAG = /* glsl */ `
// Source uv of side (0 From, 1 To) at frame position f: zoom by z (distance: > 1 = farther, smaller) and rotation
// about the side's centre, then the fish-eye of amount k (per channel: the RGB distortion).
vec2 hy_map(vec2 f, vec2 c, float z, float rotDeg, float k) {
  vec2 d = f - c;
  float r2 = dot(d, d);
  d *= 1.0 + k * r2;
  return sw_uv(c + sw_rot(-rotDeg) * d * z);
}
vec4 hy_side(int side, vec2 uv) { return side == 0 ? sw_fromW(uv, u_wrapFrom) : sw_toW(uv, u_wrapTo); }
// One side, zoom/rotation-blurred over its blur transform and chroma-warped.
vec4 hy_render(int side, vec2 f, float e, float bell) {
  float s = side == 0 ? e : 1.0 - e;                       // how far the side is into its move
  float zd = side == 0 ? u_zDistFrom : u_zDistTo;
  float z = pow(max(zd, 1e-3), s);
  float rot = (side == 0 ? u_rotateFrom : u_rotateTo) * s;
  vec2 c = sw_f(side == 0 ? u_centerFrom : u_centerTo);
  float k = -0.15 * u_distortionAmount * bell;
  float kr = k * (1.0 + u_distortRgbAmount), kb = k * (1.0 - u_distortRgbAmount);
  // Blur transform: relative distance and rotation from Blur From → Blur To, faded by the bell (speed).
  float span = u_motionBlur ? bell : 0.0;
  float chroma = u_warpChroma ? clamp(u_warpAmount, 0.0, 4.0) * bell : 0.0;
  float amp = max(span, chroma);
  if (amp <= 0.0) {
    vec2 uv = hy_map(f, c, z, rot, k);
    if (u_distortRgbAmount == 0.0 || k == 0.0) return hy_side(side, uv);
    vec4 r = hy_side(side, hy_map(f, c, z, rot, kr)), g = hy_side(side, uv), b = hy_side(side, hy_map(f, c, z, rot, kb));
    return vec4(r.r, g.g, b.b, g.a);
  }
  float z0 = pow(max(u_blurFromZDist, 1e-3), amp), z1 = pow(max(u_blurToZDist, 1e-3), amp);
  float r0 = u_blurFromRotate * amp, r1 = u_blurToRotate * amp;
  // Extent of the smear at this pixel (px) → taps.
  vec2 e0 = hy_map(f, c, z * z0, rot + r0, k), e1 = hy_map(f, c, z * z1, rot + r1, k);
  float extent = length((e1 - e0) * u_compSize);
  int n = max(sw_taps(extent, 64), u_warpChroma && chroma > 0.0 ? int(clamp(u_steps, 3.0, 64.0)) : 1);
  n = min(n, 64);
  float j = extent / float(n) > 1.5 ? sw_jitter() : 0.5;
  vec3 acc = vec3(0.0), wsum = vec3(0.0);
  float aacc = 0.0;
  for (int i = 0; i < 64; i++) {
    if (i >= n) break;
    float t = (float(i) + j) / float(n);
    float zz = z * mix(z0, z1, t);
    float rr = rot + mix(r0, r1, t);
    vec3 w = mix(vec3(1.0), 3.0 * vec3((1.0 - t) * (1.0 - t), 2.0 * t * (1.0 - t), t * t), clamp(chroma, 0.0, 1.0));
    vec4 g = hy_side(side, hy_map(f, c, zz, rr, k));
    vec3 rgb = g.rgb;
    if (u_distortRgbAmount != 0.0 && k != 0.0) {
      rgb.r = hy_side(side, hy_map(f, c, zz, rr, kr)).r;
      rgb.b = hy_side(side, hy_map(f, c, zz, rr, kb)).b;
    }
    acc += rgb * w;
    wsum += w;
    aacc += g.a;
  }
  return vec4(acc / max(wsum, vec3(1e-4)), aacc / float(n));
}
void main() {
  float p = tr_progress();
  float e = sw_slow(p, u_slowIn, u_slowOut);
  float bell = sw_bell(e);
  vec2 f = sw_f(v_uv) - u_hyShake;
  float w = clamp((e - 0.5) * max(u_dissolveSpeed, 1.0) + 0.5, 0.0, 1.0);
  w = w * w * (3.0 - 2.0 * w);
  vec4 a = w < 1.0 ? hy_render(0, f, e, bell) : vec4(0.0);
  vec4 b = w > 0.0 ? hy_render(1, f, e, bell) : vec4(0.0);
  vec4 c = mix(a, b, w);
  c.rgb *= mix(1.0, u_brightness, bell);
  fragColor = c;
}`;

function hyperSpec(kind: 'pull' | 'push'): TransitionSpec {
	const pull = kind === 'pull';
	return defineShaderTransition({
		id: pull ? 'jasper.s.hyper-pull' : 'jasper.s.hyper-push',
		expensive: true,
		label: pull ? 'S_HyperPull' : 'S_HyperPush',
		bin: TRANSITION_BINS.sapphire,
		subBin: SAPPHIRE_TRANSITION_SUBBINS.other,
		description: pull
			? 'Pulls the outgoing clip away in Z before dissolving to the incoming clip rushing in from close up, with zoom motion blur, chroma warp, fish-eye, glowing brights and optional camera shake.'
			: 'Pushes the outgoing clip towards the camera before dissolving to the incoming clip arriving from far away, with zoom motion blur, chroma warp, fish-eye, glowing brights and optional camera shake.',
		keywords: ['hyper', pull ? 'pull' : 'push', 'zoom', 'z', 'warp', 'chroma', 'glow', 'shake', 'fisheye'],
		params: [
			...slowParams(1),
			sNum('dissolveSpeed', 'Dissolve Speed', 5, { min: 1, softMax: 20 }),
			sNum('zDistFrom', 'Z Dist From', pull ? 5 : 0.001, { min: 0.001, softMax: 10, step: 0.001 }),
			fxParam.point('centerFrom', 'Center XY From', [0.5, 0.5]),
			fxParam.angle('rotateFrom', 'Rotate From', 0),
			wrapParam('wrapFrom', 'Wrap From'),
			sNum('zDistTo', 'Z Dist To', pull ? 0.001 : 5, { min: 0.001, softMax: 10, step: 0.001 }),
			fxParam.point('centerTo', 'Center XY To', [0.5, 0.5]),
			fxParam.angle('rotateTo', 'Rotate To', 0),
			wrapParam('wrapTo', 'Wrap To'),
			check('motionBlur', 'Motion Blur', true),
			sNum('blurFromZDist', 'Blur From Z Dist', 0.7, { min: 0.001, softMax: 2, step: 0.001 }, 'Motion Blur'),
			fxParam.angle('blurFromRotate', 'Blur From Rotate', 0, { group: 'Motion Blur' }),
			sNum('blurToZDist', 'Blur To Z Dist', 0.9, { min: 0.001, softMax: 2, step: 0.001 }, 'Motion Blur'),
			fxParam.angle('blurToRotate', 'Blur To Rotate', 0, { group: 'Motion Blur' }),
			check('cameraShake', 'Camera Shake', false),
			sNum('amplitude', 'Amplitude', 2, { min: 0, softMax: 10 }, 'Camera Shake'),
			sNum('frequency', 'Frequency', 2, { min: 0, softMax: 10 }, 'Camera Shake'),
			check('glowBrights', 'Glow Brights', true),
			sNum('glowBrightness', 'Glow Brightness', 3, { min: 0, softMax: 10 }, 'Glow'),
			sNum('glowThreshold', 'Glow Threshold', 0.2, { min: 0, softMax: 1 }, 'Glow'),
			sNum('glowWidth', 'Glow Width', 0, { min: 0, softMax: 1, step: 0.001 }, 'Glow'),
			fxParam.vec2(
				'glowWidthXY',
				'Width X / Y',
				[1, 1],
				{ min: 0, softMax: 4, step: 0.01 },
				{ group: 'Glow' },
			),
			check('warpChroma', 'Warp Chroma', true),
			sNum('warpAmount', 'Warp Amount', 0.6, { min: 0, softMax: 2 }, 'Warp Chroma'),
			sInt('steps', 'Steps', 10, 3, 100, 32, 'Warp Chroma'),
			sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4 }),
			sNum('distortionAmount', 'Distortion Amount', -1, { softMin: -4, softMax: 4 }),
			sNum('distortRgbAmount', 'Distort RGB Amount', 0.2, { softMin: -1, softMax: 1 }),
		],
		gpu: {
			uniforms: (p, ctx) => {
				return { u_hyShake: hyperShake(p, ctx) };
			},
			passes: (p, ctx): ShaderPass[] => {
				const res: ShaderPass = { include: [GLSL_SW], frag: RES_FRAG };
				if (!bool(p.glowBrights, true)) return [res];
				// Glow: bright parts of the result at 1/2, blurred at 1/4 (Width X / Y stretch), added back.
				const xy = Array.isArray(p.glowWidthXY) ? (p.glowWidthXY as number[]) : [1, 1];
				const sigma = (0.012 + 0.08 * Math.max(0, num(p.glowWidth))) * ctx.height;
				const sx = sigma * Math.max(0, num(xy[0], 1));
				const sy = sigma * Math.max(0, num(xy[1], 1));
				const blur = (dir: [number, number], s: number, input: string, output: string): ShaderPass => ({
					output,
					scale: 0.25,
					frag: /* glsl */ `
void main() {
  vec2 texel = 1.0 / vec2(textureSize(u_${input}, 0));
  fragColor = fx_gaussian1d(u_${input}, v_uv, u_hyDir, texel, u_hySigma);
}`,
					include: [GLSL_BLUR],
					uniforms: { u_hyDir: dir, u_hySigma: s * 0.25 },
				});
				return [
					{ ...res, output: 'res' },
					{
						output: 'bright',
						scale: 0.5,
						frag: /* glsl */ `
void main() {
  vec4 c = texture(u_res, v_uv);
  vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  float l = max(rgb.r, max(rgb.g, rgb.b));
  float m = smoothstep(u_glowThreshold, u_glowThreshold + 0.6, l) * clamp(l - u_glowThreshold, 0.0, 1.0);
  fragColor = vec4(rgb * m * c.a, m * c.a);
}`,
					},
					blur([1, 0], sx, 'bright', 'glowH'),
					blur([0, 1], sy, 'glowH', 'glow'),
					{
						include: [GLSL_SW],
						frag: /* glsl */ `
void main() {
  vec4 c = texture(u_res, v_uv);
  float bell = sw_bell(sw_slow(tr_progress(), u_slowIn, u_slowOut));
  vec3 g = texture(u_glow, v_uv).rgb * u_glowBrightness * 0.2 * bell * bell;
  float a = max(c.a, clamp(max(g.r, max(g.g, g.b)), 0.0, 1.0));
  fragColor = vec4(c.rgb + g, a);
}`,
					},
				];
			},
		},
	});
}

export const S_HYPER_PULL = hyperSpec('pull');
export const S_HYPER_PUSH = hyperSpec('push');
