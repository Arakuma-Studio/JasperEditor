// Sequences, tracks, clips, effects, transitions, markers (S01 §7–§13).

import { z } from 'zod';
import type { AudioEdgeFades } from '../audio-fade.ts';
import type { SequenceCleanup } from '../cleanup/schema.ts';
import { ColorInterpretationSchema, SequenceColorSchema } from '../color/model.ts';
import { GraphicSettingsSchema, LayerPinsSchema } from '../gaps/graphics-schema.ts';
import { WarpAnalysisDataSchema } from '../gaps/warp/analysis.ts';
import {
	AudioChannelFormatSchema,
	LoudnessNormalizeSchema,
	MasterMixerSchema,
	MixerStripSchema,
	SequenceSampleRateSchema,
} from './audio.ts';
import { BlendModeSchema } from './blend.ts';
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
import { MaskSchema } from './mask.ts';
import { PuppetSchema } from './puppet.ts';
import { type VectorShapeData, VectorShapeDataSchema } from './shapes.ts';
import type { ClipBed, ClipSfx, SoundDesign } from './sound.ts';
import { TextAnimatorGroupSchema, TextMoreOptionsSchema, TextPathOptionsSchema } from './text-animators.ts';
import {
	CameraDataSchema,
	ClipCameraTrackerSchema,
	Layer3DSchema,
	LightDataSchema,
	Sequence3DSchema,
} from './three-d.ts';

export { BLEND_MODES, type BlendMode, BlendModeSchema } from './blend.ts';

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
	/** sim-warp: the Puppet effect's meshes and pins (absent = none). */
	puppet: PuppetSchema.optional(),
	/**
	 * Wave expressions (optional): the instance's own name (Effect Controls ▸ Rename, AE's renamed "Slider Control"
	 * → "Speed"); absent = the effect's label. Expressions find effects by this name.
	 */
	name: z.string().optional(),
	/**
	 * gaps (FX-6): the Warp Stabilizer's analysis of the clip, stored with the effect as Premiere does (absent = not
	 * analysed). See `gaps/warp/analysis.ts`.
	 */
	warpAnalysis: WarpAnalysisDataSchema.optional(),
});
export type EffectInstance = DeepStrip<z.infer<typeof EffectInstanceSchema>>;

// typography value schemas.
export const TEXT_SCRIPTS = ['normal', 'superscript', 'subscript'] as const;
export const TEXT_JUSTIFY_LAST = ['left', 'center', 'right', 'justify'] as const;
export const TEXT_FIGURE_STYLES = ['default', 'lining', 'oldStyle'] as const;
export const TEXT_FIGURE_WIDTHS = ['default', 'proportional', 'tabular'] as const;
export const TextKerningSchema = z.union([z.enum(['metrics', 'optical']), z.number().min(-1000).max(10000)]);
/** OpenType features beyond kerning / ligatures / small caps / scripts (AE Character panel ▸ OpenType). */
export const TextOpenTypeSchema = z.looseObject({
	discretionaryLigatures: z.boolean().optional(),
	contextualAlternates: z.boolean().optional(),
	stylisticAlternates: z.boolean().optional(),
	/** Stylistic sets on (1…20 → `ss01`…`ss20`). */
	stylisticSets: z.array(z.number().int().min(1).max(20)).optional(),
	swash: z.boolean().optional(),
	titling: z.boolean().optional(),
	ordinals: z.boolean().optional(),
	fractions: z.boolean().optional(),
	allSmallCaps: z.boolean().optional(),
	figureStyle: z.enum(TEXT_FIGURE_STYLES).optional(),
	figureWidth: z.enum(TEXT_FIGURE_WIDTHS).optional(),
});
export type TextOpenType = DeepStrip<z.infer<typeof TextOpenTypeSchema>>;

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
	// typography.ts supplies read-time defaults. Character settings apply per styled run;
	// paragraph settings apply per entry in paragraphs.
	/** `metrics` (font kerning, default), `optical` (from the outlines) or manual 1/1000 em before each character. */
	kerning: TextKerningSchema.optional(),
	/** Pixels, positive = up (default 0). */
	baselineShiftPx: z.number().optional(),
	/** Percent (0…100) of the space around each character removed (default 0). */
	tsume: z.number().min(0).max(100).optional(),
	fauxBold: z.boolean().optional(),
	fauxItalic: z.boolean().optional(),
	smallCaps: z.boolean().optional(),
	/** Superscript / subscript (58.3 % size, ±33.3 % of the size; default normal). */
	script: z.enum(TEXT_SCRIPTS).optional(),
	/** Standard ligatures (`liga`, `clig`; default on). */
	ligatures: z.boolean().optional(),
	openType: TextOpenTypeSchema.optional(),
	/** Variable font axis values by 4-letter tag (e.g. `{wght: 650}`), user units. */
	fontVariations: z.record(z.string().regex(/^[\x20-\x7e]{4}$/), z.number()).optional(),
	/** Alignment of the last line when `align` is `justify` (default left). */
	justifyLast: z.enum(TEXT_JUSTIFY_LAST).optional(),
	indentLeftPx: z.number().optional(),
	indentRightPx: z.number().optional(),
	indentFirstLinePx: z.number().optional(),
	spaceBeforePx: z.number().optional(),
	spaceAfterPx: z.number().optional(),
});
export type TextStyle = DeepStrip<z.infer<typeof TextStyleSchema>>;

export const TextContentSchema = z.looseObject({
	text: z.string(),
	style: TextStyleSchema,
	runs: z
		.array(z.looseObject({ from: nonNegInt(), to: nonNegInt(), style: TextStyleSchema.partial() }))
		.optional(),
	/**
	 * per-paragraph overrides of the paragraph settings (`align`, `justifyLast`, indents,
	 * spacing, `direction`) by paragraph index (paragraphs are separated by line breaks). Absent = base style.
	 */
	paragraphs: z.array(z.looseObject({ index: nonNegInt(), style: TextStyleSchema.partial() })).optional(),
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
	// resolveCaptionStyle supplies defaults for absent fields.
	/** Vertical placement inside the title-safe area (default `bottom`). */
	placement: z.enum(['bottom', 'middle', 'top']).optional(),
	/** Extra distance from the title-safe edge, % of the frame height (0–45, default 0). */
	marginPct: z.number().min(0).max(45).optional(),
	/** WebVTT `line:N%`: top of the caption block at N % of the frame height; null = placement. */
	linePct: z.number().min(0).max(100).nullable().optional(),
	/** WebVTT `position:N%`: horizontal anchor of the caption block at N % of the frame width; null = centred. */
	positionPct: z.number().min(0).max(100).nullable().optional(),
});
export type CaptionStyle = DeepStrip<z.infer<typeof CaptionStyleSchema>>;

/** wp captions: caption track standards (Premiere's caption track "Format"). */
export const CAPTION_STANDARDS = ['subtitle', 'cea-608', 'cea-708', 'teletext'] as const;
export const CaptionStandardSchema = z.enum(CAPTION_STANDARDS);
export type CaptionStandard = DeepStrip<z.infer<typeof CaptionStandardSchema>>;

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
	/** BCP-47 language of the captions (`en`, `fr-CA`); written to embedded streams and sidecars. */
	language: z.string().optional(),
	/** Caption standard of the track (default `subtitle`). */
	captionStandard: CaptionStandardSchema.optional(),
	/** WebVTT STYLE / REGION / NOTE blocks kept from an imported file for round trips. */
	vttBlocks: z.array(z.string()).optional(),
});
export type Track = DeepStrip<z.infer<typeof TrackSchema>>;

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

/**
 * One speed keyframe of a clip's Time Remapping (Premiere "Time Remapping ▸ Speed"): the point where the clip's
 * content time `time` (flicks, the keyframe axis of the clip — the same axis as every other keyframe, so Motion and
 * effect keyframes stay where they are) shows the media time `source` (flicks from the start of the media). Between
 * two keyframes the media advances linearly (a constant speed segment: forward, reverse when `source` decreases, a
 * freeze frame when it stays). `ramp` (content flicks, ≥ 0) splits the keyframe into a speed transition of `2·ramp`
 * centred on it; `ease` (0 = linear speed change … 1 = smooth S-curve, default 1) shapes it. A ramp never moves the
 * media frames anchored by the keyframes.
 */
export const RemapKeyframeSchema = z.looseObject({
	id: z.string(),
	time: z.number(),
	source: z.number(),
	ramp: z.number().min(0).optional(),
	ease: z.number().min(0).max(1).optional(),
});
export type RemapKeyframe = DeepStrip<z.infer<typeof RemapKeyframeSchema>>;

/**
 * Time Remapping of a video clip (OPTIONAL, read with defaults). Absent or `enabled: false` = the clip plays its
 * content linearly (constant speed). `speedBefore` / `speedAfter` are the media-per-content slopes before the first
 * and after the last keyframe (default 1). Without keyframes the media time equals the content time.
 */
export const TimeRemapSchema = z.looseObject({
	enabled: z.boolean(),
	keyframes: z.array(RemapKeyframeSchema),
	speedBefore: z.number().optional(),
	speedAfter: z.number().optional(),
});
export type TimeRemap = DeepStrip<z.infer<typeof TimeRemapSchema>>;

/** Premiere "Time Interpolation": how frames are made when media time falls between source frames. */
export const TIME_INTERPOLATIONS = ['frame-sampling', 'frame-blending', 'optical-flow'] as const;
export const TimeInterpolationSchema = z.enum(TIME_INTERPOLATIONS);
export type TimeInterpolation = DeepStrip<z.infer<typeof TimeInterpolationSchema>>;

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
	// three-d: After Effects-style cameras and lights (video tracks; they draw nothing themselves).
	'camera',
	'light',
	// three-d: a 3D model layer (glTF / OBJ media; always 3D, drawn by Advanced 3D).
	'model',
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
	/** edit-ux: placed from this subclip project item; its range bounds trims when it restricts them. */
	subclipId: z.string().optional(),
};

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
	/**
	 * Faces rotos: the tracked faces over [`start`, `end`] (media px): per frame from `startFrame` 4 numbers (centre x,
	 * y, size forehead → chin, roll in radians clockwise) in `poses`, and `present` (1 = seen, 0 = lost and held).
	 */
	faces: z
		.array(
			z.looseObject({
				id: nonNegInt(),
				startFrame: nonNegInt(),
				poses: z.array(z.number()),
				present: z.array(z.number().int().min(0).max(1)),
			}),
		)
		.optional(),
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
	/** wp masks: the Opacity masks of the layer (S03:MSK-001). Absent = none. */
	masks: z.array(MaskSchema).optional(),
	/** color-mgmt: this clip's colour interpretation (over its media's Interpret Footage ▸ Colour). Media clips only. */
	colorInterpretation: ColorInterpretationSchema.optional(),
	/** three-d: the 3D Layer switch and 3D transform / material (schema/three-d.ts). Absent = a 2D layer. */
	threeD: Layer3DSchema.optional(),
	/** gaps (GR-5): Responsive Design – Position of a graphic's layer (absent = not pinned). */
	pins: LayerPinsSchema.optional(),
};
const canvasSchema = z.union([
	z.literal('sequence'),
	z.looseObject({ width: z.number().int().positive(), height: z.number().int().positive() }),
]);
export type ClipCanvas = DeepStrip<z.infer<typeof canvasSchema>>;
export const ChannelsSchema = z.looseObject({
	streamIndex: nonNegInt(),
	map: z.array(nonNegInt()),
	/** gaps (Modify ▸ Audio Channels): clip channels no source channel is routed to (they play silence). */
	mute: z.array(nonNegInt()).optional(),
});

export const VideoClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('video'),
	mediaId: z.string(),
	videoStreamIndex: nonNegInt(),
	...visualShape,
	/** M2 (S09): trackers placed on this clip's picture. */
	trackers: z.array(ClipTrackerSchema).optional(),
	/** Absent means constant speed. */
	timeRemap: TimeRemapSchema.optional(),
	/** Defaults to frame-sampling. */
	timeInterpolation: TimeInterpolationSchema.optional(),
	/** parity (roto): segmented objects (Roto Brush, faces) of this clip's picture. */
	rotos: z.array(ClipRotoSchema).optional(),
	/** three-d: the 3D Camera Tracker of this clip's picture. */
	cameraTracker: ClipCameraTrackerSchema.optional(),
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
	/**
	 * Spec 12 P6-E11: source moments the remix landed on sequence frames (`{sourceSeconds, frame}`: seconds from the
	 * original clip's content start → the frame it plays at; the drop on the hero). A later remix of the clip lands them
	 * again. Read with `readRemixAnchors`; malformed entries are dropped by `repairDocument`.
	 */
	anchors: z.array(z.unknown()).max(64).optional(),
	/** Spec 12 P6-E11: the fade-in `clip.remix` added over a trimmed intro (removed by Revert Remix). */
	fadeInId: z.string().optional(),
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
	/**
	 * sound-design (spec 12 §2.2): the clip was placed by sound design (its cue, sound, layer, role, alignment). Accepted
	 * as any value here so a malformed one never fails a load; INV-SFX checks it and `repairDocument` repairs or drops it.
	 */
	sfx: z.custom<ClipSfx>(() => true).optional(),
	/**
	 * sound-design (spec 12 §4 P6-E12): the clip is a piece of an ambience or room-tone bed (`soundDesign.layBed`).
	 * Accepted as any value here; INV-SFX checks it and `repairDocument` drops a malformed one (the clip stays).
	 */
	bed: z.custom<ClipBed>(() => true).optional(),
	/**
	 * spec 14 TC-024 (v9): equal-power micro-fades at the clip's edges (ms, 0 < x ≤ 30) — the declick of a cleanup
	 * join, rendered as audio fades by every path (`resolveAudioTransitions`). Accepted as any value; INV-CLEANUP checks it
	 * (`edgeFadesProblem`) and `repairDocument` drops an unreadable one.
	 */
	edgeFades: z.custom<AudioEdgeFades>(() => true).optional(),
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
	// Source Text keys hold their values; content supplies the value when no keys exist.
	animators: z.array(TextAnimatorGroupSchema).optional(),
	pathOptions: TextPathOptionsSchema.optional(),
	moreOptions: TextMoreOptionsSchema.optional(),
	perCharacter3d: z.boolean().optional(),
	sourceTextKeyframes: z.array(keyframeSchema(TextContentSchema)).optional(),
	/**
	 * spec 13 SH-002 (schema v9): the project text style (`ProjectDocument.textStyles`) the clip is linked to; absent =
	 * not linked. Read leniently (any value loads; INV-TEXTSTYLE checks it; a style that is gone reads as not linked).
	 * `content.style` stays the effective style.
	 */
	styleId: z.custom<string>(() => true).optional(),
	/** spec 13 SH-002: where a linked clip deviates from its style (a `TextStyleOverrides` patch; absent = none). */
	styleOverrides: z.custom<Record<string, unknown>>(() => true).optional(),
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
	// Keyframes of numeric/colour params of anime templates, per param
	// name, in content time (flicks). The static value stays in `params`; absent/empty = not animated.
	paramKeyframes: z.record(z.string(), z.array(MgParamKeyframeSchema)).optional(),
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
	timeRemap: TimeRemapSchema.optional(),
	/** Defaults to frame-sampling. */
	timeInterpolation: TimeInterpolationSchema.optional(),
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
export const ShapeDataSchema = z.union([LegacyShapeDataSchema, VectorShapeDataSchema]);
export type ShapeData = LegacyShapeData | VectorShapeData;
export const isLegacyShape = (s: ShapeData): s is LegacyShapeData => s.type !== 'vector';
export const ShapeClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('shape'),
	shape: ShapeDataSchema,
	...visualShape,
});

/** three-d: a camera on a video track; the topmost enabled camera at a frame is the sequence's active camera. */
export const CameraClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('camera'),
	camera: CameraDataSchema,
});
/** three-d: a light on a video track (lights every 3D layer of the sequence while it is on). */
export const LightClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('light'),
	light: LightDataSchema,
});
/**
 * three-d: a 3D model layer (After Effects' 3D model layers): a `model` media drawn by Advanced 3D, fitted to half the
 * frame height around the frame centre in layer space, moved by its Motion and 3D transform.
 */
export const ModelClipSchema = z.looseObject({
	...commonShape,
	kind: z.literal('model'),
	mediaId: z.string(),
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
	CameraClipSchema,
	LightClipSchema,
	ModelClipSchema,
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
export type CameraClip = DeepStrip<z.infer<typeof CameraClipSchema>>;
export type LightClip = DeepStrip<z.infer<typeof LightClipSchema>>;
export type ModelClip = DeepStrip<z.infer<typeof ModelClipSchema>>;
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
	/**
	 * Premiere port (Custom Start alignment, v8): where the cut sits in a two-sided transition's span, as the fraction
	 * of the span before it (0…1; frames before the cut = round(cutPosition × duration), `cutOffsetOf`). Absent = the
	 * `alignment`'s position. Read leniently (any value; INV-010 reports one that is not a number in (0, 1) or sits on
	 * a fade, `repairDocument` drops it).
	 */
	cutPosition: z.custom<number>().optional(),
});
export type Transition = DeepStrip<z.infer<typeof TransitionSchema>>;

export const LinkGroupSchema = z.looseObject({ id: z.string(), members: z.array(z.string()) });
export type LinkGroup = DeepStrip<z.infer<typeof LinkGroupSchema>>;
export const ClipGroupSchema = z.looseObject({ id: z.string(), members: z.array(z.string()) });
export type ClipGroup = DeepStrip<z.infer<typeof ClipGroupSchema>>;

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
	/**
	 * color-mgmt: the working colour space (`WORKING_SPACE_IDS`: rec709, srgb, rec2020, p3d65, displayp3, rec2100-pq,
	 * rec2100-hlg). A string so an unknown id loads and is repaired to Rec. 709 (INV-COLOR); read with
	 * `sequenceColorInfo`.
	 */
	workingColorSpace: z.string(),
	/** color-mgmt: Sequence Settings ▸ Colour (linearize, blend using 1.0 gamma, tone mapping, HDR white/peak). */
	color: SequenceColorSchema.optional(),
	// sequenceFormatOf resolves absent format settings.
	/** Pixel Aspect Ratio of the delivered files; absent / 1:1 = square pixels. `width` is then the display width. */
	pixelAspectRatio: z.looseObject({ num: z.number(), den: z.number() }).nullable().optional(),
	/** Frame width the delivered files carry (with a non-square pixel aspect ratio). */
	storageWidth: z.number().nullable().optional(),
	/** Fields: progressive (absent), upper or lower field first. */
	fieldOrder: z.string().nullable().optional(),
});
export type SequenceSettings = DeepStrip<z.infer<typeof SequenceSettingsSchema>>;

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

/**
 * `format`: `h264-iframe` = I-frame-only H.264 (every frame a keyframe: frame-exact, instant seeks; Premiere's default
 * "I-Frame Only MPEG"), `h264` = H.264 with a keyframe every 15 frames (≈ ⅓ smaller), `vp9` = VP9 in WebM. `size`:
 * full or half the sequence frame size (half renders and plays faster; exports never use half-size previews).
 * `quality`: the bitrate class. Absent = `h264-iframe`, full size, standard quality.
 */
export const PREVIEW_FORMATS = ['h264-iframe', 'h264', 'vp9'] as const;
export type PreviewFormat = (typeof PREVIEW_FORMATS)[number];
export const SequencePreviewSettingsSchema = z.looseObject({
	format: z.enum(PREVIEW_FORMATS).optional(),
	size: z.enum(['full', 'half']).optional(),
	quality: z.enum(['standard', 'high']).optional(),
});
export type SequencePreviewSettings = DeepStrip<z.infer<typeof SequencePreviewSettingsSchema>>;
/** The effective preview settings of a sequence (defaults applied at read time). */
export function previewSettingsOf(seq: { previews?: SequencePreviewSettings | undefined }): {
	format: PreviewFormat;
	size: 'full' | 'half';
	quality: 'standard' | 'high';
} {
	const p = seq.previews;
	return {
		format: p?.format && (PREVIEW_FORMATS as readonly string[]).includes(p.format) ? p.format : 'h264-iframe',
		size: p?.size === 'half' ? 'half' : 'full',
		quality: p?.quality === 'high' ? 'high' : 'standard',
	};
}

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
	/** three-d: 3D renderer settings (absent = Classic 3D). */
	threeD: Sequence3DSchema.optional(),
	/** previews: render preview file settings (absent = defaults, see `previewSettingsOf`). */
	previews: SequencePreviewSettingsSchema.optional(),
	/** gaps (GR-4/5): present = an Essential Graphics graphic (its tracks are the layers), see gaps/graphics.ts. */
	graphic: GraphicSettingsSchema.optional(),
	/**
	 * sound-design (spec 12 §2.2): sound cues, settings and the last Sound Check. Accepted as any value here so a
	 * malformed one never fails a load; INV-SOUND checks it and `repairDocument` repairs it (`readSoundDesign`).
	 */
	soundDesign: z.custom<SoundDesign>(() => true).optional(),
	/**
	 * spec 14 TC-030 (v9): transcript cleanup settings (preset + overrides), the attached script, rejected finding
	 * fingerprints and edited word lists. Accepted as any value so a malformed one never fails a load; INV-CLEANUP
	 * checks it (`sequenceCleanupIssue`) and `repairDocument` keeps its readable parts (`repairSequenceCleanup`).
	 */
	cleanup: z.custom<SequenceCleanup>(() => true).optional(),
});
export type Sequence = Omit<DeepStrip<z.infer<typeof SequenceSchema>>, 'clips'> & {
	clips: Record<string, Clip>;
};
