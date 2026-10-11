import { z } from 'zod';
import { RegisteredMediaSchema } from './media.ts';

/** `GET /api/media/:mediaKey/location`: where the media's bytes are on the engine host. */
export const MediaLocationSchema = z.object({
	mediaKey: z.string(),
	/** Absolute path on the engine host; null when the media is offline. */
	path: z.string().nullable(),
	exists: z.boolean(),
	/** Whether the engine can open files with the host's applications (local engines only). */
	canOpen: z.boolean(),
});
export type MediaLocation = z.infer<typeof MediaLocationSchema>;

/** `POST /api/media/:mediaKey/open`: `reveal` = show it in the file browser, `open` = open it in its default app. */
export const MediaOpenRequestSchema = z.object({ action: z.enum(['reveal', 'open']).default('reveal') });
export type MediaOpenRequest = z.infer<typeof MediaOpenRequestSchema>;
export const MediaOpenResponseSchema = z.object({
	ok: z.literal(true),
	path: z.string(),
	action: z.enum(['reveal', 'open']),
});
export type MediaOpenResponse = z.infer<typeof MediaOpenResponseSchema>;

/** One scratch location: where it is on the engine host and the space left there. */
export const ScratchLocationSchema = z.object({
	/** Absolute folder (null on a remote engine: paths are not exposed). */
	path: z.string().nullable(),
	exists: z.boolean(),
	writable: z.boolean(),
	freeBytes: z.number().nullable(),
});
export type ScratchLocation = z.infer<typeof ScratchLocationSchema>;

/** `GET /api/projects/:projectId/scratch`: the engine folders behind the Scratch Disks page. */
export const ScratchInfoSchema = z.object({
	local: z.boolean(),
	/** "Same as Project" for Captured and Generated Media (proxies, frames, Project Manager, ingest). */
	projectMedia: ScratchLocationSchema,
	/** Video and audio render previews (in the media cache). */
	previews: ScratchLocationSchema,
	mediaCache: ScratchLocationSchema,
	/** Saved versions (Project Auto Save). */
	autoSave: ScratchLocationSchema,
	/** The engine host's home folder (folder pickers start there). */
	home: z.string().nullable(),
});
export type ScratchInfo = z.infer<typeof ScratchInfoSchema>;

/** `POST /api/scratch/check`: whether a folder can take generated media (created when `create`). */
export const ScratchCheckRequestSchema = z.object({
	path: z.string().min(1).max(4096),
	create: z.boolean().optional(),
});
export const ScratchCheckSchema = ScratchLocationSchema.extend({
	ok: z.boolean(),
	message: z.string().optional(),
});
export type ScratchCheck = z.infer<typeof ScratchCheckSchema>;

/**
 * Where Create Proxies / ingest writes: `next-to-media` = a `Proxies` (or `Ingested Media`) folder beside the source
 * (managed uploads fall back to the project), `project` = the project's scratch media folder (Project Settings ▸
 * Scratch Disks, default "Same as Project"), `folder` = `folder`.
 */
export const MediaJobDestinationSchema = z.object({
	mode: z.enum(['next-to-media', 'project', 'folder']),
	folder: z.string().min(1).max(4096).optional(),
});
export type MediaJobDestination = z.infer<typeof MediaJobDestinationSchema>;

/**
 * `POST /api/media-jobs` → 202 EngineJob kind `proxy-create`: one job over several media. `op`: `proxy` (Create
 * Proxies / ingest proxies, preset from `PROXY_PRESETS`), `transcode` (ingest Transcode, full size), `copy` (ingest
 * Copy: byte copy verified by fingerprint). The result lists each output as RegisteredMedia; the client attaches
 * proxies (`media.attachProxy`) or relinks copies / transcodes (`media.relink`).
 */
export const MediaJobRequestSchema = z.object({
	projectId: z.string().optional(),
	op: z.enum(['proxy', 'transcode', 'copy']),
	preset: z.string().max(64).optional(),
	destination: MediaJobDestinationSchema,
	items: z
		.array(
			z.object({
				mediaKey: z.string().min(1),
				mediaId: z.string().min(1),
				name: z.string().max(400).optional(),
			}),
		)
		.min(1)
		.max(2000),
});
export type MediaJobRequest = z.infer<typeof MediaJobRequestSchema>;

export const MediaJobResultSchema = z.object({
	op: z.enum(['proxy', 'transcode', 'copy']),
	preset: z.string().nullable(),
	outputs: z.array(z.object({ mediaId: z.string(), path: z.string(), registered: RegisteredMediaSchema })),
	skipped: z.array(z.object({ mediaId: z.string(), reason: z.string() })),
});
export type MediaJobResult = z.infer<typeof MediaJobResultSchema>;

/**
 * Engine-wide preferences: saved versions (Premiere's "Automatically save every N minutes" and
 * "Maximum Project Versions" — a version of the project file is kept at most every `versionIntervalMinutes`, the
 * newest `keepVersions` are kept) and Memory ▸ "Optimize rendering for" (`memory` halves the parallel render pages
 * and browser tabs of exports, previews and pre-renders).
 */
export const EngineGapsSettingsSchema = z.object({
	versionIntervalMinutes: z.number().min(1).max(240),
	keepVersions: z.number().int().min(1).max(500),
	optimizeFor: z.enum(['performance', 'memory']),
});
export type EngineGapsSettings = z.infer<typeof EngineGapsSettingsSchema>;

/** `GET /api/settings/gaps` also reports the host memory (Preferences ▸ Memory). */
export const EngineGapsInfoSchema = EngineGapsSettingsSchema.extend({
	memory: z.object({
		totalBytes: z.number(),
		freeBytes: z.number(),
		engineRssBytes: z.number(),
		cpuCount: z.number(),
	}),
});

export const ProjectManagerOptionsSchema = z.object({
	/** Absolute folder the copy is written to (created when missing). */
	destination: z.string().min(1).max(4096),
	/** Collect Files and Copy to New Location, or Consolidate and Transcode. */
	mode: z.enum(['collect', 'consolidate']),
	/** Sequences to keep (with the sequences nested in them); absent / empty = every sequence. */
	sequenceIds: z.array(z.string()).max(1000).optional(),
	/** Exclude Unused Clips (Premiere default on). */
	excludeUnused: z.boolean().default(true),
	/** Handles of consolidated clips, frames (Premiere default 30). */
	handlesFrames: z.number().int().min(0).max(10_000).default(30),
	/** Include Preview Files: the render previews of the kept sequences, under `Render Files/`. */
	includePreviews: z.boolean().default(false),
	/** Include Proxies (collect only: consolidated media lose their proxies, as in Premiere). */
	includeProxies: z.boolean().default(true),
	/** Name of the new project (default: the project's name + " Copy"). */
	projectName: z.string().min(1).max(200).optional(),
});
export type ProjectManagerOptions = z.infer<typeof ProjectManagerOptionsSchema>;

/** `POST /api/project-manager/plan` (estimate, Premiere's "Calculate") and `POST /api/project-manager` (job). */
export const ProjectManagerRequestSchema = z.object({
	envelope: z.looseObject({ document: z.record(z.string(), z.unknown()) }),
	options: ProjectManagerOptionsSchema,
});
export type ProjectManagerRequest = z.infer<typeof ProjectManagerRequestSchema>;

export const ProjectManagerEstimateSchema = z.object({
	originalBytes: z.number(),
	resultBytes: z.number(),
	files: z.array(
		z.object({
			mediaId: z.string(),
			name: z.string(),
			action: z.enum(['copy', 'trim', 'offline']),
			sizeBytes: z.number(),
			estimatedBytes: z.number(),
		}),
	),
	keptSequences: z.number().int(),
	droppedSequences: z.number().int(),
	droppedItems: z.number().int(),
	destinationFreeBytes: z.number().nullable(),
});
export type ProjectManagerEstimate = z.infer<typeof ProjectManagerEstimateSchema>;

/** Result of a `project-manager` job: the report. */
export const ProjectManagerResultSchema = z.object({
	projectId: z.string(),
	projectFile: z.string(),
	files: z.array(
		z.object({
			mediaId: z.string(),
			from: z.string().nullable(),
			to: z.string().nullable(),
			action: z.string(),
		}),
	),
	skipped: z.array(z.object({ mediaId: z.string(), reason: z.string() })),
	previews: z.number().int(),
	bytes: z.number(),
	droppedSequences: z.number().int(),
	droppedItems: z.number().int(),
});
export type ProjectManagerResult = z.infer<typeof ProjectManagerResultSchema>;

/**
 * `POST /api/warp-analysis`: analyse source frames [startFrame, startFrame + frameCount) of a video for the Warp
 * Stabilizer (job `warp-analysis`; its result is the analysis stored with the effect: `effect.setWarpAnalysis`).
 */
export const WarpAnalysisRequestSchema = z.object({
	projectId: z.string().optional(),
	mediaKey: z.string().min(1),
	/** The project media id (recorded in the analysis). */
	mediaId: z.string().optional(),
	startFrame: z.number().int().min(0),
	frameCount: z.number().int().min(2).max(54_000),
	/** Advanced ▸ Detailed Analysis: twice the analysis resolution and more features. */
	detailed: z.boolean().default(false),
});
export type WarpAnalysisRequest = z.infer<typeof WarpAnalysisRequestSchema>;

/** The job result (the project's `WarpAnalysisData`; validated by the command when stored). */
export const WarpAnalysisResultSchema = z.object({
	version: z.literal(1),
	key: z.string(),
	mediaId: z.string().optional(),
	start: z.number(),
	frameDuration: z.number(),
	size: z.tuple([z.number(), z.number()]),
	detailed: z.boolean(),
	frames: z.array(z.number()),
	tracks: z.array(z.object({ start: z.number().int(), pts: z.array(z.number()) })).optional(),
	confidence: z.number().optional(),
	analyzedAt: z.string().optional(),
	/** Frames actually decoded (fewer than requested when the file is shorter). */
	analysedFrames: z.number().int(),
	framesPerSec: z.number().optional(),
});
export type WarpAnalysisResult = z.infer<typeof WarpAnalysisResultSchema>;

/** `POST /api/reframe`: the subject of each frame of a media range (job `reframe`). */
export const ReframeRequestSchema = z.object({
	projectId: z.string().optional(),
	mediaKey: z.string().min(1),
	startFrame: z.number().int().min(0),
	frameCount: z.number().int().min(1).max(54_000),
	/** Use the face model when it is installed (default true). */
	faces: z.boolean().optional(),
});
export type ReframeRequest = z.infer<typeof ReframeRequestSchema>;

export const ReframeResultSchema = z.object({
	start: z.number(),
	frameDuration: z.number(),
	/** X, y (0..1 of the display), confidence per frame. */
	points: z.array(z.number()),
	source: z.enum(['faces', 'saliency', 'mixed']),
	frames: z.number().int(),
	facesFound: z.number().int(),
	note: z.string().optional(),
});
export type ReframeResult = z.infer<typeof ReframeResultSchema>;
