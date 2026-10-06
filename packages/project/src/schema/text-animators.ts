// Text animators, Path Options and More Options of text clips (workstream text-animators; After Effects "Animate
// Text"). Every field is optional on the clip (absent = no animators / no path / defaults), so documents written
// before this workstream parse unchanged and no schema version bump is needed. Animatable values reuse the shared
// `{value, keyframes}` storage (S01:KF-001) and are evaluated per frame at the clip's content time by the text
// layer, like shapes (RND-001).
import { z } from 'zod';
import { AnimNumberSchema, AnimRGBASchema, AnimVec2Schema, type DeepStrip, Vec2Schema } from './common.ts';

// ---------------------------------------------------------------- selectors

/** What a selector counts (AE "Based On"). */
export const TEXT_SELECTOR_BASED_ON = ['characters', 'charactersExcludingSpaces', 'words', 'lines'] as const;
export type TextSelectorBasedOn = (typeof TEXT_SELECTOR_BASED_ON)[number];
/** How a selector combines with the selectors above it (AE "Mode"). */
export const TEXT_SELECTOR_MODES = ['add', 'subtract', 'intersect', 'min', 'max', 'difference'] as const;
export type TextSelectorMode = (typeof TEXT_SELECTOR_MODES)[number];
/** Range selector "Shape". */
export const TEXT_RANGE_SHAPES = ['square', 'rampUp', 'rampDown', 'triangle', 'round', 'smooth'] as const;
export type TextRangeShape = (typeof TEXT_RANGE_SHAPES)[number];
/** Range selector "Units": Start / End / Offset in percent of the units or in unit indices. */
export const TEXT_RANGE_UNITS = ['percentage', 'index'] as const;
export type TextRangeUnits = (typeof TEXT_RANGE_UNITS)[number];

export const TextRangeSelectorSchema = z.looseObject({
	id: z.string(),
	kind: z.literal('range'),
	name: z.string(),
	enabled: z.boolean(),
	start: AnimNumberSchema,
	end: AnimNumberSchema,
	offset: AnimNumberSchema,
	units: z.enum(TEXT_RANGE_UNITS),
	basedOn: z.enum(TEXT_SELECTOR_BASED_ON),
	mode: z.enum(TEXT_SELECTOR_MODES),
	/** -100…100 %. */
	amount: AnimNumberSchema,
	shape: z.enum(TEXT_RANGE_SHAPES),
	/** 0…100 % (Square only). */
	smoothness: AnimNumberSchema,
	/** -100…100 %. */
	easeHigh: AnimNumberSchema,
	easeLow: AnimNumberSchema,
	randomize: z.boolean(),
	randomSeed: AnimNumberSchema,
});
export type TextRangeSelector = DeepStrip<z.infer<typeof TextRangeSelectorSchema>>;

export const TextWigglySelectorSchema = z.looseObject({
	id: z.string(),
	kind: z.literal('wiggly'),
	name: z.string(),
	enabled: z.boolean(),
	mode: z.enum(TEXT_SELECTOR_MODES),
	/** -100…100 %. */
	maxAmount: AnimNumberSchema,
	minAmount: AnimNumberSchema,
	basedOn: z.enum(TEXT_SELECTOR_BASED_ON),
	wigglesPerSecond: AnimNumberSchema,
	/** 0…100 %. */
	correlation: AnimNumberSchema,
	/** Degrees (one cycle = 360). */
	temporalPhase: AnimNumberSchema,
	spatialPhase: AnimNumberSchema,
	lockDimensions: z.boolean(),
	randomSeed: AnimNumberSchema,
});
export type TextWigglySelector = DeepStrip<z.infer<typeof TextWigglySelectorSchema>>;

export const TEXT_SELECTOR_KINDS = ['range', 'wiggly'] as const;
export type TextSelectorKind = (typeof TEXT_SELECTOR_KINDS)[number];
export const TextSelectorSchema = z.discriminatedUnion('kind', [
	TextRangeSelectorSchema,
	TextWigglySelectorSchema,
]);
export type TextSelector = TextRangeSelector | TextWigglySelector;

// ---------------------------------------------------------------- animator properties

export const TEXT_TRACKING_TYPES = ['beforeAndAfter', 'before', 'after'] as const;
export const TEXT_CHARACTER_RANGES = ['preserveCaseAndDigits', 'fullUnicode'] as const;
export const TEXT_CHARACTER_ALIGNMENTS = ['left', 'center', 'right', 'adjustKerning'] as const;

/**
 * The properties an animator offsets (only the ones added are present). Units follow AE: position / anchor / line
 * spacing / blur in layer pixels (Y down), scale and opacities in percent, angles in degrees, hue in degrees,
 * saturation / brightness offsets in percent, tracking in 1/1000 em, line anchor in percent. Z components are their
 * own numbers (`positionZ`, …; used with per-character 3D). `axes` offsets variable font axes (tag → user units).
 */
export const TextAnimatorPropertiesSchema = z.looseObject({
	anchor: AnimVec2Schema.optional(),
	anchorZ: AnimNumberSchema.optional(),
	position: AnimVec2Schema.optional(),
	positionZ: AnimNumberSchema.optional(),
	scale: AnimVec2Schema.optional(),
	scaleZ: AnimNumberSchema.optional(),
	skew: AnimNumberSchema.optional(),
	skewAxis: AnimNumberSchema.optional(),
	rotation: AnimNumberSchema.optional(),
	rotationX: AnimNumberSchema.optional(),
	rotationY: AnimNumberSchema.optional(),
	opacity: AnimNumberSchema.optional(),
	fillColor: AnimRGBASchema.optional(),
	fillHue: AnimNumberSchema.optional(),
	fillSaturation: AnimNumberSchema.optional(),
	fillBrightness: AnimNumberSchema.optional(),
	fillOpacity: AnimNumberSchema.optional(),
	strokeColor: AnimRGBASchema.optional(),
	strokeHue: AnimNumberSchema.optional(),
	strokeSaturation: AnimNumberSchema.optional(),
	strokeBrightness: AnimNumberSchema.optional(),
	strokeOpacity: AnimNumberSchema.optional(),
	strokeWidth: AnimNumberSchema.optional(),
	trackingType: z.enum(TEXT_TRACKING_TYPES).optional(),
	tracking: AnimNumberSchema.optional(),
	lineAnchor: AnimNumberSchema.optional(),
	lineSpacing: AnimVec2Schema.optional(),
	characterAlignment: z.enum(TEXT_CHARACTER_ALIGNMENTS).optional(),
	characterRange: z.enum(TEXT_CHARACTER_RANGES).optional(),
	characterOffset: AnimNumberSchema.optional(),
	characterValue: AnimNumberSchema.optional(),
	blur: AnimVec2Schema.optional(),
	axes: z.record(z.string(), AnimNumberSchema).optional(),
});
export type TextAnimatorProperties = DeepStrip<z.infer<typeof TextAnimatorPropertiesSchema>>;

export const TextAnimatorGroupSchema = z.looseObject({
	id: z.string(),
	name: z.string(),
	enabled: z.boolean(),
	properties: TextAnimatorPropertiesSchema,
	/** Evaluated top to bottom, each combined with the ones above by its mode; empty = every character fully. */
	selectors: z.array(TextSelectorSchema),
});
export type TextAnimatorGroup = DeepStrip<z.infer<typeof TextAnimatorGroupSchema>>;

// ---------------------------------------------------------------- path options and more options

/** A vertex of a text path: point and Bezier handles relative to it (layer pixels). */
export const TextPathVertexSchema = z.looseObject({
	point: Vec2Schema,
	inTangent: Vec2Schema,
	outTangent: Vec2Schema,
});
/** A Bezier path in the text box's space (pixels, origin top-left, Y down). */
export const TextPathGeometrySchema = z.looseObject({
	closed: z.boolean(),
	vertices: z.array(TextPathVertexSchema),
});
export type TextPathGeometry = DeepStrip<z.infer<typeof TextPathGeometrySchema>>;

/** AE Path Options: the characters are placed along `path`. */
export const TextPathOptionsSchema = z.looseObject({
	path: TextPathGeometrySchema,
	reversePath: z.boolean(),
	perpendicularToPath: z.boolean(),
	forceAlignment: z.boolean(),
	firstMargin: AnimNumberSchema,
	lastMargin: AnimNumberSchema,
});
export type TextPathOptions = DeepStrip<z.infer<typeof TextPathOptionsSchema>>;

export const TEXT_ANCHOR_GROUPINGS = ['character', 'word', 'line', 'all'] as const;
export const TEXT_FILL_AND_STROKE = ['perCharacter', 'allFillsOverAllStrokes', 'allStrokesOverAllFills'] as const;
/** Inter-Character Blending (the CSS blend modes the browser composites characters with). */
export const TEXT_INTER_CHARACTER_BLENDING = [
	'normal',
	'darken',
	'multiply',
	'color-burn',
	'lighten',
	'screen',
	'color-dodge',
	'overlay',
	'soft-light',
	'hard-light',
	'difference',
	'exclusion',
	'hue',
	'saturation',
	'color',
	'luminosity',
] as const;

/** AE More Options. */
export const TextMoreOptionsSchema = z.looseObject({
	anchorPointGrouping: z.enum(TEXT_ANCHOR_GROUPINGS),
	/** Percent of the group's width / of the font size, added to the pivot. */
	groupingAlignment: AnimVec2Schema,
	fillAndStroke: z.enum(TEXT_FILL_AND_STROKE),
	interCharacterBlending: z.enum(TEXT_INTER_CHARACTER_BLENDING),
});
export type TextMoreOptions = DeepStrip<z.infer<typeof TextMoreOptionsSchema>>;
