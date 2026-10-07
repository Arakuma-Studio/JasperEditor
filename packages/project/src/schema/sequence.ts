// Sequences, tracks, clips, effects, transitions, markers (S01 §7–§13).
import { z } from 'zod';
import {
	AudioChannelFormatSchema,
	LoudnessNormalizeSchema,
	MasterMixerSchema,
	MixerStripSchema,
	SequenceSampleRateSchema,
} from './audio.ts';
import type { DeepStrip } from './common.ts';
import {
	AnimNumberSchema,
	AnimParamSchema,
	AnimRGBASchema,
	AnimVec2Schema,
	ExpressionSchema,
	int,
	keyframeSchema,
	LabelColorSchema,
	nonNegInt,
	RationalSchema,
	RGBASchema,
	Vec2Schema,
} from './common.ts';
import { type VectorShapeData, VectorShapeDataSchema } from './shapes.ts';
import { MaskSchema } from './mask.ts';

// ---------------------------------------------------------------- effects

export const EffectInstanceSchema = z.looseObject({
	id: z.string(),
	effectId: z.string(),
	effectVersion: int(),
	enabled: z.boolean(),
	params: z.record(z.string(), AnimParamSchema),
	/** audio-mix: a track / submix / Mix insert placed after the fader (absent = pre-fader). */
	postFader: z.boolean().optional(),
	/**
	 * audio-fx: this instance is managed by the clip's Essential Sound settings (the slot: `rumble`, `noise`, `dehum`,
	 * `deess`, `reverbReduce`, `dynamics`, `eq`, `enhance`, `width`, `reverb`, `mute`). Absent = the user's own.
	 */
	essential: z.string().optional(),
	/** wp masks: Premiere's per-effect masks (the effect applies inside them). Absent = none. */
	masks: z.array(MaskSchema).optional(),
	/**
	 * Wave expressions (optional): the instance's own name (Effect Controls ▸ Rename, AE's renamed "Slider Control"
	 * → "Speed"); absent = the effect's label. Expressions find effects by this name.
	 */
	name: z.string().optional(),
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
	/** Wave expressions (optional): a Source Text expression; its result (a string) replaces `text` per frame. */
	expression: ExpressionSchema.optional(),
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
	// ---- wp captions (all optional, defaults at read time: `resolveCaptionStyle`)
	/** Vertical placement inside the title-safe area (default `bottom`). */
	placement: z.enum(['bottom', 'middle', 'top']).optional(),
	/** Extra distance from the title-safe edge, % of the frame height (0–45, default 0). */
	marginPct: z.number().min(0).max(45).optional(),
	/** WebVTT `line:N%`: top of the caption block at N % of the frame height; null = placement. */
	linePct: z.number().min(0).max(100).nullable().optional(),
	/** WebVTT `position:N%`: horizontal anchor of the caption block at N % of the frame width; null = centred. */
	positionPct: z.number().min(0).max(100).nullable().optional(),
	// ---- end wp captions
});
export type CaptionStyle = DeepStrip<z.infer<typeof CaptionStyleSchema>>;

/** wp captions: caption track standards (Premiere's caption track "Format"). */
export const CAPTION_STANDARDS = ['subtitle', 'cea-608', 'cea-708', 'teletext'] as const;
export const CaptionStandardSchema = z.enum(CAPTION_STANDARDS);
export type CaptionStandard = DeepStrip<z.infer<typeof CaptionStandardSchema>>;

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
	/** audio-mix: `5.1` added (L, R, C, LFE, Ls, Rs). Absent = stereo. */
	channelFormat: AudioChannelFormatSchema.optional(),
	effects: z.array(EffectInstanceSchema).optional(),
	/** audio-mix: Audio Track Mixer state (automation mode, output, sends, record-arm, lanes). */
	mixer: MixerStripSchema.optional(),
	captionFormat: z.literal('open').optional(),
	visible: z.boolean().optional(),
	styleDefaults: CaptionStyleSchema.optional(),
	// ---- wp captions (caption tracks; optional)
	/** BCP-47 language of the captions (`en`, `fr-CA`); written to embedded streams and sidecars. */
	language: z.string().optional(),
	/** Caption standard of the track (default `subtitle`). */
	captionStandard: CaptionStandardSchema.optional(),
	/** WebVTT STYLE / REGION / NOTE blocks kept from an imported file for round trips. */
	vttBlocks: z.array(z.string()).optional(),
	// ---- end wp captions
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

/**
 * Clip blend modes (keyframes-blend): Premiere Pro's 27 in its menu order (Normal, Dissolve | Darken, Multiply, Color
 * Burn, Linear Burn, Darker Color | Lighten, Screen, Color Dodge, Linear Dodge (Add), Lighter Color | Overlay, Soft
 * Light, Hard Light, Vivid Light, Linear Light, Pin Light, Hard Mix | Difference, Exclusion, Subtract, Divide | Hue,
 * Saturation, Color, Luminosity), then After Effects' utility modes (Stencil / Silhouette Alpha / Luma, Alpha Add).
 * `add` is Linear Dodge (Add) (the id predates the full set). Formulas, groups and labels: `blend-modes.ts`.
 */
export const BLEND_MODES = [
	'normal',
	'dissolve',
	'darken',
	'multiply',
	'color-burn',
	'linear-burn',
	'darker-color',
	'lighten',
	'screen',
	'color-dodge',
	'add',
	'lighter-color',
	'overlay',
	'soft-light',
	'hard-light',
	'vivid-light',
	'linear-light',
	'pin-light',
	'hard-mix',
	'difference',
	'exclusion',
	'subtract',
	'divide',
	'hue',
	'saturation',
	'color',
	'luminosity',
	'stencil-alpha',
	'stencil-luma',
	'silhouette-alpha',
	'silhouette-luma',
	'alpha-add',
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
	// edit-structure: the sound of a synthetic source (Bars and Tone's tone, the counting leader's blips).
	'synthetic-audio',
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
	/**
	 * edit-structure (Premiere Frame Hold, docs/wp-notes/edit-structure.md): the clip shows one frame of its content —
	 * the content time `flicks` — for its whole duration. `holdFilters`: effects, Motion and Opacity keyframes are
	 * evaluated at the held time too (Premiere "Hold Filters"); otherwise they keep animating. Absent = no hold.
	 * Visual clips only (not adjustment layers or captions).
	 */
	frameHold: z.looseObject({ flicks: nonNegInt(), holdFilters: z.boolean().optional() }).optional(),
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

const visualShape = {
	transform: TransformSchema,
	opacity: AnimNumberSchema,
	blendMode: BlendModeSchema,
	effects: z.array(EffectInstanceSchema),
	/** M2 (S09): this clip follows a tracker of another clip. */
	trackedBy: TrackedBySchema.optional(),
	/** wp masks: the Opacity masks of the layer (S03:MSK-001). Absent = none. */
	masks: z.array(MaskSchema).optional(),
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
});
/**
 * audio-fx: one piece of a music remix (Essential Sound ▸ Duration ▸ Remix, the Remix tool). The remixed clip became
 * `count` clips (grouped, constant-power crossfades at the joints); every piece remembers the original clip so the
 * remix can be redone at another duration or reverted.
 */
export const ClipRemixSchema = z.looseObject({
	/** Shared by the pieces of one remix (also their clip group id). */
	id: z.string(),
	index: z.number().int().min(0),
	count: z.number().int().min(1),
	original: z.looseObject({ start: nonNegInt(), duration: z.number().int().min(1), sourceIn: nonNegInt() }),
	targetFrames: z.number().int().min(1),
	segments: z.number().min(0).max(100),
	variations: z.number().min(0).max(100),
	bpm: z.number().positive(),
});
export type ClipRemix = DeepStrip<z.infer<typeof ClipRemixSchema>>;

export const AudioClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('audio'),
	mediaId: z.string(),
	channels: ChannelsSchema,
	gainDb: z.number(),
	volumeDb: AnimNumberSchema,
	pan: AnimNumberSchema,
	effects: z.array(EffectInstanceSchema),
	/** audio-fx: Essential Sound audio type and settings (absent = no type); read with `readEssentialSound`. */
	essential: z.unknown().optional(),
	/** audio-fx: this clip is a piece of a music remix. */
	remix: ClipRemixSchema.optional(),
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
	/** wp captions: the WebVTT cue identifier and cue settings (verbatim) kept from an imported file. */
	cue: z.looseObject({ id: z.string().nullable().optional(), settings: z.string().optional() }).optional(),
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
// ---------------------------------------------------------------- multi-camera (wp-multicam)

/**
 * wp-multicam: the angle a nest clip of a multi-camera source sequence shows (Clip ▸ Multi-Camera). `enabled`
 * false (Multi-Camera ▸ Enable off) = the clip plays like an ordinary nest. `angle` = an angle id of the source's
 * `multicam.angles`: the picture of video clips, and the sound of audio clips when the source switches audio.
 */
export const MulticamSelectionSchema = z.looseObject({
	enabled: z.boolean(),
	angle: z.string(),
});
export type MulticamSelection = DeepStrip<z.infer<typeof MulticamSelectionSchema>>;

export const NestVideoClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('nest-video'),
	sequenceId: z.string(),
	...visualShape,
	/** wp-multicam: present = a multi-camera clip. */
	multicam: MulticamSelectionSchema.optional(),
});
export const NestAudioClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('nest-audio'),
	sequenceId: z.string(),
	gainDb: z.number(),
	volumeDb: AnimNumberSchema,
	pan: AnimNumberSchema,
	effects: z.array(EffectInstanceSchema),
	/** wp-multicam: present = a multi-camera clip. */
	multicam: MulticamSelectionSchema.optional(),
});
export const AdjustmentClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('adjustment'),
	syntheticId: z.string(),
	opacity: AnimNumberSchema,
	blendMode: BlendModeSchema,
	effects: z.array(EffectInstanceSchema),
});

/**
 * edit-structure: the audio half of a synthetic source with sound (`bars-and-tone`: a sine tone; `counting-leader`:
 * its cue blips). Placed linked to the source's `solid` video clip, like a media file's audio clip. Stereo.
 */
export const SyntheticAudioClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('synthetic-audio'),
	syntheticId: z.string(),
	gainDb: z.number(),
	volumeDb: AnimNumberSchema,
	pan: AnimNumberSchema,
	effects: z.array(EffectInstanceSchema),
});

// ---------------------------------------------------------------- shapes (M2, S11:SHP-001, schema v4)

/**
 * `rect` / `ellipse`: the parametric shapes of M2 (size, fill, stroke, corner radius). `vector` (wp shapes): an After
 * Effects-style shape layer whose `contents` hold groups, paths, paints and path operators (`schema/shapes.ts`).
 */
export const SHAPE_TYPES = ['rect', 'ellipse', 'vector'] as const;
export const ShapeTypeSchema = z.enum(SHAPE_TYPES);
export type ShapeType = DeepStrip<z.infer<typeof ShapeTypeSchema>>;
export const LEGACY_SHAPE_TYPES = ['rect', 'ellipse'] as const;
export type LegacyShapeType = (typeof LEGACY_SHAPE_TYPES)[number];
export const SHAPE_STROKE_POSITIONS = ['inside', 'center', 'outside'] as const;
export const ShapeStrokeSchema = z.looseObject({
	color: AnimRGBASchema,
	/** Visible stroke width in layer pixels (whatever the position). */
	width: AnimNumberSchema,
	position: z.enum(SHAPE_STROKE_POSITIONS),
});
export type ShapeStroke = DeepStrip<z.infer<typeof ShapeStrokeSchema>>;
/** Geometry and paint of a rectangle / ellipse clip; every numeric/colour field is an Animatable (KF evaluator). */
export const LegacyShapeDataSchema = z.looseObject({
	type: z.enum(LEGACY_SHAPE_TYPES),
	/** Width and height in layer pixels. */
	size: AnimVec2Schema,
	/** `null` = no fill. */
	fill: AnimRGBASchema.nullable(),
	/** `null` = no stroke. */
	stroke: ShapeStrokeSchema.nullable(),
	/** Rectangle corner radius in layer pixels (ignored by ellipses). */
	cornerRadius: AnimNumberSchema,
});
export type LegacyShapeData = DeepStrip<z.infer<typeof LegacyShapeDataSchema>>;
// Lazy: schema/shapes.ts imports this module (BlendModeSchema); either may be evaluated first.
export const ShapeDataSchema = z.union([LegacyShapeDataSchema, z.lazy(() => VectorShapeDataSchema)]);
export type ShapeData = LegacyShapeData | VectorShapeData;
export const isVectorShape = (s: ShapeData): s is VectorShapeData => s.type === 'vector';
export const isLegacyShape = (s: ShapeData): s is LegacyShapeData => s.type !== 'vector';
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
	SyntheticAudioClipSchema,
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
export type ShapeClip = Omit<DeepStrip<z.infer<typeof ShapeClipSchema>>, 'shape'> & { shape: ShapeData };
/** A rectangle / ellipse shape clip (narrowed by `isLegacyShape(clip.shape)`). */
export type LegacyShapeClip = ShapeClip & { shape: LegacyShapeData };
export type SyntheticAudioClip = DeepStrip<z.infer<typeof SyntheticAudioClipSchema>>;
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
	/**
	 * edit-structure (S01:TRN-003 `handles: 'freeze'`): the transition keeps its duration where the media has too few
	 * frames beyond the cut; the missing handle frames repeat the clip's first / last frame (Premiere's freeze-frame
	 * handles, drawn with a warning stripe). Absent = handles come from the media only.
	 */
	freezeHandles: z.boolean().optional(),
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
	/** audio-mix: 44.1 / 48 / 96 kHz (the mix and exports run at this rate). */
	audioSampleRate: SequenceSampleRateSchema,
	/** audio-mix: channel format of the Mix (stereo, mono or 5.1). */
	masterLayout: AudioChannelFormatSchema,
	backgroundColor: RGBASchema,
	workingColorSpace: z.literal('rec709'),
});
export type SequenceSettings = DeepStrip<z.infer<typeof SequenceSettingsSchema>>;

// ---------------------------------------------------------------- multi-camera sources and merged clips (wp-multicam)

/** Sync point of Synchronize, Merge Clips and Create Multi-Camera Source Sequence. */
export const SYNC_METHODS = ['in', 'out', 'timecode', 'marker', 'audio'] as const;
export const SyncMethodSchema = z.enum(SYNC_METHODS);
export type SyncMethod = DeepStrip<z.infer<typeof SyncMethodSchema>>;

/**
 * Multi-camera source audio (Create Multi-Camera Source Sequence ▸ Audio): `camera1` plays the first video angle's
 * audio, `all` mixes every camera, `switch` plays the selected angle's audio (multi-camera audio clips switch with
 * their angle). Audio-only angles always play.
 */
export const MULTICAM_AUDIO_MODES = ['camera1', 'all', 'switch'] as const;
export const MulticamAudioModeSchema = z.enum(MULTICAM_AUDIO_MODES);
export type MulticamAudioMode = DeepStrip<z.infer<typeof MulticamAudioModeSchema>>;

/** One camera (angle) of a multi-camera source sequence: one video track plus its audio tracks. */
export const MulticamAngleSchema = z.looseObject({
	/** Stable id within the source (the id of the track the angle was created on). */
	id: z.string(),
	name: z.string(),
	/** null = an audio-only source: never an angle of the grid, mixed in by every audio mode. */
	videoTrackId: z.string().nullable(),
	audioTrackIds: z.array(z.string()),
	/** Shown in the Multi-Camera view (Edit Cameras); hidden angles keep their clips. */
	enabled: z.boolean(),
	/** Project item the angle was made from (informational, Match Frame). */
	itemId: z.string().nullable().optional(),
});
export type MulticamAngle = DeepStrip<z.infer<typeof MulticamAngleSchema>>;

/** What makes a sequence a multi-camera source sequence. Angle order = camera order (Camera 1 = angles[0]). */
export const MulticamSourceSchema = z.looseObject({
	angles: z.array(MulticamAngleSchema),
	audio: MulticamAudioModeSchema,
	/** How the cameras were synchronised (informational). */
	sync: SyncMethodSchema.optional(),
});
export type MulticamSource = DeepStrip<z.infer<typeof MulticamSourceSchema>>;

/**
 * What makes a sequence a merged clip (Clip ▸ Merge Clips): one video clip on V1 and its separately recorded audio
 * on the audio tracks, synchronised. Placing it edits the clips it holds (linked), not a nest.
 */
export const MergedClipSchema = z.looseObject({
	videoItemId: z.string().nullable(),
	audioItemIds: z.array(z.string()),
	sync: SyncMethodSchema,
	removeVideoAudio: z.boolean(),
});
export type MergedClip = DeepStrip<z.infer<typeof MergedClipSchema>>;

export const SequenceSchema = z.looseObject({
	id: z.string(),
	settings: SequenceSettingsSchema,
	videoTracks: z.array(TrackSchema),
	audioTracks: z.array(TrackSchema),
	captionTracks: z.array(TrackSchema),
	master: z.looseObject({
		volumeDb: AnimNumberSchema,
		effects: z.array(EffectInstanceSchema),
		/** audio-mix: the Mix's automation mode. */
		mixer: MasterMixerSchema.optional(),
		/** audio-mix: loudness normalisation of the Mix (preview and export). */
		loudness: LoudnessNormalizeSchema.optional(),
	}),
	/** audio-mix: submix tracks (buses without clips), mixer order S1, S2 … */
	submixTracks: z.array(TrackSchema).optional(),
	clips: z.record(z.string(), ClipSchema),
	transitions: z.record(z.string(), TransitionSchema),
	links: z.record(z.string(), LinkGroupSchema),
	groups: z.record(z.string(), ClipGroupSchema),
	markers: z.array(MarkerSchema),
	inPoint: nonNegInt().nullable(),
	outPoint: nonNegInt().nullable(),
	workArea: z.looseObject({ start: nonNegInt(), end: nonNegInt() }).nullable(),
	/** wp-multicam: present = a multi-camera source sequence. */
	multicam: MulticamSourceSchema.optional(),
	/** wp-multicam: present = a merged clip. */
	merged: MergedClipSchema.optional(),
	/** wp captions: the caption track the Captions panel edits and that export embeds first (null = C1). */
	activeCaptionTrackId: z.string().nullable().optional(),
});
export type Sequence = Omit<DeepStrip<z.infer<typeof SequenceSchema>>, 'clips'> & {
	clips: Record<string, Clip>;
};
