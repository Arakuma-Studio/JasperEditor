// Media assets, locators, derivations, synthetic sources, transcripts and fonts (S01 §6).
import { z } from 'zod';
import { int, nonNegInt, RationalSchema, RGBASchema } from './common.ts';
import type { DeepStrip } from './common.ts';

export const MEDIA_KINDS = ['video', 'audio', 'image', 'animated-image', 'font', 'lut'] as const;
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

/** Where the bytes might be (S01:AST-004). `engine-store` uses `key = mediaKey` (ARCHITECTURE D-09). */
export const MediaLocatorSchema = z.discriminatedUnion('type', [
	z.looseObject({ type: z.literal('path'), path: z.string(), relativeToProject: z.string().nullable() }),
	z.looseObject({ type: z.literal('browser-store'), key: z.string() }),
	z.looseObject({ type: z.literal('engine-store'), engineId: z.string(), key: z.string() }),
	z.looseObject({ type: z.literal('url'), url: z.string() }),
	z.looseObject({ type: z.literal('cloud'), provider: z.string(), key: z.string() }),
]);
export type MediaLocator = DeepStrip<z.infer<typeof MediaLocatorSchema>>;

export const NativeRecipeSchema = z.discriminatedUnion('op', [
	z.looseObject({ op: z.literal('conform-cfr'), frameRate: RationalSchema }),
	z.looseObject({ op: z.literal('reverse') }),
	z.looseObject({ op: z.literal('stabilize'), smoothing: z.number(), crop: z.enum(['keep', 'black']) }),
	z.looseObject({ op: z.literal('denoise-audio'), strength: z.number() }),
	z.looseObject({ op: z.literal('loudness-normalize'), targetLufs: z.number(), truePeakDb: z.number() }),
	z.looseObject({ op: z.literal('extract-audio'), streamIndex: nonNegInt(), format: z.enum(['wav', 'flac']) }),
	z.looseObject({ op: z.literal('transcode'), preset: z.string() }),
	z.looseObject({ op: z.literal('time-stretch'), rate: z.number().positive(), preservePitch: z.boolean() }),
	z.looseObject({ op: z.literal('range'), inFlicks: nonNegInt(), outFlicks: nonNegInt() }),
]);
export type NativeRecipe = DeepStrip<z.infer<typeof NativeRecipeSchema>>;

export const DerivationSchema = z.looseObject({
	fromMediaId: z.string(),
	recipe: NativeRecipeSchema,
	recipeVersion: int(),
	recipeHash: z.string(),
});
export type Derivation = DeepStrip<z.infer<typeof DerivationSchema>>;

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
});
export type MediaAsset = DeepStrip<z.infer<typeof MediaAssetSchema>>;

export const SyntheticSourceSchema = z.discriminatedUnion('kind', [
	z.looseObject({ id: z.string(), kind: z.literal('color-matte'), color: RGBASchema }),
	z.looseObject({ id: z.string(), kind: z.literal('adjustment') }),
	z.looseObject({ id: z.string(), kind: z.literal('transparent') }),
	z.looseObject({ id: z.string(), kind: z.literal('black-video') }),
	z.looseObject({ id: z.string(), kind: z.literal('bars-and-tone'), toneHz: z.number(), toneDb: z.number() }),
	z.looseObject({ id: z.string(), kind: z.literal('counting-leader'), style: z.record(z.string(), z.unknown()) }),
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
