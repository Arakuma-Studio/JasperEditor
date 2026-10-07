// Render previews (workstream `previews`, docs/wp-notes/previews.md): Sequence ▸ Render Effects In to Out / Render In
// to Out / Render Selection / Render Audio / Delete Render Files, the render bar's green state and preview playback.
//
// Segments and their content hashes are computed by `@jasper/project` (`previewSegments`, `audioPreviewSegments`)
// on both sides: the editor asks which of its hashes have files (`/api/previews/status`); render requests carry the
// document and the engine computes the segments itself (a client never names the files the engine writes).
import { z } from 'zod';
import { EnvelopeSchema } from './projects.ts';

/** Sequence Settings ▸ Video Previews (the engine's file format key is derived from them and the renderer version). */
export const PreviewSettingsSchema = z.object({
	format: z.enum(['h264-iframe', 'h264', 'vp9']).default('h264-iframe'),
	size: z.enum(['full', 'half']).default('full'),
	quality: z.enum(['standard', 'high']).default('standard'),
});
export type PreviewSettings = z.infer<typeof PreviewSettingsSchema>;

const Hash = z.string().regex(/^[0-9a-f]{32}$/);

/** `POST /api/previews/status`: which of these segment hashes have preview files (video and audio). */
export const PreviewStatusRequestSchema = z.object({
	settings: PreviewSettingsSchema.default({ format: 'h264-iframe', size: 'full', quality: 'standard' }),
	video: z.array(Hash).max(100_000).default([]),
	audio: z.array(Hash).max(100_000).default([]),
});
export type PreviewStatusRequest = z.input<typeof PreviewStatusRequestSchema>;

export const PreviewStatusSchema = z.object({
	/** The preview file format key (directory) these answers are for. */
	formatKey: z.string(),
	/** Hashes (from the request) whose video preview exists. */
	video: z.array(z.string()),
	audio: z.array(z.string()),
	/** URL template of a video preview: replace `{hash}` (served with byte ranges, immutable). */
	videoUrl: z.string(),
	/** URL template of an audio preview (32-bit float stereo WAV at the sequence rate). */
	audioUrl: z.string(),
	/** Container/extension of the video previews of this format. */
	container: z.enum(['mp4', 'webm']),
	/** Size of the preview frames (`half` = half the sequence size). */
	size: z.enum(['full', 'half']),
	/** Audio preview files of this format (the editor computes audio segments only when there are some). */
	audioFiles: z.number().int(),
});
export type PreviewStatus = z.infer<typeof PreviewStatusSchema>;

/**
 * What a render command picks (Premiere's Sequence menu): `effects` = Render Effects In to Out (red and yellow
 * segments in the range), `all` = Render In to Out (every segment in the range), `selection` = Render Selection
 * (segments showing one of `clipIds`), `audio` = Render Audio (audio segments in the range).
 */
export const PreviewRenderModeSchema = z.enum(['effects', 'all', 'selection', 'audio']);
export type PreviewRenderMode = z.infer<typeof PreviewRenderModeSchema>;

/** `POST /api/previews/render` → 202 EngineJob kind `preview` (`?wait=1`: the finished job). */
export const PreviewRenderRequestSchema = z.object({
	envelope: EnvelopeSchema,
	sequenceId: z.string().min(1),
	mode: PreviewRenderModeSchema,
	/** Frames [start, end) (absent = the sequence's In/Out, else the whole sequence). */
	range: z.object({ start: z.number().int().min(0), end: z.number().int().min(1) }).optional(),
	/** Render Selection: the selected clips. */
	clipIds: z.array(z.string()).max(10_000).optional(),
	/** Absent = the sequence's own preview settings. */
	settings: PreviewSettingsSchema.optional(),
});
export type PreviewRenderRequest = z.input<typeof PreviewRenderRequestSchema>;

/** Result of a `preview` job. */
export const PreviewRenderResultSchema = z.object({
	formatKey: z.string(),
	/** Segments rendered by this job, already valid before it, and skipped (with the reason). */
	rendered: z.array(z.object({ hash: z.string(), startFrame: z.number().int(), frames: z.number().int() })),
	existing: z.number().int(),
	skipped: z.array(z.object({ startFrame: z.number().int(), frames: z.number().int(), reason: z.string() })),
	frames: z.number().int(),
	seconds: z.number(),
	bytes: z.number().int(),
	/** Render paths used per segment (native / hybrid / remotion) for video, `mix` for audio. */
	paths: z.record(z.string(), z.number().int()),
});
export type PreviewRenderResult = z.infer<typeof PreviewRenderResultSchema>;

/**
 * `POST /api/previews/delete`: Delete Render Files (`all`: every preview file of every format) or Delete Render Files
 * In to Out (the hashes of the segments in the range, both kinds).
 */
export const PreviewDeleteRequestSchema = z.union([
	z.object({ all: z.literal(true) }),
	z.object({ hashes: z.array(Hash).max(100_000) }),
]);
export type PreviewDeleteRequest = z.infer<typeof PreviewDeleteRequestSchema>;
export const PreviewDeleteResultSchema = z.object({ deleted: z.number().int(), bytes: z.number().int() });
export type PreviewDeleteResult = z.infer<typeof PreviewDeleteResultSchema>;

/** Answer of `POST /api/previews/render` when every segment of the range has its file already. */
export const PreviewRenderNothingSchema = z.object({ job: z.null(), existing: z.number().int() });
