// Engine jobs (S04 §17.1, ARCHITECTURE §9.3).
import { z } from 'zod';

export const JOB_KINDS = [
	'upload',
	'probe',
	'keyframes',
	'poster',
	'sprite',
	'peaks',
	'proxy',
	'analysis',
	'transcription',
	'model-download',
	'export',
	'still',
	'mg-render',
	'browser-download',
	'gc',
	'relink-scan',
	// wp interchange: timeline export (pre-renders, audio essence, the document)
	'interchange-export',
	// M2 (ARCHITECTURE §19.7)
	'process',
	'track',
	'mg-bundle',
	'mg-prerender',
	'layer-bake',
	'remote-setup',
	// M3 (wp-m3-cachegc): moving the media cache to another folder (S04:CA-021)
	'cache-move',
	// Workstream `time`: Scene Edit Detection
	'scene-detect',
	// parity (roto): Roto Brush segmentation / propagation and face tracking
	'roto',
	// parity (three-d): 3D Camera Tracker (feature tracking + camera solve)
	'camtrack',
	// imports: interpreted variants, image sequences, layered documents
	'interpret',
	'image-sequence',
	'layers',
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
