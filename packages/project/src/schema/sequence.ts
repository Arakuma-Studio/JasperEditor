// Sequences, tracks, clips, effects, transitions, markers (S01 §7–§13).
import { z } from 'zod';
import type { DeepStrip } from './common.ts';
import {
	AnimNumberSchema,
	AnimParamSchema,
	AnimVec2Schema,
	int,
	LabelColorSchema,
	nonNegInt,
	RationalSchema,
	RGBASchema,
} from './common.ts';

// ---------------------------------------------------------------- effects

export const EffectInstanceSchema = z.looseObject({
	id: z.string(),
	effectId: z.string(),
	effectVersion: int(),
	enabled: z.boolean(),
	params: z.record(z.string(), AnimParamSchema),
});
export type EffectInstance = DeepStrip<z.infer<typeof EffectInstanceSchema>>;

// ---------------------------------------------------------------- text

export const TextStrokeSchema = z.looseObject({
	color: RGBASchema,
	widthPx: z.number().min(0),
	position: z.enum(['outside', 'center', 'inside']),
});
export const TextStyleSchema = z.looseObject({
	fontId: z.string(),
	weight: z.number().int().min(1).max(1000),
	italic: z.boolean(),
	sizePx: z.number().positive(),
	lineHeight: z.number().positive(),
	trackingEm: z.number(),
	align: z.enum(['left', 'center', 'right', 'justify']),
	direction: z.enum(['ltr', 'rtl', 'auto']),
	fill: RGBASchema,
	strokes: z.array(TextStrokeSchema),
	background: z
		.looseObject({ color: RGBASchema, paddingPx: z.number().min(0), radiusPx: z.number().min(0) })
		.nullable(),
	shadow: z
		.looseObject({
			color: RGBASchema,
			angleDeg: z.number(),
			distancePx: z.number(),
			blurPx: z.number().min(0),
		})
		.nullable(),
	allCaps: z.boolean(),
});
export type TextStyle = DeepStrip<z.infer<typeof TextStyleSchema>>;

export const TextContentSchema = z.looseObject({
	text: z.string(),
	style: TextStyleSchema,
	runs: z
		.array(z.looseObject({ from: nonNegInt(), to: nonNegInt(), style: TextStyleSchema.partial() }))
		.optional(),
});
export type TextContent = DeepStrip<z.infer<typeof TextContentSchema>>;

export const TextBoxSchema = z.looseObject({
	width: z.number().min(0),
	height: z.number().min(0),
	autoSize: z.enum(['none', 'width', 'height']),
});
export type TextBox = DeepStrip<z.infer<typeof TextBoxSchema>>;

export const CaptionStyleSchema = TextStyleSchema.extend({
	highlight: z.looseObject({ mode: z.enum(['none', 'word', 'karaoke']), color: RGBASchema }),
	maxLines: z.number().int().positive(),
	maxCharsPerLine: z.number().int().positive(),
	maxSegmentMs: z.number().positive(),
	minGapMs: z.number().min(0),
	boxWidthPct: z.number().positive().max(100),
});
export type CaptionStyle = DeepStrip<z.infer<typeof CaptionStyleSchema>>;

// ---------------------------------------------------------------- tracks

export const TRACK_KINDS = ['video', 'audio', 'caption'] as const;
export const TrackKindSchema = z.enum(TRACK_KINDS);
export type TrackKind = DeepStrip<z.infer<typeof TrackKindSchema>>;

export const TrackSchema = z.looseObject({
	id: z.string(),
	kind: TrackKindSchema,
	name: z.string().nullable(),
	locked: z.boolean(),
	syncLock: z.boolean(),
	output: z.boolean().optional(),
	mute: z.boolean().optional(),
	solo: z.boolean().optional(),
	volumeDb: AnimNumberSchema.optional(),
	pan: AnimNumberSchema.optional(),
	channelFormat: z.enum(['mono', 'stereo']).optional(),
	effects: z.array(EffectInstanceSchema).optional(),
	captionFormat: z.literal('open').optional(),
	visible: z.boolean().optional(),
	styleDefaults: CaptionStyleSchema.optional(),
});
export type Track = DeepStrip<z.infer<typeof TrackSchema>>;

// ---------------------------------------------------------------- markers

export const MARKER_TYPES = ['comment', 'chapter', 'segmentation', 'web-link', 'agent-note'] as const;
export const MarkerTypeSchema = z.enum(MARKER_TYPES);
export type MarkerType = DeepStrip<z.infer<typeof MarkerTypeSchema>>;
export const AuthorSchema = z.union([z.literal('user'), z.looseObject({ agent: z.string() })]);
export type Author = DeepStrip<z.infer<typeof AuthorSchema>>;

const markerBase = {
	id: z.string(),
	duration: nonNegInt(),
	name: z.string(),
	comment: z.string(),
	color: LabelColorSchema,
	type: MarkerTypeSchema,
	url: z.string().optional(),
	author: AuthorSchema,
};
export const MarkerSchema = z.looseObject({ ...markerBase, frame: nonNegInt() });
export type Marker = DeepStrip<z.infer<typeof MarkerSchema>>;
/** Clip markers live in content time (S01:SEQ-008). */
export const ClipMarkerSchema = z.looseObject({ ...markerBase, flicks: nonNegInt() });
export type ClipMarker = DeepStrip<z.infer<typeof ClipMarkerSchema>>;

// ---------------------------------------------------------------- clips

export const BLEND_MODES = [
	'normal',
	'multiply',
	'screen',
	'overlay',
	'darken',
	'lighten',
	'add',
	'difference',
] as const;
export const BlendModeSchema = z.enum(BLEND_MODES);
export type BlendMode = DeepStrip<z.infer<typeof BlendModeSchema>>;

export const TransformSchema = z.looseObject({
	position: AnimVec2Schema,
	anchor: AnimVec2Schema,
	scale: AnimNumberSchema,
	scaleWidth: AnimNumberSchema,
	uniformScale: z.boolean(),
	rotation: AnimNumberSchema,
	flipH: z.boolean(),
	flipV: z.boolean(),
});
export type Transform = DeepStrip<z.infer<typeof TransformSchema>>;

export const SpeedSchema = z.looseObject({
	rate: z.number().min(0.01).max(100),
	reverse: z.boolean(),
	maintainPitch: z.boolean(),
});
export type Speed = DeepStrip<z.infer<typeof SpeedSchema>>;

export const KNOWN_CLIP_KINDS = [
	'video',
	'audio',
	'still',
	'animated-image',
	'text',
	'solid',
	'captions',
	'motion-graphic',
	'composition',
	'nest-video',
	'nest-audio',
	'adjustment',
] as const;
export type KnownClipKind = (typeof KNOWN_CLIP_KINDS)[number];

const commonShape = {
	id: z.string(),
	trackId: z.string(),
	start: nonNegInt(),
	duration: z.number().int().min(1),
	sourceIn: nonNegInt(),
	speed: SpeedSchema,
	name: z.string(),
	label: LabelColorSchema,
	enabled: z.boolean(),
	linkId: z.string().nullable(),
	groupId: z.string().nullable(),
	markers: z.array(ClipMarkerSchema),
};
const visualShape = {
	transform: TransformSchema,
	opacity: AnimNumberSchema,
	blendMode: BlendModeSchema,
	effects: z.array(EffectInstanceSchema),
};
const canvasSchema = z.union([
	z.literal('sequence'),
	z.looseObject({ width: z.number().int().positive(), height: z.number().int().positive() }),
]);
export type ClipCanvas = DeepStrip<z.infer<typeof canvasSchema>>;
export const ChannelsSchema = z.looseObject({ streamIndex: nonNegInt(), map: z.array(nonNegInt()) });

export const VideoClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('video'),
	mediaId: z.string(),
	videoStreamIndex: nonNegInt(),
	...visualShape,
});
export const AudioClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('audio'),
	mediaId: z.string(),
	channels: ChannelsSchema,
	gainDb: z.number(),
	volumeDb: AnimNumberSchema,
	pan: AnimNumberSchema,
	effects: z.array(EffectInstanceSchema),
});
export const StillClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('still'),
	mediaId: z.string(),
	...visualShape,
});
export const AnimatedImageClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('animated-image'),
	mediaId: z.string(),
	loop: z.boolean(),
	...visualShape,
});
export const TextClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('text'),
	content: TextContentSchema,
	box: TextBoxSchema,
	layoutPending: z.boolean().optional(),
	...visualShape,
});
export const SolidClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('solid'),
	syntheticId: z.string(),
	...visualShape,
});
export const CaptionsClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('captions'),
	transcriptId: z.string(),
	style: CaptionStyleSchema.partial(),
	transform: TransformSchema,
	opacity: AnimNumberSchema,
});
export const MotionGraphicClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('motion-graphic'),
	template: z.looseObject({ id: z.string(), version: int() }),
	params: z.record(z.string(), z.unknown()),
	canvas: canvasSchema,
	...visualShape,
});
export const CompositionClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('composition'),
	composition: z.looseObject({ id: z.string(), version: int() }),
	props: z.record(z.string(), z.unknown()),
	canvas: canvasSchema,
	...visualShape,
});
export const NestVideoClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('nest-video'),
	sequenceId: z.string(),
	...visualShape,
});
export const NestAudioClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('nest-audio'),
	sequenceId: z.string(),
	gainDb: z.number(),
	volumeDb: AnimNumberSchema,
	pan: AnimNumberSchema,
	effects: z.array(EffectInstanceSchema),
});
export const AdjustmentClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('adjustment'),
	syntheticId: z.string(),
	opacity: AnimNumberSchema,
	blendMode: BlendModeSchema,
	effects: z.array(EffectInstanceSchema),
});

export const KnownClipSchema = z.discriminatedUnion('kind', [
	VideoClipSchema,
	AudioClipSchema,
	StillClipSchema,
	AnimatedImageClipSchema,
	TextClipSchema,
	SolidClipSchema,
	CaptionsClipSchema,
	MotionGraphicClipSchema,
	CompositionClipSchema,
	NestVideoClipSchema,
	NestAudioClipSchema,
	AdjustmentClipSchema,
]);

export type VideoClip = DeepStrip<z.infer<typeof VideoClipSchema>>;
export type AudioClip = DeepStrip<z.infer<typeof AudioClipSchema>>;
export type StillClip = DeepStrip<z.infer<typeof StillClipSchema>>;
export type AnimatedImageClip = DeepStrip<z.infer<typeof AnimatedImageClipSchema>>;
export type TextClip = DeepStrip<z.infer<typeof TextClipSchema>>;
export type SolidClip = DeepStrip<z.infer<typeof SolidClipSchema>>;
export type CaptionsClip = DeepStrip<z.infer<typeof CaptionsClipSchema>>;
export type MotionGraphicClip = DeepStrip<z.infer<typeof MotionGraphicClipSchema>>;
export type CompositionClip = DeepStrip<z.infer<typeof CompositionClipSchema>>;
export type NestVideoClip = DeepStrip<z.infer<typeof NestVideoClipSchema>>;
export type NestAudioClip = DeepStrip<z.infer<typeof NestAudioClipSchema>>;
export type AdjustmentClip = DeepStrip<z.infer<typeof AdjustmentClipSchema>>;
export type KnownClip = DeepStrip<z.infer<typeof KnownClipSchema>>;

const ClipCommonSchema = z.looseObject(commonShape);
export type ClipCommon = DeepStrip<z.infer<typeof ClipCommonSchema>>;

/**
 * A clip kind written by a newer version (S01:KND-030). At runtime `kind` holds whatever string the newer
 * version wrote; the type uses a sentinel literal so `switch (clip.kind)` on known kinds narrows. Detect
 * unknown clips with `isKnownClipKind(clip.kind)` — never by comparing against the sentinel.
 */
export type UnknownClipKind = '(unknown)';
export type UnknownClip = ClipCommon & { kind: UnknownClipKind };

const KNOWN_KIND_SET = new Set<string>(KNOWN_CLIP_KINDS);
export function isKnownClipKind(kind: string): kind is KnownClipKind {
	return KNOWN_KIND_SET.has(kind);
}

/** Unknown kinds are preserved verbatim; they only need the common fields to occupy their range. */
export const UnknownClipSchema = z.looseObject({
	...commonShape,
	kind: z.string().refine((k) => !KNOWN_KIND_SET.has(k), { message: 'known kind' }),
}) as unknown as z.ZodType<UnknownClip>;

export const ClipSchema = z.union([KnownClipSchema, UnknownClipSchema]);
export type Clip = KnownClip | UnknownClip;
export type ClipKind = Clip['kind'];

/** Clips with visual Motion/Opacity properties. */
export type VisualClip =
	| VideoClip
	| StillClip
	| AnimatedImageClip
	| TextClip
	| SolidClip
	| MotionGraphicClip
	| CompositionClip
	| NestVideoClip;

// ---------------------------------------------------------------- transitions, links, groups

export const TransitionSchema = z.looseObject({
	id: z.string(),
	trackId: z.string(),
	effectId: z.string(),
	effectVersion: int(),
	outgoingClipId: z.string().nullable(),
	incomingClipId: z.string().nullable(),
	duration: z.number().int().min(1),
	alignment: z.enum(['center', 'start-at-cut', 'end-at-cut']),
	params: z.record(z.string(), AnimParamSchema),
});
export type Transition = DeepStrip<z.infer<typeof TransitionSchema>>;

export const LinkGroupSchema = z.looseObject({ id: z.string(), members: z.array(z.string()) });
export type LinkGroup = DeepStrip<z.infer<typeof LinkGroupSchema>>;
export const ClipGroupSchema = z.looseObject({ id: z.string(), members: z.array(z.string()) });
export type ClipGroup = DeepStrip<z.infer<typeof ClipGroupSchema>>;

// ---------------------------------------------------------------- sequence

export const SequenceSettingsSchema = z.looseObject({
	frameRate: RationalSchema,
	width: z.number().int(),
	height: z.number().int(),
	pixelAspect: z.looseObject({ num: z.literal(1), den: z.literal(1) }),
	dropFrame: z.boolean(),
	startTimecodeFrames: nonNegInt(),
	audioSampleRate: z.literal(48000),
	masterLayout: z.literal('stereo'),
	backgroundColor: RGBASchema,
	workingColorSpace: z.literal('rec709'),
});
export type SequenceSettings = DeepStrip<z.infer<typeof SequenceSettingsSchema>>;

export const SequenceSchema = z.looseObject({
	id: z.string(),
	settings: SequenceSettingsSchema,
	videoTracks: z.array(TrackSchema),
	audioTracks: z.array(TrackSchema),
	captionTracks: z.array(TrackSchema),
	master: z.looseObject({ volumeDb: AnimNumberSchema, effects: z.array(EffectInstanceSchema) }),
	clips: z.record(z.string(), ClipSchema),
	transitions: z.record(z.string(), TransitionSchema),
	links: z.record(z.string(), LinkGroupSchema),
	groups: z.record(z.string(), ClipGroupSchema),
	markers: z.array(MarkerSchema),
	inPoint: nonNegInt().nullable(),
	outPoint: nonNegInt().nullable(),
	workArea: z.looseObject({ start: nonNegInt(), end: nonNegInt() }).nullable(),
});
export type Sequence = Omit<DeepStrip<z.infer<typeof SequenceSchema>>, 'clips'> & {
	clips: Record<string, Clip>;
};
