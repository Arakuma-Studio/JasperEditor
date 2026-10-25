import { MediaAssetSchema } from '@jasper/project';
import { z } from 'zod';
import { RationalSchema } from './common.ts';
import { RegisteredMediaSchema } from './media.ts';
import { EnvelopeSchema } from './projects.ts';

export const INTERCHANGE_FORMATS = ['fcp7', 'fcpxml', 'otio', 'edl', 'aaf', 'omf', 'ale'] as const;
export const InterchangeFormatSchema = z.enum(INTERCHANGE_FORMATS);
export type InterchangeFormat = z.infer<typeof InterchangeFormatSchema>;

/** File extensions File ▸ Import treats as timeline documents (`.xml` is sniffed: FCP7 XML vs other XML). */
export const INTERCHANGE_EXTENSIONS = [
	'xml',
	'xmeml',
	'fcpxml',
	'otio',
	'edl',
	'aaf',
	'omf',
	'omfi',
	'ale',
] as const;

/** One entry of an import/export report: what was not carried (and what was written instead), or a note. */
export const InterchangeReportEntrySchema = z.object({
	level: z.enum(['info', 'warning']),
	message: z.string(),
	count: z.number().int().min(1),
	subject: z
		.object({
			kind: z.string(),
			id: z.string().optional(),
			name: z.string().optional(),
			frame: z.number().optional(),
		})
		.optional(),
	instead: z.string().optional(),
});
export type InterchangeReportEntry = z.infer<typeof InterchangeReportEntrySchema>;

export const InterchangeImportRequestSchema = z
	.object({
		/** The project the media is registered for (derivatives, managed copies of embedded audio). */
		projectId: z.string().min(1),
		/** An absolute path (local engines), or the document's bytes. */
		path: z.string().min(1).optional(),
		file: z.object({ name: z.string().min(1), contentBase64: z.string() }).optional(),
		/** Default: sniffed from the bytes and the file name. */
		format: InterchangeFormatSchema.optional(),
		/** EDL / ALE: the rate timecodes are read at when the document does not say. */
		rate: RationalSchema.optional(),
		dropFrame: z.boolean().optional(),
		/** Directory relative media paths resolve against (default: the document's folder). */
		baseDir: z.string().optional(),
	})
	.refine((r) => !!r.path !== !!r.file, { message: 'Give either path or file' });
export type InterchangeImportRequest = z.infer<typeof InterchangeImportRequestSchema>;

export const InterchangeMissingSchema = z.object({
	mediaId: z.string(),
	name: z.string(),
	path: z.string().nullable(),
	kind: z.string(),
	durationFlicks: z.number().nullable(),
	reason: z.enum(['no-path', 'not-found', 'offline-in-document', 'unresolved']),
});
export type InterchangeMissing = z.infer<typeof InterchangeMissingSchema>;

export const InterchangeImportResponseSchema = z.object({
	format: InterchangeFormatSchema,
	/** The `project.importTimeline` fragment (bins, items, media, sequences, captions). */
	fragment: z.record(z.string(), z.unknown()),
	missing: z.array(InterchangeMissingSchema),
	warnings: z.array(InterchangeReportEntrySchema),
	/** Files the engine wrote (embedded AAF / OMF audio), registered as media. */
	extracted: z.array(z.object({ name: z.string(), path: z.string() })),
});
export type InterchangeImportResponse = z.infer<typeof InterchangeImportResponseSchema>;

export const PrerenderModeSchema = z.enum(['unsupported', 'all', 'none']);

export const InterchangeAudioOptionsSchema = z.object({
	/** `link`: reference the source files; `embed`: audio inside the AAF / OMF; `separate`: trimmed audio files next to it. */
	mode: z.enum(['link', 'embed', 'separate']).default('link'),
	/** Extra media before and after every used range (embed / separate). */
	handlesFrames: z.number().int().min(0).max(10_000).default(0),
	breakoutToMono: z.boolean().default(false),
	bitDepth: z.union([z.literal(16), z.literal(24)]).default(24),
	/** Separate files: WAV or AIFF. */
	fileFormat: z.enum(['wav', 'aiff']).default('wav'),
	/** Premiere's "Copy Complete Audio Files": whole media instead of the used ranges ("Trim Audio Files", default). */
	copyComplete: z.boolean().default(false),
});
export type InterchangeAudioOptions = z.infer<typeof InterchangeAudioOptionsSchema>;

export const InterchangeExportOptionsSchema = z.object({
	/** Name of the timeline in the document (default: the sequence's). */
	name: z.string().optional(),
	/** Clips the format cannot represent are rendered to ProRes 4444 with alpha and referenced (default per format). */
	prerender: PrerenderModeSchema.optional(),
	xmemlVersion: z.union([z.literal(4), z.literal(5)]).optional(),
	fcpxmlVersion: z.enum(['1.9', '1.10', '1.11']).optional(),
	/** OTIO / FCP7 / FCPXML: media paths relative to the document's folder (destination exports). */
	relativePaths: z.boolean().optional(),
	edl: z
		.object({
			/** Video track written (0 = V1); null = audio only. */
			videoTrack: z.number().int().min(0).nullable().optional(),
			/** Audio tracks (0 = A1), at most four. */
			audioTracks: z.array(z.number().int().min(0)).max(4).optional(),
			reelMode: z.enum(['file-name', 'clip-name', 'ax']).optional(),
			/** 8 (strict CMX 3600) or 32 (extended reel names). */
			reelLength: z.union([z.literal(8), z.literal(32)]).optional(),
			clipNames: z.boolean().optional(),
			sourceFiles: z.boolean().optional(),
			effectNames: z.boolean().optional(),
			markers: z.boolean().optional(),
			/** One list per video track (`<name>_V1.edl`, …). */
			perTrack: z.boolean().optional(),
		})
		.optional(),
	audio: InterchangeAudioOptionsSchema.optional(),
	aafSmallSectors: z.boolean().optional(),
	ale: z.object({ scope: z.enum(['sequence', 'project']) }).optional(),
});
export type InterchangeExportOptions = z.input<typeof InterchangeExportOptionsSchema>;

export const InterchangeExportRequestSchema = z.object({
	envelope: EnvelopeSchema,
	sequenceId: z.string(),
	format: InterchangeFormatSchema,
	options: InterchangeExportOptionsSchema.default({}),
	/** `download` keeps the files in the job's folder; `path` also writes them there (local engines). */
	destination: z
		.discriminatedUnion('type', [
			z.object({ type: z.literal('download') }),
			z.object({ type: z.literal('path'), path: z.string().min(1) }),
		])
		.default({ type: 'download' }),
});
export type InterchangeExportRequest = z.input<typeof InterchangeExportRequestSchema>;

/** `EngineJob.result` of a finished interchange export. */
export const InterchangeExportResultSchema = z.object({
	format: InterchangeFormatSchema,
	files: z.array(
		z.object({
			name: z.string(),
			downloadUrl: z.string(),
			byteSize: z.number().int().min(0),
			path: z.string().optional(),
			/** `document`, `audio` (separate AAF / OMF audio) or `prerender` (ProRes 4444 movies). */
			role: z.enum(['document', 'audio', 'prerender']),
		}),
	),
	prerendered: z.array(z.object({ clipId: z.string(), clipName: z.string(), reason: z.string() })),
	warnings: z.array(InterchangeReportEntrySchema),
});
export type InterchangeExportResult = z.infer<typeof InterchangeExportResultSchema>;

export const InterchangePrerenderPlanRequestSchema = z.object({
	envelope: EnvelopeSchema,
	sequenceId: z.string(),
	format: InterchangeFormatSchema,
	prerender: PrerenderModeSchema.optional(),
});
export const InterchangePrerenderPlanResponseSchema = z.object({
	mode: PrerenderModeSchema,
	clips: z.array(
		z.object({
			clipId: z.string(),
			sequenceId: z.string(),
			clipName: z.string(),
			reason: z.string(),
			startFrame: z.number().int(),
			durationFrames: z.number().int(),
		}),
	),
});

/**
 * Link Media ▸ Match File Properties (docs/wp-notes/link-media.md §1): `name` the file name without extension,
 * `extension` the extension (case-insensitive), `size` the byte size, `duration` the media length, `mediaStart` the
 * start timecode, `streams` the kind and stream layout (video / audio). A property the asset does not record (a size
 * of 0, no start timecode) is not compared.
 */
export const RELINK_CRITERIA = ['name', 'extension', 'size', 'duration', 'mediaStart', 'streams'] as const;
export const RelinkCriterionSchema = z.enum(RELINK_CRITERIA);
export type RelinkCriterion = z.infer<typeof RelinkCriterionSchema>;

/** Longest path a relink request carries (characters). */
const PATH = z.string().min(1).max(32_767);

export const AssetRelinkRequestSchema = z.object({
	projectId: z.string().min(1),
	/** The replacement file (absolute on the engine host, local engines). */
	path: PATH,
	/** The asset as the document has it (to compare fingerprint, duration, resolution, frame rate, audio layout). */
	asset: MediaAssetSchema,
	/** Selected match properties the file must satisfy (`failed` lists those it does not); default none. */
	match: z.array(RelinkCriterionSchema).max(RELINK_CRITERIA.length).optional(),
	/** Compatibility: `name` compares the whole file name unless this is true or `extension` is listed. */
	ignoreExtension: z.boolean().optional(),
});
export type AssetRelinkRequest = z.infer<typeof AssetRelinkRequestSchema>;

export const RelinkDiffSchema = z.object({
	field: z.enum(['duration', 'resolution', 'frameRate', 'audio', 'kind', 'name', 'size', 'mediaStart']),
	was: z.string(),
	now: z.string(),
});

export const AssetRelinkResponseSchema = z.object({
	/** The registered file (build the `media.relink` command from it). */
	media: RegisteredMediaSchema,
	/** `fingerprint`: the same bytes; `placeholder`: the asset had no fingerprint yet (imported offline). */
	match: z.enum(['fingerprint', 'placeholder', 'different']),
	/** What differs (empty when nothing the user would notice does). */
	diff: z.array(RelinkDiffSchema),
	/** Selected match properties the file does not satisfy. */
	failed: z.array(RelinkCriterionSchema).optional(),
	/** The user must confirm (`force`) before relinking. */
	needsConfirm: z.boolean(),
});
export type AssetRelinkResponse = z.infer<typeof AssetRelinkResponseSchema>;

/** A located file: its last known path (any operating system) and its path on the engine host now. */
export const RelinkAnchorSchema = z.object({
	from: PATH,
	to: PATH,
	/** The asset's project-relative path (MediaLocator `relativeToProject`), when known. */
	relativePath: PATH.nullable().optional(),
});
export type RelinkAnchor = z.infer<typeof RelinkAnchorSchema>;

/** Most offline media one Link Media run checks (the request body stays well under the engine's 20 MB limit). */
export const RELINK_MAX_ASSETS = 20_000;

export const RelinkScanRequestSchema = z.object({
	/** Folder to search (absolute on the engine host, local engines), recursively. */
	folder: PATH.optional(),
	/**
	 * Relink others automatically: files the user located. Each gives a folder mapping (old → new parent folders
	 * aligned on their longest common suffix), a project-relative base and a folder to look in and search.
	 */
	anchors: z.array(RelinkAnchorSchema).max(1000).optional(),
	/** The offline assets to find (each asset's last known path is tried first when the engine can open it). */
	assets: z.array(MediaAssetSchema).min(1).max(RELINK_MAX_ASSETS),
	/** Match File Properties every candidate must satisfy (besides a compatible kind). */
	match: z.array(RelinkCriterionSchema).min(1).default(['name']),
	/** Compatibility: `name` compares the whole file name unless this is true or `extension` is listed. */
	ignoreExtension: z.boolean().default(false),
	/** Time budget of the folder walk (seconds); the files seen until then are used and `timedOut` is set. */
	timeLimitSec: z.number().int().min(1).max(3600).default(120),
	/** Most files the folder walk indexes. */
	maxFiles: z.number().int().min(1).max(200_000).default(200_000),
});
export type RelinkScanRequest = z.input<typeof RelinkScanRequestSchema>;

/**
 * How a file was found: `original` its own last known path; `mapping` a located file's folder mapping; `relative`
 * its project-relative path; `same-folder` a located file's folder; `search` the folder walk (by name);
 * `fingerprint` the folder walk (same bytes under another name).
 */
export const RelinkStepSchema = z.enum([
	'original',
	'mapping',
	'relative',
	'same-folder',
	'search',
	'fingerprint',
]);
export type RelinkStep = z.infer<typeof RelinkStepSchema>;

/** The full result of a `relink-scan` job (`GET /api/projects/:projectId/relink-scan/:jobId`). */
export const RelinkScanResultSchema = z.object({
	found: z.array(
		z.object({
			assetId: z.string(),
			path: z.string(),
			media: RegisteredMediaSchema,
			matched: z.array(RelinkCriterionSchema),
			match: z.enum(['fingerprint', 'placeholder', 'different']),
			diff: z.array(RelinkDiffSchema),
			step: RelinkStepSchema.optional(),
			/** A different file, or a kind / length the clips cannot use: link only when the user confirms. */
			needsConfirm: z.boolean().optional(),
		}),
	),
	/** Several files satisfy the match properties: listed (at most 20), never guessed. */
	ambiguous: z
		.array(z.object({ assetId: z.string(), step: RelinkStepSchema, candidates: z.array(z.string()) }))
		.default([]),
	notFound: z.array(z.string()),
	scannedFiles: z.number().int().min(0),
	truncated: z.boolean(),
	/** The folder walk stopped at its time budget. */
	timedOut: z.boolean().default(false),
	/** The folder mappings derived from the anchors (display paths). */
	mappings: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
});
export type RelinkScanResult = z.infer<typeof RelinkScanResultSchema>;

/** `EngineJob.result` of a `relink-scan` job: counts; the full result is fetched separately (it can be large). */
export const RelinkScanSummarySchema = z.object({
	found: z.number().int().min(0),
	needsConfirm: z.number().int().min(0),
	ambiguous: z.number().int().min(0),
	notFound: z.number().int().min(0),
	scannedFiles: z.number().int().min(0),
	truncated: z.boolean(),
	timedOut: z.boolean(),
});
export type RelinkScanSummary = z.infer<typeof RelinkScanSummarySchema>;
