// Matte and keying tools (parity workstream `roto`), ported from EffectCraft `crates/effects/src/keylight.rs`,
// `matte.rs` and `keying.rs` (MIT OR Apache-2.0, licenses/ported/roto.md) to GLSL:
//
// - Screen Keyer (`jasper.screen-keyer`): a full screen-colour keyer with the controls of After Effects' bundled
//   "Keylight (1.2)" (the name is a trademark of its vendor; this is the textbook *screen difference* key written from
//   the public description of the controls): Screen Gain / Balance, Despill / Alpha Bias, Screen Pre-blur, Clip
//   Black / White / Rollback, Shrink/Grow, Softness, Despot Black / White, Replace Method, Inside / Outside masks
//   (roto objects of the clip), foreground and edge colour correction, Source Crops and the 11 views.
// - Refine Soft Matte / Refine Hard Matte (After Effects): edge-aware refinement of an existing alpha (luma-guided
//   filter in the edge band, He et al. 2010), Smooth, Feather, Contrast / Choke, Shift Edge, Reduce Chatter and Motion
//   Blur over neighbouring frames, edge colour decontamination.
// - Key Cleaner (After Effects): edge colour restoration and alpha contrast after a key.
// - Advanced Spill Suppressor (After Effects): Standard (dominant screen primary detected over the frame) and Ultra
//   (key colour, Tolerance, Desaturate, Spill Range, Spill Color Correction, Luma Correction).
//
// Reduce Chatter / Motion Blur of the Refine mattes read the neighbouring frames through the framework's time samples,
// which are the clip's source pictures before any effect (fx-shader-framework §9): they act on the source's own alpha
// (alpha-channel footage). Colours are display-referred straight RGB 0..1 (as the rest of the fx catalogue).
import type { EffectParams, EffectSpec } from '../effects.ts';
import { defineShaderEffect } from './define.ts';
import { GLSL_BLUR } from './glsl/blur.ts';
import { GLSL_COLOR } from './glsl/color.ts';
import { blurPasses, GLSL_OBJECT_MATTE, morphPasses } from './matte-ops.ts';
import { fxParam } from './params.ts';
import type { GlslChunk, ShaderPass } from './shader.ts';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d = false) => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const col = (v: unknown, d: [number, number, number]): [number, number, number] =>
	Array.isArray(v) && v.length >= 3 ? [num(v[0]), num(v[1]), num(v[2])] : d;
const luma709 = (c: readonly number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

/** Index of the screen's primary channel and the two others (larger-in-screen first). */
export function screenPrimary(s: readonly number[]): [number, number, number] {
	const pi = s[1]! >= s[0]! && s[1]! >= s[2]! ? 1 : s[2]! >= s[0]! ? 2 : 0;
	const [a, b] = pi === 0 ? [1, 2] : pi === 1 ? [0, 2] : [0, 1];
	return s[a]! >= s[b]! ? [pi, a, b] : [pi, b, a];
}

/** Channels scaled so `bias` becomes neutral. */
export function neutralise(c: readonly number[], bias: readonly number[]): [number, number, number] {
	const l = Math.max(1e-4, luma709(bias));
	return [0, 1, 2].map((i) => (c[i]! * l) / Math.max(1e-4, bias[i]!)) as [number, number, number];
}

/** Screen difference: primary minus the balance-weighted secondaries. */
export function screenDiff(c: readonly number[], p: readonly number[], bal: number): number {
	return c[p[0]!]! - (bal * c[p[1]!]! + (1 - bal) * c[p[2]!]!);
}

/** HSL (h 0..1, s, l) → RGB. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const f = (t0: number) => {
		const t = t0 - Math.floor(t0);
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};
	return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

/** Tint offset of a Colour Balance wheel (hue in degrees, saturation 0..100). */
export function balanceTint(hueDeg: number, satPct: number): [number, number, number] {
	const s = satPct / 100;
	if (s <= 0) return [0, 0, 0];
	const h = (((hueDeg / 360) % 1) + 1) % 1;
	const [r, g, b] = hslToRgb(h, 1, 0.5);
	const l = luma709([r, g, b]);
	return [(r - l) * s * 0.5, (g - l) * s * 0.5, (b - l) * s * 0.5];
}

// ---------------------------------------------------------------- Screen Keyer

const KL_VIEWS = [
	'source',
	'sourceAlpha',
	'correctedSource',
	'colourCorrectionEdges',
	'screenMatte',
	'insideMask',
	'outsideMask',
	'combinedMatte',
	'status',
	'intermediateResult',
	'finalResult',
] as const;
const KL_VIEW_LABELS = [
	'Source',
	'Source Alpha',
	'Corrected Source',
	'Colour Correction Edges',
	'Screen Matte',
	'Inside Mask',
	'Outside Mask',
	'Combined Matte',
	'Status',
	'Intermediate Result',
	'Final Result',
];
const REPLACE = ['none', 'source', 'hardColour', 'softColour'] as const;
const REPLACE_LABELS = ['None', 'Source', 'Hard Colour', 'Soft Colour'];
const SUPPRESS = ['none', 'red', 'green', 'blue', 'cyan', 'magenta', 'yellow'] as const;
const SUPPRESS_LABELS = ['None', 'Red', 'Green', 'Blue', 'Cyan', 'Magenta', 'Yellow'];
const CROP_METHODS = ['colour', 'repeat', 'reflect', 'wrap'] as const;
const CROP_LABELS = ['Colour', 'Repeat', 'Reflect', 'Wrap'];

const G_SM = 'Screen Matte';
const G_IN = 'Inside Mask';
const G_OUT = 'Outside Mask';
const G_FG = 'Foreground Colour Correction';
const G_EDGE = 'Edge Colour Correction';
const G_CROP = 'Source Crops';

const pct = (name: string, label: string, def: number, group: string) =>
	fxParam.percent(name, label, def, { group });
const pxp = (name: string, label: string, def: number, max: number, group?: string) =>
	fxParam.pixels(name, label, def, max, group ? { group } : undefined);
const bip = (name: string, label: string, group: string) =>
	fxParam.number(
		name,
		label,
		0,
		{ min: -100, max: 100, step: 0.1 },
		{ group, ui: { control: 'slider', bipolar: true } },
	);

/** Shared GLSL of the screen keyer. */
const GLSL_KEYLIGHT: GlslChunk = {
	name: 'roto/keylight',
	deps: [GLSL_COLOR],
	source: /* glsl */ `
vec3 kl_neutralise(vec3 c, vec3 bias) {
  float l = max(fx_luma(bias), 1.0e-4);
  return c * l / max(bias, vec3(1.0e-4));
}
float kl_diff(vec3 c) {
  return c[u_klPrim.x] - (u_klBal * c[u_klPrim.y] + (1.0 - u_klBal) * c[u_klPrim.z]);
}
vec3 kl_correct(vec3 c, float sat, float con, float bri) {
  float l = fx_luma(c);
  c = vec3(l) + (c - vec3(l)) * sat;
  return ((c - 0.5) * con + 0.5) * bri;
}
// Colour Suppression: kind 1..3 = R, G, B (excess over the balance-weighted others); 4..6 = C, M, Y.
vec3 kl_suppress(vec3 c, int kind, float bal, float amt) {
  if (kind == 0 || amt <= 0.0) return c;
  if (kind <= 3) {
    int k = kind - 1;
    int a = (k + 1) - 3 * ((k + 1) / 3);
    int b = (k + 2) - 3 * ((k + 2) / 3);
    float limit = c[a] * bal + c[b] * (1.0 - bal);
    c[k] -= max(c[k] - limit, 0.0) * amt;
    return c;
  }
  int third = kind == 4 ? 0 : kind == 5 ? 1 : 2;
  int a = (third + 1) - 3 * ((third + 1) / 3);
  int b = (third + 2) - 3 * ((third + 2) / 3);
  float excess = max(min(c[a], c[b]) - c[third], 0.0) * amt;
  c[a] -= excess;
  c[b] -= excess;
  return c;
}
vec3 kl_balance(vec3 c, vec3 tint) { return all(equal(tint, vec3(0.0))) ? c : max(c + tint, vec3(0.0)); }
`,
};

/** Fold of a coordinate into [lo, hi) by a crop method; -1e9 = outside with Colour. */
const GLSL_KL_CROP = /* glsl */ `
float kl_fold(float v, float lo, float hi, int m) {
  float span = max(hi - lo, 1.0);
  if (v >= lo && v < hi) return v;
  if (m == 1) return clamp(v, lo, hi - 0.5);
  if (m == 2) { float t = mod(v - lo, 2.0 * span); return lo + (t >= span ? 2.0 * span - t - 0.5 : t); }
  if (m == 3) return lo + mod(v - lo, span);
  return -1.0e9;
}
`;

export const SCREEN_KEYER = defineShaderEffect({
	id: 'jasper.screen-keyer',
	label: 'Screen Keyer',
	category: 'Keying',
	description:
		'A complete screen-colour keyer (screen difference) with the controls of After Effects’ Keylight: Screen Gain / Balance, biases, clip black / white / rollback, despot, shrink / grow, softness, replace methods, inside / outside masks from roto objects, foreground and edge colour correction, source crops and 11 views.',
	keywords: [
		'keylight',
		'key light',
		'green screen',
		'blue screen',
		'chroma key',
		'screen matte',
		'despill',
		'keyer',
	],
	params: [
		fxParam.choice('view', 'View', KL_VIEWS, KL_VIEW_LABELS, 'finalResult'),
		fxParam.toggle('unpremultiplyResult', 'Unpremultiply Result', true),
		fxParam.color('screenColour', 'Screen Colour', [0, 1, 0, 1]),
		fxParam.number('screenGain', 'Screen Gain', 100, { min: 0, max: 200, step: 0.1 }, { unit: '%' }),
		fxParam.number('screenBalance', 'Screen Balance', 50, { min: 0, max: 100, step: 0.1 }, { unit: '%' }),
		fxParam.color('despillBias', 'Despill Bias', [0.5, 0.5, 0.5, 1]),
		fxParam.color('alphaBias', 'Alpha Bias', [0.5, 0.5, 0.5, 1]),
		fxParam.toggle('lockBiasesTogether', 'Lock Biases Together', true),
		pxp('screenPreblur', 'Screen Pre-blur', 0, 10),
		pct('clipBlack', 'Clip Black', 0, G_SM),
		pct('clipWhite', 'Clip White', 100, G_SM),
		pxp('clipRollback', 'Clip Rollback', 0, 20, G_SM),
		fxParam.number(
			'screenShrinkGrow',
			'Screen Shrink/Grow',
			0,
			{ min: -100, max: 100, softMin: -10, softMax: 10, step: 0.1 },
			{
				unit: 'px',
				group: G_SM,
			},
		),
		pxp('screenSoftness', 'Screen Softness', 0, 20, G_SM),
		pxp('screenDespotBlack', 'Screen Despot Black', 0, 20, G_SM),
		pxp('screenDespotWhite', 'Screen Despot White', 0, 20, G_SM),
		fxParam.choice('replaceMethod', 'Replace Method', REPLACE, REPLACE_LABELS, 'softColour', { group: G_SM }),
		fxParam.color('replaceColour', 'Replace Colour', [0.5, 0.5, 0.5, 1], { group: G_SM }),
		fxParam.object('insideObject', 'Inside Mask', { group: G_IN }),
		pxp('insideMaskSoftness', 'Inside Mask Softness', 0, 20, G_IN),
		fxParam.toggle('invertInsideMask', 'Invert', false, { group: G_IN }),
		fxParam.choice('insideReplaceMethod', 'Replace Method', REPLACE, REPLACE_LABELS, 'source', {
			group: G_IN,
		}),
		fxParam.color('insideReplaceColour', 'Replace Colour', [0.5, 0.5, 0.5, 1], { group: G_IN }),
		fxParam.choice(
			'sourceAlpha',
			'Source Alpha',
			['ignore', 'addToInsideMask', 'normal'],
			['Ignore', 'Add to Inside Mask', 'Normal'],
			'normal',
			{
				group: G_IN,
			},
		),
		fxParam.object('outsideObject', 'Outside Mask', { group: G_OUT }),
		pxp('outsideMaskSoftness', 'Outside Mask Softness', 0, 20, G_OUT),
		fxParam.toggle('invertOutsideMask', 'Invert', false, { group: G_OUT }),
		fxParam.toggle('enableColourCorrection', 'Enable Colour Correction', false, { group: G_FG }),
		fxParam.number(
			'saturation',
			'Saturation',
			100,
			{ min: 0, max: 400, softMax: 200, step: 0.1 },
			{ unit: '%', group: G_FG },
		),
		bip('contrast', 'Contrast', G_FG),
		bip('brightness', 'Brightness', G_FG),
		fxParam.choice('colourSuppression', 'Colour Suppression', SUPPRESS, SUPPRESS_LABELS, 'none', {
			group: G_FG,
		}),
		pct('suppressionBalance', 'Suppression Balance', 50, G_FG),
		pct('suppressionAmount', 'Suppression Amount', 0, G_FG),
		fxParam.angle('colourBalanceHue', 'Colour Balance Hue', 0, { group: G_FG }),
		pct('colourBalanceSaturation', 'Colour Balance Saturation', 0, G_FG),
		fxParam.toggle('enableEdgeColourCorrection', 'Enable Edge Colour Correction', false, { group: G_EDGE }),
		pct('edgeHardness', 'Edge Hardness', 0, G_EDGE),
		pxp('edgeSoftness', 'Edge Softness', 0, 20, G_EDGE),
		pxp('edgeGrow', 'Edge Grow', 1, 20, G_EDGE),
		fxParam.number(
			'edgeSaturation',
			'Saturation',
			100,
			{ min: 0, max: 400, softMax: 200, step: 0.1 },
			{ unit: '%', group: G_EDGE },
		),
		bip('edgeContrast', 'Contrast', G_EDGE),
		bip('edgeBrightness', 'Brightness', G_EDGE),
		fxParam.choice('edgeColourSuppression', 'Colour Suppression', SUPPRESS, SUPPRESS_LABELS, 'none', {
			group: G_EDGE,
		}),
		pct('edgeSuppressionBalance', 'Suppression Balance', 50, G_EDGE),
		pct('edgeSuppressionAmount', 'Suppression Amount', 0, G_EDGE),
		fxParam.angle('edgeColourBalanceHue', 'Colour Balance Hue', 0, { group: G_EDGE }),
		pct('edgeColourBalanceSaturation', 'Colour Balance Saturation', 0, G_EDGE),
		fxParam.choice('xMethod', 'X Method', CROP_METHODS, CROP_LABELS, 'colour', { group: G_CROP }),
		fxParam.choice('yMethod', 'Y Method', CROP_METHODS, CROP_LABELS, 'colour', { group: G_CROP }),
		fxParam.color('edgeColour', 'Edge Colour', [0, 0, 0, 1], { group: G_CROP }),
		pct('edgeColourAlpha', 'Edge Colour Alpha', 0, G_CROP),
		pct('cropLeft', 'Left', 0, G_CROP),
		pct('cropRight', 'Right', 0, G_CROP),
		pct('cropTop', 'Top', 0, G_CROP),
		pct('cropBottom', 'Bottom', 0, G_CROP),
	],
	gpu: {
		mattes: [
			{ name: 'inMatte', param: 'insideObject' },
			{ name: 'outMatte', param: 'outsideObject' },
		],
		uniforms: (p: EffectParams) => {
			const screen = col(p.screenColour, [0, 1, 0]);
			const prim = screenPrimary(screen);
			const dbias = col(p.despillBias, [0.5, 0.5, 0.5]);
			const abias = bool(p.lockBiasesTogether, true) ? dbias : col(p.alphaBias, [0.5, 0.5, 0.5]);
			const bal = num(p.screenBalance, 50) / 100;
			const sd = Math.max(1e-3, screenDiff(neutralise(screen, abias), prim, bal));
			const l0 = Math.max(1e-4, luma709(dbias) / Math.max(1e-4, dbias[prim[0]]!));
			return {
				u_klPrim: { ivec3: prim },
				u_klBal: bal,
				u_klSd: sd,
				u_klL0: l0,
				u_klAbias: abias,
				u_klDbias: dbias,
				u_klFgTint: balanceTint(num(p.colourBalanceHue), num(p.colourBalanceSaturation)),
				u_klEdgeTint: balanceTint(num(p.edgeColourBalanceHue), num(p.edgeColourBalanceSaturation)),
			};
		},
		passes: (p: EffectParams, ctx) => {
			const s = ctx.pxScale;
			const preblur = Math.max(0, num(p.screenPreblur)) * s;
			const rollback = Math.max(0, num(p.clipRollback)) * s;
			const despotB = Math.max(0, num(p.screenDespotBlack)) * s;
			const despotW = Math.max(0, num(p.screenDespotWhite)) * s;
			const sg = num(p.screenShrinkGrow) * s;
			const soft = Math.max(0, num(p.screenSoftness)) * s;
			const inSoft = Math.max(0, num(p.insideMaskSoftness)) * s;
			const outSoft = Math.max(0, num(p.outsideMaskSoftness)) * s;
			const edges = bool(p.enableEdgeColourCorrection);
			const keySrc = preblur > 0 ? 'kKey' : 'kSrc';
			const copy = (from: string, to: string, chan = 'r'): ShaderPass => ({
				output: to,
				frag: `void main() { float v = texture(u_${from}, v_uv).${chan}; fragColor = vec4(v, v, v, 1.0); }`,
			});
			const objPass = (name: string, matte: string): ShaderPass => ({
				output: name,
				include: [GLSL_OBJECT_MATTE],
				frag: /* glsl */ `
void main() {
  float m = abs(u_${matte}_state - 1.0) < 0.5 ? om_sample(u_${matte}, u_${matte}_size, fx_layerNorm()) : 0.0;
  fragColor = vec4(m, m, m, 1.0);
}`,
			});
			return [
				// Source Crops: borders take the Edge Colour or repeat / reflect / wrap the kept picture.
				{
					output: 'kSrc',
					frag: /* glsl */ `
${GLSL_KL_CROP}
void main() {
  vec2 lp = v_uv * u_canvasSize;
  float lx0 = u_box.x + u_cropLeft / 100.0 * u_box.z;
  float lx1 = u_box.x + (1.0 - u_cropRight / 100.0) * u_box.z;
  float ly0 = u_box.y + u_cropTop / 100.0 * u_box.w;
  float ly1 = u_box.y + (1.0 - u_cropBottom / 100.0) * u_box.w;
  bool none = u_cropLeft <= 0.0 && u_cropRight <= 0.0 && u_cropTop <= 0.0 && u_cropBottom <= 0.0;
  if (none || (u_xMethod == 0 && u_yMethod == 0 && u_edgeColourAlpha <= 0.0)) { fragColor = texture(u_source, v_uv); return; }
  float fx = kl_fold(lp.x, lx0, lx1, u_xMethod);
  float fy = kl_fold(lp.y, ly0, ly1, u_yMethod);
  if (fx < -1.0e8 || fy < -1.0e8) { float a = u_edgeColourAlpha / 100.0; fragColor = vec4(u_edgeColour.rgb * a, a); return; }
  fragColor = texture(u_source, vec2(fx, fy) / u_canvasSize);
}`,
				},
				...(preblur > 0
					? [
							{ output: 'kKey', frag: 'void main() { fragColor = texture(u_kSrc, v_uv); }' } as ShaderPass,
							...blurPasses('kKey', preblur * 0.5),
						]
					: []),
				// Raw screen matte (opacity of the foreground) and its clipped version.
				{
					output: 'kRaw',
					include: [GLSL_KEYLIGHT],
					frag: /* glsl */ `
void main() {
  vec4 px = texture(u_${keySrc}, v_uv);
  vec3 c = px.a > 0.0 ? px.rgb / px.a : vec3(0.0);
  float d = kl_diff(kl_neutralise(c, u_klAbias));
  float raw = clamp(1.0 - (u_screenGain / 100.0) * d / u_klSd, 0.0, 1.0);
  float cb = u_clipBlack / 100.0;
  float cw = u_clipWhite / 100.0;
  float clipped = clamp((raw - cb) / max(cw - cb, 1.0e-4), 0.0, 1.0);
  fragColor = vec4(raw, clipped, 0.0, 1.0);
}`,
				},
				copy('kRaw', 'kM', 'g'),
				...(rollback > 0
					? [
							copy('kM', 'kGrow'),
							...morphPasses('kGrow', rollback),
							copy('kM', 'kShr'),
							...morphPasses('kShr', -rollback),
							{
								output: 'kM',
								update: true,
								frag: /* glsl */ `
void main() {
  float m = texture(u_kM, v_uv).r;
  float g = texture(u_kGrow, v_uv).r;
  float s = texture(u_kShr, v_uv).r;
  float raw = texture(u_kRaw, v_uv).r;
  float v = g > s + 1.0e-4 ? min(max(m, raw), g) : m;
  fragColor = vec4(v, v, v, 1.0);
}`,
							} as ShaderPass,
						]
					: []),
				...(despotB > 0 ? [...morphPasses('kM', despotB), ...morphPasses('kM', -despotB)] : []),
				...(despotW > 0 ? [...morphPasses('kM', -despotW), ...morphPasses('kM', despotW)] : []),
				...morphPasses('kM', sg),
				...blurPasses('kM', soft * 0.5),
				objPass('kIn', 'inMatte'),
				...blurPasses('kIn', inSoft * 0.5),
				objPass('kOut', 'outMatte'),
				...blurPasses('kOut', outSoft * 0.5),
				// Combined matte: screen matte ∪ inside mask (∪ source alpha), minus the outside mask (× source alpha).
				{
					output: 'kComb',
					frag: /* glsl */ `
void main() {
  float a = texture(u_kM, v_uv).r;
  float sa = clamp(texture(u_kSrc, v_uv).a, 0.0, 1.0);
  bool hasIn = abs(u_inMatte_state - 1.0) < 0.5;
  bool hasOut = abs(u_outMatte_state - 1.0) < 0.5;
  float ins = hasIn ? texture(u_kIn, v_uv).r : 0.0;
  if (hasIn && u_invertInsideMask) ins = 1.0 - ins;
  if (u_sourceAlpha == 1) ins = max(ins, sa);
  a = max(a, ins);
  if (hasOut) { float o = texture(u_kOut, v_uv).r; if (u_invertOutsideMask) o = 1.0 - o; a *= 1.0 - o; }
  if (u_sourceAlpha == 2) a *= sa;
  a = clamp(a, 0.0, 1.0);
  fragColor = vec4(a, a, a, 1.0);
}`,
				},
				...(edges
					? [
							{
								output: 'kEdge',
								frag: `void main() { float a = texture(u_kComb, v_uv).r; float b = a > 1.0e-3 && a < 0.999 ? 1.0 : 0.0; fragColor = vec4(b, b, b, 1.0); }`,
							} as ShaderPass,
							...morphPasses('kEdge', Math.max(0, num(p.edgeGrow, 1)) * s),
							...blurPasses('kEdge', Math.max(0, num(p.edgeSoftness)) * s * 0.5),
						]
					: []),
				{
					include: [GLSL_KEYLIGHT],
					frag: /* glsl */ `
vec3 kl_replace(vec3 fg, vec3 c, int method, vec3 rc, float amt) {
  if (amt <= 0.0) return fg;
  if (method == 1) return fg + (c - fg) * amt;
  if (method == 2) return rc;
  if (method == 3) { float l = fx_luma(c) / max(fx_luma(rc), 1.0e-4); return fg + (rc * l - fg) * amt; }
  return fg;
}
vec4 kl_grey(float v) { return fx_inBox(v_uv) ? vec4(v, v, v, 1.0) : vec4(0.0); }
void main() {
  vec4 src = texture(u_kSrc, v_uv);
  if (u_view == 0) { fragColor = texture(u_source, v_uv); return; }
  vec3 c = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
  float a = texture(u_kComb, v_uv).r;
  float sm = texture(u_kM, v_uv).r;
  float raw = texture(u_kRaw, v_uv).r;
  bool hasIn = abs(u_inMatte_state - 1.0) < 0.5;
  bool hasOut = abs(u_outMatte_state - 1.0) < 0.5;
  float ins = hasIn ? texture(u_kIn, v_uv).r : 0.0;
  if (hasIn && u_invertInsideMask) ins = 1.0 - ins;
  float outs = hasOut ? texture(u_kOut, v_uv).r : 0.0;
  if (hasOut && u_invertOutsideMask) outs = 1.0 - outs;
  // Screen removal on the raw transparency, then despill.
  float ar = max(raw, 1.0e-4);
  vec3 fg = max((c - (1.0 - ar) * u_screenColour.rgb) / ar, vec3(0.0));
  float spill = max(kl_diff(kl_neutralise(fg, u_klDbias)), 0.0);
  fg[u_klPrim.x] -= spill / u_klL0;
  vec3 intermediate = fg;
  // Replace colour where the alpha was raised beyond the raw screen matte.
  fg = kl_replace(fg, c, u_replaceMethod, u_replaceColour.rgb, max(sm - raw, 0.0));
  fg = kl_replace(fg, c, u_insideReplaceMethod, u_insideReplaceColour.rgb, hasIn ? max(ins - sm, 0.0) : 0.0);
  if (u_enableColourCorrection)
    fg = kl_balance(kl_suppress(kl_correct(fg, u_saturation / 100.0, u_contrast / 100.0 + 1.0, u_brightness / 100.0 + 1.0),
      u_colourSuppression, u_suppressionBalance / 100.0, u_suppressionAmount / 100.0), u_klFgTint);
  float edge = 0.0;
${
	edges
		? `  edge = min(texture(u_kEdge, v_uv).r * (1.0 + u_edgeHardness / 100.0 * 4.0), 1.0);
  if (edge > 0.0) {
    vec3 ce = kl_balance(kl_suppress(kl_correct(fg, u_edgeSaturation / 100.0, u_edgeContrast / 100.0 + 1.0, u_edgeBrightness / 100.0 + 1.0),
      u_edgeColourSuppression, u_edgeSuppressionBalance / 100.0, u_edgeSuppressionAmount / 100.0), u_klEdgeTint);
    fg += (ce - fg) * edge;
  }`
		: ''
}
  if (u_view == 1) { fragColor = kl_grey(src.a); return; }
  if (u_view == 2) {
    vec3 cs = kl_neutralise(c, u_klDbias);
    cs[u_klPrim.x] -= max(kl_diff(cs), 0.0);
    if (u_enableColourCorrection) cs = kl_correct(cs, u_saturation / 100.0, u_contrast / 100.0 + 1.0, u_brightness / 100.0 + 1.0);
    fragColor = fx_inBox(v_uv) ? vec4(cs, 1.0) : vec4(0.0);
    return;
  }
  if (u_view == 3) { fragColor = kl_grey(edge); return; }
  if (u_view == 4) { fragColor = kl_grey(sm); return; }
  if (u_view == 5) { fragColor = kl_grey(ins); return; }
  if (u_view == 6) { fragColor = kl_grey(outs); return; }
  if (u_view == 7) { fragColor = kl_grey(a); return; }
  if (u_view == 8) { fragColor = kl_grey(a <= 1.0e-3 ? 0.0 : a >= 0.999 ? 1.0 : 0.5); return; }
  if (u_view == 9) { fragColor = vec4(intermediate * sm, sm); return; }
  vec2 lp = (v_uv * u_canvasSize - u_box.xy) / u_box.zw;
  bool cropped = (lp.x < u_cropLeft / 100.0 || lp.x > 1.0 - u_cropRight / 100.0 || lp.y < u_cropTop / 100.0 ||
    lp.y > 1.0 - u_cropBottom / 100.0) && u_edgeColourAlpha <= 0.0 && u_xMethod == 0 && u_yMethod == 0;
  if (cropped) { fragColor = vec4(0.0); return; }
  // Keylight's output is premultiplied; "Unpremultiply Result" off = that premultiplied colour read as straight.
  fragColor = u_unpremultiplyResult ? vec4(fg * a, a) : vec4(fg * a * a, a);
}`,
				},
			];
		},
	},
});

// ---------------------------------------------------------------- Refine Soft / Hard Matte

const G_MB = 'Motion Blur';
const G_DECON = 'Decontamination';

function refineParams(hard: boolean) {
	const temporal = [
		pct('reduceChatter', 'Reduce Chatter', 0, 'Matte'),
		fxParam.toggle('useMotionBlur', 'Use Motion Blur', false, { group: G_MB }),
		fxParam.number(
			'motionBlurSamples',
			'Motion Blur Samples',
			16,
			{ min: 1, max: 64, step: 1 },
			{ group: G_MB },
		),
		fxParam.number(
			'shutterAngle',
			'Shutter Angle',
			180,
			{ min: 0, max: 720, softMax: 360, step: 1 },
			{ unit: 'deg', group: G_MB },
		),
		fxParam.toggle('higherQuality', 'Higher Quality', false, { group: G_MB }),
	];
	const decon = [
		fxParam.toggle('decontaminate', 'Decontaminate Edge Colors', true, { group: G_DECON }),
		pct('decontaminationAmount', 'Decontamination Amount', 100, G_DECON),
		fxParam.toggle('extendWhereSmoothed', 'Extend Where Smoothed', true, { group: G_DECON }),
		pxp('increaseDecontaminationRadius', 'Increase Decontamination Radius', 0, 20, G_DECON),
		fxParam.toggle('viewDecontaminationMap', 'View Decontamination Map', false, { group: G_DECON }),
	];
	const radius = (d: number) =>
		fxParam.number(
			'radius',
			'Additional Edge Radius',
			d,
			{ min: 1, max: 200, softMax: 50, step: 0.1 },
			{ unit: 'px' },
		);
	if (!hard)
		return [
			fxParam.toggle('calculateEdgeDetails', 'Calculate Edge Details', true),
			radius(10),
			fxParam.toggle('viewEdgeRegion', 'View Edge Region', false),
			pct('smooth', 'Smooth', 0, 'Matte'),
			pct('feather', 'Feather', 10, 'Matte'),
			pct('contrast', 'Contrast', 0, 'Matte'),
			fxParam.number(
				'shiftEdge',
				'Shift Edge',
				0,
				{ min: -100, max: 100, step: 0.1 },
				{
					unit: '%',
					group: 'Matte',
					ui: { control: 'slider', bipolar: true },
				},
			),
			...temporal,
			...decon,
			fxParam.toggle('invert', 'Invert', false),
		];
	return [
		pct('smooth', 'Smooth', 20, 'Matte'),
		pct('feather', 'Feather', 0, 'Matte'),
		fxParam.number(
			'choke',
			'Choke',
			0,
			{ min: -100, max: 100, step: 0.1 },
			{
				unit: '%',
				group: 'Matte',
				ui: { control: 'slider', bipolar: true },
			},
		),
		...temporal,
		...decon,
		radius(3),
		fxParam.number(
			'alphaContrast',
			'Alpha Contrast',
			300,
			{ min: 100, max: 1000, softMax: 500, step: 1 },
			{ unit: '%' },
		),
		fxParam.toggle('invert', 'Invert', false),
	];
}

/** Time sample offsets of the Refine mattes (neighbours for Reduce Chatter, the shutter for Motion Blur). */
export function refineSampleOffsets(p: EffectParams): number[] {
	const out = new Set<number>();
	if (num(p.reduceChatter) > 0) {
		out.add(-1);
		out.add(1);
	}
	if (bool(p.useMotionBlur) && num(p.shutterAngle, 180) > 0) {
		const half = Math.min(2, Math.ceil(num(p.shutterAngle, 180) / 360 / 2 + 1e-9));
		for (let k = 1; k <= half; k++) {
			out.add(-k);
			out.add(k);
		}
	}
	return [...out].sort((a, b) => a - b).slice(0, 8);
}

function refineEffect(hard: boolean): EffectSpec {
	return defineShaderEffect({
		id: hard ? 'jasper.refine-hard-matte' : 'jasper.refine-soft-matte',
		label: hard ? 'Refine Hard Matte' : 'Refine Soft Matte',
		category: 'Keying',
		description: hard
			? 'Cleans a hard-edged matte: smooths and chokes its edge, follows image edges in the edge band (guided filter), reduces chatter, adds motion blur and decontaminates edge colours.'
			: 'Refines a soft matte for hair and fine detail: edge-aware matting in a band around the edge (guided filter), smooth, feather, contrast, shift edge, reduce chatter, motion blur and edge colour decontamination.',
		keywords: ['refine edge', 'matte', 'hair', 'choke', 'decontaminate', 'chatter', 'roto', 'key'],
		params: refineParams(hard),
		gpu: {
			time: {
				samples: (p) => refineSampleOffsets(p),
				sampleEdge: 'clamp',
			},
			passes: (p: EffectParams, ctx) => {
				const s = ctx.pxScale;
				const r = Math.max(1, Math.round(Math.max(1, num(p.radius, hard ? 3 : 10)) * s));
				const smooth = num(p.smooth, hard ? 20 : 0) / 100;
				const edgeDetails = hard || bool(p.calculateEdgeDetails, true);
				const featherPx = (num(p.feather, hard ? 0 : 10) / 100) * r * 0.5;
				const eps = 1e-4 + smooth * smooth * 0.05;
				const decon = bool(p.decontaminate, true) && num(p.decontaminationAmount, 100) > 0;
				const deconR = r + Math.max(0, num(p.increaseDecontaminationRadius)) * s;
				const box = (name: string): ShaderPass[] =>
					[0, 1].map((axis) => ({
						output: name,
						update: true,
						format: 'rgba16f',
						include: [GLSL_BLUR],
						frag: `void main() { fragColor = fx_box1d(u_${name}, v_uv, u_rDir, u_texel, u_rR); }`,
						uniforms: { u_rDir: axis === 0 ? [1, 0] : [0, 1], u_rR: r },
					}));
				return [
					{
						output: 'rHi',
						frag: 'void main() { float a = texture(u_source, v_uv).a; fragColor = vec4(a, a, a, 1.0); }',
					},
					...morphPasses('rHi', r),
					{
						output: 'rLo',
						frag: 'void main() { float a = texture(u_source, v_uv).a; fragColor = vec4(a, a, a, 1.0); }',
					},
					...morphPasses('rLo', -r),
					...(edgeDetails
						? [
								{
									output: 'rM',
									format: 'rgba16f',
									include: [GLSL_COLOR],
									frag: /* glsl */ `
void main() {
  vec4 px = texture(u_source, v_uv);
  float I = fx_luma(px.rgb);
  float a = px.a;
  fragColor = vec4(I, a, I * a, I * I);
}`,
								} as ShaderPass,
								...box('rM'),
								{
									output: 'rAB',
									format: 'rgba16f',
									frag: /* glsl */ `
void main() {
  vec4 m = texture(u_rM, v_uv);
  float va = m.w - m.x * m.x;
  float cv = m.z - m.x * m.y;
  float A = cv / (va + u_rEps);
  fragColor = vec4(A, m.y - A * m.x, 0.0, 1.0);
}`,
									uniforms: { u_rEps: eps },
								} as ShaderPass,
								...box('rAB'),
							]
						: []),
					{
						output: 'rQ',
						include: [GLSL_COLOR],
						frag: edgeDetails
							? /* glsl */ `
void main() {
  vec4 px = texture(u_source, v_uv);
  float band = texture(u_rHi, v_uv).r - texture(u_rLo, v_uv).r;
  vec2 ab = texture(u_rAB, v_uv).xy;
  float q = band > 1.0e-3 ? clamp(ab.x * fx_luma(px.rgb) + ab.y, 0.0, 1.0) : px.a;
  fragColor = vec4(q, q, q, 1.0);
}`
							: 'void main() { float a = texture(u_source, v_uv).a; fragColor = vec4(a, a, a, 1.0); }',
					},
					...(!edgeDetails ? blurPasses('rQ', smooth * r * 0.5) : []),
					...blurPasses('rQ', featherPx),
					...(decon
						? [
								{
									output: 'rEst',
									scale: 0.5,
									frag: 'void main() { fragColor = texture(u_source, v_uv); }',
								} as ShaderPass,
								...blurPasses('rEst', deconR * 0.25, 0.5),
							]
						: []),
					{
						include: [GLSL_BLUR],
						frag: /* glsl */ `
float rf_shape(float v) {
  float choke = clamp(${hard ? 'u_choke' : '-u_shiftEdge'}, -100.0, 100.0) / 100.0 * 0.5;
  if (choke > 0.0) v = (v - choke) / (1.0 - choke);
  else if (choke < 0.0) v = v / (1.0 + choke);
  float contrast = ${hard ? 'u_alphaContrast / 100.0' : '1.0 + max(u_contrast, 0.0) / 100.0 * 3.0'};
  if (abs(contrast - 1.0) > 1.0e-6) v = (v - 0.5) * contrast + 0.5;
  v = clamp(v, 0.0, 1.0);
  return u_invert ? 1.0 - v : v;
}
// A neighbouring frame's alpha through the same (pointwise) shaping (the guided filter only runs on this frame).
float rf_sampleAlpha(int i) { return rf_shape(fx_sample(i, v_uv).a); }
void main() {
  vec4 src = texture(u_source, v_uv);
  float na = rf_shape(texture(u_rQ, v_uv).r);
  // Reduce Chatter: where the previous and next frames agree but this one differs, average the three.
  float chatter = clamp(u_reduceChatter / 100.0, 0.0, 1.0);
  if (chatter > 0.0 && u_sampleCount > 0) {
    float pa = -1.0; float pn = -1.0;
    for (int i = 0; i < 8; i++) {
      if (i >= u_sampleCount) break;
      if (u_sampleOffsets[i] == -1.0) pa = rf_sampleAlpha(i);
      if (u_sampleOffsets[i] == 1.0) pn = rf_sampleAlpha(i);
    }
    if (pa >= 0.0 && pn >= 0.0) {
      float steady = clamp(1.0 - abs(pa - pn) / 0.5, 0.0, 1.0);
      na += ((pa + na + pn) / 3.0 - na) * chatter * steady;
    }
  }
  // Motion blur: the matte averaged over the shutter (neighbouring frames within it, linearly weighted by overlap).
  if (u_useMotionBlur && u_shutterAngle > 0.0 && u_sampleCount > 0) {
    float hs = u_shutterAngle / 360.0 / 2.0;
    float acc = na;
    float wsum = 1.0;
    for (int i = 0; i < 8; i++) {
      if (i >= u_sampleCount) break;
      float o = abs(u_sampleOffsets[i]);
      float w = clamp(hs - o + 1.0, 0.0, 1.0) * (o <= hs + 1.0 ? 1.0 : 0.0);
      if (w <= 0.0) continue;
      acc += rf_sampleAlpha(i) * w;
      wsum += w;
    }
    na = acc / wsum;
  }
  if (${hard ? 'false' : 'u_viewEdgeRegion'}) {
    float band = texture(u_rHi, v_uv).r - texture(u_rLo, v_uv).r;
    fragColor = fx_inBox(v_uv) ? (band > 1.0e-3 ? vec4(0.5 + 0.5 * na, 0.5 * na, 0.5 * na, 1.0) : vec4(na, na, na, 1.0)) : vec4(0.0);
    return;
  }
  float a0 = src.a;
  bool partial0 = a0 > 1.0e-4 && a0 < 0.999;
  bool partialN = na > 1.0e-4 && na < 0.999;
  float t = partial0 ? 1.0 - a0 : (u_extendWhereSmoothed && partialN ? 1.0 - na : 0.0);
  t *= u_decontaminationAmount / 100.0;
  if (u_viewDecontaminationMap) { float v = u_decontaminate ? t : 0.0; fragColor = fx_inBox(v_uv) ? vec4(v, v, v, 1.0) : vec4(0.0); return; }
  vec3 c = a0 > 1.0e-4 ? src.rgb / a0 : vec3(0.0);
${
	decon
		? `  if (t > 0.0 && a0 > 1.0e-4) {
    vec4 e = texture(u_rEst, v_uv);
    if (e.a > 1.0e-4) c += (e.rgb / e.a - c) * t;
  }`
		: ''
}
  fragColor = vec4(c * na, na);
}`,
					},
				];
			},
		},
	});
}

export const REFINE_SOFT_MATTE = refineEffect(false);
export const REFINE_HARD_MATTE = refineEffect(true);

// ---------------------------------------------------------------- Key Cleaner

export const KEY_CLEANER = defineShaderEffect({
	id: 'jasper.key-cleaner',
	label: 'Key Cleaner',
	category: 'Keying',
	description:
		'Restores detail and colour at the edges of a keyed matte: edge colours are pulled towards the nearby foreground, chatter is reduced and the alpha contrast raised.',
	keywords: ['key cleaner', 'edge', 'matte', 'chatter', 'keylight', 'clean'],
	params: [
		fxParam.number(
			'additionalEdgeRadius',
			'Additional Edge Radius',
			3,
			{ min: 0, max: 100, softMax: 20, step: 0.1 },
			{ unit: 'px' },
		),
		fxParam.toggle('reduceChatter', 'Reduce Chatter', false),
		fxParam.number(
			'alphaContrast',
			'Alpha Contrast',
			100,
			{ min: 100, max: 500, softMax: 300, step: 1 },
			{ unit: '%' },
		),
		fxParam.percent('strength', 'Strength', 100),
	],
	gpu: {
		passes: (p: EffectParams, ctx) => {
			const r = Math.max(0, num(p.additionalEdgeRadius, 3)) * ctx.pxScale;
			const est = r > 0 && num(p.strength, 100) > 0;
			return [
				{
					output: 'kcA',
					frag: 'void main() { float a = texture(u_source, v_uv).a; fragColor = vec4(a, a, a, 1.0); }',
				},
				...(bool(p.reduceChatter) ? blurPasses('kcA', 1) : []),
				...(est
					? [
							{ output: 'kcEst', frag: 'void main() { fragColor = texture(u_source, v_uv); }' } as ShaderPass,
							...blurPasses('kcEst', r * 0.5),
						]
					: []),
				{
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  float a0 = src.a;
  vec3 c = a0 > 1.0e-4 ? src.rgb / a0 : vec3(0.0);
  float na = texture(u_kcA, v_uv).r;
  if (u_reduceChatter) na = clamp((na - 0.5) * 1.5 + 0.5, 0.0, 1.0);
${
	est
		? `  if (a0 > 1.0e-4 && a0 < 0.999) {
    vec4 e = texture(u_kcEst, v_uv);
    if (e.a > 1.0e-4) c += (e.rgb / e.a - c) * (u_strength / 100.0) * (1.0 - a0);
  }`
		: ''
}
  na = clamp((na - 0.5) * (u_alphaContrast / 100.0) + 0.5, 0.0, 1.0);
  if (a0 <= 1.0e-6) na = 0.0;
  fragColor = vec4(c * na, na);
}`,
				},
			];
		},
	},
});

// ---------------------------------------------------------------- Advanced Spill Suppressor

/** Grid of the Standard method's dominant-primary statistics. */
const SPILL_GRID = 48;

export const ADVANCED_SPILL_SUPPRESSOR = defineShaderEffect({
	id: 'jasper.advanced-spill-suppressor',
	label: 'Advanced Spill Suppressor',
	category: 'Keying',
	description:
		'Removes coloured spill from a keyed subject. Standard detects the screen primary over the frame; Ultra uses the key colour with Tolerance, Desaturate, Spill Range, Spill Color Correction and Luma Correction.',
	keywords: ['spill', 'despill', 'green screen', 'blue screen', 'suppress', 'keying'],
	params: [
		fxParam.choice('method', 'Method', ['standard', 'ultra'], ['Standard', 'Ultra'], 'standard'),
		fxParam.number(
			'suppression',
			'Suppression',
			100,
			{ min: 0, max: 200, softMax: 100, step: 0.1 },
			{ unit: '%' },
		),
		fxParam.color('keyColor', 'Key Color', [0, 1, 0, 1], { group: 'Ultra Settings' }),
		fxParam.percent('tolerance', 'Tolerance', 50, { group: 'Ultra Settings' }),
		fxParam.percent('desaturate', 'Desaturate', 0, { group: 'Ultra Settings' }),
		fxParam.percent('spillRange', 'Spill Range', 50, { group: 'Ultra Settings' }),
		fxParam.percent('spillColorCorrection', 'Spill Color Correction', 0, { group: 'Ultra Settings' }),
		fxParam.percent('lumaCorrection', 'Luma Correction', 0, { group: 'Ultra Settings' }),
	],
	gpu: {
		uniforms: (p: EffectParams) => {
			const key = col(p.keyColor, [0, 1, 0]);
			const mx = Math.max(...key);
			const mn = Math.min(...key);
			let hue = 0;
			if (mx - mn > 1e-6) {
				const d = mx - mn;
				hue =
					mx === key[0]
						? (key[1] - key[2]) / d + (key[1] < key[2] ? 6 : 0)
						: mx === key[1]
							? (key[2] - key[0]) / d + 2
							: (key[0] - key[1]) / d + 4;
				hue /= 6;
			}
			return { u_asKeyPrim: { int: screenPrimary(key)[0] }, u_asKeyHue: hue };
		},
		passes: (p: EffectParams) => {
			const ultra = str(p.method, 'standard') === 'ultra';
			return [
				...(ultra
					? []
					: [
							{
								output: 'asStat',
								size: { width: 1, height: 1 },
								format: 'rgba16f',
								filter: 'nearest',
								frag: /* glsl */ `
void main() {
  vec3 ex = vec3(0.0);
  for (int j = 0; j < ${SPILL_GRID}; j++)
    for (int i = 0; i < ${SPILL_GRID}; i++) {
      vec4 px = texture(u_source, (vec2(float(i), float(j)) + 0.5) / ${SPILL_GRID}.0);
      vec3 c = px.a > 0.0 ? px.rgb / px.a : vec3(0.0);
      ex += vec3(max(c.r - max(c.g, c.b), 0.0), max(c.g - max(c.r, c.b), 0.0), max(c.b - max(c.r, c.g), 0.0)) * px.a;
    }
  fragColor = vec4(ex / float(${SPILL_GRID * SPILL_GRID}), 1.0);
}`,
							} as ShaderPass,
						]),
				{
					include: [GLSL_COLOR],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  if (src.a <= 0.0) { fragColor = src; return; }
  vec3 c = src.rgb / src.a;
  int pi;
  float tol = 1.0;
  float desat = 0.0;
  float neutral = 0.0;
  if (u_method == 1) {
    pi = u_asKeyPrim;
    tol = u_tolerance / 100.0;
    desat = u_desaturate / 100.0;
    neutral = u_spillColorCorrection / 100.0;
  } else {
${ultra ? '    pi = u_asKeyPrim;' : '    vec3 ex = texelFetch(u_asStat, ivec2(0, 0), 0).rgb;\n    pi = ex.g >= ex.r && ex.g >= ex.b ? 1 : ex.b >= ex.r ? 2 : 0;'}
  }
  int o1 = pi == 0 ? 1 : 0;
  int o2 = pi == 2 ? 1 : 2;
  float w = 1.0;
  if (tol < 1.0) {
    float h = fx_rgb2hsl(c).x;
    float d = abs(h - u_asKeyHue);
    d = min(d, 1.0 - d);
    w = clamp(1.0 - d / max(tol * 0.5, 1.0e-4), 0.0, 1.0);
  }
  float mx = max(c[o1], c[o2]);
  float avg = 0.5 * (c[o1] + c[o2]);
  float limit = mx + (avg - mx) * (u_method == 1 ? u_spillRange / 100.0 : 0.5);
  float spill = max(c[pi] - limit, 0.0) * (u_suppression / 100.0) * w;
  c[pi] -= spill;
  vec3 L = vec3(0.2126, 0.7152, 0.0722);
  float back = spill * L[pi] * (u_method == 1 ? u_lumaCorrection / 100.0 : 0.0) + spill * neutral / 3.0;
  c += vec3(back);
  if (desat > 0.0 && spill > 0.0) {
    float l = fx_luma(c);
    float k = min(desat * min(spill * 4.0, 1.0), 1.0);
    c += (vec3(l) - c) * k;
  }
  fragColor = vec4(c * src.a, src.a);
}`,
				},
			];
		},
	},
});

export const KEYING_MATTE_EFFECTS: readonly EffectSpec[] = [
	SCREEN_KEYER,
	REFINE_SOFT_MATTE,
	REFINE_HARD_MATTE,
	KEY_CLEANER,
	ADVANCED_SPILL_SUPPRESSOR,
];
