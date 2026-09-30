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
import { type Sequence, SequenceSchema } from './sequence.ts';

export const CURRENT_SCHEMA_VERSION = 1;

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
	defaultScaling: DefaultScalingSchema,
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

/** On-disk envelope shared by every ProjectStore adapter (S01:PER-002). */
export const ProjectEnvelopeSchema = z.looseObject({
	format: z.literal('jasper-project'),
	schemaVersion: z.number().int().min(1),
	savedAt: z.string(),
	savedBy: z.looseObject({ app: z.string(), version: z.string(), platform: z.string() }),
	revision: nonNegInt(),
	document: z.unknown(),
});
export type ProjectEnvelope = {
	format: 'jasper-project';
	schemaVersion: number;
	savedAt: string;
	savedBy: { app: string; version: string; platform: string };
	revision: number;
	document: ProjectDocument;
};

/** Parses a document with zod (no migration, no invariants). */
export function parseDocument(raw: unknown): ProjectDocument {
	return ProjectDocumentSchema.parse(raw) as ProjectDocument;
}
export function safeParseDocument(raw: unknown) {
	return ProjectDocumentSchema.safeParse(raw) as
		| { success: true; data: ProjectDocument }
		| { success: false; error: z.ZodError };
}

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
