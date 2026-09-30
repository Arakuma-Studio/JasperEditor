// Worker-thread pool for the de-judder step (S07:PST-014): N workers, each with its own OpenCV.js instance,
// one task per worker at a time, FIFO queue in the main thread.
//
// Bundling (PRC-011): the worker is a separate entry point. From the source tree (vitest / tsx) it is
// `./worker.mjs` next to this file; in the esbuild bundle `dist/jasper-proc.mjs` it must be emitted as
// `dist/dejudder-worker.mjs` (a second esbuild entry: `src/processing/proc/dejudder/worker.mjs` →
// `dist/dejudder-worker.mjs`, bundle, platform node, format esm, with a banner defining `require`,
// `__filename` and `__dirname` because opencv.js is CommonJS and reads `__dirname` under Node).
// `JASPER_DEJUDDER_WORKER` (absolute path or file: URL) overrides the lookup.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

/** Farnebäck parameters of the warp flow (PST-013). */
export type FlowParams = {
	/** Flow is computed on a grey proxy at most this wide, then upsampled (PST-013: ≤ 960). */
	maxWidth: number;
	pyrScale: number;
	levels: number;
	winsize: number;
	iterations: number;
	polyN: number;
	polySigma: number;
	/** `OPTFLOW_FARNEBACK_GAUSSIAN` window (better quality, slower). */
	gaussian: boolean;
	/** Gaussian smoothing of the flow field before use, sigma in flow-resolution px (0 = off). */
	smoothSigma: number;
};

export type WorkerRequest =
	| { type: 'motion'; id: number; width: number; height: number; a: Uint8Array; b: Uint8Array }
	| {
			type: 'warp';
			id: number;
			width: number;
			height: number;
			/** rgb48 frame that is warped (the nearest real frame). */
			near: Uint16Array;
			/** Its neighbour; only used for the flow. */
			far: Uint16Array;
			/** Fraction of the near→far step to move (PST-013 `shift`). */
			t: number;
			flow: FlowParams;
	  };

type Task = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

export type MotionResult = { p75: number; dx: number; dy: number };

type WorkerResponse =
	| { type: 'ready' }
	| ({ type: 'motion'; id: number } & MotionResult)
	| { type: 'warp'; id: number; data: Uint16Array }
	| { type: 'error'; id: number; message: string };

/**
 * Where the worker script lives: `JASPER_DEJUDDER_WORKER` → `dejudder-worker.mjs` next to the running module
 * (bundled `dist/jasper-proc.mjs`) → `worker.mjs` next to this source file.
 */
export function resolveWorkerUrl(env: NodeJS.ProcessEnv = process.env, base: string = import.meta.url): URL {
	const override = env.JASPER_DEJUDDER_WORKER;
	if (override) return override.startsWith('file:') ? new URL(override) : pathToFileURL(override);
	for (const name of ['./dejudder-worker.mjs', './worker.mjs']) {
		const url = new URL(name, base);
		if (existsSync(fileURLToPath(url))) return url;
	}
	throw new Error(`dejudder worker script not found next to ${base} (set JASPER_DEJUDDER_WORKER)`);
}

type Slot = { worker: Worker; busy: boolean };
type Pending = { task: Task; transfer: ArrayBuffer[]; resolve: (v: any) => void; reject: (e: Error) => void };

export class CvPool {
	private readonly slots: Slot[] = [];
	private readonly queue: Pending[] = [];
	private readonly inflight = new Map<number, Pending & { slot: Slot }>();
	private nextId = 1;
	private failure: Error | null = null;
	private closed = false;

	private constructor() {}

	/** Starts `size` workers and waits until each has loaded OpenCV.js. */
	static async create(size: number, workerUrl: URL = resolveWorkerUrl()): Promise<CvPool> {
		const pool = new CvPool();
		const n = Math.max(1, Math.floor(size));
		try {
			await Promise.all(Array.from({ length: n }, () => pool.spawn(workerUrl)));
		} catch (e) {
			await pool.close();
			throw e;
		}
		return pool;
	}

	get size(): number {
		return this.slots.length;
	}

	private spawn(url: URL): Promise<void> {
		return new Promise((resolve, reject) => {
			const worker = new Worker(url);
			const slot: Slot = { worker, busy: true };
			let ready = false;
			worker.on('message', (msg: WorkerResponse) => {
				if (msg.type === 'ready') {
					ready = true;
					slot.busy = false;
					this.slots.push(slot);
					resolve();
					this.pump();
					return;
				}
				if (!ready) {
					reject(new Error(msg.type === 'error' ? msg.message : 'dejudder worker failed to start'));
					return;
				}
				const job = this.inflight.get(msg.id);
				if (!job) return;
				this.inflight.delete(msg.id);
				slot.busy = false;
				if (msg.type === 'error') job.reject(new Error(`dejudder worker: ${msg.message}`));
				else if (msg.type === 'warp') job.resolve(msg.data);
				else if (msg.type === 'motion') job.resolve({ p75: msg.p75, dx: msg.dx, dy: msg.dy });
				this.pump();
			});
			const fail = (err: Error) => {
				if (!ready) {
					reject(err);
					return;
				}
				if (this.closed) return;
				this.fail(err);
			};
			worker.on('error', (e) => fail(e instanceof Error ? e : new Error(String(e))));
			worker.on('exit', (code) => fail(new Error(`dejudder worker exited (${code})`)));
		});
	}

	private fail(err: Error): void {
		if (this.failure) return;
		this.failure = err;
		for (const job of this.inflight.values()) job.reject(err);
		this.inflight.clear();
		for (const job of this.queue.splice(0)) job.reject(err);
	}

	private pump(): void {
		for (const slot of this.slots) {
			if (slot.busy) continue;
			const job = this.queue.shift();
			if (!job) return;
			const id = this.nextId++;
			slot.busy = true;
			this.inflight.set(id, { ...job, slot });
			slot.worker.postMessage({ ...job.task, id }, job.transfer);
		}
	}

	private run<T>(task: Task, transfer: ArrayBuffer[] = []): Promise<T> {
		if (this.failure) return Promise.reject(this.failure);
		if (this.closed) return Promise.reject(new Error('dejudder pool is closed'));
		return new Promise<T>((resolve, reject) => {
			this.queue.push({ task, transfer, resolve, reject });
			this.pump();
		});
	}

	/** Per-pair motion of two grey proxies (PST-011). The buffers are copied. */
	motion(width: number, height: number, a: Uint8Array, b: Uint8Array): Promise<MotionResult> {
		return this.run({ type: 'motion', width, height, a, b });
	}

	/** Backward warp of `near` by `t` of the near→far step (PST-013). The buffers are copied. */
	warp(
		width: number,
		height: number,
		near: Uint16Array,
		far: Uint16Array,
		t: number,
		flow: FlowParams,
	): Promise<Uint16Array> {
		return this.run({ type: 'warp', width, height, near, far, t, flow });
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.fail(new Error('dejudder pool is closed'));
		await Promise.all(this.slots.map((s) => s.worker.terminate()));
		this.slots.length = 0;
	}
}
