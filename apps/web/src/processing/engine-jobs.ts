// Small helpers for engine calls made by the processing UI (M2 routes go through `engine.call`, ARCHITECTURE
// §19.7): follow a job until it ends, and turn errors into one readable line.
import { type EngineJob, TERMINAL_JOB_STATES } from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';

/** Polls a job until it reaches a terminal state (or the signal aborts); `onUpdate` sees every snapshot. */
export async function followJob(
	engine: EngineClient,
	jobId: string,
	opts: { onUpdate?(job: EngineJob): void; signal?: AbortSignal; intervalMs?: number } = {},
): Promise<EngineJob> {
	for (;;) {
		const job = (await engine.getJob(jobId)) as EngineJob;
		opts.onUpdate?.(job);
		if (TERMINAL_JOB_STATES.has(job.state)) return job;
		if (opts.signal?.aborted) return job;
		await new Promise((r) => setTimeout(r, opts.intervalMs ?? 1000));
	}
}

export async function pollActiveJob(
	engine: Pick<EngineClient, 'getJob'>,
	jobId: string,
	opts: { isActive(): boolean; onUpdate?(job: EngineJob): void; intervalMs: number },
): Promise<EngineJob | null> {
	let transientFailures = 0;
	while (opts.isActive()) {
		await new Promise<void>((resolve) => setTimeout(resolve, opts.intervalMs));
		if (!opts.isActive()) return null;
		let job: EngineJob;
		try {
			job = await engine.getJob(jobId);
		} catch (error) {
			if (!opts.isActive()) return null;
			if (
				error instanceof EngineError &&
				(error.code === 'NETWORK' || error.retryable) &&
				++transientFailures < 3
			)
				continue;
			throw error;
		}
		if (!opts.isActive()) return null;
		transientFailures = 0;
		opts.onUpdate?.(job);
		if (TERMINAL_JOB_STATES.has(job.state)) return job;
	}
	return null;
}

/** `CODE: message` for engine errors, the message otherwise. */
export function errorText(e: unknown): string {
	if (e instanceof EngineError) return e.code === 'NETWORK' ? e.message : `${e.message} (${e.code})`;
	return e instanceof Error ? e.message : String(e);
}

export function formatBytes(n: number): string {
	if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
	if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
	if (n >= 1024) return `${Math.round(n / 1024)} KB`;
	return `${n} B`;
}

/** "just now", "5 min ago", "3 h ago", or the date. */
export function formatAgo(iso: string, now = Date.now()): string {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return iso;
	const s = Math.max(0, (now - t) / 1000);
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
	return new Date(t).toLocaleDateString();
}
