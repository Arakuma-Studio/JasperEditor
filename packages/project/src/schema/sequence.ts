// Sequences, tracks, clips, effects, transitions, markers (S01 §7–§13).
import { z } from 'zod';
import type { DeepStrip } from './common.ts';
import {
	AnimNumberSchema,
	AnimParamSchema,
	AnimRGBASchema,
	AnimVec2Schema,
	int,
	keyframeSchema,
	LabelColorSchema,
	nonNegInt,
	RationalSchema,
	RGBASchema,
	Vec2Schema,
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

/**
 * M2 (S11:TXA-001, schema v4): one in/out animator of a text clip. `preset` + `version` name a catalogue entry
 * (`TEXT_ANIMATION_SPECS`, implementations in `@jasper/motion/text`); `durationFrames` is the window length in
 * sequence frames; `params` are the preset's params (validated by its schema; unknown presets are preserved).
 */
export const TextAnimatorSchema = z.looseObject({
	preset: z.string(),
	version: int(),
	durationFrames: z.number().int().min(1),
	params: z.record(z.string(), z.unknown()),
});
export type TextAnimator = DeepStrip<z.infer<typeof TextAnimatorSchema>>;
/** `null` / absent side = no animator on that side. */
export const TextAnimationSchema = z.looseObject({
	in: TextAnimatorSchema.nullable().optional(),
	out: TextAnimatorSchema.nullable().optional(),
});
export type TextAnimation = DeepStrip<z.infer<typeof TextAnimationSchema>>;

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
	// M2 (S11:SHP-001, schema v4)
	'shape',
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
// ---------------------------------------------------------------- tracking (M2, ARCHITECTURE §19.5, S09)

/**
 * Dense per-frame tracker output in the tracked clip's content time. Sample `i` is at content time
 * `start + i·step`; its values are `data[i·stride … i·stride+stride−1]` in **media pixels** of the tracked clip's
 * source (before its Motion): planar = 8 numbers (TL, TR, BR, BL corners, x then y), point = 2 numbers.
 * A lost sample has confidence 0 and repeats the previous values.
 */
export const TrackerSamplesSchema = z.looseObject({
	start: nonNegInt(),
	step: z.number().int().positive(),
	stride: z.union([z.literal(2), z.literal(8)]),
	data: z.array(z.number()),
	confidence: z.array(z.number().min(0).max(1)),
});
export type TrackerSamples = DeepStrip<z.infer<typeof TrackerSamplesSchema>>;

export const ClipTrackerSchema = z.looseObject({
	id: z.string(),
	name: z.string(),
	kind: z.enum(['point', 'planar']),
	/** Where the user placed the region: content time and media-pixel geometry. */
	reference: z.looseObject({
		time: nonNegInt(),
		/** planar: TL, TR, BR, BL. */
		corners: z.array(Vec2Schema).length(4).optional(),
		/** point: centre of the template. */
		point: Vec2Schema.optional(),
		/** point: template edge in media pixels. */
		patch: z.number().int().positive().optional(),
		/** Search radius in media pixels. */
		search: z.number().int().positive().optional(),
	}),
	samples: TrackerSamplesSchema.nullable(),
	/** Tracker algorithm and version that produced `samples`, e.g. `klt-homography@1`. */
	method: z.string(),
	/** Temporal smoothing radius (frames) applied when the samples are applied to a target. */
	smoothing: z.number().min(0).optional(),
});
export type ClipTracker = DeepStrip<z.infer<typeof ClipTrackerSchema>>;

/** On a target clip: which tracker drives it and how (re-applied by `tracker.apply`, shown in the UI). */
export const TrackedBySchema = z.looseObject({
	clipId: z.string(),
	trackerId: z.string(),
	mode: z.enum(['corner-pin', 'transform']),
	/** Corner-pin effect instance written by the apply (mode `corner-pin`). */
	effectInstanceId: z.string().optional(),
	/**
	 * M3 (wp-m3-trackui, S09:TRK-023): the baked keys were simplified with this tolerance (sequence px); re-applying
	 * the tracker from the UI simplifies again with it.
	 */
	simplify: z.looseObject({ tolerance: z.number().positive() }).optional(),
});
export type TrackedBy = DeepStrip<z.infer<typeof TrackedBySchema>>;

// ---------------------------------------------------------------- roto / object mattes (parity: roto)

/**
 * A Roto Brush stroke on one source frame: a polyline swept by a disc, in **media pixels** of the clip's source
 * (display orientation). `fg` / `bg` select / exclude (hard constraints of the graph cut), `refine` / `refineErase`
 * paint / erase the Refine Edge band (edge matting).
 */
export const RotoStrokeSchema = z.looseObject({
	kind: z.enum(['fg', 'bg', 'refine', 'refineErase']),
	/** Media frame (index at `ClipRoto.rate`). */
	frame: nonNegInt(),
	radius: z.number().positive().max(10_000),
	points: z.array(Vec2Schema).min(1),
});
export type RotoStroke = DeepStrip<z.infer<typeof RotoStrokeSchema>>;

/** A box prompt on one source frame ([x0, y0, x1, y1] media px): outside is background (GrabCut's rectangle). */
export const RotoBoxSchema = z.looseObject({
	frame: nonNegInt(),
	rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});
export type RotoBox = DeepStrip<z.infer<typeof RotoBoxSchema>>;

/** Segmentation / tracking settings (absent = the defaults of `rotoSettingsOf`). */
export const RotoSettingsSchema = z.looseObject({
	/** `model`: SAM 2.1 (when installed) as a prior of the graph cut; `classic`: colour models only. */
	engine: z.enum(['model', 'classic']).optional(),
	/** Model id of the processing-model catalogue (segmentation models). */
	model: z.string().min(1).optional(),
	quality: z.enum(['standard', 'best']).optional(),
	/** Propagation: Search Radius (media px), Motion Threshold / Motion Damping (%). */
	searchRadius: z.number().min(0).max(200).optional(),
	motionThreshold: z.number().min(0).max(100).optional(),
	motionDamping: z.number().min(0).max(100).optional(),
	/** Edge refinement baked into the matte: off, guided filter, or guided + closed-form matting. */
	edgeMode: z.enum(['off', 'guided', 'closed-form']).optional(),
	/** Width (media px) of the automatic edge band; 0 = only Refine Edge strokes. */
	edgeRadius: z.number().min(0).max(100).optional(),
	edgeSmooth: z.number().min(0).max(100).optional(),
	/** Faces: detection confidence 0..1, outline growth (%), shape. */
	faceThreshold: z.number().min(0.05).max(0.99).optional(),
	faceExpand: z.number().min(-50).max(200).optional(),
	faceShape: z.enum(['outline', 'ellipse']).optional(),
});
export type RotoSettings = DeepStrip<z.infer<typeof RotoSettingsSchema>>;

/**
 * Where the computed mattes are: an engine matte store `key` holding one 8-bit matte per media frame of
 * [`start`, `end`] at `width × height`; `inputs` = `rotoInputsHash` of the roto they were computed from (stale when it
 * differs); `model` = the model id used (null: classic engine).
 */
export const RotoResultSchema = z.looseObject({
	key: z.string().min(1),
	start: nonNegInt(),
	end: nonNegInt(),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	inputs: z.string(),
	model: z.string().nullable(),
});
export type RotoResult = DeepStrip<z.infer<typeof RotoResultSchema>>;

/**
 * A segmented object on a video or still clip (After Effects' Roto Brush span, or the faces found by face
 * tracking). Frames are media frames at `rate` (the source's frame rate); geometry is media pixels. Effects
 * reference it by id (`object` param of `jasper.object-matte` / `jasper.object-blur` / mask inputs).
 */
export const ClipRotoSchema = z.looseObject({
	id: z.string(),
	name: z.string(),
	kind: z.enum(['brush', 'faces']),
	/** The media the strokes and mattes belong to (the clip's media when drawn). */
	mediaId: z.string(),
	rate: RationalSchema,
	/** Base frame: where segmentation starts (the first frame with a selecting stroke / box); null = none yet. */
	base: nonNegInt().nullable(),
	/** Segmentation span (inclusive media frames). */
	span: z.tuple([nonNegInt(), nonNegInt()]),
	strokes: z.array(RotoStrokeSchema),
	boxes: z.array(RotoBoxSchema).optional(),
	settings: RotoSettingsSchema,
	result: RotoResultSchema.nullable(),
	/** Freeze: the computed mattes are kept permanently and the roto cannot be edited until unfrozen. */
	frozen: z.boolean().optional(),
});
export type ClipRoto = DeepStrip<z.infer<typeof ClipRotoSchema>>;

const visualShape = {
	transform: TransformSchema,
	opacity: AnimNumberSchema,
	blendMode: BlendModeSchema,
	effects: z.array(EffectInstanceSchema),
	/** M2 (S09): this clip follows a tracker of another clip. */
	trackedBy: TrackedBySchema.optional(),
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
	/** M2 (S09): trackers placed on this clip's picture. */
	trackers: z.array(ClipTrackerSchema).optional(),
	/** parity (roto): segmented objects (Roto Brush, faces) of this clip's picture. */
	rotos: z.array(ClipRotoSchema).optional(),
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
	/** parity (roto): segmented objects of the still (one frame). */
	rotos: z.array(ClipRotoSchema).optional(),
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
	/** M2 (S11:TXA-001): in/out animators (schema v4). */
	textAnimation: TextAnimationSchema.optional(),
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
/** M2 (S11:ATP-001): how a motion-graphic template is drawn — `fframes` (jasper-mg + SVG twin) or `anime`. */
export const MG_RENDERERS = ['fframes', 'anime'] as const;
export const MgRendererSchema = z.enum(MG_RENDERERS);
export type MgRenderer = DeepStrip<z.infer<typeof MgRendererSchema>>;

/** wp-m2-anime-templates (S11:ATP-006): one keyframe of an anime template param (a number or an RGBA tuple). */
export const MgParamKeyframeSchema = keyframeSchema(z.union([z.number(), z.array(z.number())]));

export const MotionGraphicClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('motion-graphic'),
	/**
	 * M2 (S11:ATP-002, schema v4): `renderer` is stamped from the template registry by `clip.addMotionGraphic`;
	 * absent = `fframes` (the M1 templates).
	 */
	template: z.looseObject({ id: z.string(), version: int(), renderer: MgRendererSchema.optional() }),
	params: z.record(z.string(), z.unknown()),
	// ---- wp-m2-anime-templates (S11:ATP-006): keyframes of numeric/colour params of anime templates, per param
	// name, in content time (flicks). The static value stays in `params`; absent/empty = not animated.
	paramKeyframes: z.record(z.string(), z.array(MgParamKeyframeSchema)).optional(),
	// ---- end wp-m2-anime-templates
	canvas: canvasSchema,
	...visualShape,
});
export const CompositionClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('composition'),
	/**
	 * M2 (S08): `mediaId` = the `mg-bundle` asset, `id` = the composition id inside the bundle, `version` = 1.
	 * (`mediaId` is optional in the schema only because v1 documents had no composition clips with it.)
	 */
	composition: z.looseObject({ id: z.string(), version: int(), mediaId: z.string().optional() }),
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

// ---------------------------------------------------------------- shapes (M2, S11:SHP-001, schema v4)

export const SHAPE_TYPES = ['rect', 'ellipse'] as const;
export const ShapeTypeSchema = z.enum(SHAPE_TYPES);
export type ShapeType = DeepStrip<z.infer<typeof ShapeTypeSchema>>;
export const SHAPE_STROKE_POSITIONS = ['inside', 'center', 'outside'] as const;
export const ShapeStrokeSchema = z.looseObject({
	color: AnimRGBASchema,
	/** Visible stroke width in layer pixels (whatever the position). */
	width: AnimNumberSchema,
	position: z.enum(SHAPE_STROKE_POSITIONS),
});
export type ShapeStroke = DeepStrip<z.infer<typeof ShapeStrokeSchema>>;
/** Geometry and paint of a shape clip; every numeric/colour field is an Animatable (KF evaluator). */
export const ShapeDataSchema = z.looseObject({
	type: ShapeTypeSchema,
	/** Width and height in layer pixels. */
	size: AnimVec2Schema,
	/** `null` = no fill. */
	fill: AnimRGBASchema.nullable(),
	/** `null` = no stroke. */
	stroke: ShapeStrokeSchema.nullable(),
	/** Rectangle corner radius in layer pixels (ignored by ellipses). */
	cornerRadius: AnimNumberSchema,
});
export type ShapeData = DeepStrip<z.infer<typeof ShapeDataSchema>>;
export const ShapeClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('shape'),
	shape: ShapeDataSchema,
	...visualShape,
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
	ShapeClipSchema,
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
export type ShapeClip = DeepStrip<z.infer<typeof ShapeClipSchema>>;
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
	| NestVideoClip
	| ShapeClip;

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
