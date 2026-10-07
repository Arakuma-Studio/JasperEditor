// Project document root, project items and the persistence envelope (S01 §4, §5, PER-002).
import { z } from 'zod';
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
import { CaptionStyleSchema, type Sequence, SequenceSchema } from './sequence.ts';

/** v3 (M2): additive fields only — media kind `mg-bundle`, `lut`/`mgBundle` headers, `process` recipes, trackers,
 * `trackedBy`, curve params (ARCHITECTURE §19.1). Older builds open v3 files read-only (S01:MIG-003).
 * v4 (M2, D-32): additive — `TextClip.textAnimation`, `MotionGraphicClip.template.renderer`, clip kind `shape`
 * (ARCHITECTURE §20.1).
 * v5 (M3): additive — `MediaAsset.sourceRange` (S07:PRC-015…019: the source frames a processed version or a
 * rendered file holds). The v4 → v5 migration records the whole-source range on existing processed versions;
 * later M3 additions may share v5 (older builds open v5 files read-only). */
export const CURRENT_SCHEMA_VERSION = 5;

export const SourceMarksSchema = z.looseObject({
	in: z.looseObject({ flicks: nonNegInt() }).nullable(),
	out: z.looseObject({ flicks: nonNegInt() }).nullable(),
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
]);
export type BinItem = DeepStrip<z.infer<typeof BinItemSchema>>;
export type MediaItem = DeepStrip<z.infer<typeof MediaItemSchema>>;
export type SequenceItem = DeepStrip<z.infer<typeof SequenceItemSchema>>;
export type SyntheticItem = DeepStrip<z.infer<typeof SyntheticItemSchema>>;
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

export const ProjectSettingsSchema = z.looseObject({
	defaultSequencePreset: z.string(),
	mediaPolicy: z.looseObject({ copyOnImport: z.boolean() }),
	proxyPolicy: ProxyPolicySchema,
	defaultStillDurationFrames: z.number().int().min(1),
	defaultTransitionFrames: z.number().int().min(1),
	/** M3 (S10:TUI-032): default audio transition length; absent = `defaultTransitionFrames`. */
	defaultAudioTransitionFrames: z.number().int().min(1).optional(),
	defaultScaling: DefaultScalingSchema,
	/** wp captions: caption style presets saved in the project (Premiere "Track Style"). */
	captionStylePresets: z
		.array(z.looseObject({ id: z.string(), name: z.string(), style: CaptionStyleSchema.partial() }))
		.optional(),
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
