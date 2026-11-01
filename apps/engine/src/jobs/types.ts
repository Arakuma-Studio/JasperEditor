import type { ChildProcess } from 'node:child_process';
import type { EngineJob, JobKind } from '@jasper/api';

export type JobPriority = EngineJob['priority'];
type JobOrigin = EngineJob['origin'];

export type JobSubmit = {
	kind: JobKind;
	title: string;
	priority: JobPriority;
	/** Requested CPU slots (S04:JB-012). 0 = no CPU budget (I/O only). */
	cpuSlots: number;
	/** Start with fewer slots than requested, but never fewer than this (exports: half). */
	minSlots?: number;
	origin?: JobOrigin;
	projectId?: string;
	assetId?: string;
	parentId?: string;
	/** Submitting while a queued/running job has this key returns that job (S04:JB-014). */
	dedupeKey?: string;
	/** Serializable runner input; journaled so artifact jobs can re-queue after a restart. */
	input?: unknown;
	/** Initial stage text. */
	stage?: string;
};

export type ProgressExtra = { stage?: string; speed?: number; etaSec?: number };

export type JobContext = {
	readonly job: Readonly<EngineJob>;
	readonly input: unknown;
	/** Aborted on cancel or engine shutdown. Pass it to every tool call. */
	readonly signal: AbortSignal;
	/** CPU slots granted by the scheduler (thread counts should follow it, S04:JB-012). */
	readonly slots: number;
	/** 0..1 (clamped) or null for indeterminate. Throttled to 4 events/s per job (S04:JB-040). */
	progress(progress: number | null, extra?: ProgressExtra): void;
	/** Register a spawned child so cancellation kills its process tree (S04:JB-020). */
	trackChild(child: ChildProcess): void;
	/** Files/directories deleted when the job is cancelled or fails (partial outputs). */
	addPartial(path: string): void;
	/** A scratch directory `<appdir>/tmp/<jobId>` removed when the job ends. */
	scratchDir(): Promise<string>;
	/** Appends a line to the job's diagnostic log (kept on failure, S04:JB-021). */
	log(text: string): void;
};

/** Returns the job result (stored in `EngineJob.result`). Throw `JobError`/`ToolError` to fail. */
export type JobRunner = (ctx: JobContext) => Promise<unknown>;

export class JobError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable?: boolean,
		readonly detail?: unknown,
	) {
		super(message);
		this.name = 'JobError';
	}
}

/** Artifact job kinds re-queued automatically after an engine restart (S04:JB-030). */
export const ARTIFACT_JOB_KINDS: ReadonlySet<JobKind> = new Set([
	'probe',
	'keyframes',
	'poster',
	'sprite',
	'peaks',
	'proxy',
	'playback-audio',
	'mg-render',
]);

/** Codes that are not worth retrying until something changes (S04:JB-021). */
export const NON_RETRYABLE_CODES: ReadonlySet<string> = new Set([
	'BINARY_MISSING',
	'DISK_FULL',
	'UNSUPPORTED_MEDIA',
	'PATH_NOT_ELIGIBLE',
	'VALIDATION_FAILED',
	'ASSET_NOT_FOUND',
	'MG_UNAVAILABLE',
	'INVALID_SPEC',
	'REMOTE_REFERENCE_BLOCKED',
	'GPL_FILTER_REFUSED',
]);
