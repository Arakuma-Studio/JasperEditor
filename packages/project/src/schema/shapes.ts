// Vector shape contents (wp shapes): the After Effects shape-layer model on a `shape` clip of type `vector` — nested
// groups with transforms, parametric and free Bézier paths, solid and gradient fills and strokes (dashes, taper,
// wave) and the path operators, in stacking order (index 0 = top of the list). Everything numeric is an Animatable
// (shared keyframe evaluator); paths and gradients interpolate through `vector/values.ts`. Every item has an id
// unique within its clip; property keys address items by id (`shape.items.<id>.<field…>`).
//
// All fields added in this workstream are optional at read time where a default exists (see `vector/defaults.ts`).
import { z } from 'zod';
import type { BezierPath } from '../path/model.ts';
import type { GradientValue } from '../vector/values.ts';
import { BezierPathSchema } from './mask.ts';
import { type BlendMode, BlendModeSchema } from './sequence.ts';
import {
	type Animatable,
	AnimNumberSchema,
	AnimRGBASchema,
	AnimVec2Schema,
	animatable,
	type RGBA,
	type Vec2,
} from './common.ts';

/**
 * Blend modes of shape groups, fills and strokes: the full clip set (`BLEND_MODES`, keyframes-blend). Paints blend
 * with what is under them inside the shape layer (the layer is isolated), as After Effects' per-paint Blend Mode.
 */
export type ShapeBlendMode = BlendMode;

export const SHAPE_ITEM_TYPES = [
	'group',
	'rect',
	'ellipse',
	'polystar',
	'path',
	'fill',
	'stroke',
	'gradientFill',
	'gradientStroke',
	'trim',
	'repeater',
	'offsetPaths',
	'roundCorners',
	'zigZag',
	'twist',
	'wiggle',
	'puckerBloat',
	'mergePaths',
] as const;
export type ShapeItemType = (typeof SHAPE_ITEM_TYPES)[number];

export const PATH_ITEM_TYPES = ['rect', 'ellipse', 'polystar', 'path'] as const;
export const PAINT_ITEM_TYPES = ['fill', 'stroke', 'gradientFill', 'gradientStroke'] as const;
export const OPERATOR_ITEM_TYPES = [
	'trim',
	'repeater',
	'offsetPaths',
	'roundCorners',
	'zigZag',
	'twist',
	'wiggle',
	'puckerBloat',
	'mergePaths',
] as const;

type AN = Animatable<number>;
type AV = Animatable<Vec2>;

type ItemBase = {
	id: string;
	name: string;
	/** The item's eye: disabled items are skipped (absent = enabled). */
	enabled?: boolean;
};

export type ShapeTransform = {
	anchor: AV;
	position: AV;
	/** Percent per axis. */
	scale: AV;
	/** Degrees (−85…85). */
	skew: AN;
	/** Degrees. */
	skewAxis: AN;
	/** Degrees, clockwise. */
	rotation: AN;
	/** 0…100 %. */
	opacity: AN;
};

export type PathDirectionValue = 'normal' | 'reversed';
export type LineCapValue = 'butt' | 'round' | 'square';
export type LineJoinValue = 'miter' | 'round' | 'bevel';
export type FillRuleValue = 'nonzero' | 'evenodd';
export type CompositeValue = 'below' | 'above';
export type StrokePositionValue = 'center' | 'inside' | 'outside';

export type StrokeDashes = {
	/** Dash / gap pairs (up to three, as After Effects' Dash, Gap, Dash 2, Gap 2, Dash 3, Gap 3). */
	segments: { dash: AN; gap: AN }[];
	offset: AN;
};

export type StrokeTaper = {
	units: 'percent' | 'pixels';
	startLength: AN;
	endLength: AN;
	/** Percent of the stroke width at the tips. */
	startWidth: AN;
	endWidth: AN;
	/** Percent. */
	startEase: AN;
	endEase: AN;
};

export type StrokeWave = {
	/** Percent. */
	amount: AN;
	units: 'pixels' | 'cycles';
	/** Pixels (units = pixels). */
	wavelength: AN;
	/** Waves per path (units = cycles). */
	cycles: AN;
	/** Degrees. */
	phase: AN;
};

type StrokeStyleFields = {
	composite?: CompositeValue;
	blendMode?: ShapeBlendMode;
	/** 0…100 %. */
	opacity: AN;
	width: AN;
	lineCap?: LineCapValue;
	lineJoin?: LineJoinValue;
	miterLimit: AN;
	dashes?: StrokeDashes | null;
	taper?: StrokeTaper | null;
	wave?: StrokeWave | null;
	/** Where the stroke sits on the outline (Premiere-style; After Effects strokes are centred). */
	position?: StrokePositionValue;
};

type GradientFields = {
	gradientType: 'linear' | 'radial';
	startPoint: AV;
	endPoint: AV;
	/** Radial only: focal point offset, −100…100 % of the radius. */
	highlightLength: AN;
	/** Radial only: degrees from the start→end axis. */
	highlightAngle: AN;
	colors: Animatable<GradientValue>;
};

export type ShapeGroupItem = ItemBase & {
	type: 'group';
	blendMode?: ShapeBlendMode;
	contents: ShapeItem[];
	transform: ShapeTransform;
};
export type ShapeRectItem = ItemBase & {
	type: 'rect';
	direction?: PathDirectionValue;
	size: AV;
	position: AV;
	roundness: AN;
};
export type ShapeEllipseItem = ItemBase & { type: 'ellipse'; direction?: PathDirectionValue; size: AV; position: AV };
export type ShapePolystarItem = ItemBase & {
	type: 'polystar';
	direction?: PathDirectionValue;
	starType: 'star' | 'polygon';
	points: AN;
	position: AV;
	rotation: AN;
	innerRadius: AN;
	outerRadius: AN;
	/** Percent. */
	innerRoundness: AN;
	outerRoundness: AN;
};
export type ShapePathItem = ItemBase & { type: 'path'; direction?: PathDirectionValue; path: Animatable<BezierPath> };
export type ShapeFillItem = ItemBase & {
	type: 'fill';
	composite?: CompositeValue;
	fillRule?: FillRuleValue;
	blendMode?: ShapeBlendMode;
	color: Animatable<RGBA>;
	opacity: AN;
};
export type ShapeStrokeItem = ItemBase & StrokeStyleFields & { type: 'stroke'; color: Animatable<RGBA> };
export type ShapeGradientFillItem = ItemBase &
	GradientFields & {
		type: 'gradientFill';
		composite?: CompositeValue;
		fillRule?: FillRuleValue;
		blendMode?: ShapeBlendMode;
		opacity: AN;
	};
export type ShapeGradientStrokeItem = ItemBase & StrokeStyleFields & GradientFields & { type: 'gradientStroke' };
export type ShapeTrimItem = ItemBase & {
	type: 'trim';
	/** Percent. */
	start: AN;
	end: AN;
	/** Degrees (360° = one full length). */
	offset: AN;
	mode?: 'simultaneous' | 'individual';
};
export type ShapeRepeaterItem = ItemBase & {
	type: 'repeater';
	copies: AN;
	offset: AN;
	composite?: CompositeValue;
	transform: {
		anchor: AV;
		position: AV;
		scale: AV;
		rotation: AN;
		/** Percent. */
		startOpacity: AN;
		endOpacity: AN;
	};
};
export type ShapeOffsetPathsItem = ItemBase & {
	type: 'offsetPaths';
	amount: AN;
	lineJoin?: LineJoinValue;
	miterLimit: AN;
	copies: AN;
	copyOffset: AN;
};
export type ShapeRoundCornersItem = ItemBase & { type: 'roundCorners'; radius: AN };
export type ShapeZigZagItem = ItemBase & {
	type: 'zigZag';
	size: AN;
	ridges: AN;
	points?: 'corner' | 'smooth';
};
export type ShapeTwistItem = ItemBase & { type: 'twist'; angle: AN; center: AV };
export type ShapeWiggleItem = ItemBase & {
	type: 'wiggle';
	size: AN;
	detail: AN;
	points?: 'corner' | 'smooth';
	/** Wiggles per second. */
	speed: AN;
	/** Percent. */
	correlation: AN;
	/** Degrees. */
	temporalPhase: AN;
	spatialPhase: AN;
	seed: AN;
};
export type ShapePuckerBloatItem = ItemBase & { type: 'puckerBloat'; amount: AN };
export type ShapeMergePathsItem = ItemBase & {
	type: 'mergePaths';
	mode: 'merge' | 'add' | 'subtract' | 'intersect' | 'exclude';
};

export type ShapeItem =
	| ShapeGroupItem
	| ShapeRectItem
	| ShapeEllipseItem
	| ShapePolystarItem
	| ShapePathItem
	| ShapeFillItem
	| ShapeStrokeItem
	| ShapeGradientFillItem
	| ShapeGradientStrokeItem
	| ShapeTrimItem
	| ShapeRepeaterItem
	| ShapeOffsetPathsItem
	| ShapeRoundCornersItem
	| ShapeZigZagItem
	| ShapeTwistItem
	| ShapeWiggleItem
	| ShapePuckerBloatItem
	| ShapeMergePathsItem;

export type ShapeItemOf<T extends ShapeItemType> = Extract<ShapeItem, { type: T }>;

// ---------------------------------------------------------------- zod

export const GradientValueSchema = z.looseObject({
	colors: z
		.array(
			z.looseObject({
				position: z.number(),
				color: z.tuple([z.number(), z.number(), z.number()]),
				midpoint: z.number().optional(),
			}),
		)
		.min(1),
	opacities: z.array(
		z.looseObject({ position: z.number(), opacity: z.number(), midpoint: z.number().optional() }),
	),
});
/** Shape paths use the shared Bézier path value of masks (`path/model.ts`). */
export const AnimPathSchema = animatable(BezierPathSchema);
export const AnimGradientSchema = animatable(GradientValueSchema);

const base = {
	id: z.string(),
	name: z.string(),
	enabled: z.boolean().optional(),
};
const direction = z.enum(['normal', 'reversed']).optional();
// Lazy: sequence.ts imports this module (the schema is only read when parsing).
const blendMode = z.lazy(() => BlendModeSchema).optional();
const composite = z.enum(['below', 'above']).optional();
const fillRule = z.enum(['nonzero', 'evenodd']).optional();
const lineCap = z.enum(['butt', 'round', 'square']).optional();
const lineJoin = z.enum(['miter', 'round', 'bevel']).optional();

const ShapeTransformSchema = z.looseObject({
	anchor: AnimVec2Schema,
	position: AnimVec2Schema,
	scale: AnimVec2Schema,
	skew: AnimNumberSchema,
	skewAxis: AnimNumberSchema,
	rotation: AnimNumberSchema,
	opacity: AnimNumberSchema,
});

const strokeStyle = {
	composite,
	blendMode,
	opacity: AnimNumberSchema,
	width: AnimNumberSchema,
	lineCap,
	lineJoin,
	miterLimit: AnimNumberSchema,
	dashes: z
		.looseObject({
			segments: z.array(z.looseObject({ dash: AnimNumberSchema, gap: AnimNumberSchema })).max(3),
			offset: AnimNumberSchema,
		})
		.nullable()
		.optional(),
	taper: z
		.looseObject({
			units: z.enum(['percent', 'pixels']),
			startLength: AnimNumberSchema,
			endLength: AnimNumberSchema,
			startWidth: AnimNumberSchema,
			endWidth: AnimNumberSchema,
			startEase: AnimNumberSchema,
			endEase: AnimNumberSchema,
		})
		.nullable()
		.optional(),
	wave: z
		.looseObject({
			amount: AnimNumberSchema,
			units: z.enum(['pixels', 'cycles']),
			wavelength: AnimNumberSchema,
			cycles: AnimNumberSchema,
			phase: AnimNumberSchema,
		})
		.nullable()
		.optional(),
	position: z.enum(['center', 'inside', 'outside']).optional(),
};
const gradient = {
	gradientType: z.enum(['linear', 'radial']),
	startPoint: AnimVec2Schema,
	endPoint: AnimVec2Schema,
	highlightLength: AnimNumberSchema,
	highlightAngle: AnimNumberSchema,
	colors: AnimGradientSchema,
};

export const ShapeItemSchema: z.ZodType<ShapeItem> = z.lazy(() =>
	z.discriminatedUnion('type', [
		z.looseObject({
			...base,
			type: z.literal('group'),
			blendMode,
			contents: z.array(ShapeItemSchema),
			transform: ShapeTransformSchema,
		}),
		z.looseObject({
			...base,
			type: z.literal('rect'),
			direction,
			size: AnimVec2Schema,
			position: AnimVec2Schema,
			roundness: AnimNumberSchema,
		}),
		z.looseObject({ ...base, type: z.literal('ellipse'), direction, size: AnimVec2Schema, position: AnimVec2Schema }),
		z.looseObject({
			...base,
			type: z.literal('polystar'),
			direction,
			starType: z.enum(['star', 'polygon']),
			points: AnimNumberSchema,
			position: AnimVec2Schema,
			rotation: AnimNumberSchema,
			innerRadius: AnimNumberSchema,
			outerRadius: AnimNumberSchema,
			innerRoundness: AnimNumberSchema,
			outerRoundness: AnimNumberSchema,
		}),
		z.looseObject({ ...base, type: z.literal('path'), direction, path: AnimPathSchema }),
		z.looseObject({
			...base,
			type: z.literal('fill'),
			composite,
			fillRule,
			blendMode,
			color: AnimRGBASchema,
			opacity: AnimNumberSchema,
		}),
		z.looseObject({ ...base, type: z.literal('stroke'), ...strokeStyle, color: AnimRGBASchema }),
		z.looseObject({
			...base,
			type: z.literal('gradientFill'),
			composite,
			fillRule,
			blendMode,
			opacity: AnimNumberSchema,
			...gradient,
		}),
		z.looseObject({ ...base, type: z.literal('gradientStroke'), ...strokeStyle, ...gradient }),
		z.looseObject({
			...base,
			type: z.literal('trim'),
			start: AnimNumberSchema,
			end: AnimNumberSchema,
			offset: AnimNumberSchema,
			mode: z.enum(['simultaneous', 'individual']).optional(),
		}),
		z.looseObject({
			...base,
			type: z.literal('repeater'),
			copies: AnimNumberSchema,
			offset: AnimNumberSchema,
			composite,
			transform: z.looseObject({
				anchor: AnimVec2Schema,
				position: AnimVec2Schema,
				scale: AnimVec2Schema,
				rotation: AnimNumberSchema,
				startOpacity: AnimNumberSchema,
				endOpacity: AnimNumberSchema,
			}),
		}),
		z.looseObject({
			...base,
			type: z.literal('offsetPaths'),
			amount: AnimNumberSchema,
			lineJoin,
			miterLimit: AnimNumberSchema,
			copies: AnimNumberSchema,
			copyOffset: AnimNumberSchema,
		}),
		z.looseObject({ ...base, type: z.literal('roundCorners'), radius: AnimNumberSchema }),
		z.looseObject({
			...base,
			type: z.literal('zigZag'),
			size: AnimNumberSchema,
			ridges: AnimNumberSchema,
			points: z.enum(['corner', 'smooth']).optional(),
		}),
		z.looseObject({ ...base, type: z.literal('twist'), angle: AnimNumberSchema, center: AnimVec2Schema }),
		z.looseObject({
			...base,
			type: z.literal('wiggle'),
			size: AnimNumberSchema,
			detail: AnimNumberSchema,
			points: z.enum(['corner', 'smooth']).optional(),
			speed: AnimNumberSchema,
			correlation: AnimNumberSchema,
			temporalPhase: AnimNumberSchema,
			spatialPhase: AnimNumberSchema,
			seed: AnimNumberSchema,
		}),
		z.looseObject({ ...base, type: z.literal('puckerBloat'), amount: AnimNumberSchema }),
		z.looseObject({
			...base,
			type: z.literal('mergePaths'),
			mode: z.enum(['merge', 'add', 'subtract', 'intersect', 'exclude']),
		}),
	]),
) as unknown as z.ZodType<ShapeItem>;

export type VectorShapeData = { type: 'vector'; contents: ShapeItem[] };
export const VectorShapeDataSchema = z.looseObject({
	type: z.literal('vector'),
	contents: z.array(ShapeItemSchema),
});
