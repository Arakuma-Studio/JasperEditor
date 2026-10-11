// Family-private helpers of the Sapphire "swish + other" transitions (../sapphire-swish-other.ts): param readers and
// builders with Sapphire's names/defaults, the pure TS maths behind `gpu.uniforms` (Slow In/Out, whip curves,
// shutter length per frame, camera shake), and the family's GLSL chunk `sw/core` (prefix `sw_`).
//
// Conventions of this family (documented in the authoring guide's terms):
// - "Sapphire units" for shifts and sizes: 1 = HALF the frame width, the same unit on both axes (Sapphire's screen
//   coordinates, so Sapphire's numeric defaults keep their meaning: WhipLash Shift −4 = two frame widths). The
//   editor's axes are kept: x right, y DOWN. Angles are degrees, clockwise on screen (editor convention; Sapphire's
//   Rotate is counter-clockwise).
// - Centres are frame-normalised points (`fxParam.point`, on-canvas handle); Sapphire's centred defaults are
//   converted with `sapphirePoint`.
// - Motion blur is a shutter in PROGRESS space: `u_frameStep` is the progress change per frame of the span, and a
//   blur of B frames samples the move over [p − B·step/2, p + B·step/2], shrunk near the ends so progress 0 is
//   exactly A and 1 exactly B. Tap counts follow the on-screen extent (≤ 1.5 px apart, stratified jitter beyond).
import type { ParamValue } from '../../../schema/common.ts';
import type { EffectParams, ParamSpec } from '../../effects.ts';
import { GLSL_HASH } from '../../fx/glsl/hash.ts';
import { fxParam, seedParam } from '../../fx/params.ts';
import type { GlslChunk } from '../../fx/shader.ts';
import { booleanParam as bool, clamp, numberParam as num, stringParam as str } from '../../param-values.ts';
import { GLSL_TRANSITION } from '../glsl.ts';
import type { TrFrameContext } from '../shader.ts';

export const vec2 = (v: ParamValue | undefined, d: [number, number]): [number, number] =>
	Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number'
		? [v[0], v[1]]
		: d;

type Range = NonNullable<ParamSpec['range']>;

/** A keyframable Sapphire slider. */
export function sNum(name: string, label: string, def: number, range: Range = {}, group?: string): ParamSpec {
	return fxParam.number(name, label, def, { step: 0.01, ...range }, group ? { group } : undefined);
}

export function sInt(
	name: string,
	label: string,
	def: number,
	min: number,
	max?: number,
	softMax?: number,
	group?: string,
): ParamSpec {
	return fxParam.number(
		name,
		label,
		def,
		{ min, ...(max !== undefined ? { max } : {}), ...(softMax !== undefined ? { softMax } : {}), step: 1 },
		group ? { group } : undefined,
	);
}

/** A checkbox (hold-only). */
export const check = (name: string, label: string, def: boolean, group?: string) =>
	fxParam.toggle(name, label, def, group ? { group } : undefined);

/** A colour (straight RGB, alpha 1). */
export const rgbParam = (name: string, label: string, c: [number, number, number], group?: string) =>
	fxParam.color(name, label, [c[0], c[1], c[2], 1], group ? { group } : undefined);

/** A popup (hold-only). */
export const choice = (
	name: string,
	label: string,
	options: readonly string[],
	labels: readonly string[],
	def: string,
	group?: string,
) => fxParam.choice(name, label, options, labels, def, group ? { group } : undefined);

/** Sapphire's Slow In / Slow Out pair (0..1, default 0.5 each). */
export function slowParams(def = 0.5, defOut = def): ParamSpec[] {
	return [
		sNum('slowIn', 'Slow In', def, { min: 0, max: 1 }),
		sNum('slowOut', 'Slow Out', defOut, { min: 0, max: 1 }),
	];
}

/** Sapphire's Seed (0.123 default), mixed into `u_seed` by the framework. */
export function sapphireSeed(): ParamSpec {
	return { ...seedParam(0.123), range: { min: 0, softMax: 10, step: 0.001 } };
}

/** Sapphire centred coordinates (x −1..1 over the width, y UP in the same unit) → a frame-normalised point. */
export function sapphirePoint(x: number, y: number, aspect = 16 / 9): [number, number] {
	const r = (v: number) => Math.round(v * 10000) / 10000;
	return [r(0.5 + x / 2), r(0.5 - (y * aspect) / 2)];
}

/** Sapphire wrap popups (`sw_wrapUv` modes). */
export const WRAP_OPTIONS = ['no', 'tile', 'reflect'] as const;
export const WRAP_LABELS = ['No', 'Tile', 'Reflect'] as const;
export const wrapParam = (name: string, label: string, def: (typeof WRAP_OPTIONS)[number] = 'reflect') =>
	choice(name, label, WRAP_OPTIONS, WRAP_LABELS, def);

/** Sapphire's Edge Mode popup (Transparent / Repeat / Reflect) — the same modes as the wraps. */
export const edgeModeParam = (name = 'edgeMode', label = 'Edge Mode') =>
	choice(name, label, WRAP_OPTIONS, ['Transparent', 'Repeat', 'Reflect'], 'reflect');

/** Whip Out popups (`sw_whip` styles). */
export const WHIP_OPTIONS = ['smooth', 'bounce', 'snap'] as const;
export const whipParam = (name: string, label: string) =>
	choice(name, label, WHIP_OPTIONS, ['Smooth', 'Bounce', 'Snap'], 'smooth');

/** Sapphire's four-way direction popups → unit vectors on screen (y down). */
export const DIRECTION_OPTIONS = ['left', 'right', 'up', 'down'] as const;
export const DIRECTION_LABELS = ['Left', 'Right', 'Up', 'Down'] as const;
const DIRS: Record<string, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
export const directionVector = (v: ParamValue | undefined, def = 'left'): [number, number] =>
	DIRS[str(v, def)] ?? DIRS[def]!;

/**
 * Sapphire Slow In / Slow Out: a cubic Hermite from 0 to 1 whose end tangents are 1 − slowIn and 1 − slowOut
 * (0, 0 = linear; 1, 1 = smoothstep). Monotonic for every setting; exactly 0 and 1 at the ends.
 */
export function sapphireSlow(t: number, slowIn: number, slowOut: number): number {
	const x = clamp(t, 0, 1);
	const m0 = 1 - clamp(slowIn, 0, 1);
	const m1 = 1 - clamp(slowOut, 0, 1);
	const x2 = x * x;
	const x3 = x2 * x;
	return (x3 - 2 * x2 + x) * m0 + (-2 * x3 + 3 * x2) + (x3 - x2) * m1;
}

/**
 * The whip curve of WhipLash / MochaWhip (0 → 1 over the transition, 0.5 at the cut in the middle): an accelerating
 * whip into the cut, then the Whip Out: Smooth (decelerates), Bounce (overshoots and settles, damped), Snap (keeps
 * its speed and stops dead). Velocity is continuous through the cut (3 per unit of progress).
 */
export function whipCurve(e: number, style: string): number {
	const x = clamp(e, 0, 1);
	if (x <= 0.5) return 0.5 * (2 * x) ** 3;
	const u = 2 * x - 1;
	if (style === 'snap') return Math.min(1, 0.5 + 1.5 * u);
	if (style === 'bounce') {
		const w = 3 * Math.PI;
		return 1 - 0.5 * (1 - u) ** 2 * (Math.cos(w * u) - Math.sin(w * u) / w);
	}
	return 1 - 0.5 * (1 - u) ** 3;
}

/**
 * Progress change per frame of the span (the shutter unit of the motion blurs): the framework's linear ramp step —
 * `1 / (d + 1)` two-sided, `1 / d` at a single clip edge — scaled by Start/End %.
 */
export function frameStep(
	p: EffectParams,
	ctx: Pick<TrFrameContext, 'duration' | 'hasFrom' | 'hasTo'>,
): number {
	const d = Math.max(1, ctx.duration);
	const linear = ctx.hasFrom && ctx.hasTo ? 1 / (d + 1) : 1 / d;
	const span = Math.abs(clamp(num(p.endPercent, 100), 0, 100) - clamp(num(p.startPercent, 0), 0, 100)) / 100;
	return linear * span;
}

/** Deterministic 0..1 hash of (seed, n) for TS-side randomness (no Math.random). */
export function hash01(seed: number, n: number): number {
	let h = (Math.floor(seed * 4294967295) ^ Math.imul(n + 0x9e3779b9, 0x85ebca6b)) >>> 0;
	h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
	h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
	h = (h ^ (h >>> 16)) >>> 0;
	return h / 4294967296;
}

/** Smooth 1-D value noise (−1..1, C1) of x for a stream: Catmull-Rom through seeded knots. */
export function smoothNoise(seed: number, stream: number, x: number): number {
	const i = Math.floor(x);
	const t = x - i;
	const k = (n: number) => 2 * hash01(seed, n * 131 + stream * 7919) - 1;
	const p0 = k(i - 1);
	const p1 = k(i);
	const p2 = k(i + 1);
	const p3 = k(i + 2);
	return (
		0.5 *
		(2 * p1 +
			(-p0 + p2) * t +
			(2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
			(-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)
	);
}

/**
 * Camera shake offset (frame heights, y down) at time t seconds: smooth noise at `frequency` Hz plus a jumpy
 * component (random held targets) — Amplitude, Frequency, Jumpiness as in Sapphire's shakes.
 */
export function shakeOffset(
	seed: number,
	t: number,
	o: { amplitude: number; frequency: number; jumpiness?: number; random?: number },
): [number, number] {
	const f = Math.max(0, o.frequency);
	const j = Math.max(0, o.jumpiness ?? 0);
	const r = Math.max(0, o.random ?? 0);
	const axis = (s: number) => {
		const smooth = smoothNoise(seed, s, t * f * 3);
		const seg = Math.floor(t * f * 2);
		const jump = j > 0 ? (2 * hash01(seed, seg * 17 + s * 101) - 1) * j * 0.5 : 0;
		const fine = r > 0 ? (2 * hash01(seed, Math.floor(t * 60) * 31 + s) - 1) * r : 0;
		return smooth + jump + fine;
	};
	const a = Math.max(0, o.amplitude) * 0.01;
	return [axis(1) * a, axis(2) * a];
}

/**
 * `sw/core`: Slow In/Out, bells, wraps, frame units, shutters and the whip curve (mirrors of the TS above).
 * Frame units ("f"): centred, y down, 1 = the frame HEIGHT (x spans ±aspect/2). Sapphire units (1 = half the
 * width) → f: × aspect / 2 (`sw_sapph`).
 */
export const GLSL_SW: GlslChunk = {
	name: 'sapphire-swish-other/core',
	deps: [GLSL_TRANSITION, GLSL_HASH],
	source: /* glsl */ `
const float SW_PI = 3.14159265358979;
float sw_slow(float t, float slowIn, float slowOut) {
  float x = clamp(t, 0.0, 1.0);
  float m0 = 1.0 - clamp(slowIn, 0.0, 1.0), m1 = 1.0 - clamp(slowOut, 0.0, 1.0);
  float x2 = x * x, x3 = x2 * x;
  return (x3 - 2.0 * x2 + x) * m0 + (-2.0 * x3 + 3.0 * x2) + (x3 - x2) * m1;
}
// 0 at both ends, 1 in the middle.
float sw_bell(float e) { return sin(SW_PI * clamp(e, 0.0, 1.0)); }
float sw_lstep(float a, float b, float x) { return clamp((x - a) / max(b - a, 1e-6), 0.0, 1.0); }
// Wrap modes: 0 No (transparent outside), 1 Tile, 2 Reflect.
vec2 sw_wrapUv(vec2 uv, int mode) {
  if (mode == 1) return fract(uv);
  if (mode == 2) return 1.0 - abs(1.0 - mod(uv, 2.0));
  return uv;
}
vec4 sw_fromW(vec2 uv, int mode) { return tr_from(sw_wrapUv(uv, mode)); }
vec4 sw_toW(vec2 uv, int mode) { return tr_to(sw_wrapUv(uv, mode)); }
// uv ↔ frame units (centred, y down, frame height = 1).
vec2 sw_f(vec2 uv) { return (uv - 0.5) * vec2(tr_aspect(), 1.0); }
vec2 sw_uv(vec2 f) { return f / vec2(tr_aspect(), 1.0) + 0.5; }
// Sapphire units (1 = half the frame width) → frame units.
vec2 sw_sapph(vec2 s) { return s * 0.5 * tr_aspect(); }
mat2 sw_rot(float deg) { float a = radians(deg); float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
// Taps for an on-screen blur extent (px): ≤ 1.5 px apart, at most maxN.
int sw_taps(float extentPx, int maxN) { return int(clamp(ceil(extentPx / 1.5), 1.0, float(maxN))); }
// Per-pixel stratified jitter (0..1) for sparse taps.
float sw_jitter() { return fx_hash2(ivec2(floor(tr_px())), 0.5); }
// Tap i of n over [lo, hi] (centred in its stratum, jittered when the strata are wider than 1.5 px).
float sw_tapAt(int i, int n, float lo, float hi, float jitter) {
  return mix(lo, hi, (float(i) + jitter) / float(n));
}
// The whip curve (see whipCurve in common.ts): style 0 Smooth, 1 Bounce, 2 Snap.
float sw_whip(float e, int style) {
  float x = clamp(e, 0.0, 1.0);
  if (x <= 0.5) { float y = 2.0 * x; return 0.5 * y * y * y; }
  float u = 2.0 * x - 1.0;
  if (style == 2) return min(1.0, 0.5 + 1.5 * u);
  if (style == 1) {
    float w = 3.0 * SW_PI;
    return 1.0 - 0.5 * (1.0 - u) * (1.0 - u) * (cos(w * u) - sin(w * u) / w);
  }
  float v = 1.0 - u;
  return 1.0 - 0.5 * v * v * v;
}
// Premultiplied screen (where only one side is present it is that side).
vec4 sw_screen(vec4 a, vec4 b) { return a + b - a * b; }
// Spectral weights (Color1 → Color2 → Color3 Bernstein basis) of tap t in 0..1.
vec3 sw_spectrum(float t, vec3 c1, vec3 c2, vec3 c3) {
  return c1 * (1.0 - t) * (1.0 - t) + c2 * 2.0 * t * (1.0 - t) + c3 * t * t;
}
`,
};

/**
 * `sw/shutter`: the motion-blur shutter (needs the `u_frameStep` uniform: spread `shutterUniforms` into
 * `gpu.uniforms`).
 */
export const GLSL_SW_SHUTTER: GlslChunk = {
	name: 'sapphire-swish-other/shutter',
	deps: [GLSL_SW],
	source: /* glsl */ `
// Half width of the shutter window around progress p (blurFrames frames of u_frameStep), shrunk at the ends so that
// progress 0 / 1 sample only themselves.
float sw_shutter(float p, float blurFrames) {
  return max(0.0, min(0.5 * max(blurFrames, 0.0) * u_frameStep, min(p, 1.0 - p)));
}
`,
};

/** The shutter uniform every motion-blurred transition of the family declares. */
export function shutterUniforms(p: EffectParams, ctx: TrFrameContext) {
	return { u_frameStep: frameStep(p, ctx) };
}

export { bool, clamp, num, str };
