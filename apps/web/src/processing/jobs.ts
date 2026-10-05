// Process jobs from the client's side (S07:PRU-002): submit `POST /api/media/:key/process`, follow the engine
// job at module level (keyed by job id, so it completes while the dialog is closed or another panel has focus)
// and, when it succeeds, commit ONE transaction `media.derive` labelled "Process Clip" (with `replaceInClips`
// when the user asked to replace the clips). Progress itself is the Jobs panel's (engine jobs).
//
// Failures surface as a toast with the job's error and a Retry action (engine retry = a new job, which is
// followed again); a remote failure offers "Run on This Computer" explicitly — it never falls back silently
// (S07:PRM-007). A Retry pressed in the Jobs panel is picked up too: failed jobs are remembered by dedupe key and
// a new active job with the same key is followed.
import {
	type EngineJob,
	type ProcessRequest,
	type ProcessResult,
	ProcessResultSchema,
	TERMINAL_JOB_STATES,
} from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import type { Command, MediaAsset, ProcessStep, ProjectDocument } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { toast as uiToast } from '@jasper/ui';
import { buildMediaAsset, mediaKeyOf } from '../import/assets.ts';
import { originalOf, recipeLabel } from './model.ts';

const PROCESS_TX_LABEL = 'Process Clip';

type ProcessWatch = {
	jobId: string;
	engine: EngineClient;
	session: EditorSession;
	/** The document media the job processes (`media.derive.fromMediaId`). */
	fromMediaId: string;
	mediaKey: string;
	steps: ProcessStep[];
	executor: ProcessRequest['executor'];
	/** Clips to swap to the processed version when done (empty = only add it to the Project panel). */
	replaceInClips: string[];
	/** Source frames processed (S07:PRC-015); absent = the whole media. */
	range?: ProcessRange;
	dedupeKey?: string;
};

export type ProcessRange = { startFrame: number; endFrame: number };

// ------------------------------------------------------------------ media.derive

/**
 * The `media.derive` command for a finished process job, or an error message. Clips that were deleted, are not
 * video clips or no longer use a version of the same original are left out of `replaceInClips`.
 */
function deriveCommand(
	doc: ProjectDocument,
	input: {
		fromMediaId: string;
		steps: ProcessStep[];
		result: ProcessResult;
		replaceInClips: readonly string[];
	},
): { command: Command; replaced: string[] } | { error: string } {
	const { result } = input;
	let fromMediaId = input.fromMediaId;
	if (!doc.media[fromMediaId]) {
		const byKey = (Object.values(doc.media) as MediaAsset[]).find(
			(m) => mediaKeyOf(m) === result.fromMediaKey,
		);
		if (!byKey) return { error: 'The source media is no longer in the project' };
		fromMediaId = byKey.id;
	}
	const original = originalOf(doc, fromMediaId);
	const replaced: string[] = [];
	for (const clipId of new Set(input.replaceInClips)) {
		for (const seq of Object.values(doc.sequences)) {
			const clip = seq.clips[clipId] as { kind: string; mediaId?: string } | undefined;
			if (!clip) continue;
			if (clip.kind === 'video' && clip.mediaId && originalOf(doc, clip.mediaId) === original)
				replaced.push(clipId);
			break;
		}
	}
	const asset = buildMediaAsset(result.registered, { id: 'unused', now: new Date(0).toISOString() });
	const command = {
		type: 'media.derive',
		fromMediaId,
		recipe: { op: 'process', steps: input.steps },
		asset: {
			fingerprint: asset.fingerprint,
			originalName: asset.originalName,
			sizeBytes: asset.sizeBytes,
			container: asset.container,
			probe: asset.probe,
			locators: asset.locators,
			recipeVersion: result.recipeVersion,
			recipeHash: result.recipeHash,
		},
		...(replaced.length ? { replaceInClips: replaced, fit: 'skip' } : {}),
		...(result.range ? { range: result.range } : {}),
	} as unknown as Command;
	return { command, replaced };
}

/** Commits the processed version (one undo entry "Process Clip"). */
export function commitProcessed(
	session: EditorSession,
	input: {
		fromMediaId: string;
		steps: ProcessStep[];
		result: ProcessResult;
		replaceInClips: readonly string[];
	},
): { ok: true; replaced: string[]; skipped: string[]; mediaId?: string } | { ok: false; message: string } {
	const built = deriveCommand(session.getCommitted(), input);
	if ('error' in built) return { ok: false, message: built.error };
	let r = session.apply({ label: PROCESS_TX_LABEL, origin: 'user', commands: [built.command] });
	let replaced = built.replaced;
	if (!r.ok && replaced.length) {
		// A clip could not switch (locked track, shorter version…): still add the version to the project.
		const { replaceInClips: _drop, ...rest } = built.command as unknown as Record<string, unknown>;
		r = session.apply({ label: PROCESS_TX_LABEL, origin: 'user', commands: [rest as unknown as Command] });
		replaced = [];
	}
	if (!r.ok)
		return { ok: false, message: r.errors[0]?.message ?? 'The processed version could not be added' };
	const value = r.results[0] as
		| { mediaId?: string; clipIds?: string[]; skippedClipIds?: string[] }
		| undefined;
	// Clips the version does not cover (trimmed or moved while it ran) stay on their media (S07:PRC-017).
	const skipped = value?.skippedClipIds ?? [];
	return {
		ok: true,
		replaced: replaced.filter((id) => !skipped.includes(id)),
		skipped,
		...(value?.mediaId ? { mediaId: value.mediaId } : {}),
	};
}

// ------------------------------------------------------------------ submit

type StartInput = {
	engine: EngineClient;
	session: EditorSession;
	mediaId: string;
	steps: ProcessStep[];
	executor: ProcessRequest['executor'];
	replaceInClips: readonly string[];
	/** Only these source frames of the media (clip range + handles, S07:PRC-015). */
	range?: ProcessRange | null;
};

/** Queues the process job and follows it; throws EngineError (e.g. MODEL_NOT_INSTALLED) when refused. */
export async function startProcessing(input: StartInput): Promise<EngineJob> {
	const asset = input.session.getCommitted().media[input.mediaId] as MediaAsset | undefined;
	const key = mediaKeyOf(asset);
	if (!asset || !key) throw new EngineError('ASSET_NOT_FOUND', 'This media is not stored by the engine');
	const job = (await input.engine.call('mediaProcess', {
		params: { key },
		body: {
			projectId: input.session.projectId,
			steps: input.steps,
			executor: input.executor,
			...(input.range ? { range: input.range } : {}),
		} satisfies ProcessRequest,
	})) as EngineJob;
	processWatcher.watch({
		jobId: job.id,
		engine: input.engine,
		session: input.session,
		fromMediaId: input.mediaId,
		mediaKey: key,
		steps: input.steps,
		executor: input.executor,
		replaceInClips: [...input.replaceInClips],
		...(input.range ? { range: input.range } : {}),
		...(job.dedupeKey ? { dedupeKey: job.dedupeKey } : {}),
	});
	if (TERMINAL_JOB_STATES.has(job.state)) void processWatcher.tick();
	return job;
}

// ------------------------------------------------------------------ watcher

/** A user notice (toast) with up to two actions. */
type Notice = {
	kind: 'info' | 'success' | 'warning' | 'error';
	message: string;
	detail?: string;
	actions?: { label: string; run(): void }[];
};

const RETRY_MEMORY_MS = 60 * 60 * 1000;

function errorHint(code: string): string | null {
	switch (code) {
		case 'REMOTE_CONNECTION_LOST':
			return 'The connection to the remote host was lost. Retry to run it again; it does not fall back to this computer on its own.';
		case 'REMOTE_NOT_CONFIGURED':
			return 'Set up a remote host in Preferences ▸ Processing, or run it on this computer.';
		case 'MODEL_NOT_INSTALLED':
		case 'MODEL_MISSING':
			return 'Install the model in Preferences ▸ Processing (or from the Process Clip dialog).';
		default:
			return null;
	}
}

function isRemoteFailure(w: ProcessWatch, job: EngineJob): boolean {
	return (
		w.executor === 'remote' ||
		job.stage?.startsWith('Remote') === true ||
		!!job.error?.code.startsWith('REMOTE_')
	);
}

class ProcessWatcher {
	private pending = new Map<string, ProcessWatch>();
	/** Failed jobs by dedupe key: a Retry from the Jobs panel (a new job, same key) is followed again. */
	private failed = new Map<string, { watch: ProcessWatch; at: number }>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private busy = false;

	watch(w: ProcessWatch): void {
		const prev = this.pending.get(w.jobId);
		// The engine dedupes identical requests to the running job: merge the clips to replace.
		const merged = prev
			? { ...w, replaceInClips: [...new Set([...prev.replaceInClips, ...w.replaceInClips])] }
			: w;
		this.pending.set(w.jobId, merged);
		this.schedule();
	}

	private schedule(): void {
		const active = this.pending.size > 0 || this.failed.size > 0;
		if (active && !this.timer) {
			this.timer = setInterval(() => void this.tick(), 1000);
			(this.timer as { unref?: () => void }).unref?.();
		} else if (!active && this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** One polling round (also called directly by tests). */
	async tick(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			for (const w of [...this.pending.values()]) {
				let job: EngineJob;
				try {
					job = (await w.engine.getJob(w.jobId)) as EngineJob;
				} catch (e) {
					if (e instanceof EngineError && (e.code === 'NOT_FOUND' || e.code === 'JOB_NOT_FOUND')) {
						this.pending.delete(w.jobId);
					}
					continue; // engine unreachable: keep waiting
				}
				if (!TERMINAL_JOB_STATES.has(job.state)) continue;
				this.pending.delete(w.jobId);
				if (job.state === 'succeeded') this.succeeded(w, job);
				else if (job.state === 'failed' || job.state === 'interrupted') this.failedJob(w, job);
				// cancelled: the user did it in the Jobs panel; nothing to commit
			}
			await this.reattach();
		} finally {
			this.busy = false;
			this.schedule();
		}
	}

	private async reattach(): Promise<void> {
		const now = Date.now();
		for (const [k, f] of this.failed) if (now - f.at > RETRY_MEMORY_MS) this.failed.delete(k);
		if (!this.failed.size) return;
		const byProject = new Map<string, ProcessWatch>();
		for (const f of this.failed.values()) byProject.set(`${f.watch.session.projectId}`, f.watch);
		for (const [projectId, w] of byProject) {
			let jobs: EngineJob[];
			try {
				jobs = (await w.engine.listJobs({ projectId, active: '1' })).jobs as EngineJob[];
			} catch {
				continue;
			}
			for (const job of jobs) {
				if (job.kind !== 'process' || !job.dedupeKey) continue;
				const f = this.failed.get(job.dedupeKey);
				if (!f || this.pending.has(job.id)) continue;
				this.failed.delete(job.dedupeKey);
				this.watch({ ...f.watch, jobId: job.id });
			}
		}
	}

	private succeeded(w: ProcessWatch, job: EngineJob): void {
		const parsed = ProcessResultSchema.safeParse(job.result);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			defaultNotify({
				kind: 'error',
				message: 'Processing finished without a usable result',
				detail: issue ? `${issue.path.join('.')}: ${issue.message}` : undefined,
			});
			return;
		}
		const res = commitProcessed(w.session, {
			fromMediaId: w.fromMediaId,
			steps: w.steps,
			result: parsed.data,
			replaceInClips: w.replaceInClips,
		});
		const label = recipeLabel(w.steps);
		if (!res.ok) {
			defaultNotify({
				kind: 'warning',
				message: 'The processed version could not be added',
				detail: `${res.message}. Processing again reuses the finished file.`,
			});
			return;
		}
		const skipped = res.skipped.length
			? `\n${res.skipped.length} clip${res.skipped.length > 1 ? 's were' : ' was'} left on ${res.skipped.length > 1 ? 'their' : 'its'} media: the processed frames do not cover ${res.skipped.length > 1 ? 'them' : 'it'} any more`
			: '';
		const notes = `${parsed.data.notes.length ? `\n${parsed.data.notes.join('\n')}` : ''}${skipped}`;
		defaultNotify({
			kind: 'success',
			message: res.replaced.length
				? `Clip${res.replaced.length > 1 ? 's' : ''} now use${res.replaced.length > 1 ? '' : 's'} the processed version`
				: 'Processed version added to the Project panel',
			detail: `${parsed.data.registered.originalName} (${label}, ${parsed.data.executor === 'remote' ? 'remote' : 'this computer'})${notes}`,
		});
	}

	private failedJob(w: ProcessWatch, job: EngineJob): void {
		const code = job.error?.code ?? 'PROCESS_FAILED';
		const message = job.error?.message ?? 'The process job failed';
		const hint = errorHint(code);
		const retryable = job.error?.retryable !== false;
		if (w.dedupeKey && retryable) this.failed.set(w.dedupeKey, { watch: w, at: Date.now() });
		const actions: NonNullable<Notice['actions']> = [];
		if (retryable) actions.push({ label: 'Retry', run: () => void this.retry(w) });
		if (isRemoteFailure(w, job))
			actions.push({
				label: 'Run on This Computer',
				run: () =>
					void startProcessing({
						engine: w.engine,
						session: w.session,
						mediaId: w.fromMediaId,
						steps: w.steps,
						executor: 'local',
						replaceInClips: w.replaceInClips,
						...(w.range ? { range: w.range } : {}),
					}).catch((e) =>
						defaultNotify({
							kind: 'error',
							message: 'Processing failed',
							detail: String((e as Error).message),
						}),
					),
			});
		defaultNotify({
			kind: 'error',
			message: 'Processing failed',
			detail: `${code}: ${message}${hint ? `\n${hint}` : ''}`,
			...(actions.length ? { actions } : {}),
		});
		this.schedule();
	}

	/** Engine retry (a new job) of a failed process job, followed like the original. */
	async retry(w: ProcessWatch): Promise<void> {
		try {
			const job = (await w.engine.retryJob(w.jobId)) as EngineJob;
			if (w.dedupeKey) this.failed.delete(w.dedupeKey);
			this.watch({ ...w, jobId: job.id, ...(job.dedupeKey ? { dedupeKey: job.dedupeKey } : {}) });
		} catch (e) {
			defaultNotify({ kind: 'error', message: 'Retry failed', detail: (e as Error).message });
		}
	}
}

function defaultNotify(t: Notice): void {
	uiToast({
		kind: t.kind,
		title: t.message,
		...(t.detail ? { detail: t.detail } : {}),
		source: 'engine',
		...(t.actions?.length ? { actions: t.actions } : {}),
	});
}

/** The module-level watcher (one per window). */
export const processWatcher = new ProcessWatcher();
