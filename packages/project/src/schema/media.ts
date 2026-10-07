// Media assets, locators, derivations, synthetic sources, transcripts and fonts (S01 §6).
import { z } from 'zod';
import { ColorInterpretationSchema } from '../color/model.ts';
import type { DeepStrip } from './common.ts';
import { int, nonNegInt, RationalSchema, RGBASchema } from './common.ts';

/** `mg-bundle` (M2, ARCHITECTURE §19.3): an imported Remotion bundle whose compositions become clips. */
/** color-mgmt: `color-config` = a custom OpenColorIO configuration (`.ocio`), bundled with the files it references. */
export const MEDIA_KINDS = [
	'video',
	'audio',
	'image',
	'animated-image',
	'font',
	'lut',
	'mg-bundle',
	'color-config',
] as const;
export const MediaKindSchema = z.enum(MEDIA_KINDS);
export type MediaKind = DeepStrip<z.infer<typeof MediaKindSchema>>;

export const VideoStreamSchema = z.looseObject({
	index: nonNegInt(),
	type: z.literal('video'),
	codec: z.string(),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	pixelAspect: RationalSchema,
	frameRate: RationalSchema,
	pixelFormat: z.string(),
	bitDepth: z.number().int().positive(),
	color: z.looseObject({
		primaries: z.string(),
		transfer: z.string(),
		matrix: z.string(),
		range: z.enum(['tv', 'pc']),
	}),
	browserDecodable: z.boolean().nullable(),
	/**
	 * color-mgmt: HDR static metadata of the stream (SMPTE ST 2086 mastering display luminance, CTA-861.3 MaxCLL /
	 * MaxFALL, cd/m²) from `mdcv`/`clli` or Matroska MasteringMetadata. Absent = none signalled.
	 */
	hdr: z
		.looseObject({
			masteringMaxNits: z.number().optional(),
			masteringMinNits: z.number().optional(),
			maxCll: z.number().optional(),
			maxFall: z.number().optional(),
		})
		.optional(),
});
export const AudioStreamSchema = z.looseObject({
	index: nonNegInt(),
	type: z.literal('audio'),
	codec: z.string(),
	sampleRate: z.number().int().positive(),
	channels: z.number().int().positive(),
	channelLayout: z.string(),
});
export const SubtitleStreamSchema = z.looseObject({
	index: nonNegInt(),
	type: z.literal('subtitle'),
	codec: z.string(),
	language: z.string().nullable(),
});
export const MediaStreamSchema = z.discriminatedUnion('type', [
	VideoStreamSchema,
	AudioStreamSchema,
	SubtitleStreamSchema,
]);
export type VideoStream = DeepStrip<z.infer<typeof VideoStreamSchema>>;
export type AudioStream = DeepStrip<z.infer<typeof AudioStreamSchema>>;
export type MediaStream = DeepStrip<z.infer<typeof MediaStreamSchema>>;

export const RotationSchema = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);

export const MediaProbeSchema = z.looseObject({
	durationFlicks: nonNegInt().nullable(),
	startTimecode: z.string().nullable(),
	streams: z.array(MediaStreamSchema),
	rotationDegrees: RotationSchema,
	hasAlpha: z.boolean(),
	variableFrameRate: z.boolean(),
});
export type MediaProbe = DeepStrip<z.infer<typeof MediaProbeSchema>>;

/** Probe of assets that are not audio/video (LUTs, motion-graphics bundles, fonts). */
export const EMPTY_PROBE: MediaProbe = {
	durationFlicks: null,
	startTimecode: null,
	streams: [],
	rotationDegrees: 0,
	hasAlpha: false,
	variableFrameRate: false,
};

/** Where the bytes might be (S01:AST-004). `engine-store` uses `key = mediaKey` (ARCHITECTURE D-09). */
export const MediaLocatorSchema = z.discriminatedUnion('type', [
	z.looseObject({ type: z.literal('path'), path: z.string(), relativeToProject: z.string().nullable() }),
	z.looseObject({ type: z.literal('browser-store'), key: z.string() }),
	z.looseObject({ type: z.literal('engine-store'), engineId: z.string(), key: z.string() }),
	z.looseObject({ type: z.literal('url'), url: z.string() }),
	z.looseObject({ type: z.literal('cloud'), provider: z.string(), key: z.string() }),
]);
export type MediaLocator = DeepStrip<z.infer<typeof MediaLocatorSchema>>;

/**
 * One step of a clip-processing recipe (ARCHITECTURE §19.4, S07). Every step keeps the frame count and the
 * frame rate of its input, so a processed version can replace the original in a clip without retiming
 * (`upscale` changes the pixel size only).
 */
export const ProcessStepSchema = z.discriminatedUnion('op', [
	z.looseObject({
		op: z.literal('stabilize'),
		/**
		 * `auto` = vid.stab (WASM), else `deshake`. `smoothpath` (S07:PST-005) = background tracking + one
		 * Gaussian-smoothed camera path + one static zoom for the whole shot: for a sudden reframe / jerk or a
		 * slow drift that should become an even move.
		 */
		method: z.enum(['auto', 'vidstab', 'deshake', 'smoothpath']),
		/** Camera-path smoothing in frames: vid.stab's window radius; the Gaussian sigma for `smoothpath`. */
		smoothing: z.number().int().min(1).max(120),
		/** `crop` zooms in just enough to hide the moving borders; `keep` leaves them (black). */
		borders: z.enum(['crop', 'keep']),
		/** 1..10, vid.stab `shakiness`. */
		shakiness: z.number().int().min(1).max(10).optional(),
		/** Also stabilize rotation (vid.stab only). */
		rotation: z.boolean().optional(),
		/** `smoothpath`: the vertical camera path becomes a straight line (no intended tilt). */
		lockVertical: z.boolean().optional(),
		/** `smoothpath`: the roll becomes a straight line (no intended rotation). */
		lockRotation: z.boolean().optional(),
		/**
		 * `smoothpath` with `borders: 'crop'`: largest static zoom in percent (default 112). When the requested
		 * smoothing needs more, the largest smoothing that fits is used and the job notes say so.
		 */
		maxZoom: z.number().min(100).max(200).optional(),
	}),
	z.looseObject({
		op: z.literal('dejudder'),
		/** `auto` analyses the cadence first and only retimes when a pull-down / decimation pattern is found. */
		mode: z.enum(['auto', 'force']),
		/** Fraction of the inter-frame step each off-phase frame is moved (default 1/6 for 2:2:1). */
		shift: z.number().min(0).max(0.5).optional(),
	}),
	z.looseObject({
		op: z.literal('denoise'),
		method: z.enum(['atadenoise', 'fftdnoiz', 'nlmeans']),
		/** 0..1 mapped per method (S07:PRC-040). */
		strength: z.number().min(0).max(1),
	}),
	z.looseObject({
		op: z.literal('deblock'),
		filter: z.enum(['weak', 'strong']),
		block: z.number().int().min(4).max(64).optional(),
	}),
	z.looseObject({
		op: z.literal('upscale'),
		/** Model id from the engine's model catalog (`GET /api/processing/models`). */
		model: z.string().min(1),
		scale: z.union([z.literal(2), z.literal(4)]),
		/** Final size after the model (bicubic), e.g. 1920x1080 from a 2x of 848x480; default = model output. */
		size: z
			.looseObject({ width: z.number().int().positive(), height: z.number().int().positive() })
			.optional(),
		/** 0..1 blend towards a Lanczos upscale (hybrid). */
		mix: z.number().min(0).max(1).optional(),
	}),
]);
export type ProcessStep = DeepStrip<z.infer<typeof ProcessStepSchema>>;

export const NativeRecipeSchema = z.discriminatedUnion('op', [
	z.looseObject({ op: z.literal('conform-cfr'), frameRate: RationalSchema }),
	z.looseObject({ op: z.literal('reverse') }),
	z.looseObject({ op: z.literal('stabilize'), smoothing: z.number(), crop: z.enum(['keep', 'black']) }),
	z.looseObject({ op: z.literal('denoise-audio'), strength: z.number() }),
	z.looseObject({ op: z.literal('loudness-normalize'), targetLufs: z.number(), truePeakDb: z.number() }),
	z.looseObject({
		op: z.literal('extract-audio'),
		streamIndex: nonNegInt(),
		format: z.enum(['wav', 'flac']),
	}),
	z.looseObject({ op: z.literal('transcode'), preset: z.string() }),
	z.looseObject({ op: z.literal('time-stretch'), rate: z.number().positive(), preservePitch: z.boolean() }),
	z.looseObject({ op: z.literal('range'), inFlicks: nonNegInt(), outFlicks: nonNegInt() }),
	/** Clip processing (M2, S07): the steps run in order on the whole source; output ProRes (4444 keeps alpha). */
	z.looseObject({ op: z.literal('process'), steps: z.array(ProcessStepSchema).min(1) }),
]);
export type NativeRecipe = DeepStrip<z.infer<typeof NativeRecipeSchema>>;

export const DerivationSchema = z.looseObject({
	fromMediaId: z.string(),
	recipe: NativeRecipeSchema,
	recipeVersion: int(),
	recipeHash: z.string(),
});
export type Derivation = DeepStrip<z.infer<typeof DerivationSchema>>;

/**
 * M3 (S07:PRC-015…019, schema v5): the source frames a file holds — file frame `i` shows frame
 * `firstFrame + i` of its source. Processed versions record the range they were made from (the whole source or
 * a range with handles); files imported or relinked with a source-range sidecar record what the sidecar says.
 * Frame correspondence is by index (de-judder retimes the picture but keeps the frame count), so the file and
 * the source must share the frame rate for a clip to switch between them.
 */
export const SourceRangeSchema = z.looseObject({
	/** The project media holding the source frames; null when the source is not in the project. */
	mediaId: z.string().nullable(),
	/** File name of the source (e.g. `crudo.mp4`) — matching and display when `mediaId` is null. */
	sourceName: z.string().nullable().optional(),
	/** Source frame shown by the first frame of this file. */
	firstFrame: nonNegInt(),
	/** Frames this file holds. */
	frames: z.number().int().min(1),
	/** Rate the source frames are counted at (the source's video rate). */
	frameRate: RationalSchema,
	/** Where the range comes from: the engine's processing, a sidecar file, or a client/agent. */
	origin: z.enum(['process', 'sidecar', 'manual']),
});
export type SourceRange = DeepStrip<z.infer<typeof SourceRangeSchema>>;

/** Parsed header of a LUT asset (M2, S06:CG-050). The table itself stays in the file (`/media/<key>`). */
export const LutInfoSchema = z.looseObject({
	/** color-mgmt: `.3dl`, `.spi1d`, `.spi3d`, `.csp` besides `.cube`. */
	format: z.enum(['cube', '3dl', 'spi1d', 'spi3d', 'csp']),
	dimensions: z.union([z.literal(1), z.literal(3)]),
	size: z.number().int().min(2).max(256),
	title: z.string().nullable(),
	domainMin: z.tuple([z.number(), z.number(), z.number()]),
	domainMax: z.tuple([z.number(), z.number(), z.number()]),
	/** color-mgmt: entries of the 1D shaper applied before the cube (Resolve 1D + 3D `.cube`, `.csp`, non-uniform `.3dl`). */
	shaperSize: z.number().int().min(2).max(65536).optional(),
});
export type LutInfo = DeepStrip<z.infer<typeof LutInfoSchema>>;

/** color-mgmt: header of a custom OCIO config asset (the bundle itself stays in the file, `/media/<key>`). */
export const ColorConfigInfoSchema = z.looseObject({
	format: z.literal('ocio'),
	name: z.string(),
	/** `ocio_profile_version`. */
	version: z.number(),
	spaces: z.array(
		z.looseObject({ name: z.string(), family: z.string(), reference: z.enum(['scene', 'display']) }),
	),
	roles: z.array(z.tuple([z.string(), z.string()])),
	displays: z.array(z.looseObject({ name: z.string(), views: z.array(z.string()) })),
	/** Transforms this build cannot apply (spaces using them are refused). */
	unsupported: z.array(z.string()),
	/** FileTransform sources that were not found when the config was imported. */
	missing: z.array(z.string()),
});
export type ColorConfigInfo = DeepStrip<z.infer<typeof ColorConfigInfoSchema>>;

/**
 * A text layer a composition declares (M3, wp-m3-mgtext, S08:MGC-036): manifest `texts.<prop.path>` or the
 * `x-jasper-text` JSON Schema annotation. Style roles name the props that style the text (dotted paths).
 */
export const MgTextDeclSchema = z.looseObject({
	label: z.string().optional(),
	multiline: z.boolean().optional(),
	/** Soft limits: warnings, not errors (the schema's maxLength is the hard one). */
	maxChars: z.number().int().positive().optional(),
	maxLines: z.number().int().positive().optional(),
	/** Safe area of the text in composition pixels: a measured text outside it is reported. */
	box: z
		.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
		.optional(),
	/** Composition frame where the text is fully laid out (measuring, on-canvas editing). */
	frame: z.number().int().min(0).optional(),
	/** One line of help shown under the editor (e.g. a markup convention). */
	hint: z.string().optional(),
	/**
	 * The text uses the accent markup: `*…*` spans render in this colour (a CSS colour, or the dotted path of the
	 * colour prop that holds it). The on-canvas editor draws them so and hides the asterisks (wp-m3-mgtext).
	 */
	accent: z.string().optional(),
	style: z.record(z.string(), z.string()).optional(),
});
export type MgTextDecl = DeepStrip<z.infer<typeof MgTextDeclSchema>>;

/** One composition of an imported Remotion bundle (M2, S08:MGC-010). */
export const MgCompositionInfoSchema = z.looseObject({
	id: z.string(),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	/** Remotion frame rate (a number, e.g. 30 or 29.97). */
	fps: z.number().positive(),
	durationInFrames: z.number().int().positive(),
	defaultProps: z.record(z.string(), z.unknown()),
	/** JSON Schema (draft 2020-12) of the props, or null when none is known. */
	propsSchema: z.record(z.string(), z.unknown()).nullable(),
	schemaSource: z.enum(['bundle', 'manifest', 'inferred']),
	/**
	 * M2 (wp-m2-mg, additive): form hints by dotted prop path (`jasper.mg.json` `ui`, merged over the inferred
	 * ones), e.g. `{"accent": {"control": "color"}}`.
	 */
	ui: z.record(z.string(), z.looseObject({ control: z.string().optional() })).optional(),
	/** Manifest `category` (Motion Templates panel grouping). */
	category: z.string().optional(),
	/** Manifest `thumbnailFrame` (poster frame; default 0). */
	thumbnailFrame: z.number().int().min(0).optional(),
	/**
	 * M3 (wp-m3-mgtext, S08:MGC-036, additive): text layers declared by `jasper.mg.json` `texts`, keyed by the
	 * dotted prop path of the text; `false` hides a string prop that would otherwise be discovered as a text.
	 */
	texts: z.record(z.string(), z.union([z.literal(false), MgTextDeclSchema])).optional(),
});
export type MgCompositionInfo = DeepStrip<z.infer<typeof MgCompositionInfoSchema>>;

/** Header of an `mg-bundle` asset (M2, S08:MGC-001). */
export const MgBundleInfoSchema = z.looseObject({
	remotionVersion: z.string(),
	/** sha256 of the bundle directory (content address; part of every pre-render cache key). */
	bundleHash: z.string(),
	builtAt: z.string(),
	source: z.looseObject({
		type: z.enum(['project-dir', 'bundle-upload']),
		/** Project directory on the engine host (local mode) — used for rebuilds and watching. */
		path: z.string().nullable(),
		name: z.string(),
	}),
	compositions: z.array(MgCompositionInfoSchema),
});
export type MgBundleInfo = DeepStrip<z.infer<typeof MgBundleInfoSchema>>;

export const MediaAssetSchema = z.looseObject({
	id: z.string(),
	kind: MediaKindSchema,
	fingerprint: z.string(),
	originalName: z.string(),
	sizeBytes: nonNegInt(),
	container: z.string(),
	probe: MediaProbeSchema,
	locators: z.array(MediaLocatorSchema),
	derivation: DerivationSchema.nullable(),
	importedAt: z.string(),
	/** kind `lut` (M2). */
	lut: LutInfoSchema.optional(),
	/** kind `mg-bundle` (M2). */
	mgBundle: MgBundleInfoSchema.optional(),
	/** M3 (S07:PRC-015, schema v5): the source frames this file holds (processed versions, sidecars). */
	sourceRange: SourceRangeSchema.optional(),
	/** color-mgmt: kind `color-config` (a custom OCIO config). */
	colorConfig: ColorConfigInfoSchema.optional(),
	/**
	 * Interpret Footage. color-mgmt adds the Colour section (`color`); the other sections (frame rate, pixel aspect,
	 * fields, alpha, loop) belong to the imports workstream and are separate fields of the same object.
	 */
	interpretation: z.looseObject({ color: ColorInterpretationSchema.optional() }).optional(),
});
export type MediaAsset = DeepStrip<z.infer<typeof MediaAssetSchema>>;

export const SyntheticSourceSchema = z.discriminatedUnion('kind', [
	z.looseObject({ id: z.string(), kind: z.literal('color-matte'), color: RGBASchema }),
	z.looseObject({ id: z.string(), kind: z.literal('adjustment') }),
	z.looseObject({ id: z.string(), kind: z.literal('transparent') }),
	z.looseObject({ id: z.string(), kind: z.literal('black-video') }),
	z.looseObject({ id: z.string(), kind: z.literal('bars-and-tone'), toneHz: z.number(), toneDb: z.number() }),
	z.looseObject({
		id: z.string(),
		kind: z.literal('counting-leader'),
		style: z.record(z.string(), z.unknown()),
	}),
]);
export type SyntheticSource = DeepStrip<z.infer<typeof SyntheticSourceSchema>>;
export type SyntheticKind = SyntheticSource['kind'];

export const TranscriptWordSchema = z.looseObject({
	text: z.string(),
	start: nonNegInt(),
	end: nonNegInt(),
	confidence: z.number().min(0).max(1).nullable(),
	speaker: z.string().nullable(),
	breakBefore: z.enum(['none', 'line', 'segment']),
});
export type TranscriptWord = DeepStrip<z.infer<typeof TranscriptWordSchema>>;

export const TranscriptSchema = z.looseObject({
	id: z.string(),
	mediaId: z.string().nullable(),
	language: z.string(),
	origin: z.enum(['whisper-local', 'cloud-asr', 'subtitle-file', 'manual']),
	words: z.array(TranscriptWordSchema),
	speakers: z.record(z.string(), z.looseObject({ name: z.string() })),
	/** wp speech (optional): the speech model that produced the words, e.g. `whisper-base`. */
	model: z.string().optional(),
	/** wp speech (optional): `translate` = English text of speech in `sourceLanguage`. */
	task: z.enum(['transcribe', 'translate']).optional(),
	/** wp speech (optional): the spoken language when `task` is `translate` (`language` is then `en`). */
	sourceLanguage: z.string().optional(),
	/** wp speech (optional): when the words were recognised (ISO 8601). */
	createdAt: z.string().optional(),
	/**
	 * wp speech (optional): the media time ranges (flicks, sorted, disjoint) that were transcribed, when not the
	 * whole media — a transcript made from a sequence's mix covers only the parts the sequence plays.
	 */
	coverage: z.array(z.tuple([nonNegInt(), nonNegInt()])).optional(),
});
export type Transcript = DeepStrip<z.infer<typeof TranscriptSchema>>;

export const FontSourceSchema = z.discriminatedUnion('type', [
	z.looseObject({ type: z.literal('bundled') }),
	z.looseObject({ type: z.literal('google'), family: z.string() }),
	z.looseObject({ type: z.literal('system') }),
	z.looseObject({ type: z.literal('asset'), mediaId: z.string() }),
]);
export const FontRefSchema = z.looseObject({ id: z.string(), family: z.string(), source: FontSourceSchema });
export type FontRef = DeepStrip<z.infer<typeof FontRefSchema>>;
