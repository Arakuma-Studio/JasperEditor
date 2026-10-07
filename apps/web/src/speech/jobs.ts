// wp speech: transcription jobs from the client's side. `startTranscription` submits the engine jobs (one per media,
// or one for a sequence's mix) and the module-level watcher follows them (keyed by job id, so they complete while
// dialogs are closed); a finished job commits ONE transaction "Generate Transcript" (`transcript.attach`). Progress is
// the Jobs panel's; the Text panel shows a status line from `transcriptionWatcher.pending`. Failures toast with the
// engine's message and a Retry action.
import {
	type EngineJob,
	TERMINAL_JOB_STATES,
	type TranscribeOptions,
	TranscriptionResultSchema,
} from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import { type MediaAsset, makeEnvelope } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { toast } from '@jasper/ui';
import { mediaKeyOf } from '../import/assets.ts';
import { mediaAttach, mixAttach, sequenceName } from './model.ts';

export const GENERATE_LABEL = 'Generate Transcript';

type Watch = {
	jobId: string;
	engine: EngineClient;
	session: EditorSession;
	target:
		| { type: 'media'; mediaId: string; name: string }
		| { type: 'sequence'; sequenceId: string; name: string };
	replace: boolean;
	progress: number | null;
	stage: string;
};

type Listener = () => void;

class TranscriptionWatcher {
	private pending = new Map<string, Watch>();
	private listeners = new Set<Listener>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private busy = false;

	/** Running transcriptions (for status lines). */
	list(): Watch[] {
		return [...this.pending.values()];
	}

	subscribe(l: Listener): () => void {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}

	private emit(): void {
		for (const l of this.listeners) l();
	}

	watch(w: Omit<Watch, 'progress' | 'stage'>): void {
		this.pending.set(w.jobId, { ...w, progress: null, stage: 'Queued' });
		this.emit();
		this.schedule();
	}

	private schedule(): void {
		if (this.pending.size && !this.timer) {
			this.timer = setInterval(() => void this.tick(), 1000);
			(this.timer as { unref?: () => void }).unref?.();
		} else if (!this.pending.size && this.timer) {
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
					if (e instanceof EngineError && (e.code === 'NOT_FOUND' || e.code === 'JOB_NOT_FOUND'))
						this.pending.delete(w.jobId);
					continue;
				}
				w.progress = job.progress;
				w.stage = job.stage ?? job.state;
				if (!TERMINAL_JOB_STATES.has(job.state)) continue;
				this.pending.delete(w.jobId);
				if (job.state === 'succeeded') this.succeeded(w, job);
				else if (job.state === 'failed' || job.state === 'interrupted') this.failed(w, job);
			}
		} finally {
			this.busy = false;
			this.emit();
			this.schedule();
		}
	}

	private succeeded(w: Watch, job: EngineJob): void {
		const parsed = TranscriptionResultSchema.safeParse(job.result);
		if (!parsed.success) {
			toast({ kind: 'error', title: 'Transcription finished without a usable result', source: 'engine' });
			return;
		}
		const doc = w.session.getCommitted();
		const res = parsed.data;
		let mediaId = w.target.type === 'media' ? w.target.mediaId : '';
		if (w.target.type === 'media' && !doc.media[mediaId] && res.target.type === 'media') {
			const key = res.target.mediaKey;
			mediaId = (Object.values(doc.media) as MediaAsset[]).find((m) => mediaKeyOf(m) === key)?.id ?? mediaId;
		}
		const built =
			w.target.type === 'media'
				? mediaAttach(doc, mediaId, res, w.replace ? 'replace' : 'keep')
				: mixAttach(doc, res, w.replace);
		if ('error' in built) {
			toast({
				kind: 'warning',
				title: `Transcript of ${w.target.name} not added`,
				detail: built.error,
				source: 'engine',
			});
			return;
		}
		const r = w.session.apply({ label: GENERATE_LABEL, origin: 'user', commands: built.commands });
		if (!r.ok) {
			toast({
				kind: 'warning',
				title: `Transcript of ${w.target.name} not added`,
				detail: r.errors[0]?.message ?? 'The project refused the transcript',
				source: 'engine',
			});
			return;
		}
		toast({
			kind: 'success',
			title: `Transcript of ${w.target.name} ready`,
			detail: built.summary,
			source: 'engine',
		});
	}

	private failed(w: Watch, job: EngineJob): void {
		const code = job.error?.code ?? 'TRANSCRIPTION_FAILED';
		toast({
			kind: 'error',
			title: `Transcription of ${w.target.name} failed`,
			detail: `${code}: ${job.error?.message ?? job.state}`,
			source: 'engine',
			actions: [
				{
					label: 'Retry',
					run: () =>
						void w.engine
							.retryJob(w.jobId)
							.then((j) => this.watch({ ...w, jobId: (j as EngineJob).id }))
							.catch((e) =>
								toast({
									kind: 'error',
									title: 'Retry failed',
									detail: (e as Error).message,
									source: 'engine',
								}),
							),
				},
			],
		});
	}
}

export const transcriptionWatcher = new TranscriptionWatcher();

/** Submits one job per media (skipping media without an engine copy); returns the jobs and refusals. */
export async function transcribeMedia(input: {
	engine: EngineClient;
	session: EditorSession;
	mediaIds: readonly string[];
	options: TranscribeOptions;
	replace: boolean;
}): Promise<{ jobs: EngineJob[]; failed: Array<{ name: string; message: string }> }> {
	const doc = input.session.getCommitted();
	const jobs: EngineJob[] = [];
	const failed: Array<{ name: string; message: string }> = [];
	for (const id of input.mediaIds) {
		const m = doc.media[id] as MediaAsset | undefined;
		const name = m?.originalName ?? id;
		const key = mediaKeyOf(m);
		if (!m || !key) {
			failed.push({ name, message: 'This media is not stored by the engine' });
			continue;
		}
		try {
			const job = (await input.engine.call('mediaTranscribe', {
				params: { key },
				body: { ...input.options, projectId: input.session.projectId },
			})) as EngineJob;
			jobs.push(job);
			transcriptionWatcher.watch({
				jobId: job.id,
				engine: input.engine,
				session: input.session,
				target: { type: 'media', mediaId: id, name },
				replace: input.replace,
			});
		} catch (e) {
			failed.push({ name, message: e instanceof Error ? e.message : String(e) });
		}
	}
	return { jobs, failed };
}

/** Submits a sequence-mix job. */
export async function transcribeSequenceMix(input: {
	engine: EngineClient;
	session: EditorSession;
	sequenceId: string;
	options: TranscribeOptions;
	inOutOnly: boolean;
	replace: boolean;
}): Promise<EngineJob> {
	const doc = input.session.getCommitted();
	const seq = doc.sequences[input.sequenceId];
	const envelope = makeEnvelope(doc, {
		revision: input.session.getState().revision,
		savedAt: new Date().toISOString(),
		platform: 'web',
	});
	const job = (await input.engine.call('speechTranscribeSequence', {
		body: {
			...input.options,
			envelope,
			sequenceId: input.sequenceId,
			projectId: input.session.projectId,
			range: input.inOutOnly ? 'in-out' : 'entire',
		},
	})) as EngineJob;
	transcriptionWatcher.watch({
		jobId: job.id,
		engine: input.engine,
		session: input.session,
		target: {
			type: 'sequence',
			sequenceId: input.sequenceId,
			name: seq ? sequenceName(doc, input.sequenceId) : 'the sequence',
		},
		replace: input.replace,
	});
	return job;
}
