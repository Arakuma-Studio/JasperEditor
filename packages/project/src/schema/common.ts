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

/** Wave expressions: 3D Point Control values (`[x, y, z]`). */
export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = [number, number, number];

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

/**
 * keyframe-sides: the incoming temporal interpolation of a key (After Effects / Premiere keep an incoming and an
 * outgoing type per key; docs/wp-notes/keyframe-sides.md). Hold is not an incoming type here: a Hold segment is
 * decided by the key it leaves (After Effects' incoming Hold only mirrors the previous key's outgoing Hold). Auto
 * Bezier and Continuous Bezier shape both sides of a key, so a key whose two sides differ never uses them.
 */
export const IN_INTERPOLATIONS = ['linear', 'bezier', 'auto-bezier', 'continuous-bezier'] as const;
export const InInterpolationSchema = z.enum(IN_INTERPOLATIONS);
export type InInterpolation = (typeof IN_INTERPOLATIONS)[number];
/** Interpolations that shape both sides of a key (a key whose sides differ cannot use them). */
export const BOTH_SIDED_INTERPOLATIONS = ['auto-bezier', 'continuous-bezier'] as const;
/** The side(s) of a key a temporal interpolation edit applies to. */
export const INTERPOLATION_SIDES = ['both', 'in', 'out'] as const;
export const InterpolationSideSchema = z.enum(INTERPOLATION_SIDES);
export type InterpolationSide = (typeof INTERPOLATION_SIDES)[number];

/**
 * A temporal ease: influence (0, 1] of the segment and the speed as a slope normalised by the segment's average speed
 * (1 = linear). keyframes-blend: the slope is any finite number — negative = the value first moves away from the
 * next key (anticipation), steep = it passes it (overshoot), as Premiere's graph handles allow.
 */
export const EaseSchema = z.looseObject({ influence: z.number().gt(0).max(1), slope: z.number() });
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
/**
 * keyframes-blend: the Auto Bezier rule of a key. `proportional` (keys made Auto Bezier from now on) = After Effects':
 * the handles lie along (next − prev) and each is ⅓ of its own neighbouring chord, so a key between a short and a long
 * segment has a short and a long handle (and no overshoot into the short one); the first and last keys have none.
 * Absent / `uniform` = the Catmull-Rom rule documents were written with, `±(next − prev) / 6` (kept so existing
 * projects draw the same paths; re-applying Auto Bezier upgrades a key).
 */
export const AUTO_TANGENT_RULES = ['uniform', 'proportional'] as const;
export const SpatialSchema = z.looseObject({
	mode: SpatialInterpolationSchema,
	inTangent: Vec2Schema,
	outTangent: Vec2Schema,
	auto: z.enum(AUTO_TANGENT_RULES).optional(),
});
export type Spatial = {
	mode: SpatialInterpolation;
	inTangent: Vec2;
	outTangent: Vec2;
	auto?: (typeof AUTO_TANGENT_RULES)[number];
};

export type Keyframe<T> = {
	id: string;
	time: number;
	value: T;
	/**
	 * The key's temporal interpolation: its outgoing side, and also its incoming side when `inInterpolation` is
	 * absent (documents written before keyframe-sides).
	 */
	interpolation: Interpolation;
	/**
	 * keyframe-sides: the incoming side. Present = the segment arriving at this key is evaluated per side, After
	 * Effects-style (the previous key's outgoing side and this incoming side; a Linear side contributes influence ⅙
	 * at the segment's average speed). Absent = the rule documents were written with: the segment follows the previous
	 * key's `interpolation` (Linear → linear whatever this key stores), so existing projects evaluate as before.
	 */
	inInterpolation?: InInterpolation;
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
/**
 * An After Effects-style expression on an animatable property (wave expressions, docs/wp-notes/expressions.md):
 * JavaScript evaluated per frame by `@jasper/expressions` with `value` = the keyframed value. `enabled: false`
 * keeps the text but renders the keyframed value (AE's "Enable Expression" switch). Absent = no expression.
 */
export const ExpressionSchema = z.looseObject({ text: z.string(), enabled: z.boolean() });
export type Expression = { text: string; enabled: boolean };

export type Animatable<T> = { value: T; keyframes: Keyframe<T>[]; expression?: Expression };

export function keyframeSchema<T extends z.ZodType>(value: T) {
	return z.looseObject({
		id: z.string(),
		time: int(),
		value,
		interpolation: InterpolationSchema,
		// keyframe-sides: read leniently (any value loads); INV-011 reports a bad one and `repairDocument` fixes it.
		inInterpolation: z.custom<InInterpolation>(() => true).optional(),
		easeIn: EaseSchema,
		easeOut: EaseSchema,
		spatial: SpatialSchema.optional(),
		roving: z.boolean().optional(),
	});
}

/** `Animatable<T> = {value, keyframes}` (S01:KF-001). */
export function animatable<T extends z.ZodType>(value: T) {
	return z.looseObject({
		value,
		keyframes: z.array(keyframeSchema(value)),
		/** Optional (wave expressions; additive, no schema bump). */
		expression: ExpressionSchema.optional(),
	});
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

/** Most numbers of a mesh param value (sim-warp: Mesh Warp / Liquify distortion meshes). */
export const MESH_VALUE_MAX = 400_000;
/** sim-warp: a distortion mesh value (`mesh` params): finite numbers, layout defined by the effect. */
export const MeshValueSchema = z.array(z.number()).max(MESH_VALUE_MAX);
export type MeshValue = number[];

/** Effect/transition parameter values (S01:FX-020; `curve` added in M2, ARCHITECTURE §19.2). */
export const ParamValueSchema = z.union([
	z.number(),
	z.boolean(),
	z.string(),
	Vec2Schema,
	// Wave expressions (additive): 3D Point Control.
	Vec3Schema,
	RGBASchema,
	z.looseObject({ mediaId: z.string() }),
	CurveValueSchema,
	// sim-warp: a keyframable distortion mesh (Mesh Warp, Liquify): a flat list of numbers whose layout the effect
	// defines; keys interpolate number by number (lists of different lengths hold).
	MeshValueSchema,
]);
export type ParamValue =
	| number
	| boolean
	| string
	| Vec2
	| Vec3
	| RGBA
	| { mediaId: string }
	| CurveValue
	| MeshValue;
export const AnimParamSchema = animatable(ParamValueSchema);
