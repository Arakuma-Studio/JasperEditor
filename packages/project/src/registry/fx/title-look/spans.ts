// Spec 19 TL-036: `line` and `glyph` gradient spans. The text layer knows where each glyph rests and where it is drawn at
// this frame; it hands that over as records in a data texture (`FxTextSpans`). A pass finds the glyph that owns each pixel
// (`tlSpan`: the nearest box, as Pachislop's NEAREST_GLYPH_FRAG, with the runner-up and its share so seams antialias), and a
// paint maps the pixel through its owner back to the unanimated layout: the gradient stays on the glyph as it moves, turns
// and scales, because the span boxes are the boxes at rest. Coordinates are layer px, so nothing depends on the resolution.
// Port map: licenses/ported/pachislop-finishes.md.
import { GLSL_DATA } from '../glsl/data.ts';
import { type FxUniformValue, type GlslChunk, hashFloats, type ShaderPass } from '../shader.ts';
import { GLSL_TL_PAINT, GLSL_TL_SURFACE } from './glsl.ts';

/** A box `[x0, y0, x1, y1]` in text box px. */
export type SpanBox = readonly [number, number, number, number];

/** One drawn glyph of a text layer at a frame. */
export type SpanGlyph = {
	/** Ink box at rest, text box px. */
	box: SpanBox;
	line: number;
	/** Rest → drawn, row-major 3×3 homography in text box px (per-character 3D); absent = not moved. */
	toDrawn?: readonly number[];
	/** TL-093: the finish its run gives the letter (`content.runs[].finish`); absent = the look's own. */
	finish?: string;
};

/** `FxTitleLook.textSpans`: what the text layer hands to a look. */
export type FxTextSpans = {
	/** `RECORD_TEXELS` per glyph, then one per line: see `GLSL_TL_SPAN_RECORDS`. */
	texels: Float32Array;
	key: string;
	glyphs: number;
	lines: number;
	/** The text at rest, layer px: the box of a `block` span. */
	block: SpanBox;
	/** TL-093: the finishes runs give letters; a glyph's record holds its slot, 0 = the look's own, k + 1 = `finishes[k]`. */
	finishes: readonly string[];
};

const RECORD_TEXELS = 4;
/** Most glyphs in the records: the owner pass is linear in them, and the data texture must stay bounded. */
export const MAX_SPAN_GLYPHS = 4096;
/** Most distinct run finishes in one text: a slot is a bit of an int mask in `tl_runShare`. More fall back to the look's. */
export const MAX_RUN_FINISHES = 16;

/** The inverse of a row-major 3×3, normalised so the last element is 1, or null when it is singular. */
function invert3(m: readonly number[]): number[] | null {
	const [a, b, c, d, e, f, g, h, i] = m as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	];
	const A = e * i - f * h;
	const B = c * h - b * i;
	const C = b * f - c * e;
	const D = f * g - d * i;
	const E = a * i - c * g;
	const F = c * d - a * f;
	const G = d * h - e * g;
	const H = b * g - a * h;
	const I = a * e - b * d;
	const det = a * A + b * D + c * G;
	if (
		!Number.isFinite(det) ||
		Math.abs(det) < 1e-12 ||
		!Number.isFinite(I) ||
		Math.abs(I) < 1e-12 * Math.abs(det)
	)
		return null;
	const k = 1 / I;
	return [A * k, B * k, C * k, D * k, E * k, F * k, G * k, H * k, 1];
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const finiteBox = (b: SpanBox) => b.every((v) => Number.isFinite(v)) && b[2] >= b[0] && b[3] >= b[1];

/** The records of a text layer's drawn glyphs, or null when nothing can own a pixel. */
export function buildTextSpans(input: readonly SpanGlyph[]): FxTextSpans | null {
	const glyphs: { g: SpanGlyph; inv: number[]; scale: number }[] = [];
	for (const g of input) {
		if (glyphs.length >= MAX_SPAN_GLYPHS) break;
		if (!finiteBox(g.box)) continue;
		const inv = invert3(g.toDrawn ?? IDENTITY);
		// A glyph scaled to nothing owns nothing.
		if (!inv) continue;
		const m = g.toDrawn ?? IDENTITY;
		glyphs.push({ g, inv, scale: Math.sqrt(Math.max(1e-6, Math.abs(m[0]! * m[4]! - m[1]! * m[3]!))) });
	}
	if (glyphs.length === 0) return null;
	const lineIds = [...new Set(glyphs.map((x) => x.g.line))].sort((a, b) => a - b);
	const lineIndex = new Map(lineIds.map((id, i) => [id, i]));
	const lines = lineIds.map(
		() => [Infinity, Infinity, -Infinity, -Infinity] as [number, number, number, number],
	);
	const block: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
	for (const { g } of glyphs)
		for (const box of [lines[lineIndex.get(g.line)!]!, block]) {
			box[0] = Math.min(box[0], g.box[0]);
			box[1] = Math.min(box[1], g.box[1]);
			box[2] = Math.max(box[2], g.box[2]);
			box[3] = Math.max(box[3], g.box[3]);
		}
	const finishes: string[] = [];
	const slotOf = (f: string | undefined) => {
		if (typeof f !== 'string' || f === '') return 0;
		const at = finishes.indexOf(f);
		if (at >= 0) return at + 1;
		if (finishes.length >= MAX_RUN_FINISHES) return 0;
		finishes.push(f);
		return finishes.length;
	};
	const texels = new Float32Array((glyphs.length * RECORD_TEXELS + lines.length) * 4);
	glyphs.forEach(({ g, inv, scale }, i) => {
		const at = i * RECORD_TEXELS * 4;
		texels.set([inv[0]!, inv[1]!, inv[2]!, inv[3]!, inv[4]!, inv[5]!, inv[6]!, inv[7]!], at);
		texels.set(g.box, at + 8);
		texels.set([lineIndex.get(g.line)!, scale, slotOf(g.finish), 0], at + 12);
	});
	lines.forEach((b, i) => {
		texels.set(b, (glyphs.length * RECORD_TEXELS + i) * 4);
	});
	// The slots are numbers in the records: the ids they stand for belong in the key.
	const key = finishes.length ? `${hashFloats(texels)}:${finishes.join(',')}` : hashFloats(texels);
	return { texels, key, glyphs: glyphs.length, lines: lines.length, block, finishes };
}

/**
 * A stored appearance has a gradient paint on an enabled layer, or the text's runs give letters a finish (TL-093), so its
 * text layer should report its glyphs.
 */
export function appearanceWantsTextSpans(
	appearance: unknown,
	runs?: readonly { finish?: string | undefined }[],
): boolean {
	const layers = (appearance as { layers?: unknown } | undefined)?.layers;
	if (!Array.isArray(layers)) return false;
	if (runs?.some((r) => typeof r?.finish === 'string')) return true;
	const gradient = (v: unknown) => (v as { kind?: unknown } | null | undefined)?.kind === 'gradient';
	for (const l of layers as { enabled?: boolean; params?: Record<string, unknown> }[]) {
		if (l?.enabled === false) continue;
		for (const a of Object.values(l?.params ?? {})) {
			const { value, keyframes } = (a ?? {}) as { value?: unknown; keyframes?: { value?: unknown }[] };
			if (gradient(value) || (Array.isArray(keyframes) && keyframes.some((k) => gradient(k?.value))))
				return true;
		}
	}
	return false;
}

/** The look's uniforms of the records (`gpu.uniforms`). */
export function textSpanUniforms(s: FxTextSpans | null | undefined): Record<string, FxUniformValue> {
	if (!s) return {};
	return {
		u_tlSpans: { texels: s.texels, key: s.key },
		u_tlSpanGlyphs: { int: s.glyphs },
		u_tlSpanBlock: s.block as unknown as readonly [number, number, number, number],
	};
}

/**
 * `u_tlSpans`, `RECORD_TEXELS` per glyph: (H00 H01 H02 H10) (H11 H12 H20 H21) (ink box) (line, scale, finish slot),
 * H = drawn → rest.
 */
export const GLSL_TL_SPAN_RECORDS: GlslChunk = {
	name: 'title-look/span-records',
	deps: [GLSL_DATA],
	source: /* glsl */ `
vec2 tl_spanRest(int i, vec2 p) {
  vec4 a = fx_texel(u_tlSpans, i * ${RECORD_TEXELS});
  vec4 b = fx_texel(u_tlSpans, i * ${RECORD_TEXELS} + 1);
  float w = b.z * p.x + b.w * p.y + 1.0;
  return vec2(a.x * p.x + a.y * p.y + a.z, a.w * p.x + b.x * p.y + b.y) / w;
}
`,
};

/** A `block` gradient over the text at rest: a box in a uniform, no owner pass. */
export const GLSL_TL_SPAN_BLOCK: GlslChunk = {
	name: 'title-look/span-block',
	deps: [GLSL_TL_PAINT],
	source: /* glsl */ `
vec2 tl_spanLayerPx(TlSurface s) { return (s.px - u_box.xy) / u_pxScale; }
vec4 tl_spanRamp(highp sampler2D ramp, int kind, vec2 dir, float angle, float depth, TlSurface s) {
  vec2 q = tl_spanLayerPx(s) - (u_tlSpanBlock.xy + u_tlSpanBlock.zw) * 0.5;
  return tl_ramp(ramp, tl_gradientIn(kind, dir, angle, depth, s, q, max(u_tlSpanBlock.zw - u_tlSpanBlock.xy, vec2(1.0))));
}
`,
};

/** `line` and `glyph` gradients through each pixel's owner: `mode` 1 line, 2 glyph. Needs `textSpanPass`. */
export const GLSL_TL_SPAN_OWNED: GlslChunk = {
	name: 'title-look/span-owned',
	deps: [GLSL_TL_SPAN_RECORDS, GLSL_TL_SPAN_BLOCK],
	source: /* glsl */ `
float tl_spanPos(int i, int mode, int kind, vec2 dir, float angle, float depth, TlSurface s, vec2 p) {
  vec4 box = mode == 2
    ? fx_texel(u_tlSpans, i * ${RECORD_TEXELS} + 2)
    : fx_texel(u_tlSpans, u_tlSpanGlyphs * ${RECORD_TEXELS} + int(fx_texel(u_tlSpans, i * ${RECORD_TEXELS} + 3).x));
  return tl_gradientIn(kind, dir, angle, depth, s, tl_spanRest(i, p) - (box.xy + box.zw) * 0.5, max(box.zw - box.xy, vec2(1.0)));
}
vec4 tl_spanRamp(highp sampler2D ramp, int mode, int kind, vec2 dir, float angle, float depth, TlSurface s) {
  ivec2 size = textureSize(u_tlSpan, 0);
  vec4 o = texelFetch(u_tlSpan, clamp(ivec2(s.uv * vec2(size)), ivec2(0), size - 1), 0);
  vec2 p = tl_spanLayerPx(s);
  vec4 c = tl_ramp(ramp, tl_spanPos(int(o.x), mode, kind, dir, angle, depth, s, p));
  if (o.z <= 0.0) return c;
  return mix(c, tl_ramp(ramp, tl_spanPos(int(o.y), mode, kind, dir, angle, depth, s, p)), o.z);
}
`,
};

/** Who owns each pixel: (nearest glyph, runner-up, the runner-up's share of this pixel at a seam). */
export function textSpanPass(): ShaderPass {
	return {
		output: 'tlSpan',
		format: 'rgba32f',
		filter: 'nearest',
		include: [GLSL_TL_SPAN_RECORDS],
		frag: /* glsl */ `
void main() {
  vec2 p = (v_uv * u_canvasSize - u_box.xy) / u_pxScale;
  float best = 1.0e18;
  float next = 1.0e18;
  int a = 0;
  int b = -1;
  for (int i = 0; i < u_tlSpanGlyphs; i++) {
    vec2 q = tl_spanRest(i, p);
    vec4 box = fx_texel(u_tlSpans, i * ${RECORD_TEXELS} + 2);
    vec2 o = abs(q - (box.xy + box.zw) * 0.5) - (box.zw - box.xy) * 0.5;
    // Signed distance to the box, layer px: inside two overlapping boxes the seam runs between them too.
    float d = (length(max(o, 0.0)) + min(max(o.x, o.y), 0.0)) * fx_texel(u_tlSpans, i * ${RECORD_TEXELS} + 3).y;
    if (d < best) { next = best; b = a; best = d; a = i; }
    else if (d < next) { next = d; b = i; }
  }
  // Both distances change by a pixel per pixel across the seam, in opposite directions.
  float share = b < 0 ? 0.0 : clamp(0.5 - (next - best) * 0.5 * u_pxScale, 0.0, 0.5);
  fragColor = vec4(float(a), float(max(b, 0)), share, 1.0);
}`,
	};
}

/**
 * TL-093: how much of this pixel belongs to letters whose run finish slot is in `mask` (bit k: slot k), from the owner
 * pass: its owner's share, and at a seam between two letters the runner-up's. Needs `textSpanPass`.
 */
export const GLSL_TL_SPAN_FINISH: GlslChunk = {
	name: 'title-look/span-finish',
	deps: [GLSL_TL_SPAN_RECORDS, GLSL_TL_SURFACE],
	source: /* glsl */ `
float tl_runShare(TlSurface s, int mask) {
  ivec2 size = textureSize(u_tlSpan, 0);
  vec4 o = texelFetch(u_tlSpan, clamp(ivec2(s.uv * vec2(size)), ivec2(0), size - 1), 0);
  int a = int(fx_texel(u_tlSpans, int(o.x) * ${RECORD_TEXELS} + 3).z + 0.5);
  int b = int(fx_texel(u_tlSpans, int(o.y) * ${RECORD_TEXELS} + 3).z + 0.5);
  return (((mask >> a) & 1) == 1 ? 1.0 - o.z : 0.0) + (((mask >> b) & 1) == 1 ? o.z : 0.0);
}
`,
};
