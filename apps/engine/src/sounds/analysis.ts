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

type Pending = { resolve(r: AnalysisResult): void; reject(e: Error): void };

export class SoundAnalyzer {
	private worker: Worker | null = null;
	private ready: Promise<Worker> | null = null;
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private idle: NodeJS.Timeout | null = null;
	/** The worker could not be started: analyse in-thread from now on. */
	private unavailable = false;

	constructor(
		private readonly url: URL | null,
		private readonly log: (m: string) => void = () => {},
	) {}

	/** Where the last analysis ran (tests). */
	lastMode: 'worker' | 'thread' | null = null;

	async run(job: AnalysisJob, signal?: AbortSignal): Promise<AnalysisResult> {
		if (signal?.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		if (!this.url || this.unavailable) return this.inThread(job);
		let worker: Worker;
		try {
			worker = await this.start();
		} catch (e) {
			this.unavailable = true;
			this.log(`sound analysis: no worker thread (${(e as Error).message}); analysing in-thread`);
			return this.inThread(job);
		}
		this.lastMode = 'worker';
		if (this.idle) clearTimeout(this.idle);
		const id = this.nextId++;
		return new Promise<AnalysisResult>((resolve, reject) => {
			const onAbort = () => {
				// The only way to stop a running analysis: end the worker (a new one starts next time).
				this.stop(new JobError('JOB_CANCELLED', 'Cancelled'));
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			this.pending.set(id, {
				resolve: (r) => {
					signal?.removeEventListener('abort', onAbort);
					resolve(r);
				},
				reject: (e) => {
					signal?.removeEventListener('abort', onAbort);
					reject(e);
				},
			});
			worker.postMessage(
				{ id, job } satisfies WorkerRequest,
				job.channels.map((c) => c.buffer as ArrayBuffer),
			);
		}).finally(() => this.armIdle());
	}

	private inThread(job: AnalysisJob): AnalysisResult {
		this.lastMode = 'thread';
		return runAnalysis(job);
	}

	private start(): Promise<Worker> {
		if (this.ready) return this.ready;
		const url = this.url!;
		this.ready = new Promise<Worker>((resolve, reject) => {
			let w: Worker;
			try {
				w = url.pathname.endsWith('.ts') ? new Worker(tsxBootstrap(url), { eval: true }) : new Worker(url);
			} catch (e) {
				reject(e as Error);
				return;
			}
			w.unref();
			let started = false;
			const timer = setTimeout(() => {
				if (!started) {
					void w.terminate();
					reject(new Error('the worker did not start'));
				}
			}, START_TIMEOUT_MS);
			w.on('message', (m: WorkerResponse) => {
				if ('ready' in m) {
					started = true;
					clearTimeout(timer);
					this.worker = w;
					resolve(w);
					return;
				}
				const p = this.pending.get(m.id);
				if (!p) return;
				this.pending.delete(m.id);
				if (m.ok) p.resolve(m.result);
				else p.reject(new JobError('UNSUPPORTED_MEDIA', `The sound cannot be analysed: ${m.message}`));
			});
			const dead = (e: Error) => {
				clearTimeout(timer);
				if (!started) reject(e);
				else this.stop(new JobError('ANALYSIS_FAILED', `The analysis worker stopped: ${e.message}`), w);
			};
			w.on('error', dead);
			w.on('exit', (code) => dead(new Error(`exit code ${code}`)));
		});
		this.ready.catch(() => {
			this.ready = null;
		});
		return this.ready;
	}

	/** Ends the worker; pending analyses fail with `reason`. */
	private stop(reason: Error, which: Worker | null = this.worker): void {
		if (which && which === this.worker) {
			this.worker = null;
			this.ready = null;
			void which.terminate();
		}
		for (const [id, p] of this.pending) {
			this.pending.delete(id);
			p.reject(reason);
		}
	}

	private armIdle(): void {
		if (this.idle) clearTimeout(this.idle);
		if (this.pending.size > 0) return;
		this.idle = setTimeout(() => {
			if (this.pending.size === 0 && this.worker) this.stop(new Error('idle'));
		}, IDLE_MS);
		this.idle.unref();
	}

	async close(): Promise<void> {
		if (this.idle) clearTimeout(this.idle);
		this.stop(new JobError('INTERRUPTED', 'The engine was stopped'));
	}
}
