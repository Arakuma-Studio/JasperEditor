// Worker threads of the native retime stage (workstream `time`): Optical Flow (the CPU kernel of @jasper/project
// time-remap/flow.ts, evaluated from its own source so the workers need no module loading) — one task per pair of
// source frames computes the flow once and every output frame that uses the pair, sliced into rows.
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { flowKernelSource } from '@jasper/project';

const WORKER_SOURCE = `
// Functions are inlined by their source text: under tsx (dev engine) esbuild's keepNames wraps them in __name().
var __name = (f) => f;
const { parentPort } = require('node:worker_threads');
const K = ${flowKernelSource()};
let pairKey = null;
let pair = null;
parentPort.on('message', (m) => {
	try {
		const a = { width: m.w, height: m.h, data: new Uint8Array(m.a) };
		const b = { width: m.w, height: m.h, data: new Uint8Array(m.b) };
		if (pairKey !== m.key) {
			pair = K.computeFlowPair(a, b, 255);
			pairKey = m.key;
		}
		const outs = m.ws.map((w) => {
			const data = new Uint8Array(m.w * m.h * 4);
			K.interpolateFlow(a, b, w, pair, { data });
			return data.buffer;
		});
		parentPort.postMessage({ id: m.id, outs }, outs);
	} catch (e) {
		parentPort.postMessage({ id: m.id, error: String(e && e.stack || e) });
	}
});
`;

type Job = { resolve(outs: Uint8Array[]): void; reject(e: Error): void };

/** A pool of flow workers. `run` interpolates every fraction of `ws` between two RGBA frames. */
export class FlowPool {
	private readonly workers: Worker[] = [];
	private readonly idle: Worker[] = [];
	private readonly queue: { msg: Record<string, unknown>; transfer: ArrayBuffer[]; job: Job }[] = [];
	private readonly pending = new Map<number, Job>();
	private readonly busy = new Map<Worker, number>();
	private seq = 0;
	private closed = false;
	/** The first worker failure: the pool is broken from then on (a dead worker is never handed another task). */
	private failed: Error | null = null;

	constructor(workers = Math.max(1, Math.min(8, availableParallelism() - 1))) {
		for (let i = 0; i < workers; i++) {
			const w = new Worker(WORKER_SOURCE, { eval: true });
			w.on('message', (m: { id: number; outs?: ArrayBuffer[]; error?: string }) => {
				const job = this.pending.get(m.id);
				this.pending.delete(m.id);
				this.busy.delete(w);
				this.idle.push(w);
				if (job) {
					if (m.error) job.reject(new Error(`optical flow worker: ${m.error}`));
					else job.resolve((m.outs ?? []).map((b) => new Uint8Array(b)));
				}
				this.pump();
			});
			w.on('error', (e) => this.failWorker(w, e));
			w.on('exit', (code) => {
				if (!this.closed) this.failWorker(w, new Error(`optical flow worker exited (${code})`));
			});
			this.workers.push(w);
			this.idle.push(w);
		}
	}

	get size(): number {
		return this.workers.length;
	}

	private failWorker(w: Worker, e: Error): void {
		this.failed ??= e;
		const k = this.idle.indexOf(w);
		if (k >= 0) this.idle.splice(k, 1);
		for (const q of this.queue.splice(0)) q.job.reject(e);
		const id = this.busy.get(w);
		if (id !== undefined) {
			this.pending.get(id)?.reject(e);
			this.pending.delete(id);
			this.busy.delete(w);
		}
	}

	private pump(): void {
		while (this.idle.length > 0 && this.queue.length > 0) {
			const w = this.idle.pop()!;
			const q = this.queue.shift()!;
			const id = q.msg.id as number;
			this.pending.set(id, q.job);
			this.busy.set(w, id);
			w.postMessage(q.msg, q.transfer);
		}
	}

	/** The interpolated frames at fractions `ws` between `a` and `b` (`w`×`h` RGBA). `key` names the pair. */
	run(key: string, a: Uint8Array, b: Uint8Array, w: number, h: number, ws: number[]): Promise<Uint8Array[]> {
		if (this.closed) return Promise.reject(new Error('flow pool closed'));
		if (this.failed) return Promise.reject(this.failed);
		const ac = a.slice().buffer;
		const bc = b.slice().buffer;
		return new Promise<Uint8Array[]>((resolve, reject) => {
			const id = ++this.seq;
			this.queue.push({
				msg: { id, key, a: ac, b: bc, w, h, ws },
				transfer: [ac, bc],
				job: { resolve, reject },
			});
			this.pump();
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const job of this.pending.values()) job.reject(new Error('flow pool closed'));
		this.pending.clear();
		await Promise.all(this.workers.map((w) => w.terminate()));
	}
}
