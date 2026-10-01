// Media registration, uploads, derivatives and their JSON headers (ARCHITECTURE §9.2/§9.4, D-09, D-10,
// S04:IN-005, TH-002, WF-001).
import {
	LutInfoSchema,
	MediaKindSchema,
	MediaLocatorSchema,
	MediaProbeSchema,
	MgBundleInfoSchema,
} from '@jasper/project';
import { z } from 'zod';

/** Engine-issued media key (`mk_…`), referenced from documents through `engine-store` locators. */
export const MediaKeySchema = z.string().regex(/^mk_[A-Za-z0-9]{8,}$/, 'engine media key');

export const RegisteredMediaSchema = z.object({
	mediaKey: z.string(),
	fingerprint: z.string(),
	originalName: z.string(),
	sizeBytes: z.number().int().min(0),
	container: z.string(),
	kind: MediaKindSchema,
	probe: MediaProbeSchema,
	locators: z.array(MediaLocatorSchema),
	browserPlayable: z.enum(['yes', 'no', 'unknown']),
	/** kind `lut` (M2, S06): parsed header, copied into `MediaAsset.lut`. */
	lut: LutInfoSchema.optional(),
	/** kind `mg-bundle` (M2, S08): compositions, copied into `MediaAsset.mgBundle`. */
	mgBundle: MgBundleInfoSchema.optional(),
	/**
	 * M3 (S07:PRC-019): a source-range sidecar found next to a file registered by path (`<name>.json` or
	 * `<stem>.json`, see `parseSourceSidecar`). Clients turn it into `MediaAsset.sourceRange`
	 * (`sourceRangeFromSidecar`). Not stored by the engine: read at registration.
	 */
	sourceHint: z
		.object({
			sidecar: z.string(),
			sourceName: z.string().nullable(),
			firstFrame: z.number().int().min(0),
			frames: z.number().int().min(1).nullable(),
			frameRate: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }).nullable(),
			handles: z.tuple([z.number().int().min(0), z.number().int().min(0)]).nullable(),
		})
		.optional(),
});
export type RegisteredMedia = z.infer<typeof RegisteredMediaSchema>;

/**
 * `DELETE /api/media/:mediaKey` (M3, S07:PRC-018): discards a media the client registered but did not commit
 * (Replace Footage cancelled after the upload). Only engine-managed copies (uploads, "copy into project") that no
 * stored project or project version references are deleted — never the user's own files (`path` storage) nor
 * processed versions (content-addressed, reused).
 */
export const MediaDiscardResponseSchema = z.object({
	deleted: z.boolean(),
	reason: z.enum(['deleted', 'not-managed', 'derived', 'in-use']),
});
export type MediaDiscardResponse = z.infer<typeof MediaDiscardResponseSchema>;

export const MediaRegisterRequestSchema = z.object({
	projectId: z.string(),
	paths: z.array(z.string().min(1)).min(1),
	copyIntoProject: z.boolean().optional(),
});
export type MediaRegisterRequest = z.infer<typeof MediaRegisterRequestSchema>;
export const MediaRegisterResponseSchema = z.object({
	items: z.array(RegisteredMediaSchema),
	errors: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })),
});
export type MediaRegisterResponse = z.infer<typeof MediaRegisterResponseSchema>;

export const DERIVATIVE_KINDS = ['keyframes', 'poster', 'sprite', 'peaks', 'proxy-720', 'proxy-540'] as const;
export const DerivativeKindSchema = z.enum(DERIVATIVE_KINDS);
export type DerivativeKind = z.infer<typeof DerivativeKindSchema>;

/** Same shape as S01:LIFE-050 `DerivativeStatus`, plus the URL once ready. */
export const DerivativeStatusSchema = z.object({
	state: z.enum(['none', 'queued', 'running', 'ready', 'failed']),
	progress: z.number().min(0).max(1),
	error: z.string().optional(),
	url: z.string().optional(),
	jobId: z.string().optional(),
});
export type DerivativeStatus = z.infer<typeof DerivativeStatusSchema>;

export const MediaStatusSchema = z.object({
	mediaKey: z.string(),
	status: z.enum(['online', 'missing', 'processing', 'error']),
	derivatives: z.record(DerivativeKindSchema, DerivativeStatusSchema),
});
export type MediaStatus = z.infer<typeof MediaStatusSchema>;

export const DerivativesRequestSchema = z.object({ kinds: z.array(DerivativeKindSchema).min(1) });
export type DerivativesRequest = z.infer<typeof DerivativesRequestSchema>;

/** Filmstrip sprite index (S04:TH-002). */
export const SpriteIndexSchema = z.object({
	tileWidth: z.number().int().positive(),
	tileHeight: z.number().int().positive(),
	columns: z.number().int().positive(),
	tiles: z.array(
		z.object({ sheet: z.number().int().min(0), index: z.number().int().min(0), timeSec: z.number().min(0) }),
	),
});
export type SpriteIndex = z.infer<typeof SpriteIndexSchema>;

/** Waveform peaks header (S04:WF-001): float32 LE max-abs per channel at `peaksPerSecond`. */
export const PeaksHeaderSchema = z.object({
	peaksPerSecond: z.number().positive(),
	channels: z.number().int().positive(),
	sampleCount: z.number().int().min(0),
	durationSec: z.number().min(0),
	streams: z
		.array(
			z.object({ index: z.number().int().min(0), channels: z.number().int().positive(), url: z.string() }),
		)
		.optional(),
});
export type PeaksHeader = z.infer<typeof PeaksHeaderSchema>;

// ---------------------------------------------------------------- uploads (S04:IN-005)

export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export const UploadCreateRequestSchema = z.object({
	projectId: z.string(),
	fileName: z.string().min(1),
	byteSize: z.number().int().min(0),
	mimeType: z.string(),
	clientFingerprint: z.string().optional(),
	/**
	 * M2 (wp-m2-mg, additive): `mg-bundle` = a zip of a built Remotion bundle, completed by
	 * `POST /api/mg-bundles/import {uploadId}` instead of `…/complete`. Default `media`.
	 */
	purpose: z.enum(['media', 'mg-bundle']).optional(),
});
export type UploadCreateRequest = z.infer<typeof UploadCreateRequestSchema>;
export const UploadCreateResponseSchema = z.object({
	uploadId: z.string(),
	chunkSize: z.number().int().positive(),
	offset: z.number().int().min(0),
});
export type UploadCreateResponse = z.infer<typeof UploadCreateResponseSchema>;
export const UploadAppendResponseSchema = z.object({ offset: z.number().int().min(0) });
export type UploadAppendResponse = z.infer<typeof UploadAppendResponseSchema>;
/** 409 detail when the chunk offset does not match the server's. */
export const UploadOffsetMismatchSchema = z.object({ expectedOffset: z.number().int().min(0) });
