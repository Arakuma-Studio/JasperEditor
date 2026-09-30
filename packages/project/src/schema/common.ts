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

export type Keyframe<T> = {
	id: string;
	time: number;
	value: T;
	interpolation: Interpolation;
	easeIn: Ease;
	easeOut: Ease;
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
	});
}

/** `Animatable<T> = {value, keyframes}` (S01:KF-001). */
export function animatable<T extends z.ZodType>(value: T) {
	return z.looseObject({ value, keyframes: z.array(keyframeSchema(value)) });
}

export const AnimNumberSchema = animatable(z.number());
export const AnimVec2Schema = animatable(Vec2Schema);

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
