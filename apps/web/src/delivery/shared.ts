// Spec 19 §12: what the delivery dialogs share: the envelope of the committed document, following an engine job with a
// cancel, and handing the result to the browser.
import { type EngineJob, TERMINAL_JOB_STATES } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { makeEnvelope } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useEffect, useRef } from 'react';
import { followJob } from '../processing/engine-jobs.ts';

export function envelopeOf(session: EditorSession) {
	return makeEnvelope(session.getCommitted(), {
		revision: session.getState().revision ?? 0,
		savedAt: new Date().toISOString(),
		platform: 'web',
	}) as never;
}

/** A job's progress as the dialogs show it. */
export type JobProgress = { id: string; stage: string; fraction: number | null };

/**
 * Follows a job to its end. A failure comes back as a readable error; a cancelled job as `null`. When `signal` aborts
 * (the dialog closed), polling and `onProgress` stop at once, the job is cancelled on the engine and `null` comes back.
 */
export async function runToEnd<T>(
	engine: EngineClient,
	started: EngineJob,
	onProgress: (p: JobProgress) => void,
	signal?: AbortSignal,
): Promise<T | null> {
	const done = signal?.aborted
		? started
		: await followJob(engine, started.id, {
				intervalMs: 300,
				signal,
				onUpdate: (j) =>
					onProgress({
						id: j.id,
						stage: j.stage ?? '',
						fraction: typeof j.progress === 'number' ? j.progress : null,
					}),
			});
	if (signal?.aborted) {
		if (!TERMINAL_JOB_STATES.has(done.state)) cancelQuietly(engine, started.id);
		return null;
	}
	if (done.state === 'cancelled') return null;
	if (done.state !== 'succeeded') throw new Error(done.error?.message ?? `The job ${done.state}`);
	return done.result as T;
}

export const cancelJob = (engine: EngineClient, id: string) =>
	engine.call('jobCancel', { params: { jobId: id } });

/** Cancels a job nobody waits on any more (its dialog closed): there is nowhere left to show a refusal. */
export const cancelQuietly = (engine: EngineClient, id: string): void =>
	void cancelJob(engine, id).catch((e: unknown) =>
		console.warn('[delivery] cancelling job', id, 'failed', e),
	);

/**
 * The job a delivery dialog runs, tied to the dialog: `start()` gives the signal of one run, and closing the dialog
 * (unmounting) aborts it, so nothing polls or sets state after the dialog is gone and the engine job is cancelled.
 */
export function useDialogJob(): { start(): AbortSignal; abort(): void } {
	const current = useRef<AbortController | null>(null);
	useEffect(() => () => current.current?.abort(), []);
	return {
		start() {
			current.current?.abort();
			current.current = new AbortController();
			return current.current.signal;
		},
		abort() {
			current.current?.abort();
		},
	};
}

export function downloadFile(engine: EngineClient, url: string, name: string): void {
	const a = document.createElement('a');
	a.href = engine.url(url, { download: '1' });
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
}

/** The folder suggested for delivered files, when the engine runs on this computer. */
export async function localFolder(
	engine: EngineClient,
	session: EditorSession,
): Promise<{ local: boolean; folder: string }> {
	try {
		const i = await engine.call('projectScratch', { params: { projectId: session.projectId } });
		return {
			local: i.local,
			folder: i.projectMedia.path ? `${i.projectMedia.path.replace(/[\\/]+$/, '')}/Delivery` : '',
		};
	} catch {
		return { local: false, folder: '' };
	}
}

export const safeName = (name: string) =>
	[...name]
		.map((ch) => (ch.charCodeAt(0) < 32 ? '_' : ch))
		.join('')
		.replace(/[\\/:*?"<>|]+/g, '_')
		.trim()
		.slice(0, 120) || 'Title';
