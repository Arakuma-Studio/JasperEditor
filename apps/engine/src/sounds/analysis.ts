// Runs sound analysis (analysis-core.ts) on a worker thread, so indexing a long file never holds the engine's event
// loop (measured on this host at load ≈ 160: `analyzeSound` 13.4 s and the spectrogram 4.4 s for 30 s of stereo
// noise). One worker per engine, started on first use and stopped after 30 s idle; cancelling a running analysis
// terminates it. The worker module is `JASPER_SOUND_WORKER` (a path, or `off` to analyse in-thread), else
// `sound-worker.mjs` next to the engine bundle, else — in a dev engine running under tsx — `analysis-worker.ts`.
// When no worker can be started (vitest, a missing file), analysis runs in-thread, between the job's yields.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { JobError } from '../jobs/types.ts';
import { type AnalysisJob, type AnalysisResult, runAnalysis } from './analysis-core.ts';

export const SOUND_WORKER_ENV = 'JASPER_SOUND_WORKER';
const IDLE_MS = 30_000;
const START_TIMEOUT_MS = 120_000;

export type WorkerRequest = { id: number; job: AnalysisJob };
export type WorkerResponse =
	| { id: number; ok: true; result: AnalysisResult }
	| { id: number; ok: false; message: string }
	| { id: 0; ready: true };

/** The worker module to use, or null to analyse in-thread. */
export function resolveSoundWorker(
	env: Record<string, string | undefined> = process.env,
	base: string = import.meta.url,
	execArgv: readonly string[] = process.execArgv,
): URL | null {
	const o = env[SOUND_WORKER_ENV];
	if (o === 'off' || o === '0') return null;
	if (o) return o.startsWith('file:') ? new URL(o) : pathToFileURL(o);
	const bundled = new URL('./sound-worker.mjs', base);
	if (existsSync(fileURLToPath(bundled))) return bundled;
	if (execArgv.some((a) => a.includes('tsx'))) {
		const ts = new URL('./analysis-worker.ts', base);
		if (existsSync(fileURLToPath(ts))) return ts;
	}
	return null;
}

/**
 * A worker that runs a TypeScript module from the source tree: Node 20 does not apply the main thread's tsx loader to
 * worker threads, so the worker registers tsx's ESM hooks itself before importing the module.
 */
function tsxBootstrap(url: URL): string {
	const api = import.meta.resolve('tsx/esm/api');
	return `import(${JSON.stringify(api)}).then((m) => { m.register(); return import(${JSON.stringify(url.href)}); })`;
}

/** What the analyzer needs of a worker thread (a seam: tests inject fakes). */
export type AnalysisWorker = {
	postMessage(message: WorkerRequest): void;
	terminate(): unknown;
	unref?(): void;
	on(event: 'message', fn: (m: WorkerResponse) => void): unknown;
	on(event: 'error', fn: (e: Error) => void): unknown;
	on(event: 'exit', fn: (code: number) => void): unknown;
};
export type AnalysisWorkerFactory = (url: URL) => AnalysisWorker;

const defaultWorkerFactory: AnalysisWorkerFactory = (url) =>
	(url.pathname.endsWith('.ts')
		? new Worker(tsxBootstrap(url), { eval: true })
		: new Worker(url)) as unknown as AnalysisWorker;

/** A request sent to a worker: kept (with its samples) until it settles, so it can move to a new worker. */
type Pending = {
	id: number;
	job: AnalysisJob;
	resolve(r: AnalysisResult): void;
	reject(e: Error): void;
	settled: boolean;
	/** The worker it was posted to (null while waiting for one). */
	slot: Slot | null;
	/** Times it was posted (a request is moved to a new worker at most twice). */
	posts: number;
};

/** One worker thread and the requests posted to it. Events of a slot only ever touch its own requests. */
type Slot = {
	worker: AnalysisWorker;
	ready: Promise<Slot>;
	pending: Map<number, Pending>;
	/** Ended (by us or by itself): its later events are ignored. */
	dead: boolean;
};

/** A request is moved to a new worker at most this many times when the worker it was on was stopped for another one. */
const MAX_POSTS = 3;

export class SoundAnalyzer {
	private slot: Slot | null = null;
	private nextId = 1;
	private idle: NodeJS.Timeout | null = null;
	/** The worker could not be started: analyse in-thread from now on. */
	private unavailable = false;
	private readonly createWorker: AnalysisWorkerFactory;
	private readonly startTimeoutMs: number;
	private readonly idleMs: number;

	constructor(
		private readonly url: URL | null,
		private readonly log: (m: string) => void = () => {},
		opts: { createWorker?: AnalysisWorkerFactory; startTimeoutMs?: number; idleMs?: number } = {},
	) {
		this.createWorker = opts.createWorker ?? defaultWorkerFactory;
		this.startTimeoutMs = opts.startTimeoutMs ?? START_TIMEOUT_MS;
		this.idleMs = opts.idleMs ?? IDLE_MS;
	}

	/** Where the last analysis ran (tests). */
	lastMode: 'worker' | 'thread' | null = null;

	/**
	 * Runs one analysis. `signal` cancels it (`JOB_CANCELLED`); `timeoutMs` bounds it (`ANALYSIS_TIMEOUT`). Stopping a
	 * running analysis means ending its worker: the other requests on that worker move to a new one, they do not fail.
	 */
	async run(job: AnalysisJob, signal?: AbortSignal, opts: { timeoutMs?: number } = {}): Promise<AnalysisResult> {
		if (signal?.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		if (!this.url || this.unavailable) return this.inThread(job);
		if (this.idle) clearTimeout(this.idle);
		const id = this.nextId++;
		let timer: NodeJS.Timeout | null = null;
		let onAbort: (() => void) | null = null;
		return new Promise<AnalysisResult>((resolve, reject) => {
			const p: Pending = {
				id,
				job,
				settled: false,
				slot: null,
				posts: 0,
				resolve: (r) => {
					if (p.settled) return;
					p.settled = true;
					resolve(r);
				},
				reject: (e) => {
					if (p.settled) return;
					p.settled = true;
					reject(e);
				},
			};
			onAbort = () => this.stopFor(p, new JobError('JOB_CANCELLED', 'Cancelled'));
			signal?.addEventListener('abort', onAbort, { once: true });
			if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
				const ms = opts.timeoutMs;
				timer = setTimeout(
					() =>
						this.stopFor(
							p,
							new JobError('ANALYSIS_TIMEOUT', `The sound analysis took longer than ${Math.round(ms / 1000)} s`),
						),
					ms,
				);
				timer.unref();
			}
			void this.dispatch(p);
		}).finally(() => {
			if (timer) clearTimeout(timer);
			if (onAbort) signal?.removeEventListener('abort', onAbort);
			this.armIdle();
		});
	}

	private inThread(job: AnalysisJob): AnalysisResult {
		this.lastMode = 'thread';
		return runAnalysis(job);
	}

	/** Posts a request to the current worker (started when needed); falls back to in-thread when none can start. */
	private async dispatch(p: Pending): Promise<void> {
		let slot: Slot;
		try {
			slot = await this.start();
		} catch (e) {
			if (p.settled) return;
			this.unavailable = true;
			this.log(`sound analysis: no worker thread (${(e as Error).message}); analysing in-thread`);
			try {
				p.resolve(this.inThread(p.job));
			} catch (err) {
				p.reject(err as Error);
			}
			return;
		}
		if (p.settled) return;
		if (slot.dead) return void this.dispatch(p);
		if (p.posts >= MAX_POSTS) {
			p.reject(new JobError('ANALYSIS_FAILED', 'The analysis worker stopped repeatedly'));
			return;
		}
		p.posts++;
		p.slot = slot;
		slot.pending.set(p.id, p);
		this.lastMode = 'worker';
		// The samples are copied, not transferred: the request can be posted again if this worker is stopped.
		slot.worker.postMessage({ id: p.id, job: p.job } satisfies WorkerRequest);
	}

	private start(): Promise<Slot> {
		if (this.slot && !this.slot.dead) return this.slot.ready;
		const url = this.url!;
		let worker: AnalysisWorker;
		try {
			worker = this.createWorker(url);
		} catch (e) {
			return Promise.reject(e as Error);
		}
		worker.unref?.();
		const slot: Slot = { worker, ready: null as unknown as Promise<Slot>, pending: new Map(), dead: false };
		this.slot = slot;
		slot.ready = new Promise<Slot>((resolve, reject) => {
			let started = false;
			const timer = setTimeout(() => {
				if (!started) {
					this.end(slot);
					reject(new Error('the worker did not start'));
				}
			}, this.startTimeoutMs);
			timer.unref?.();
			worker.on('message', (m: WorkerResponse) => {
				if (slot.dead) return;
				if ('ready' in m) {
					started = true;
					clearTimeout(timer);
					resolve(slot);
					return;
				}
				const p = slot.pending.get(m.id);
				if (!p) return;
				slot.pending.delete(m.id);
				if (m.ok) p.resolve(m.result);
				else p.reject(new JobError('UNSUPPORTED_MEDIA', `The sound cannot be analysed: ${m.message}`));
			});
			const dead = (e: Error) => {
				clearTimeout(timer);
				// A worker we ended ourselves, or an old one: its requests were already moved or settled.
				if (slot.dead) return;
				this.end(slot);
				if (!started) {
					reject(e);
					return;
				}
				const failure = new JobError('ANALYSIS_FAILED', `The analysis worker stopped: ${e.message}`);
				for (const p of slot.pending.values()) p.reject(failure);
				slot.pending.clear();
			};
			worker.on('error', dead);
			worker.on('exit', (code) => dead(new Error(`exit code ${code}`)));
		});
		slot.ready.catch(() => undefined);
		return slot.ready;
	}

	/** Marks a slot ended and terminates its worker (its events are ignored from now on). */
	private end(slot: Slot): void {
		if (slot.dead) return;
		slot.dead = true;
		if (this.slot === slot) this.slot = null;
		try {
			void Promise.resolve(slot.worker.terminate()).catch(() => undefined);
		} catch {
			// already gone
		}
	}

	/**
	 * Stops one request with `reason`. When it is running on a worker, that worker is ended (the only way to stop an
	 * analysis) and the worker's other requests are posted to a new one.
	 */
	private stopFor(p: Pending, reason: Error): void {
		if (p.settled) return;
		const slot = p.slot;
		p.reject(reason);
		if (!slot || slot.dead) return;
		slot.pending.delete(p.id);
		this.end(slot);
		const others = [...slot.pending.values()];
		slot.pending.clear();
		for (const o of others) {
			o.slot = null;
			void this.dispatch(o);
		}
	}

	private armIdle(): void {
		if (this.idle) clearTimeout(this.idle);
		const slot = this.slot;
		if (!slot || slot.pending.size > 0) return;
		this.idle = setTimeout(() => {
			if (this.slot === slot && slot.pending.size === 0) this.end(slot);
		}, this.idleMs);
		this.idle.unref?.();
	}

	async close(): Promise<void> {
		if (this.idle) clearTimeout(this.idle);
		const slot = this.slot;
		if (!slot) return;
		this.end(slot);
		const reason = new JobError('INTERRUPTED', 'The engine was stopped');
		for (const p of slot.pending.values()) p.reject(reason);
		slot.pending.clear();
	}
}
