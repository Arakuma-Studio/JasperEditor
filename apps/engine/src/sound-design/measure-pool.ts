// Runs the sound-design measurements (measure-core.ts: solo and bed renders, band analysis) on worker threads, so a
// plan, a rebalance, a delivery or a Sound Check never holds the engine's event loop for the seconds the offline mixer
// takes (wp-note WP6.5b item 7: the first plan with every style option did ≈ 69 solo renders on the main thread).
//
// Lifecycle (like the sound analysis worker, sounds/analysis.ts): up to two workers, started on first
// use, each stopped after 30 s idle; a request goes to an idle worker, else a new one, else the least busy. Results
// come back with their PCM transferred, not copied.
// - cancel (the job's signal): the op is told to stop (its ffmpeg decoders are killed) and the request rejects at once
//   with JOB_CANCELLED; a worker that does not answer within 5 s is ended and its other requests move to a new one.
// - timeout (10 min per op): MEASURE_TIMEOUT (retryable); the worker is ended, its other requests move.
// - crash (an uncaught error, an exit, a failed start after it was ready): every request on it rejects with
//   MEASURE_FAILED (retryable) — a job fails (or, in a plan, falls back to default levels with W_LEVELS_UNMEASURED),
//   never hangs. A request is moved at most twice (MEASURE_FAILED after that).
// - no worker (vitest, `JASPER_SD_MEASURE_WORKER=off`, no bundle, a worker that does not start): the op runs in-thread,
//   as before, with the job's own ffmpeg and child tracking.
// The worker module is `JASPER_SD_MEASURE_WORKER` (a path, or `off`), else `sd-measure-worker.mjs` next to the engine
// bundle, else — in a dev engine running under tsx — `measure-worker.ts`.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { JobError } from '../jobs/types.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { type MeasureOp, type MeasureOpResult, type RenderEnv, runMeasureOp } from './measure-core.ts';

export const SD_MEASURE_WORKER_ENV = 'JASPER_SD_MEASURE_WORKER';
const IDLE_MS = 30_000;
const START_TIMEOUT_MS = 120_000;
const OP_TIMEOUT_MS = 600_000;
const CANCEL_GRACE_MS = 5_000;
const DEFAULT_SIZE = 2;
/** A request is posted at most this many times (moved to a new worker when the one it was on was ended). */
const MAX_POSTS = 3;

type Bins = Ffmpeg['bins'];
export type MeasureWorkerRequest = { id: number; op: MeasureOp; bins: Bins } | { cancel: number };
export type MeasureWorkerResponse =
	| { id: number; ok: true; result: unknown }
	| { id: number; ok: false; message: string; aborted: boolean; code?: string; retryable?: boolean }
	| { id: 0; ready: true };

/** The worker module to use, or null to measure in-thread. */
export function resolveMeasureWorker(
	env: Record<string, string | undefined> = process.env,
	base: string = import.meta.url,
	execArgv: readonly string[] = process.execArgv,
): URL | null {
	const o = env[SD_MEASURE_WORKER_ENV];
	if (o === 'off' || o === '0') return null;
	if (o) return o.startsWith('file:') ? new URL(o) : pathToFileURL(o);
	const bundled = new URL('./sd-measure-worker.mjs', base);
	if (existsSync(fileURLToPath(bundled))) return bundled;
	if (execArgv.some((a) => a.includes('tsx'))) {
		const ts = new URL('./measure-worker.ts', base);
		if (existsSync(fileURLToPath(ts))) return ts;
	}
	return null;
}

/** A worker running a TypeScript module from the source tree registers tsx's hooks itself (Node 20). */
function tsxBootstrap(url: URL): string {
	const api = import.meta.resolve('tsx/esm/api');
	return `import(${JSON.stringify(api)}).then((m) => { m.register(); return import(${JSON.stringify(url.href)}); })`;
}

type Pending = {
	id: number;
	op: MeasureOp;
	bins: Bins;
	/** For the in-thread fallback (the job's ffmpeg and child tracking). */
	env: RenderEnv;
	resolve(r: unknown): void;
	reject(e: Error): void;
	settled: boolean;
	slot: Slot | null;
	posts: number;
};

type Slot = {
	worker: Worker;
	ready: Promise<Slot>;
	pending: Map<number, Pending>;
	/** Cancelled requests the worker has not answered yet (id → grace timer). */
	cancelling: Map<number, NodeJS.Timeout>;
	dead: boolean;
	idle: NodeJS.Timeout | null;
	/** Requests picked for it and not posted yet (waiting for it to start). */
	queued: number;
};

const load = (s: Slot) => s.pending.size + s.queued;

export class SoundDesignMeasurer {
	private slots: Slot[] = [];
	private nextId = 1;
	/** No worker could be started: measure in-thread from now on. */
	private unavailable = false;

	constructor(
		private readonly url: URL | null,
		private readonly log: (m: string) => void = () => {},
	) {}

	/**
	 * Runs one op. `env.signal` cancels it (`JOB_CANCELLED`); the ten-minute deadline bounds it (`MEASURE_TIMEOUT`). In-thread
	 * (no worker) the op runs with `env` as given (the job's ffmpeg and child tracking).
	 */
	async run<O extends MeasureOp>(op: O, env: RenderEnv): Promise<MeasureOpResult<O['kind']>> {
		const signal = env.signal;
		if (signal?.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled', true);
		if (!this.url || this.unavailable) return runMeasureOp(op, env);
		const id = this.nextId++;
		let timer: NodeJS.Timeout | null = null;
		let onAbort: (() => void) | null = null;
		return new Promise<MeasureOpResult<O['kind']>>((resolve, reject) => {
			const p: Pending = {
				id,
				op,
				bins: env.ff.bins,
				env,
				settled: false,
				slot: null,
				posts: 0,
				resolve: (r) => {
					if (p.settled) return;
					p.settled = true;
					resolve(r as MeasureOpResult<O['kind']>);
				},
				reject: (e) => {
					if (p.settled) return;
					p.settled = true;
					reject(e);
				},
			};
			onAbort = () => this.cancel(p);
			signal?.addEventListener('abort', onAbort, { once: true });
			const ms = OP_TIMEOUT_MS;
			if (ms > 0) {
				timer = setTimeout(
					() =>
						this.stopFor(
							p,
							new JobError(
								'MEASURE_TIMEOUT',
								`A sound-design measurement took longer than ${Math.round(ms / 1000)} s`,
								true,
							),
						),
					ms,
				);
				timer.unref?.();
			}
			void this.dispatch(p);
		}).finally(() => {
			if (timer) clearTimeout(timer);
			if (onAbort) signal?.removeEventListener('abort', onAbort);
		});
	}

	/** Posts a request to a worker (started when needed); runs it in-thread when no worker can start. */
	private async dispatch(p: Pending): Promise<void> {
		let slot: Slot;
		try {
			const picked = this.pick();
			picked.queued++;
			try {
				slot = await picked.ready;
			} finally {
				picked.queued--;
			}
		} catch (e) {
			if (p.settled) return;
			this.unavailable = true;
			this.log(`sound design: no measurement worker (${(e as Error).message}); measuring in-thread`);
			try {
				p.resolve(await runMeasureOp(p.op, p.env));
			} catch (err) {
				p.reject(err as Error);
			}
			return;
		}
		if (p.settled) return;
		if (slot.dead) return void this.dispatch(p);
		if (p.posts >= MAX_POSTS) {
			p.reject(new JobError('MEASURE_FAILED', 'The measurement worker stopped repeatedly', true));
			return;
		}
		p.posts++;
		p.slot = slot;
		if (slot.idle) clearTimeout(slot.idle);
		slot.idle = null;
		slot.pending.set(p.id, p);
		// copied, not transferred: the request can be posted again if this worker is ended
		slot.worker.postMessage({ id: p.id, op: p.op, bins: p.bins });
	}

	/** An idle live worker, else a new one (up to two), else the least busy. Throws when none can be made. */
	private pick(): Slot {
		this.slots = this.slots.filter((s) => !s.dead);
		const idle = this.slots.find((s) => load(s) === 0);
		if (idle) return idle;
		if (this.slots.length < DEFAULT_SIZE) return this.start();
		return this.slots.reduce((a, b) => (load(b) < load(a) ? b : a));
	}

	private start(): Slot {
		const url = this.url!;
		const worker = url.pathname.endsWith('.ts')
			? new Worker(tsxBootstrap(url), { eval: true })
			: new Worker(url);
		worker.unref();
		const slot: Slot = {
			worker,
			ready: null as unknown as Promise<Slot>,
			pending: new Map(),
			cancelling: new Map(),
			dead: false,
			idle: null,
			queued: 0,
		};
		this.slots.push(slot);
		slot.ready = new Promise<Slot>((resolve, reject) => {
			let started = false;
			const timer = setTimeout(() => {
				if (!started) {
					this.end(slot);
					reject(new Error('the worker did not start'));
				}
			}, START_TIMEOUT_MS);
			timer.unref?.();
			worker.on('message', (m: MeasureWorkerResponse) => {
				if (slot.dead) return;
				if ('ready' in m) {
					started = true;
					clearTimeout(timer);
					resolve(slot);
					return;
				}
				const grace = slot.cancelling.get(m.id);
				if (grace) {
					clearTimeout(grace);
					slot.cancelling.delete(m.id);
				}
				const p = slot.pending.get(m.id);
				if (p) {
					slot.pending.delete(m.id);
					if (m.ok) p.resolve(m.result);
					else if (m.aborted) p.reject(new JobError('JOB_CANCELLED', 'Cancelled', true));
					else p.reject(new JobError(m.code ?? 'MEASURE_FAILED', m.message, m.retryable ?? true));
				}
				this.armIdle(slot);
			});
			const dead = (e: Error) => {
				clearTimeout(timer);
				if (slot.dead) return;
				this.end(slot);
				if (!started) {
					reject(e);
					return;
				}
				const failure = new JobError(
					'MEASURE_FAILED',
					`The sound-design measurement worker stopped: ${e.message}`,
					true,
				);
				for (const p of slot.pending.values()) p.reject(failure);
				slot.pending.clear();
			};
			worker.on('error', dead);
			worker.on('exit', (code) => dead(new Error(`exit code ${code}`)));
		});
		slot.ready.catch(() => undefined);
		return slot;
	}

	/** Ends a slot: its worker is terminated, its events are ignored from now on. */
	private end(slot: Slot): void {
		if (slot.dead) return;
		slot.dead = true;
		if (slot.idle) clearTimeout(slot.idle);
		for (const t of slot.cancelling.values()) clearTimeout(t);
		slot.cancelling.clear();
		this.slots = this.slots.filter((s) => s !== slot);
		try {
			void Promise.resolve(slot.worker.terminate()).catch(() => undefined);
		} catch {
			// already gone
		}
	}

	/** Cancels a request: it rejects now; its worker is asked to stop the op and ended if it does not answer. */
	private cancel(p: Pending): void {
		if (p.settled) return;
		const slot = p.slot;
		p.reject(new JobError('JOB_CANCELLED', 'Cancelled', true));
		if (!slot || slot.dead) return;
		slot.pending.delete(p.id);
		try {
			slot.worker.postMessage({ cancel: p.id });
		} catch {
			// the worker is gone: its exit handler cleans up
		}
		const grace = setTimeout(() => {
			if (!slot.dead && slot.cancelling.has(p.id)) this.endAndMove(slot);
		}, CANCEL_GRACE_MS);
		grace.unref?.();
		slot.cancelling.set(p.id, grace);
	}

	/** Stops one request with `reason` by ending its worker; the worker's other requests move to a new one. */
	private stopFor(p: Pending, reason: Error): void {
		if (p.settled) return;
		const slot = p.slot;
		p.reject(reason);
		if (!slot || slot.dead) return;
		slot.pending.delete(p.id);
		this.endAndMove(slot);
	}

	private endAndMove(slot: Slot): void {
		this.end(slot);
		const others = [...slot.pending.values()];
		slot.pending.clear();
		for (const o of others) {
			o.slot = null;
			void this.dispatch(o);
		}
	}

	private armIdle(slot: Slot): void {
		if (slot.idle) clearTimeout(slot.idle);
		slot.idle = null;
		if (slot.dead || load(slot) > 0 || slot.cancelling.size > 0) return;
		slot.idle = setTimeout(() => {
			if (!slot.dead && load(slot) === 0 && slot.cancelling.size === 0) this.end(slot);
		}, IDLE_MS);
		slot.idle.unref?.();
	}

	/** Ends every worker; their requests reject with INTERRUPTED. */
	async close(): Promise<void> {
		for (const slot of [...this.slots]) {
			const pending = [...slot.pending.values()];
			slot.pending.clear();
			this.end(slot);
			const reason = new JobError('INTERRUPTED', 'The engine was stopped', true);
			for (const p of pending) p.reject(reason);
		}
	}
}

/** The engine's measurer (created on first use from the environment). */
let shared: SoundDesignMeasurer | null = null;
export function soundDesignMeasurer(log?: (m: string) => void): SoundDesignMeasurer {
	shared ??= new SoundDesignMeasurer(resolveMeasureWorker(), log);
	return shared;
}
/** Stops the engine's measurer (engine shutdown). */
export async function closeSoundDesignMeasurer(): Promise<void> {
	const s = shared;
	shared = null;
	await s?.close();
}
