// Card and strip transitions of the family: S_CardFlip (3D cards in perspective with lighting and a drop shadow),
// S_StripSlideTransition (strips sliding off / on one at a time) and S_ParallaxStripsTransition (refracting glass
// strips that grow, carry the dissolve and shrink away).
import { GLSL_HASH } from '../../fx/glsl/hash.ts';
import { GLSL_MB } from '../../fx/glsl/motion-blur.ts';
import { fxParam } from '../../fx/params.ts';
import { defineShaderTransition, SAPPHIRE_TRANSITION_SUBBINS, TRANSITION_BINS } from '../define.ts';
import { GLSL_TR_3D } from '../glsl.ts';
import {
	choice,
	clamp,
	DIRECTION_LABELS,
	DIRECTION_OPTIONS,
	directionVector,
	GLSL_SW,
	num,
	rgbParam,
	sapphireSeed,
	sInt,
	slowParams,
	sNum,
	str,
	wrapParam,
} from './common.ts';

const BIN = TRANSITION_BINS.sapphire;
const OTHER = SAPPHIRE_TRANSITION_SUBBINS.other;

// ---------------------------------------------------------------- S_CardFlip

/** Spin axis (0 vertical, 1 horizontal) and sign of a Spin Direction. */
export function cardSpin(direction: unknown): { axis: number; sign: number } {
	switch (str(direction, 'left')) {
		case 'right':
			return { axis: 0, sign: -1 };
		case 'up':
			return { axis: 1, sign: 1 };
		case 'down':
			return { axis: 1, sign: -1 };
		default:
			return { axis: 0, sign: 1 };
	}
}

/** Total rotation (half turns) of S_CardFlip for Revolutions: 0 = a slide/shuffle, n ≥ 1 = 2n − 1 half turns. */
export function cardHalfTurns(revolutions: unknown): number {
	const r = Math.max(0, Math.round(num(revolutions, 1)));
	return r === 0 ? 0 : 2 * r - 1;
}

export const S_CARD_FLIP = defineShaderTransition({
	id: 'jasper.s.card-flip',
	label: 'S_CardFlip',
	bin: BIN,
	subBin: OTHER,
	description:
		'The clips are two cards in perspective: they flip over (Revolutions) and/or slide apart and back (Shift), the outgoing card revealing the incoming one, with lighting and a drop shadow cast on the back card.',
	keywords: ['card', 'flip', 'spin', 'shuffle', '3d', 'perspective', 'shadow'],
	params: [
		...slowParams(0.5),
		sInt('revolutions', 'Revolutions', 1, 0, 20, 5),
		choice('spinDirection', 'Spin Direction', DIRECTION_OPTIONS, DIRECTION_LABELS, 'left'),
		sNum('shift', 'Shift', 0, { min: 0, softMax: 3 }),
		choice('shiftDirection', 'Shift Direction', DIRECTION_OPTIONS, DIRECTION_LABELS, 'left'),
		sNum('perspective', 'Perspective Amount', 1, { min: 0.25, max: 4 }),
		rgbParam('shadowColor', 'Shadow Color', [0, 0, 0]),
		sNum('shadowOpacity', 'Shadow Opacity', 2, { min: 0, softMax: 4 }),
		sNum('shadowBlur', 'Shadow Blur', 0.088, { min: 0, softMax: 1, step: 0.001 }),
		fxParam.vec2('shadowShift', 'Shadow Shift', [0, 0], { softMin: -1, softMax: 1, step: 0.001 }),
	],
	gpu: {
		uniforms: (p) => {
			const s = cardSpin(p.spinDirection);
			return {
				u_cfAxis: { int: s.axis },
				u_cfSign: s.sign,
				u_cfTurns: cardHalfTurns(p.revolutions),
				u_cfShiftDir: directionVector(p.shiftDirection),
			};
		},
		passes: [
			{
				include: [GLSL_SW, GLSL_TR_3D],
				frag: /* glsl */ `
// Coverage of a card position (0..1 inside) with an antialiased (or soft) edge: w = edge width in card uv.
float cf_cov(vec2 cuv, vec2 w) {
  vec2 e = min(cuv, 1.0 - cuv) / max(w, vec2(1e-5));
  return clamp(min(e.x, e.y) + 0.5, 0.0, 1.0);
}
// Diffuse light of a card at angle a (1 when it faces the camera), dimmer on the back.
float cf_light(float a, float face) {
  float c = abs(cos(a));
  float k = 0.35 + 0.65 * c + 0.25 * pow(max(0.0, sin(a) * u_cfSign), 6.0) * c;   // a glint as it turns
  return face > 0.0 ? k : 0.8 * k;
}
void main() {
  float p = tr_progress();
  float e = sw_slow(p, u_slowIn, u_slowOut);
  float bell = sin(SW_PI * e);
  float th = u_cfSign * SW_PI * u_cfTurns * e;
  float thB = th - u_cfSign * SW_PI * u_cfTurns;
  float dist = 2.0 / clamp(u_perspective, 0.25, 4.0);
  // Depth while apart: the card behind recedes a little (A goes back after the middle, B comes forward).
  float sep = bell * min(u_shift, 1.0);
  float swap = smoothstep(0.35, 0.65, e);
  float scA = 1.0 - sep * (0.04 + 0.08 * swap);
  float scB = 1.0 - sep * (0.04 + 0.08 * (1.0 - swap));
  vec2 off = u_cfShiftDir * u_shift * 0.5 * bell;               // frame extents
  vec3 ca = tr_card(v_uv - off, th, u_cfAxis, dist, scA);
  vec3 cb = tr_card(v_uv + off, thB, u_cfAxis, dist, scB);
  // Antialiasing widths from the card uv derivatives (uniform control flow).
  vec2 wa = fwidth(ca.xy), wb = fwidth(cb.xy);
  float covA = cf_cov(ca.xy, wa), covB = cf_cov(cb.xy, wb);
  vec4 a = tr_from(clamp(ca.xy, 0.0, 1.0)) * covA * cf_light(th, ca.z);
  vec4 b = tr_to(clamp(cb.xy, 0.0, 1.0)) * covB * cf_light(thB, cb.z);
  a.a = covA * tr_from(clamp(ca.xy, 0.0, 1.0)).a;
  b.a = covB * tr_to(clamp(cb.xy, 0.0, 1.0)).a;
  // Stacked cards (no Shift) are glued back to back: a back face is only seen once the cards have slid apart.
  float apart = smoothstep(0.0, 0.05, u_shift * bell);
  if (ca.z < 0.0) a *= apart;
  if (cb.z < 0.0) b *= apart;
  // Which card is in front: a card facing the camera beats one seen from behind (the stacked cards of a flip);
  // otherwise A until the middle, B after (the shuffle).
  bool aFront = ca.z > 0.0 && cb.z < 0.0 ? true : (cb.z > 0.0 && ca.z < 0.0 ? false : e < 0.5);
  vec4 front = aFront ? a : b;
  vec4 back = aFront ? b : a;
  // Drop shadow of the front card on the back card: its silhouette shifted and softened.
  vec2 sOff = sw_sapph(u_shadowShift) / vec2(tr_aspect(), 1.0) + vec2(0.02, 0.03) * u_shift * bell;
  vec3 cs = aFront ? tr_card(v_uv - off - sOff, th, u_cfAxis, dist, scA) : tr_card(v_uv + off - sOff, thB, u_cfAxis, dist, scB);
  // Shadow Blur (fraction of the card width) spreads the silhouette outwards with a soft falloff.
  float soft = max(u_shadowBlur, 1e-3);
  vec2 ins = min(cs.xy, 1.0 - cs.xy) / soft + 1.0;
  float sil = clamp(min(ins.x, ins.y), 0.0, 1.0);
  float shadow = sil * sil * (3.0 - 2.0 * sil) * clamp(u_shadowOpacity * 0.35, 0.0, 1.0) * bell;
  back.rgb = mix(back.rgb, u_shadowColor.rgb * back.a, shadow);
  fragColor = tr_over(front, back);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_StripSlideTransition

export const STRIP_ORDERS = ['topDown', 'bottomUp', 'random', 'centerOut', 'edgesIn'] as const;

/**
 * Timing of one strip (pure; the shader does the same): each strip moves during a window of `min(1, 3 / Speed)` of
 * the transition, the windows start in Order rank, and Slow Start eases the start. 0..1 (1 = arrived / gone).
 */
export function stripProgress(amount: number, rank: number, speed: number, slowStart: number): number {
	const d = Math.min(1, 3 / Math.max(1, speed));
	const start = clamp(rank, 0, 1) * (1 - d);
	const t = clamp((amount - start) / d, 0, 1);
	return t + (t * t - t) * clamp(slowStart, 0, 1);
}

export const S_STRIP_SLIDE_TRANSITION = defineShaderTransition({
	id: 'jasper.s.strip-slide-transition',
	label: 'S_StripSlideTransition',
	bin: BIN,
	subBin: OTHER,
	description:
		'Breaks the picture into strips that slide off one at a time to reveal the incoming clip (or slide the incoming strips on, or side by side), with motion blur.',
	keywords: ['strips', 'slats', 'slide', 'blinds', 'push', 'motion blur'],
	params: [
		choice(
			'style',
			'Style',
			['slideOff', 'slideOn', 'sideBySide'],
			['Slide Off', 'Slide On', 'Side by Side'],
			'slideOff',
		),
		sNum('motionBlur', 'Motion Blur', 0.3, { min: 0, softMax: 3 }),
		sNum('stripSize', 'Strip Size', 0.1, { min: 0.01, softMax: 1 }),
		sNum('randomizeSize', 'Randomize Size', 0, { min: 0, softMax: 1 }),
		fxParam.angle('stripAngle', 'Strip Angle', 0),
		sNum('stripShift', 'Strip Shift', 0, { softMin: -1, softMax: 1 }),
		sNum('speed', 'Speed', 10, { min: 1, softMax: 50 }),
		sNum('slowStart', 'Slow Start', 1, { min: 0, max: 1 }),
		choice(
			'order',
			'Order',
			STRIP_ORDERS,
			['Top Down', 'Bottom Up', 'Random', 'Center Out', 'Edges In'],
			'topDown',
		),
		sapphireSeed(),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_SW, GLSL_HASH, GLSL_MB],
				frag: /* glsl */ `
float ss_edge(int k) { return float(k) + (fx_hash1(k, u_seed) - 0.5) * min(u_randomizeSize, 0.9); }
float ss_progress(float amount, float rank) {
  float d = min(1.0, 3.0 / max(1.0, u_speed));
  float t = clamp((amount - clamp(rank, 0.0, 1.0) * (1.0 - d)) / d, 0.0, 1.0);
  return t + (t * t - t) * clamp(u_slowStart, 0.0, 1.0);
}
void main() {
  float amount = tr_progress();
  vec2 half_ = 0.5 * u_compSize;
  vec2 p = tr_px() - half_;
  float ang = radians(u_stripAngle);
  vec2 along = vec2(cos(ang), sin(ang));
  vec2 across = vec2(-along.y, along.x);
  float size = max(u_stripSize, 0.01) * half_.x;
  float extU = abs(along.x) * half_.x + abs(along.y) * half_.y;
  float extV = abs(across.x) * half_.x + abs(across.y) * half_.y;
  float v = dot(p, across) / size + u_stripShift;
  int k = int(floor(v));
  if (v < ss_edge(k)) k -= 1; else if (v >= ss_edge(k + 1)) k += 1;
  int kMin = int(floor(-extV / size + u_stripShift)) - 1;
  int kMax = int(floor(extV / size + u_stripShift)) + 1;
  float rank = float(k - kMin) / float(max(1, kMax - kMin));
  float mid = (0.5 * (ss_edge(k) + ss_edge(k + 1)) - u_stripShift) * size;
  float dist = abs(mid) / max(extV, 1.0);
  if (u_order == 1) rank = 1.0 - rank;
  else if (u_order == 2) rank = fx_hash1(k, fract(u_seed + 0.5));
  else if (u_order == 3) rank = dist;
  else if (u_order == 4) rank = 1.0 - dist;
  float travel = 2.0 * extU + 2.0;
  float a0 = amount >= 1.0 ? amount : amount - 0.04 * u_motionBlur;
  float t1 = ss_progress(amount, rank);
  float t0 = ss_progress(a0, rank);
  // Motion blur: taps along the strip's real (eased) slide, ≤ 1 px apart (adaptive, ≤ 64, jittered beyond).
  float ext = abs(t1 - t0) * travel;
  int n = ext > 1.5 ? max(2, fx_mbTapCount(ext, 64)) : 1;
  float j = fx_mbJitterFor(ext, n);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < fx_mbDyn(64); i++) {
    if (i >= n) break;
    float t = n == 1 ? t1 : ss_progress(mix(a0, amount, fx_mbTapAt(i, n, j)), rank);
    vec4 c;
    if (u_style == 1) {
      // Slide On: B's strip slides in over A.
      vec4 bs = tr_to(tr_uvOfPx(p + half_ + along * (1.0 - t) * travel));
      c = t >= 1.0 ? bs : tr_over(bs, tr_from(v_uv));   // a landed strip is B alone (transparent B stays so)
    } else if (u_style == 2) {
      // Side by Side: A's strip slides off and B's follows right behind it.
      vec4 as = tr_from(tr_uvOfPx(p + half_ - along * t * travel));
      vec4 bs = tr_to(tr_uvOfPx(p + half_ + along * (1.0 - t) * travel));
      c = tr_over(as, bs);
    } else {
      vec4 as = tr_from(tr_uvOfPx(p + half_ - along * t * travel));
      c = t <= 0.0 ? as : tr_over(as, tr_to(v_uv));      // an unmoved strip is A alone
    }
    acc += c;
  }
  fragColor = acc / float(n);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_ParallaxStripsTransition

/** Growth (0..1) of the strips at eased progress e: up to the middle and back, Slow Grow easing the start. */
export function parallaxGrowth(e: number, slowGrow: number): number {
	return (1 - Math.abs(2 * clamp(e, 0, 1) - 1)) ** (1 + 2 * clamp(slowGrow, 0, 2));
}

export const S_PARALLAX_STRIPS_TRANSITION = defineShaderTransition({
	id: 'jasper.s.parallax-strips-transition',
	expensive: true,
	label: 'S_ParallaxStripsTransition',
	bin: BIN,
	subBin: OTHER,
	description:
		'Refracting 3D glass strips grow over the picture, shift the image inside them and move, while the clips dissolve underneath; then they shrink away.',
	keywords: ['parallax', 'strips', 'glass', 'refraction', 'slices', 'glitch'],
	params: [
		choice(
			'effect',
			'Effect',
			['rectangular', 'linear'],
			['Rectangular Strips', 'Linear Strips'],
			'rectangular',
		),
		sInt('nStrips', 'N Strips', 50, 1, 1000, 200),
		sNum('size', 'Size', 0.35, { min: 0, softMax: 2, step: 0.001 }),
		sNum('relHeight', 'Rel Height', 0.3, { min: 0.001, softMax: 2, step: 0.001 }),
		fxParam.vec2('sizeVary', 'Size Vary', [0.1, 0.1], { min: 0, max: 1, step: 0.01 }),
		fxParam.angle('angle', 'Angle', 0),
		sNum('depth', 'Depth', 2, { min: 0, softMax: 10 }),
		sNum('stripSpeed', 'Strip Speed', 0.4, { softMin: -2, softMax: 2 }),
		sNum('stripSpeedVary', 'Strip Speed Vary', 0, { min: 0, softMax: 2 }),
		sNum('shiftAmount', 'Shift Amount', 0.6, { softMin: -2, softMax: 2 }),
		sNum('shiftVary', 'Shift Vary', 0, { min: 0, softMax: 2 }),
		fxParam.vec2('allStripsShift', 'All Strips Shift', [0, 0], { softMin: -1, softMax: 1, step: 0.001 }),
		sNum('zDist', 'Z Dist', 1, { min: 0.001, softMax: 4 }),
		choice(
			'show',
			'Show',
			['result', 'stripsOverSource', 'stripsOverBlack'],
			['Result', 'Strips Over Source', 'Strips Over Black'],
			'result',
		),
		sNum('slowFade', 'Slow Fade', 0.9, { min: 0, max: 2 }),
		sNum('slowGrow', 'Slow Grow', 0.9, { min: 0, max: 2 }),
		wrapParam('wrap', 'Wrap'),
		sapphireSeed(),
		sNum('dissolveSpeed', 'Dissolve Speed', 3, { min: 1, softMax: 20 }),
	],
	gpu: {
		uniforms: (p, ctx) => ({ u_psGrow: parallaxGrowth(ctx.progress, num(p.slowGrow, 0.9)) }),
		passes: [
			{
				include: [GLSL_SW, GLSL_HASH],
				frag: /* glsl */ `
float ps_next(inout uint st) { st = fx_pcg(st); return float(st >> 8u) * (1.0 / 16777216.0); }
// The underlying dissolve at progress p (Dissolve Speed: the width of the dissolve around the middle).
float ps_mix(float p) {
  float x = clamp((p - 0.5) * max(u_dissolveSpeed, 1.0) + 0.5, 0.0, 1.0);
  float s = clamp(u_slowFade * 0.5, 0.0, 1.0);
  return sw_slow(x, s, s);
}
vec4 ps_src(vec2 f, float m) {
  float z = mix(1.0, max(u_zDist, 1e-3), u_psGrow);
  vec2 uv = sw_uv(f * z);
  return mix(sw_fromW(uv, u_wrap), sw_toW(uv, u_wrap), m);
}
// The front-most strip at f: index (−1 none), depth, distance to its border (frame units), source position.
int ps_front(vec2 f, out float depth, out float edge, out vec2 src) {
  float g = u_psGrow;
  float ang = radians(u_angle);
  vec2 ax = vec2(cos(ang), sin(ang));
  vec2 nx = vec2(-ax.y, ax.x);
  float asp = tr_aspect();
  float extA = abs(ax.x) * asp + abs(ax.y);
  float extN = abs(nx.x) * asp + abs(nx.y);
  vec2 all2 = sw_sapph(u_allStripsShift);
  vec2 q0 = vec2(dot(f - all2, ax), dot(f - all2, nx));
  int best = -1;
  depth = -1.0;
  edge = 1e3;
  src = f;
  int n = int(clamp(floor(u_nStrips + 0.5), 1.0, 1000.0));
  uint seedBits = fx_pcg(fx_seedBits(u_seed));
  float t = u_frame / max(u_fps, 1.0);
  for (int i = 0; i < 1000; i++) {
    if (i >= n) break;
    uint st = fx_pcg(uint(i) * 2654435761u ^ seedBits);
    float z = ps_next(st);
    if (z <= depth) continue;
    float h1 = ps_next(st), h2 = ps_next(st);
    float sc = (1.0 + u_depth * z) / (1.0 + 0.5 * u_depth);
    vec3 v = vec3(ps_next(st), ps_next(st), ps_next(st)) * 2.0 - 1.0;
    float wdt = u_size * asp * sc * max(0.0, 1.0 + u_sizeVary.x * v.x) * g;
    float hgt = u_effect == 1 ? 1e3 : wdt * u_relHeight * max(0.0, 1.0 + u_sizeVary.y * v.y);
    float speed = u_stripSpeed * asp * sc * (1.0 + u_stripSpeedVary * v.z);
    float period = extA + wdt;
    float along = (h1 - 0.5) * period + speed * t;
    along = mod(along + 0.5 * period, period) - 0.5 * period;
    float across = (h2 - 0.5) * (extN + min(hgt, extN));
    vec2 q = q0 - vec2(along, across);
    vec2 inside = vec2(0.5 * wdt, 0.5 * hgt) - abs(q);
    if (inside.x >= 0.0 && inside.y >= 0.0) {
      best = i;
      depth = z;
      edge = min(inside.x, inside.y);
      vec2 r = vec2(ps_next(st), ps_next(st));
      float sgn = r.x < 0.5 ? -1.0 : 1.0;
      src = f + ax * u_shiftAmount * wdt * max(0.0, 1.0 + u_shiftVary * (2.0 * r.y - 1.0)) * sgn;
    }
  }
  return best;
}
void main() {
  float p = tr_progress();
  float m = ps_mix(p);
  vec2 f = sw_f(v_uv);
  vec4 under = u_show == 2 ? vec4(0.0, 0.0, 0.0, 1.0) : ps_src(f, m);
  if (u_psGrow <= 0.0) { fragColor = u_show == 0 ? ps_src(f, m) : under; return; }
  float d, e;
  vec2 s;
  int i = ps_front(f, d, e, s);
  if (i < 0) { fragColor = under; return; }
  vec4 c = u_show == 0 ? ps_src(s, m) : vec4(vec3(0.25 + 0.75 * d), 1.0);
  // Glass edge: a thin bright rim and a 1 px antialiased border.
  float px = 1.0 / u_compSize.y;
  float rim = (1.0 - smoothstep(0.0, 3.0 * px, e)) * 0.12 * u_psGrow;
  c.rgb += rim * c.a;
  fragColor = mix(under, c, clamp(e / px + 0.5, 0.0, 1.0));
}`,
			},
		],
	},
});
