// Shared building blocks for the S01 document schema. Objects use `z.looseObject` so unknown fields
// written by newer versions survive a load/save round trip (S01:DOC-005).
import { z } from 'zod';

/**
 * Removes the `[k: string]: unknown` index signatures that `z.looseObject` adds to inferred types, so
 * exported TS types stay precise while runtime parsing still preserves unknown fields.
 */
type KnownKeysOf<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: 0 };
export type DeepStrip<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly unknown[]
		? { [K in keyof T]: DeepStrip<T[K]> }
		: T extends object
			? [KnownKeysOf<T>] extends [never]
				? { [K in keyof T]: DeepStrip<T[K]> } // records keep their index signature
				: { [K in keyof T as string extends K ? never : number extends K ? never : K]: DeepStrip<T[K]> }
			: T;

export const int = () => z.number().int();
export const nonNegInt = () => z.number().int().min(0);

export const RationalSchema = z.looseObject({
	num: z.number().int().positive(),
	den: z.number().int().positive(),
});
export type RationalT = DeepStrip<z.infer<typeof RationalSchema>>;

/** Straight (non-premultiplied) sRGB floats 0..1 in R, G, B, A order (S01, ARCHITECTURE §2.3). */
export const RGBASchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type RGBA = [number, number, number, number];

export const Vec2Schema = z.tuple([z.number(), z.number()]);
export type Vec2 = [number, number];

export const LABEL_COLORS = [
	'violet',
	'iris',
	'caribbean',
	'lavender',
	'cerulean',
	'forest',
	'rose',
	'mango',
	'purple',
	'blue',
	'teal',
	'magenta',
	'tan',
	'green',
	'brown',
	'yellow',
] as const;
export const LabelColorSchema = z.enum(LABEL_COLORS);
export type LabelColor = DeepStrip<z.infer<typeof LabelColorSchema>>;

export const INTERPOLATIONS = ['linear', 'bezier', 'auto-bezier', 'continuous-bezier', 'hold'] as const;
export const InterpolationSchema = z.enum(INTERPOLATIONS);
export type Interpolation = DeepStrip<z.infer<typeof InterpolationSchema>>;

export const EaseSchema = z.looseObject({ influence: z.number().gt(0).max(1), slope: z.number().min(0) });
export type Ease = DeepStrip<z.infer<typeof EaseSchema>>;

/**
 * Spatial interpolation of a vec2 point keyframe (S03:KF-021, KF-030; wave1 spatial-motion-path). Same vocabulary
 * as the temporal `Interpolation`, without `hold`: `linear` = straight segments (tangents ignored), `bezier` =
 * independent in/out tangents, `auto-bezier` = tangents derived from the neighbours (Catmull-Rom, `(next − prev)
 * / 6`; the stored ones are a cache for the UI), `continuous-bezier` = user tangents kept opposite
 * (`in = −k · out`).
 */
export const SPATIAL_INTERPOLATIONS = ['linear', 'bezier', 'auto-bezier', 'continuous-bezier'] as const;
export const SpatialInterpolationSchema = z.enum(SPATIAL_INTERPOLATIONS);
export type SpatialInterpolation = DeepStrip<z.infer<typeof SpatialInterpolationSchema>>;

/**
 * Per-key spatial data of vec2 point properties. Tangents are offsets from the key's value in value units
 * (sequence px for Motion position): the path segment a → b is the cubic Bézier
 * `a.v, a.v + a.outTangent, b.v + b.inTangent, b.v`. Absent = `linear` (documents written before spatial
 * interpolation existed evaluate exactly as before; S01:MIG-005, additive).
 */
export const SpatialSchema = z.looseObject({
	mode: SpatialInterpolationSchema,
	inTangent: Vec2Schema,
	outTangent: Vec2Schema,
});
export type Spatial = { mode: SpatialInterpolation; inTangent: Vec2; outTangent: Vec2 };

export type Keyframe<T> = {
	id: string;
	time: number;
	value: T;
	interpolation: Interpolation;
	easeIn: Ease;
	easeOut: Ease;
	/** vec2 point properties only (S03:KF-030); absent = linear spatial. */
	spatial?: Spatial;
	/**
	 * keyframes-blend: After Effects' Rove Across Time — the key has no time of its own: the run of roving keys between
	 * two fixed keys moves as one segment (the fixed keys' eases shape it) and the roving keys' times follow from where
	 * the motion passes them (`retimeRoving`). Never on the first or last key or on hold keys. Absent = false.
	 */
	roving?: boolean;
};
export type Animatable<T> = { value: T; keyframes: Keyframe<T>[] };

export function keyframeSchema<T extends z.ZodType>(value: T) {
	return z.looseObject({
		id: z.string(),
		time: int(),
		value,
		interpolation: InterpolationSchema,
		easeIn: EaseSchema,
		easeOut: EaseSchema,
		spatial: SpatialSchema.optional(),
		roving: z.boolean().optional(),
	});
}

/** `Animatable<T> = {value, keyframes}` (S01:KF-001). */
export function animatable<T extends z.ZodType>(value: T) {
	return z.looseObject({ value, keyframes: z.array(keyframeSchema(value)) });
}

export const AnimNumberSchema = animatable(z.number());
export const AnimVec2Schema = animatable(Vec2Schema);
/** M2 (S11:SHP-001): animatable colours (shape fill/stroke). */
export const AnimRGBASchema = animatable(RGBASchema);

/**
 * A tone curve (ARCHITECTURE §19.2, S06:CG-030): control points `[x, y]` in 0..1, sorted by x, at least two.
 * Hold-only when keyframed (objects step, S01:KF-007).
 */
export const CurveValueSchema = z.looseObject({ curve: z.array(Vec2Schema).min(2) });
export type CurveValue = { curve: Vec2[] };

/** Effect/transition parameter values (S01:FX-020; `curve` added in M2, ARCHITECTURE §19.2). */
export const ParamValueSchema = z.union([
	z.number(),
	z.boolean(),
	z.string(),
	Vec2Schema,
	RGBASchema,
	z.looseObject({ mediaId: z.string() }),
	CurveValueSchema,
]);
export type ParamValue = number | boolean | string | Vec2 | RGBA | { mediaId: string } | CurveValue;
export const AnimParamSchema = animatable(ParamValueSchema);
