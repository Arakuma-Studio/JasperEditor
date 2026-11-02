// Spec 19 TL-011 / TL-032: paints as uniforms and GLSL. Palette colours are stored as the signal (sRGB-encoded, straight)
// and enter a look linearised and premultiplied. Gradients are baked into a 256-entry ramp: one program for every stop
// count, no uniform budget, role colours may animate. Stops interpolate in the signal, as design tools do (a black to
// white ramp reads even), and each ramp entry is then linearised; compositing stays linear.
import type { RGBA } from '../../../schema/common.ts';
import type { Gradient, LayerParamValue, Paint, Role } from '../../../title-looks/model.ts';
import { type FxUniformValue, type GlslChunk, hashFloats } from '../shader.ts';
import { GLSL_TL_PAINT } from './glsl.ts';

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
	/** GLSL defining `vec4 tlPaint_<name>(TlSurface s)`. */
	glsl: string;
	uniforms: Record<string, FxUniformValue>;
	include: readonly GlslChunk[];
	/** The paint reads the alpha bounds. */
	usesBounds: boolean;
	/** The paint reads the field this far inside the shape, percent of the unit. */
	fieldInside: number;
};

/** The uniforms and GLSL of paint param `name` with value `paint`. `angle`: the animatable rotation in degrees. */
export function paintParts(
	name: string,
	paint: Paint,
	angle: number,
	palette: Record<Role, RGBA>,
): PaintParts {
	const fn = `tlPaint_${name}`;
	const color = `u_${name}Color`;
	switch (paint.kind) {
		case 'source':
			return {
				glsl: `vec4 ${fn}(TlSurface s) { return vec4(tl_sourceLinear(s.uv).rgb, 1.0); }\n`,
				uniforms: {},
				include: [],
				usesBounds: false,
				fieldInside: 0,
			};
		case 'gradient': {
			const g = paint.gradient;
			const ramp = gradientRamp(g, palette);
			const rad = (g.angle + angle) * DEG;
			const kind = ['linear', 'radial', 'sweep', 'shape'].indexOf(g.type);
			return {
				glsl:
					`vec4 ${fn}(TlSurface s) { return tl_ramp(u_${name}Ramp, tl_gradientPos(u_${name}Type, u_${name}Dir, ` +
					`u_${name}Rad, tl_px(${SHAPE_GRADIENT_DEPTH.toFixed(1)}), s)); }\n`,
				uniforms: {
					[`u_${name}Ramp`]: { texels: ramp, key: hashFloats(ramp) },
					[`u_${name}Type`]: { int: kind },
					[`u_${name}Dir`]: [Math.cos(rad), Math.sin(rad)],
					[`u_${name}Rad`]: rad,
				},
				include: [GLSL_TL_PAINT],
				usesBounds: true,
				fieldInside: g.type === 'shape' ? SHAPE_GRADIENT_DEPTH : 0,
			};
		}
		default:
			return {
				glsl: `vec4 ${fn}(TlSurface s) { return ${color}; }\n`,
				uniforms: {
					[color]: linearPremultiplied(paint.kind === 'role' ? palette[paint.role] : (paint.color as RGBA)),
				},
				include: [],
				usesBounds: false,
				fieldInside: 0,
			};
	}
}
