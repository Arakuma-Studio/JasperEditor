import { z } from 'zod';

export const JOB_KINDS = [
	'upload',
	'probe',
	'keyframes',
	'poster',
	'sprite',
	'peaks',
	'proxy',
	'playback-audio',
	'analysis',
	'transcription',
	'model-download',
	'export',
	'still',
	'mg-render',
	'browser-download',
	'gc',
	'relink-scan',

	'interchange-export',

	'process',
	'track',
	'mg-bundle',
	'mg-prerender',
	'layer-bake',
	'remote-setup',

	'cache-move',

	'scene-detect',

	'roto',

	'camtrack',

	'interpret',
	'image-sequence',
	'layers',

	'preview',

	'proxy-create',
	'project-manager',
	'warp-analysis',
	'reframe',

	'sound-index',
	'sound-design',
	'sound-check',
	'sound-listen',
	'sound-profile',
	'sound-pack-install',
	'motion-analysis',
	'audio-classify',
	'sound-embed',
	'sound-moment',

	'voice-analysis',
	'cleanup-analysis',
	/** spec 16 SG-006: the downloadable ONNX Runtime CUDA provider (Linux x64). */
	'runtime-download',
	'edit-automation',
	/** spec 15 EA-012: Apply Style (a recipe's passes into one proposal). */
	'apply-style',
	/** spec 17 SC-090: Fix Transcript (script / glossary candidates checked against the audio → one proposal). */
	'transcript-fix',
] as const;
export const JobKindSchema = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JOB_STATES = [
	'queued',
	'running',
	'cancelling',
	'succeeded',
	'failed',
	'cancelled',
	'interrupted',
] as const;
export const JobStateSchema = z.enum(JOB_STATES);
export type JobState = z.infer<typeof JobStateSchema>;
export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set([
	'succeeded',
	'failed',
	'cancelled',
	'interrupted',
]);

export const JobOriginSchema = z.union([
	z.object({ type: z.literal('user') }),
	z.object({ type: z.literal('agent'), agentRunId: z.string() }),
	z.object({ type: z.literal('system') }),
]);

export const JobPrioritySchema = z.enum(['interactive', 'user', 'background']);

export const EngineJobSchema = z.object({
	id: z.string(),
	kind: JobKindSchema,
	title: z.string(),
	origin: JobOriginSchema,
	projectId: z.string().optional(),
	assetId: z.string().optional(),
	parentId: z.string().optional(),
	state: JobStateSchema,
	progress: z.number().min(0).max(1).nullable(),
	stage: z.string().optional(),
	speed: z.number().optional(),
	etaSec: z.number().optional(),
	createdAt: z.string(),
	startedAt: z.string().optional(),
	finishedAt: z.string().optional(),
	priority: JobPrioritySchema,
	cpuSlots: z.number().int().min(0),
	dedupeKey: z.string().optional(),
	result: z.unknown().optional(),
	error: z
		.object({ code: z.string(), message: z.string(), retryable: z.boolean(), logRef: z.string().optional() })
		.optional(),
});
export type EngineJob = z.infer<typeof EngineJobSchema>;

export const JobListQuerySchema = z.object({
	active: z.enum(['0', '1']).optional(),
	projectId: z.string().optional(),
	since: z.string().optional(),
});
export type JobListQuery = z.infer<typeof JobListQuerySchema>;
export const JobListResponseSchema = z.object({ jobs: z.array(EngineJobSchema) });
