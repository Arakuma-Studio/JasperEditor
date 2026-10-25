// Jobs panel model (S05:JOB-001…005, S04:JB-040…045): engine + client jobs grouped, statuses (with
// "Stalled" while the engine is disconnected), ETA/elapsed text and the header badge summary.
import { type EngineJob, TERMINAL_JOB_STATES } from '@jasper/api';

export type AnyJob = EngineJob & { client?: true };

export type JobGroupId = 'exports' | 'previews' | 'uploads' | 'graphics' | 'media' | 'other';
export const JOB_GROUPS: { id: JobGroupId; label: string; collapsedByDefault?: boolean }[] = [
	{ id: 'exports', label: 'Exports' },
	{ id: 'previews', label: 'Render previews' },
	{ id: 'uploads', label: 'Uploads' },
	{ id: 'graphics', label: 'Graphics renders' },
	{ id: 'media', label: 'Media analysis', collapsedByDefault: true },
	{ id: 'other', label: 'Other' },
];

function groupOf(job: Pick<EngineJob, 'kind'>): JobGroupId {
	switch (job.kind) {
		case 'export':
		case 'still':
			return 'exports';
		case 'preview':
			return 'previews';
		case 'upload':
			return 'uploads';
		case 'mg-render':
			return 'graphics';
		case 'probe':
		case 'keyframes':
		case 'poster':
		case 'sprite':
		case 'peaks':
		case 'proxy':
		case 'playback-audio':
		case 'analysis':
		case 'transcription':
			return 'media';
		default:
			return 'other';
	}
}

type JobStatus =
	| 'Queued'
	| 'Running'
	| 'Cancelling'
	| 'Stalled'
	| 'Done'
	| 'Failed'
	| 'Canceled'
	| 'Interrupted';

export function statusOf(job: AnyJob, engineConnected: boolean): JobStatus {
	if (!job.client && !engineConnected && !TERMINAL_JOB_STATES.has(job.state)) return 'Stalled';
	switch (job.state) {
		case 'queued':
			return 'Queued';
		case 'running':
			return 'Running';
		case 'cancelling':
			return 'Cancelling';
		case 'succeeded':
			return 'Done';
		case 'failed':
			return 'Failed';
		case 'cancelled':
			return 'Canceled';
		case 'interrupted':
			return 'Interrupted';
	}
}

/** Engine badge (S05:JOB-001): N = native, R = Remotion, F = fframes, Browser = client-side job. */
export function engineBadge(job: AnyJob): string {
	if (job.client) return 'Browser';
	if (job.kind === 'mg-render') return 'F';
	if (job.kind === 'still') return 'R';
	if (job.kind === 'export') {
		const path = (job.result as { path?: string } | undefined)?.path ?? job.stage ?? '';
		if (/remotion/i.test(path)) return 'R';
		return 'N';
	}
	return 'N';
}

/**
 * spec 16 SG-003: where a transcription ran ("NVIDIA GeForce RTX 3060 (CUDA) encoder · CPU decoder") and why it
 * fell back to the CPU, from the job result.
 */
export function transcriptionDevice(
	job: Pick<EngineJob, 'kind' | 'result'>,
): { label: string; fallback: string | null } | null {
	if (job.kind !== 'transcription') return null;
	const d = (job.result as { device?: { label?: unknown; fallbacks?: unknown } } | undefined)?.device;
	if (!d || typeof d.label !== 'string') return null;
	const fb = Array.isArray(d.fallbacks)
		? (d.fallbacks as Array<{ reason?: unknown; stage?: unknown }>).find((f) => typeof f?.reason === 'string')
		: undefined;
	return { label: d.label, fallback: fb ? String(fb.reason) : null };
}

export function formatEta(sec: number | undefined): string {
	if (sec === undefined || !Number.isFinite(sec) || sec < 0) return '';
	const s = Math.round(sec);
	if (s < 60) return `${s}s left`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s left`;
	return `${Math.floor(m / 60)}h ${m % 60}m left`;
}

export function formatElapsed(job: Pick<EngineJob, 'startedAt' | 'finishedAt'>, now: number): string {
	if (!job.startedAt) return '';
	const start = Date.parse(job.startedAt);
	const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
	if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
	const s = Math.max(0, Math.round((end - start) / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export const canCancel = (job: AnyJob) => job.state === 'queued' || job.state === 'running';
export const canRetry = (job: AnyJob) =>
	!job.client &&
	(job.state === 'failed' || job.state === 'cancelled' || job.state === 'interrupted') &&
	job.error?.retryable !== false;
export const isDownloadable = (job: AnyJob) =>
	!job.client && job.kind === 'export' && job.state === 'succeeded';

type JobGroupView = { id: JobGroupId; label: string; jobs: AnyJob[]; active: number };

/** Newest first within groups; empty groups omitted. */
export function groupJobs(jobs: AnyJob[], hidden: ReadonlySet<string> = new Set()): JobGroupView[] {
	const by = new Map<JobGroupId, AnyJob[]>();
	for (const j of jobs) {
		if (hidden.has(j.id)) continue;
		const g = groupOf(j);
		by.set(g, [...(by.get(g) ?? []), j]);
	}
	return JOB_GROUPS.flatMap((g) => {
		const list = (by.get(g.id) ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		if (!list.length) return [];
		return [
			{
				id: g.id,
				label: g.label,
				jobs: list,
				active: list.filter((j) => !TERMINAL_JOB_STATES.has(j.state)).length,
			},
		];
	});
}

type JobsSummary = {
	running: number;
	queued: number;
	failed: number;
	/** Aggregate progress (0..1) of running jobs with known progress, or null. */
	progress: number | null;
	/** Longest ETA among running jobs (seconds). */
	etaSec: number | null;
};

/** Header "Background tasks" badge data (S04:JB-042, S05:HD-003). */
export function summarizeJobs(jobs: AnyJob[]): JobsSummary {
	let running = 0;
	let queued = 0;
	let failed = 0;
	let sum = 0;
	let n = 0;
	let eta: number | null = null;
	for (const j of jobs) {
		if (j.state === 'running' || j.state === 'cancelling') {
			running++;
			if (j.progress !== null) {
				sum += j.progress;
				n++;
			}
			if (j.etaSec !== undefined) eta = Math.max(eta ?? 0, j.etaSec);
		} else if (j.state === 'queued') queued++;
		else if (j.state === 'failed') failed++;
	}
	return { running, queued, failed, progress: n ? sum / n : null, etaSec: eta };
}
