import {
	ColorConfigInfoSchema,
	ImageSequenceInfoSchema,
	importedDescriptors,
	LayeredInfoSchema,
	LottieInfoSchema,
	LutInfoSchema,
	MediaKindSchema,
	type MediaLocator,
	MediaLocatorSchema,
	MediaProbeSchema,
	MgBundleInfoSchema,
	VectorInfoSchema,
} from '@jasper/project';
import { z } from 'zod';
import { RationalSchema } from './common.ts';

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
	/** Kind `lut` (S06): parsed header, copied into `MediaAsset.lut`. */
	lut: LutInfoSchema.optional(),
	/** Kind `mg-bundle` (S08): compositions, copied into `MediaAsset.mgBundle`. */
	mgBundle: MgBundleInfoSchema.optional(),
	/** Color-mgmt: kind `color-config` (a custom OCIO config bundle): header, copied into `MediaAsset.colorConfig`. */
	colorConfig: ColorConfigInfoSchema.optional(),
	/** SVG / PDF / Illustrator vector still, copied into `MediaAsset.vector`. */
	vector: VectorInfoSchema.optional(),
	/** Lottie animation, copied into `MediaAsset.lottie`. */
	lottie: LottieInfoSchema.optional(),
	/** Layered document (PSD), copied into `MediaAsset.layered`. */
	layered: LayeredInfoSchema.optional(),
	/** The numbered stills this file was conformed from, copied into `MediaAsset.imageSequence`. */
	imageSequence: ImageSequenceInfoSchema.optional(),
	/**
	 * a source-range sidecar found next to a file registered by path (`<name>.json` or
	 * `<stem>.json`, see `parseSourceSidecar`). Clients turn it into `MediaAsset.sourceRange`
	 * (`sourceRangeFromSidecar`). Not stored by the engine: read at registration.
	 */
	sourceHint: z
		.object({
			sidecar: z.string(),
			sourceName: z.string().nullable(),
			firstFrame: z.number().int().min(0),
			frames: z.number().int().min(1).nullable(),
			frameRate: RationalSchema.nullable(),
			handles: z.tuple([z.number().int().min(0), z.number().int().min(0)]).nullable(),
		})
		.optional(),
});
export type RegisteredMedia = z.infer<typeof RegisteredMediaSchema>;

/**
 * `DELETE /api/media/:mediaKey` (S07:PRC-018): discards a media the client registered but did not commit
 * (Replace Footage cancelled after the upload). Only engine-managed copies (uploads, "copy into project") that no
 * stored project or project version references are deleted — never the user's own files (`path` storage) nor
 * processed versions (content-addressed, reused).
 */
export const MediaDiscardResponseSchema = z.object({
	deleted: z.boolean(),
	reason: z.enum(['deleted', 'not-managed', 'derived', 'in-use']),
	/**
	 * cached derivatives still in use after the wait (a job reading one, a response
	 * streaming) — left for the next cache cleaning pass, which removes them once unused.
	 */
	cacheKept: z.number().int().min(0).optional(),
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

/**
 * `playback-audio` (pp-wma-preview): a lossless 32-bit float WAV of every audio stream of a file whose audio the browser
 * cannot decode (`needsPlaybackAudio`, @jasper/project), played by previews instead of the original's audio.
 */
export const DERIVATIVE_KINDS = [
	'keyframes',
	'poster',
	'sprite',
	'peaks',
	'proxy-720',
	'proxy-540',
	'playback-audio',
] as const;
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

/**
 * `POST /api/media/status` (polish): the status of many media in one request — opening a project resolves every
 * medium, and one request per medium made a 2 000-item project take seconds to open.
 */
export const MEDIA_STATUS_BATCH_MAX = 1000;
export const MediaStatusBatchRequestSchema = z.object({
	mediaKeys: z.array(z.string().min(1).max(256)).min(1).max(MEDIA_STATUS_BATCH_MAX),
});
export type MediaStatusBatchRequest = z.infer<typeof MediaStatusBatchRequestSchema>;
export const MediaStatusBatchResponseSchema = z.object({
	statuses: z.array(MediaStatusSchema),
	/** Keys the engine has no record of (the media is offline for this engine). */
	unknown: z.array(z.string()),
});
export type MediaStatusBatchResponse = z.infer<typeof MediaStatusBatchResponseSchema>;

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

/**
 * `GET /media/:key/playback-audio.json` (pp-wma-preview): the playback audio's streams, one WAV each
 * (`/media/:key/playback-audio/<index>.wav`, `index` = the container stream index clips store in
 * `channels.streamIndex`), same sample rate and channel count as the original stream, `frames` samples per channel.
 */
export const PlaybackAudioHeaderSchema = z.object({
	version: z.literal(1),
	codec: z.literal('pcm_f32le'),
	streams: z.array(
		z.object({
			index: z.number().int().min(0),
			sampleRate: z.number().int().positive(),
			channels: z.number().int().positive(),
			frames: z.number().int().min(0),
			url: z.string(),
		}),
	),
});
export type PlaybackAudioHeader = z.infer<typeof PlaybackAudioHeaderSchema>;

export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export const UploadCreateRequestSchema = z.object({
	projectId: z.string(),
	fileName: z.string().min(1),
	byteSize: z.number().int().min(0),
	mimeType: z.string(),
	clientFingerprint: z.string().optional(),
	/**
	 * `mg-bundle` = a zip of a built Remotion bundle, completed by
	 * `POST /api/mg-bundles/import {uploadId}` instead of `…/complete`. Default `media`.
	 */
	purpose: z.enum(['media', 'mg-bundle', 'sequence-frame']).optional(),
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

/** Engine identity used in `engine-store` locators (clients talk to exactly one local engine). */
export const LOCAL_ENGINE_ID = 'local';

/**
 * RegisteredMedia (`POST /api/media/register`, `/api/sounds/:id/register`) → the `media.register` command that adds the
 * asset and a Project item to the document (ARCHITECTURE D-09: an `engine-store` locator keyed by the engine's media key,
 * plus the file's `path` locators; the probe is copied as is). Shared by jasper-mcp and the engine's sound-design plan.
 */
export function mediaRegisterCommand(reg: RegisteredMedia, ref: string, itemRef: string, name?: string) {
	const locators: MediaLocator[] = [{ type: 'engine-store', engineId: LOCAL_ENGINE_ID, key: reg.mediaKey }];
	const seen = new Set<string>();
	for (const l of reg.locators)
		if (l.type === 'path' && !seen.has(l.path)) {
			seen.add(l.path);
			locators.push(l);
		}
	return {
		type: 'media.register' as const,
		asset: {
			kind: reg.kind,
			fingerprint: reg.fingerprint,
			originalName: reg.originalName,
			sizeBytes: reg.sizeBytes,
			container: reg.container,
			probe: reg.probe,
			locators,
			...(reg.lut ? { lut: reg.lut } : {}),
			...(reg.colorConfig ? { colorConfig: reg.colorConfig } : {}),
			...importedDescriptors(reg),
		},
		...(name ? { name } : {}),
		ref,
		itemRef,
	};
}
