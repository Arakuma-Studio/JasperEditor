// Project document root, project items and the persistence envelope (S01 §4, §5, PER-002).
import { z } from 'zod';
import type { SubtitleTemplate } from '../captions/subtitles/templates.ts';
import type { ProjectTextStyle } from '../text-styles/model.ts';
import type { DeepStrip } from './common.ts';
import { int, LabelColorSchema, nonNegInt } from './common.ts';
import {
	type FontRef,
	FontRefSchema,
	type MediaAsset,
	MediaAssetSchema,
	type SyntheticSource,
	SyntheticSourceSchema,
	type Transcript,
	TranscriptSchema,
} from './media.ts';
import { CaptionStyleSchema, ClipMarkerSchema, type Sequence, SequenceSchema } from './sequence.ts';

/** v3 (M2): additive fields only — media kind `mg-bundle`, `lut`/`mgBundle` headers, `process` recipes, trackers,
 * `trackedBy`, curve params (ARCHITECTURE §19.1). Older builds open v3 files read-only (S01:MIG-003).
 * v4 (M2, D-32): additive — `TextClip.textAnimation`, `MotionGraphicClip.template.renderer`, clip kind `shape`
 * (ARCHITECTURE §20.1).
 * v5 (M3): additive — `MediaAsset.sourceRange` (S07:PRC-015…019: the source frames a processed version or a
 * rendered file holds). The v4 → v5 migration records the whole-source range on existing processed versions;
 * later M3 additions may share v5 (older builds open v5 files read-only).
 * v6 (parity program, D-36…D-48): additive; version bump only.
 * v7 (sound design, spec 12): Essential Sound SFX Pan is an offset (`panOffset`, `residual`) and media carry library
 * provenance (`MediaAsset.library`); version bump only, so v6 builds open v7 files read-only (docs/project-files.md). */
export const CURRENT_SCHEMA_VERSION = 9;

const markSchema = z.looseObject({ flicks: nonNegInt() });
export const SourceMarksSchema = z.looseObject({
	in: markSchema.nullable(),
	out: markSchema.nullable(),
	/**
	 * edit-ux (Premiere Mark Split): separate video/audio In/Out marks for split edits (J/L cuts from the source).
	 * Absent / null fields fall back to `in`/`out`.
	 */
	split: z
		.looseObject({
			videoIn: markSchema.nullable().optional(),
			videoOut: markSchema.nullable().optional(),
			audioIn: markSchema.nullable().optional(),
			audioOut: markSchema.nullable().optional(),
		})
		.optional(),
});
export type SourceMarks = DeepStrip<z.infer<typeof SourceMarksSchema>>;

export const BinItemSchema = z.looseObject({
	id: z.string(),
	kind: z.literal('bin'),
	name: z.string(),
	children: z.array(z.string()),
	label: LabelColorSchema,
});
export const MediaItemSchema = z.looseObject({
	id: z.string(),
	kind: z.literal('media'),
	name: z.string(),
	mediaId: z.string(),
	label: LabelColorSchema,
	marks: SourceMarksSchema,
	poster: z.looseObject({ flicks: nonNegInt() }).optional(),
	/** wp-multicam: source clip markers (media time), set in the Source monitor; sync points of Merge Clips and
	 * Create Multi-Camera Source Sequence by "Clip Marker". */
	markers: z.array(ClipMarkerSchema).optional(),
	/**
	 * gaps (Clip ▸ Modify ▸ Audio Channels on a Project item): the audio clips a placement of this item creates — one
	 * entry per clip (its stream, channel map and muted channels). Absent = the default (one stereo clip).
	 */
	audioChannels: z
		.looseObject({
			clips: z.array(
				z.looseObject({
					streamIndex: nonNegInt(),
					map: z.array(nonNegInt()),
					mute: z.array(nonNegInt()).optional(),
				}),
			),
		})
		.optional(),
});
export const SequenceItemSchema = z.looseObject({
	id: z.string(),
	kind: z.literal('sequence'),
	name: z.string(),
	sequenceId: z.string(),
	label: LabelColorSchema,
});
export const SyntheticItemSchema = z.looseObject({
	id: z.string(),
	kind: z.literal('synthetic'),
	name: z.string(),
	syntheticId: z.string(),
	label: LabelColorSchema,
	marks: SourceMarksSchema,
});
/**
 * edit-ux (Premiere Make Subclip): a named range of a media item's content, usable in the Source monitor and on
 * timelines. `range` is in content flicks `[in, out)`. With `restrictTrims` ("Restrict Trims to Subclip
 * Boundaries") clips placed from it cannot be trimmed past the range (they carry `subclipId`).
 */
export const SubclipItemSchema = z.looseObject({
	id: z.string(),
	kind: z.literal('subclip'),
	name: z.string(),
	label: LabelColorSchema,
	mediaId: z.string(),
	/** The media item it was made from (null when that item was deleted). */
	parentItemId: z.string().nullable(),
	range: z.looseObject({ in: nonNegInt(), out: nonNegInt() }),
	restrictTrims: z.boolean(),
	marks: SourceMarksSchema,
});
export const SearchBinItemSchema = z.looseObject({
	id: z.string(),
	kind: z.literal('search-bin'),
	name: z.string(),
	query: z.record(z.string(), z.unknown()),
	label: LabelColorSchema,
});
export const ProjectItemSchema = z.discriminatedUnion('kind', [
	BinItemSchema,
	MediaItemSchema,
	SequenceItemSchema,
	SyntheticItemSchema,
	SearchBinItemSchema,
	SubclipItemSchema,
]);
export type BinItem = DeepStrip<z.infer<typeof BinItemSchema>>;
export type MediaItem = DeepStrip<z.infer<typeof MediaItemSchema>>;
export type SequenceItem = DeepStrip<z.infer<typeof SequenceItemSchema>>;
export type SyntheticItem = DeepStrip<z.infer<typeof SyntheticItemSchema>>;
export type SubclipItem = DeepStrip<z.infer<typeof SubclipItemSchema>>;
export type ProjectItem = DeepStrip<z.infer<typeof ProjectItemSchema>>;

export const ProxyPolicySchema = z.looseObject({
	mode: z.enum(['off', 'auto', 'always']),
	preset: z.enum(['h264-720p', 'h264-540p']),
	autoWhen: z.looseObject({ minHeight: int(), codecs: z.array(z.string()), bitDepthAbove: int() }),
});
export type ProxyPolicy = DeepStrip<z.infer<typeof ProxyPolicySchema>>;

export const DEFAULT_SCALING_MODES = ['none', 'fit-if-larger', 'fit', 'fill'] as const;
export const DefaultScalingSchema = z.enum(DEFAULT_SCALING_MODES);
export type DefaultScaling = DeepStrip<z.infer<typeof DefaultScalingSchema>>;

/** Project Settings ▸ General ▸ Video Display Format (how times are shown and typed). */
export const VIDEO_DISPLAY_FORMATS = ['timecode', 'frames', 'feet35', 'feet16'] as const;
/** Project Settings ▸ General ▸ Audio Display Format (audio time units in the timeline ruler and Info). */
export const AUDIO_DISPLAY_FORMATS = ['samples', 'milliseconds'] as const;
export const ProjectDisplaySchema = z.looseObject({
	video: z.enum(VIDEO_DISPLAY_FORMATS).optional(),
	audio: z.enum(AUDIO_DISPLAY_FORMATS).optional(),
});
export type ProjectDisplay = DeepStrip<z.infer<typeof ProjectDisplaySchema>>;

/**
 * Project Settings ▸ Scratch Disks, as they map onto the engine: where files the project creates go. `media` =
 * Captured and Generated Media (proxies, exported frames, Project Manager copies, ingest copies and transcodes);
 * null / absent = the default (proxies and ingest next to the source media, frames in the engine's exports folder).
 * Previews, the media cache and auto-save versions live in the engine's folders (shown, moved from Media Cache).
 */
export const ProjectScratchSchema = z.looseObject({
	media: z.string().max(4096).nullable().optional(),
});
export type ProjectScratch = DeepStrip<z.infer<typeof ProjectScratchSchema>>;

/** Project Settings ▸ Ingest Settings (Premiere: Copy, Transcode, Create Proxies, Copy and Create Proxies). */
export const INGEST_ACTIONS = ['copy', 'transcode', 'proxies', 'copyAndProxies'] as const;
export const ProjectIngestSchema = z.looseObject({
	enabled: z.boolean(),
	action: z.enum(INGEST_ACTIONS),
	/** Proxy preset (`proxies` / `copyAndProxies`) or transcode preset (`transcode`); absent = the default. */
	preset: z.string().max(64).optional(),
	/** Folder for copies, transcodes and proxies; null = the scratch media folder, else next to the source. */
	destination: z.string().max(4096).nullable().optional(),
});
export type ProjectIngest = DeepStrip<z.infer<typeof ProjectIngestSchema>>;

export const ProjectSettingsSchema = z.looseObject({
	defaultSequencePreset: z.string(),
	mediaPolicy: z.looseObject({ copyOnImport: z.boolean() }),
	proxyPolicy: ProxyPolicySchema,
	defaultStillDurationFrames: z.number().int().min(1),
	defaultTransitionFrames: z.number().int().min(1),
	/** M3 (S10:TUI-032): default audio transition length; absent = `defaultTransitionFrames`. */
	defaultAudioTransitionFrames: z.number().int().min(1).optional(),
	defaultScaling: DefaultScalingSchema,
	captionStylePresets: z
		.array(z.looseObject({ id: z.string(), name: z.string(), style: CaptionStyleSchema.partial() }))
		.optional(),
	// projectSettingsOf supplies defaults for absent settings.
	display: ProjectDisplaySchema.optional(),
	scratch: ProjectScratchSchema.optional(),
	ingest: ProjectIngestSchema.optional(),
});
export type ProjectSettings = DeepStrip<z.infer<typeof ProjectSettingsSchema>>;

export const ProjectDocumentSchema = z.looseObject({
	schemaVersion: z.number().int().min(1),
	projectId: z.string(),
	name: z.string(),
	settings: ProjectSettingsSchema,
	rootItems: z.array(z.string()),
	items: z.record(z.string(), ProjectItemSchema),
	media: z.record(z.string(), MediaAssetSchema),
	synthetics: z.record(z.string(), SyntheticSourceSchema),
	transcripts: z.record(z.string(), TranscriptSchema),
	fonts: z.record(z.string(), FontRefSchema),
	sequences: z.record(z.string(), SequenceSchema),
	extensions: z.record(z.string(), z.unknown()),
	/**
	 * spec 13 SH-002 (schema v9): named project text styles by id (`tsy_…`) that text clips link to (`styleId`).
	 * Read leniently (any value loads; INV-TEXTSTYLE checks it, `repairTextStyles` fixes it on load); absent = none.
	 */
	textStyles: z.custom<Record<string, ProjectTextStyle>>(() => true).optional(),
	/**
	 * spec 13 AS-020 (schema v9): subtitle templates copied into the project when used, by id. Read leniently
	 * (INV-SUBTITLE checks it, `repairSubtitleTemplates` drops unreadable ones on load); absent = none.
	 */
	subtitleTemplates: z.custom<Record<string, SubtitleTemplate>>(() => true).optional(),
});

export type ProjectDocument = {
	schemaVersion: number;
	projectId: string;
	name: string;
	settings: ProjectSettings;
	rootItems: string[];
	items: Record<string, ProjectItem>;
	media: Record<string, MediaAsset>;
	synthetics: Record<string, SyntheticSource>;
	transcripts: Record<string, Transcript>;
	fonts: Record<string, FontRef>;
	sequences: Record<string, Sequence>;
	extensions: Record<string, unknown>;
	/** spec 13 SH-002: named project text styles by id (absent = none; see `text-styles/model.ts`). */
	textStyles?: Record<string, ProjectTextStyle>;
	/** spec 13 AS-020: subtitle templates used in the project (absent = none; see `captions/subtitles/templates.ts`). */
	subtitleTemplates?: Record<string, SubtitleTemplate>;
};

export type ProjectEnvelope = {
	format: 'jasper-project';
	schemaVersion: number;
	savedAt: string;
	savedBy: { app: string; version: string; platform: string };
	revision: number;
	document: ProjectDocument;
};

export function makeEnvelope(
	document: ProjectDocument,
	meta: { revision: number; savedAt: string; platform: string; appVersion?: string },
): ProjectEnvelope {
	return {
		format: 'jasper-project',
		schemaVersion: document.schemaVersion,
		savedAt: meta.savedAt,
		savedBy: { app: 'JasperEditor', version: meta.appVersion ?? '0.1.0', platform: meta.platform },
		revision: meta.revision,
		document,
	};
}
