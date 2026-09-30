// Engine job queue (S04 §17, ARCHITECTURE §9.3): lanes (interactive > user > background, FIFO within a
// lane), a CPU-slot scheduler, dedupe keys, cancel (process-tree kill, partials removed, `cancelled`
// within 5 s), retry, a jobs.jsonl journal with restart recovery and throttled `job.updated` events.
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { type EngineJob, type JobKind, RETRYABLE_CODES, TERMINAL_JOB_STATES } from '@jasper/api';
import type { Broadcaster } from '../events/broadcaster.ts';
import { randomId } from '../tools/fs.ts';
import { terminateTree } from '../tools/process.ts';
import {
	ARTIFACT_JOB_KINDS,
	type JobContext,
	JobError,
	type JobRunner,
	type JobSubmit,
	NON_RETRYABLE_CODES,
	type ProgressExtra,
} from './types.ts';

const LANE_RANK: Record<EngineJob['priority'], number> = { interactive: 0, user: 1, background: 2 };
export const UPDATE_THROTTLE_MS = 250;
export const CANCEL_DEADLINE_MS = 4500;
const KEEP_FINISHED = 500;
const KEEP_FINISHED_MS = 7 * 24 * 3600 * 1000;

type Entry = {
	job: EngineJob;
	input: unknown;
	seq: number;
	minSlots: number;
	granted: number;
	controller: AbortController | null;
	children: Set<ChildProcess>;
	partials: string[];
	scratch: string | null;
	logLines: string[];
	lastEmit: number;
	emitTimer: NodeJS.Timeout | null;
	waiters: ((j: EngineJob) => void)[];
	settled: Promise<void> | null;
	/** Interrupted artifact job already re-queued after a restart. */
	requeued: boolean;
};

export type JobQueueOptions = {
	/** jobs.jsonl path; null disables journaling (tests). */
	journalPath: string | null;
	/** Scratch root (`<appdir>/tmp`). */
	tmpDir: string;
	/** Directory for failed-job logs (`<appdir>/engine/logs/jobs`). */
	logDir?: string | null;
	broadcaster?: Broadcaster | null;
	totalSlots?: number;
	/** Pause the background lane while an export runs (S04:JB-013). Default true. */
	pauseBackgroundDuringExport?: boolean;
	now?: () => Date;
	onError?(e: unknown): void;
};

type JournalRecord = { job: EngineJob; input: unknown; requeued?: boolean };

export type JobListFilter = { active?: boolean; projectId?: string; since?: string; kind?: JobKind };

export class JobQueue {
	readonly totalSlots: number;
	private readonly entries = new Map<string, Entry>();
	private readonly runners = new Map<JobKind, JobRunner>();
	private readonly dedupe = new Map<string, string>();
	private seq = 0;
	private started = false;
	private stopping = false;
	private readonly now: () => Date;

	constructor(private readonly opts: JobQueueOptions) {
		this.totalSlots = Math.max(1, opts.totalSlots ?? availableParallelism());
		this.now = opts.now ?? (() => new Date());
	}

	// ------------------------------------------------------------------ registration and lifecycle

	registerRunner(kind: JobKind, runner: JobRunner): void {
		this.runners.set(kind, runner);
		if (this.started) this.pump();
	}

	hasRunner(kind: JobKind): boolean {
		return this.runners.has(kind);
	}

	/**
	 * Restores the journal (S04:JB-030) and starts scheduling. Call after every runner is registered.
	 * Queued jobs are restored in order; running jobs become `interrupted`; interrupted artifact jobs are
	 * re-queued automatically as new jobs.
	 */
	start(): void {
		if (this.started) return;
		this.started = true;
		const requeue: Entry[] = [];
		for (const { job, input, requeued } of this.readJournal()) {
			if (job.state === 'running' || job.state === 'cancelling') {
				job.state = 'interrupted';
				job.finishedAt = this.now().toISOString();
				job.error = {
					code: 'INTERRUPTED',
					message: 'The engine stopped while this job was running',
					retryable: true,
				};
			}
			const entry = this.makeEntry(job, input, 1);
			entry.requeued = !!requeued;
			this.entries.set(job.id, entry);
			if (
				job.state === 'interrupted' &&
				!entry.requeued &&
				ARTIFACT_JOB_KINDS.has(job.kind) &&
				this.runners.has(job.kind)
			)
				requeue.push(entry);
			if (job.state === 'queued') {
				if (this.runners.has(job.kind)) {
					if (job.dedupeKey) this.dedupe.set(job.dedupeKey, job.id);
				} else {
					job.state = 'failed';
					job.finishedAt = this.now().toISOString();
					job.error = { code: 'NOT_IMPLEMENTED', message: `No runner for ${job.kind}`, retryable: true };
				}
			}
		}
		for (const e of requeue) {
			e.requeued = true;
			const next = this.submit({ ...this.specOf(e.job), input: e.input });
			e.job.stage = `Re-queued as ${next.id}`;
		}
		this.compactJournal();
		this.pump();
	}

	/**
	 * Graceful shutdown (S04:ENG-004): stop scheduling, abort running jobs and record them as
	 * `interrupted` (queued jobs stay queued in the journal for the next start).
	 */
	async shutdown(timeoutMs = 4000): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		const running = [...this.entries.values()].filter(
			(e) => e.job.state === 'running' || e.job.state === 'cancelling',
		);
		for (const e of running) {
			e.controller?.abort(new Error('engine shutdown'));
			for (const c of e.children) void terminateTree(c);
		}
		await Promise.race([
			Promise.all(running.map((e) => e.settled)),
			new Promise((r) => setTimeout(r, timeoutMs).unref()),
		]);
		for (const e of running) {
			if (!TERMINAL_JOB_STATES.has(e.job.state)) {
				this.finish(e, 'interrupted', {
					error: { code: 'INTERRUPTED', message: 'The engine was stopped', retryable: true },
				});
			}
		}
		for (const e of this.entries.values()) if (e.emitTimer) clearTimeout(e.emitTimer);
	}

	// ------------------------------------------------------------------ public API

	/** Submits a job, or returns the queued/running job with the same dedupe key (S04:JB-014). */
	submit(spec: JobSubmit): EngineJob {
		if (spec.dedupeKey) {
			const existing = this.dedupe.get(spec.dedupeKey);
			const e = existing ? this.entries.get(existing) : undefined;
			if (e && !TERMINAL_JOB_STATES.has(e.job.state)) return this.snapshot(e.job);
		}
		const job: EngineJob = {
			id: randomId('job', 8),
			kind: spec.kind,
			title: spec.title,
			origin: spec.origin ?? { type: 'user' },
			...(spec.projectId ? { projectId: spec.projectId } : {}),
			...(spec.assetId ? { assetId: spec.assetId } : {}),
			...(spec.parentId ? { parentId: spec.parentId } : {}),
			state: 'queued',
			progress: 0,
			...(spec.stage ? { stage: spec.stage } : {}),
			createdAt: this.now().toISOString(),
			priority: spec.priority,
			cpuSlots: Math.max(0, Math.min(this.totalSlots, Math.floor(spec.cpuSlots))),
			...(spec.dedupeKey ? { dedupeKey: spec.dedupeKey } : {}),
		};
		const minSlots = Math.max(0, Math.min(job.cpuSlots, spec.minSlots ?? job.cpuSlots));
		const entry = this.makeEntry(job, spec.input, minSlots);
		this.entries.set(job.id, entry);
		if (job.dedupeKey) this.dedupe.set(job.dedupeKey, job.id);
		this.journal(entry);
		this.opts.broadcaster?.publish('job.created', this.snapshot(job), job.projectId);
		if (!this.runners.has(job.kind)) {
			this.finish(entry, 'failed', {
				error: {
					code: 'NOT_IMPLEMENTED',
					message: `No runner registered for ${job.kind} jobs`,
					retryable: true,
				},
			});
		} else this.pump();
		return this.snapshot(job);
	}

	get(id: string): EngineJob | null {
		const e = this.entries.get(id);
		return e ? this.snapshot(e.job) : null;
	}

	/** Jobs newest first. `since` keeps jobs created or finished at/after that ISO time. */
	list(filter: JobListFilter = {}): EngineJob[] {
		const out: EngineJob[] = [];
		for (const e of this.entries.values()) {
			const j = e.job;
			if (filter.active && TERMINAL_JOB_STATES.has(j.state)) continue;
			if (filter.projectId && j.projectId !== filter.projectId) continue;
			if (filter.kind && j.kind !== filter.kind) continue;
			if (filter.since) {
				const t = Date.parse(filter.since);
				const touched = Date.parse(j.finishedAt ?? j.startedAt ?? j.createdAt);
				if (!Number.isNaN(t) && touched < t && TERMINAL_JOB_STATES.has(j.state)) continue;
			}
			out.push(this.snapshot(j));
		}
		return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
	}

	/** Resolves with the job once it reaches a terminal state. */
	wait(id: string): Promise<EngineJob> {
		const e = this.entries.get(id);
		if (!e) return Promise.reject(new JobError('JOB_NOT_FOUND', `Unknown job ${id}`));
		if (TERMINAL_JOB_STATES.has(e.job.state)) return Promise.resolve(this.snapshot(e.job));
		return new Promise((resolve) => e.waiters.push(resolve));
	}

	/**
	 * Cancels a queued or running job and its children (S04:JB-020). Running jobs go through
	 * `cancelling`; their process trees get SIGTERM then SIGKILL after 3 s; partial outputs are removed.
	 */
	cancel(id: string): EngineJob | null {
		const e = this.entries.get(id);
		if (!e) return null;
		for (const child of this.entries.values()) if (child.job.parentId === id) this.cancel(child.job.id);
		if (e.job.state === 'queued') {
			this.finish(e, 'cancelled', {});
		} else if (e.job.state === 'running') {
			e.job.state = 'cancelling';
			this.journal(e);
			this.emitUpdated(e, true);
			e.controller?.abort(new JobError('JOB_CANCELLED', 'Cancelled'));
			for (const c of e.children) void terminateTree(c);
			// Runners that ignore the signal still reach `cancelled` by the deadline (QA-007).
			const deadline = setTimeout(() => {
				if (e.job.state === 'cancelling') void this.cleanupAndFinish(e, 'cancelled', {});
			}, CANCEL_DEADLINE_MS);
			deadline.unref();
		}
		return this.snapshot(e.job);
	}

	/** Retries a failed (retryable), cancelled or interrupted job as a new job (S04:JB-010). */
	retry(id: string): EngineJob {
		const e = this.entries.get(id);
		if (!e) throw new JobError('JOB_NOT_FOUND', `Unknown job ${id}`);
		const j = e.job;
		const ok =
			j.state === 'cancelled' ||
			j.state === 'interrupted' ||
			(j.state === 'failed' && j.error?.retryable !== false);
		if (!ok) throw new JobError('JOB_NOT_RETRYABLE', `Job ${id} is ${j.state} and cannot be retried`);
		return this.submit({ ...this.specOf(j), input: e.input });
	}

	/** Slots currently granted to running jobs. */
	get usedSlots(): number {
		let n = 0;
		for (const e of this.entries.values())
			if (e.job.state === 'running' || e.job.state === 'cancelling') n += e.granted;
		return n;
	}

	// ------------------------------------------------------------------ scheduling

	private pump(): void {
		if (!this.started || this.stopping) return;
		const queued = [...this.entries.values()]
			.filter((e) => e.job.state === 'queued')
			.sort((a, b) => LANE_RANK[a.job.priority] - LANE_RANK[b.job.priority] || a.seq - b.seq);
		if (queued.length === 0) return;
		const pauseBg =
			(this.opts.pauseBackgroundDuringExport ?? true) &&
			[...this.entries.values()].some(
				(e) => e.job.kind === 'export' && (e.job.state === 'running' || e.job.state === 'cancelling'),
			);
		let used = this.usedSlots;
		for (const e of queued) {
			if (pauseBg && e.job.priority === 'background') continue;
			if (!this.runners.has(e.job.kind)) continue;
			const avail = this.totalSlots - used;
			let grant: number;
			if (avail >= e.job.cpuSlots) grant = e.job.cpuSlots;
			else if (avail >= e.minSlots && avail > 0) grant = avail;
			else continue;
			used += grant;
			this.launch(e, grant);
		}
	}

	private launch(e: Entry, granted: number): void {
		const runner = this.runners.get(e.job.kind)!;
		e.granted = granted;
		e.controller = new AbortController();
		e.job.state = 'running';
		e.job.startedAt = this.now().toISOString();
		this.journal(e);
		this.emitUpdated(e, true);
		const ctx: JobContext = {
			job: e.job,
			input: e.input,
			signal: e.controller.signal,
			slots: Math.max(1, granted),
			progress: (p, extra) => this.onProgress(e, p, extra),
			trackChild: (c) => {
				e.children.add(c);
				c.once('exit', () => e.children.delete(c));
				if (e.controller?.signal.aborted) void terminateTree(c);
			},
			addPartial: (p) => {
				e.partials.push(p);
			},
			scratchDir: async () => {
				if (!e.scratch) {
					e.scratch = join(this.opts.tmpDir, e.job.id);
					await mkdir(e.scratch, { recursive: true });
				}
				return e.scratch;
			},
			log: (text) => {
				e.logLines.push(text);
				if (e.logLines.length > 400) e.logLines.splice(0, e.logLines.length - 400);
			},
		};
		e.settled = (async () => {
			try {
				const result = await runner(ctx);
				if (e.job.state === 'cancelling' || e.controller?.signal.aborted) {
					await this.cleanupAndFinish(e, this.stopping ? 'interrupted' : 'cancelled', {});
				} else await this.cleanupAndFinish(e, 'succeeded', { result });
			} catch (err) {
				if (e.job.state === 'cancelling' || (e.controller?.signal.aborted && !this.stopping)) {
					await this.cleanupAndFinish(e, 'cancelled', {});
				} else if (this.stopping) {
					await this.cleanupAndFinish(e, 'interrupted', {
						error: { code: 'INTERRUPTED', message: 'The engine was stopped', retryable: true },
					});
				} else {
					const code = (err as { code?: string }).code ?? 'INTERNAL';
					const message = (err as Error)?.message ?? String(err);
					const explicit = (err as JobError).retryable;
					const retryable =
						typeof explicit === 'boolean'
							? explicit
							: RETRYABLE_CODES.has(code) || !NON_RETRYABLE_CODES.has(code);
					const stderr = (err as { detail?: { stderr?: string } }).detail?.stderr;
					if (stderr) ctx.log(stderr);
					ctx.log(`${code}: ${message}`);
					const logRef = this.writeLog(e);
					await this.cleanupAndFinish(e, 'failed', {
						error: { code, message: message.slice(0, 2000), retryable, ...(logRef ? { logRef } : {}) },
					});
				}
			}
		})();
	}

	private onProgress(e: Entry, p: number | null, extra: ProgressExtra = {}): void {
		if (e.job.state !== 'running') return;
		e.job.progress = p === null ? null : Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0));
		if (extra.stage !== undefined) e.job.stage = extra.stage;
		if (extra.speed !== undefined && Number.isFinite(extra.speed)) e.job.speed = extra.speed;
		if (extra.etaSec !== undefined && Number.isFinite(extra.etaSec)) e.job.etaSec = Math.max(0, extra.etaSec);
		this.emitUpdated(e, false);
	}

	/** `job.updated`, at most every 250 ms per job; `force` sends now (state changes, final state). */
	private emitUpdated(e: Entry, force: boolean): void {
		const b = this.opts.broadcaster;
		if (!b) return;
		const t = Date.now();
		const send = () => {
			e.emitTimer = null;
			e.lastEmit = Date.now();
			b.publish('job.updated', this.snapshot(e.job), e.job.projectId);
		};
		if (force || t - e.lastEmit >= UPDATE_THROTTLE_MS) {
			if (e.emitTimer) clearTimeout(e.emitTimer);
			send();
		} else if (!e.emitTimer) {
			e.emitTimer = setTimeout(send, UPDATE_THROTTLE_MS - (t - e.lastEmit));
			e.emitTimer.unref();
		}
	}

	private async cleanupAndFinish(
		e: Entry,
		state: EngineJob['state'],
		patch: Pick<Partial<EngineJob>, 'result' | 'error'>,
	): Promise<void> {
		if (TERMINAL_JOB_STATES.has(e.job.state)) return;
		if (state !== 'succeeded') {
			for (const c of e.children) await terminateTree(c);
			for (const p of e.partials) await rm(p, { recursive: true, force: true }).catch(() => undefined);
		}
		if (e.scratch) await rm(e.scratch, { recursive: true, force: true }).catch(() => undefined);
		this.finish(e, state, patch);
	}

	private finish(
		e: Entry,
		state: EngineJob['state'],
		patch: Pick<Partial<EngineJob>, 'result' | 'error'>,
	): void {
		if (TERMINAL_JOB_STATES.has(e.job.state)) return;
		e.job.state = state;
		e.job.finishedAt = this.now().toISOString();
		if (state === 'succeeded') {
			e.job.progress = 1;
			delete e.job.error;
			if (patch.result !== undefined) e.job.result = patch.result;
		} else if (patch.error) e.job.error = patch.error;
		else if (state === 'cancelled')
			e.job.error = { code: 'JOB_CANCELLED', message: 'Cancelled', retryable: true };
		delete e.job.etaSec;
		e.controller = null;
		e.granted = 0;
		if (e.job.dedupeKey && this.dedupe.get(e.job.dedupeKey) === e.job.id) this.dedupe.delete(e.job.dedupeKey);
		this.journal(e);
		if (e.emitTimer) clearTimeout(e.emitTimer);
		e.emitTimer = null;
		const b = this.opts.broadcaster;
		if (b) {
			const snap = this.snapshot(e.job);
			b.publish('job.updated', snap, e.job.projectId);
			b.publish('job.finished', snap, e.job.projectId);
		}
		const waiters = e.waiters.splice(0);
		for (const w of waiters) w(this.snapshot(e.job));
		this.pump();
	}

	// ------------------------------------------------------------------ journal (S04:JB-030)

	private journal(e: Entry): void {
		const path = this.opts.journalPath;
		if (!path) return;
		try {
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `${JSON.stringify(this.record(e))}\n`);
		} catch (err) {
			this.opts.onError?.(err);
		}
	}

	private record(e: Entry): JournalRecord {
		return { job: e.job, input: e.input ?? null, ...(e.requeued ? { requeued: true } : {}) };
	}

	private readJournal(): JournalRecord[] {
		const path = this.opts.journalPath;
		if (!path) return [];
		let text: string;
		try {
			text = readFileSync(path, 'utf8');
		} catch {
			return [];
		}
		const latest = new Map<string, JournalRecord>();
		for (const line of text.split('\n')) {
			if (!line.trim()) continue;
			try {
				const rec = JSON.parse(line) as JournalRecord;
				if (rec?.job?.id) {
					latest.delete(rec.job.id); // keep insertion order = last write order
					latest.set(rec.job.id, rec);
				}
			} catch {
				// torn last line after a crash: skip
			}
		}
		const all = [...latest.values()].sort((a, b) => (a.job.createdAt < b.job.createdAt ? -1 : 1));
		const cutoff = this.now().getTime() - KEEP_FINISHED_MS;
		const finished = all.filter((r) => TERMINAL_JOB_STATES.has(r.job.state));
		const keepFinished = new Set(
			finished
				.filter(
					(r, i) =>
						i >= finished.length - KEEP_FINISHED || Date.parse(r.job.finishedAt ?? r.job.createdAt) >= cutoff,
				)
				.map((r) => r.job.id),
		);
		return all.filter(
			(r) =>
				!TERMINAL_JOB_STATES.has(r.job.state) || keepFinished.has(r.job.id) || r.job.state === 'interrupted',
		);
	}

	private compactJournal(): void {
		const path = this.opts.journalPath;
		if (!path) return;
		try {
			mkdirSync(dirname(path), { recursive: true });
			const lines = [...this.entries.values()]
				.sort((a, b) => a.seq - b.seq)
				.map((e) => JSON.stringify(this.record(e)));
			writeFileSync(path, lines.length ? `${lines.join('\n')}\n` : '');
		} catch (err) {
			this.opts.onError?.(err);
		}
	}

	private writeLog(e: Entry): string | null {
		if (!this.opts.logDir || e.logLines.length === 0) return null;
		try {
			mkdirSync(this.opts.logDir, { recursive: true });
			const file = join(this.opts.logDir, `${e.job.id}.log`);
			writeFileSync(file, e.logLines.join('\n').slice(-64_000));
			return `jobs/${e.job.id}.log`;
		} catch {
			return null;
		}
	}

	// ------------------------------------------------------------------ helpers

	private makeEntry(job: EngineJob, input: unknown, minSlots: number): Entry {
		return {
			job,
			input,
			seq: this.seq++,
			minSlots,
			granted: 0,
			controller: null,
			children: new Set(),
			partials: [],
			scratch: null,
			logLines: [],
			lastEmit: 0,
			emitTimer: null,
			waiters: [],
			settled: null,
			requeued: false,
		};
	}

	private specOf(j: EngineJob): JobSubmit {
		return {
			kind: j.kind,
			title: j.title,
			priority: j.priority,
			cpuSlots: j.cpuSlots,
			minSlots: j.kind === 'export' ? Math.ceil(j.cpuSlots / 2) : j.cpuSlots,
			origin: j.origin,
			...(j.projectId ? { projectId: j.projectId } : {}),
			...(j.assetId ? { assetId: j.assetId } : {}),
			...(j.parentId ? { parentId: j.parentId } : {}),
			...(j.dedupeKey ? { dedupeKey: j.dedupeKey } : {}),
		};
	}

	private snapshot(j: EngineJob): EngineJob {
		return structuredClone(j);
	}
}
