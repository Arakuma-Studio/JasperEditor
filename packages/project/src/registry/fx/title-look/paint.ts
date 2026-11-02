// Spec 19 TL-011 / TL-032: paints as uniforms and GLSL. Palette colours are stored as the signal (sRGB-encoded, straight)
// and enter a look linearised and premultiplied. Gradients are baked into a 256-entry ramp: one program for every stop
// count, no uniform budget, role colours may animate. Stops interpolate in the signal, as design tools do (a black to
// white ramp reads even), and each ramp entry is then linearised; compositing stays linear.
import type { RGBA } from '../../../schema/common.ts';
import type { Gradient, LayerParamValue, Paint, Role } from '../../../title-looks/model.ts';
import { type FxUniformValue, type GlslChunk, hashFloats } from '../shader.ts';
import { GLSL_TL_PAINT } from './glsl.ts';
import { type FxTextSpans, GLSL_TL_SPAN_PAINT } from './spans.ts';

const DEG = Math.PI / 180;
export const RAMP_SIZE = 256;

/** How deep a `shape` gradient runs from the edge inward, percent of the unit. */
export const SHAPE_GRADIENT_DEPTH = 15;

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** A signal colour as premultiplied linear light. */
export function linearPremultiplied(c: RGBA): [number, number, number, number] {
	const a = Math.min(1, Math.max(0, c[3]));
	return [srgbToLinear(c[0]) * a, srgbToLinear(c[1]) * a, srgbToLinear(c[2]) * a, a];
}

/** The colour of a role-or-colour paint under a palette. */
function solid(paint: { role: Role } | { color: RGBA }, palette: Record<Role, RGBA>): RGBA {
	return 'role' in paint ? palette[paint.role] : paint.color;
}

/** Sorted stops as signal colours with their opacity. */
function stopsOf(g: Gradient, palette: Record<Role, RGBA>): { at: number; c: RGBA }[] {
	return g.stops
		.map((s) => {
			const c = solid(s.paint as { role: Role } | { color: RGBA }, palette);
			return { at: s.at, c: [c[0], c[1], c[2], c[3] * (s.alpha ?? 1)] as RGBA };
		})
		.sort((a, b) => a.at - b.at);
}

/** The ramp of a gradient: `RAMP_SIZE` premultiplied linear RGBA entries. */
export function gradientRamp(g: Gradient, palette: Record<Role, RGBA>): Float32Array {
	const out = new Float32Array(RAMP_SIZE * 4);
	const stops = stopsOf(g, palette);
	let k = 0;
	for (let i = 0; i < RAMP_SIZE; i++) {
		const x = i / (RAMP_SIZE - 1);
		while (k < stops.length - 2 && x > stops[k + 1]!.at) k++;
		const a = stops[k]!;
		const b = stops[Math.min(k + 1, stops.length - 1)]!;
		const span = b.at - a.at;
		const f = span > 0 ? Math.min(1, Math.max(0, (x - a.at) / span)) : x >= b.at ? 1 : 0;
		const c: RGBA = [0, 1, 2, 3].map((j) => a.c[j]! + (b.c[j]! - a.c[j]!) * f) as RGBA;
		out.set(linearPremultiplied(c), i * 4);
	}
	return out;
}

/** A paint param's value, falling back to its default when it is not a paint. */
export function paintOf(v: LayerParamValue | undefined, fallback: Paint): Paint {
	if (v && typeof v === 'object' && 'kind' in v) return v as Paint;
	return fallback;
}

export type PaintParts = {
	/**
	 * GLSL defining `vec4 tlPaint_<name>(TlSurface s)`, and `vec4 tlPaintAt_<name>(float x, TlSurface s)`: the paint at
	 * position `x` along it (a gradient's ramp; the plain paint for the other kinds), for gradient maps and curves.
	 */
	glsl: string;
	uniforms: Record<string, FxUniformValue>;
	include: readonly GlslChunk[];
	/** The paint reads the alpha bounds. */
	usesBounds: boolean;
	/** The paint reads the owner of each pixel (TL-036). */
	usesSpans: boolean;
	/** The paint reads the field this far inside the shape, percent of the unit. */
	fieldInside: number;
};

/**
 * The uniforms and GLSL of paint param `name` with value `paint`. `angle`: the animatable rotation in degrees. `spans`:
 * the text layout boxes (TL-036); without them a `line` or `glyph` gradient spans the block, as `gradientSpanOn` reports.
 */
export function paintParts(
	name: string,
	paint: Paint,
	angle: number,
	palette: Record<Role, RGBA>,
	spans?: FxTextSpans | null,
): PaintParts {
	const fn = `tlPaint_${name}`;
	const at = `tlPaintAt_${name}`;
	const color = `u_${name}Color`;
	const plainAt = `vec4 ${at}(float x, TlSurface s) { return ${fn}(s); }\n`;
	switch (paint.kind) {
		case 'source':
			return {
				glsl: `vec4 ${fn}(TlSurface s) { return vec4(tl_sourceLinear(s.uv).rgb, 1.0); }\n${plainAt}`,
				uniforms: {},
				include: [],
				usesBounds: false,
				usesSpans: false,
				fieldInside: 0,
			};
		case 'gradient': {
			const g = paint.gradient;
			const ramp = gradientRamp(g, palette);
			const rad = (g.angle + angle) * DEG;
			const kind = ['linear', 'radial', 'sweep', 'shape'].indexOf(g.type);
			const form = `u_${name}Type, u_${name}Dir, u_${name}Rad, tl_px(${SHAPE_GRADIENT_DEPTH.toFixed(1)}), s`;
			const span = spans ? ['block', 'line', 'glyph'].indexOf(g.span) : 0;
			const body = !spans
				? `tl_ramp(u_${name}Ramp, tl_gradientPos(${form}))`
				: span > 0
					? `tl_spanRamp(u_${name}Ramp, ${span}, ${form})`
					: `tl_spanRamp(u_${name}Ramp, ${form})`;
			return {
				glsl:
					`vec4 ${fn}(TlSurface s) { return ${body}; }\n` +
					`vec4 ${at}(float x, TlSurface s) { return tl_ramp(u_${name}Ramp, x); }\n`,
				uniforms: {
					[`u_${name}Ramp`]: { texels: ramp, key: hashFloats(ramp) },
					[`u_${name}Type`]: { int: kind },
					[`u_${name}Dir`]: [Math.cos(rad), Math.sin(rad)],
					[`u_${name}Rad`]: rad,
				},
				include: spans ? [GLSL_TL_SPAN_PAINT] : [GLSL_TL_PAINT],
				usesBounds: true,
				usesSpans: !!spans && span > 0,
				fieldInside: g.type === 'shape' ? SHAPE_GRADIENT_DEPTH : 0,
			};
		}
		default:
			return {
				glsl: `vec4 ${fn}(TlSurface s) { return ${color}; }\n${plainAt}`,
				uniforms: {
					[color]: linearPremultiplied(paint.kind === 'role' ? palette[paint.role] : (paint.color as RGBA)),
				},
				include: [],
				usesBounds: false,
				usesSpans: false,
				fieldInside: 0,
			};
	}
}

/**
 * TL-036: the span a gradient actually gets on a clip. Line and glyph spans need text layout, so on other clips they act
 * as `block`; the UI shows the requested span with `spanNote`.
 */
export function gradientSpanOn(
	span: Gradient['span'],
	clipKind: string,
): { span: Gradient['span']; spanNote: 'needs-text' | null } {
	if (span === 'block' || clipKind === 'text') return { span, spanNote: null };
	return { span: 'block', spanNote: 'needs-text' };
}
