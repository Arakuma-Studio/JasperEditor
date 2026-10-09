// Worker-thread pool of the blend kernel (keyframes-blend; like stream/pool.ts): each worker runs `blendStackedFrame`
// with `makeBlendKernel` (their source text) on frame slots that live in SharedArrayBuffers (input `2W×H` frame +
// output `W×H` frame per slot), no copies across threads.
import { Worker } from 'node:worker_threads';
import { makeBlendKernel } from '@jasper/project';
import { blendStackedFrame } from './kernel.ts';

/** One reusable frame slot: `src` (composite ‖ layer, `2W×H` RGBA) and `out` (`W×H` RGBA). */
export type BlendSlot = { index: number; src: Uint8Array; out: Uint8Array };

const WORKER_SOURCE = `
// Functions are inlined by their source text: under tsx (dev engine) esbuild's keepNames wraps them in __name().
var __name = (f) => f;
const { parentPort, workerData } = require('node:worker_threads');
const makeBlendKernel = ${makeBlendKernel.toString()};
const blendStackedFrame = ${blendStackedFrame.toString()};
const K = makeBlendKernel();
const len = workerData.W * workerData.H * 4;
const slots = workerData.slots.map((buf) => ({
	src: new Uint8Array(buf, 0, 2 * len),
	out: new Uint8Array(buf, 2 * len, len),
}));
parentPort.on('message', (m) => {
	const s = slots[m.slot];
	blendStackedFrame(K, s.src, workerData.W, workerData.H, m.mode, m.seed, m.active, s.out);
	parentPort.postMessage(m.slot);
});
`;

type Msg = { slot: number; mode: number; seed: number; active: boolean };

export class BlendPool {
	readonly slots: BlendSlot[] = [];
	private readonly workers: Worker[] = [];
	private readonly idle: Worker[] = [];
	private readonly queue: { msg: Msg; done: (e?: Error) => void }[] = [];
	private readonly pending = new Map<Worker, (e?: Error) => void>();
	private closed = false;
	/** The first worker failure: the pool is broken from then on (a dead worker is never handed another frame). */
	private failed: Error | null = null;

	constructor(size: { W: number; H: number }, opts: { workers: number; slots: number }) {
		const len = size.W * size.H * 4;
		const bufs: SharedArrayBuffer[] = [];
		for (let i = 0; i < Math.max(1, opts.slots); i++) {
			const buf = new SharedArrayBuffer(len * 3);
			bufs.push(buf);
			this.slots.push({
				index: i,
				src: new Uint8Array(buf, 0, 2 * len),
				out: new Uint8Array(buf, 2 * len, len),
			});
		}
		for (let i = 0; i < Math.max(1, opts.workers); i++) {
			const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { slots: bufs, W: size.W, H: size.H } });
			w.on('message', () => this.finished(w));
			w.on('error', (e) => this.finished(w, e));
			w.on('exit', (code) => {
				if (!this.closed) this.finished(w, new Error(`blend worker exited (${code})`));
			});
			this.workers.push(w);
			this.idle.push(w);
		}
	}

	/** Blends the frame in `slot` on the next free worker. */
	run(slot: BlendSlot, mode: number, seed: number, active: boolean): Promise<void> {
		if (this.closed) return Promise.reject(new Error('blend pool closed'));
		if (this.failed) return Promise.reject(this.failed);
		return new Promise((resolve, reject) => {
			this.queue.push({
				msg: { slot: slot.index, mode, seed, active },
				done: (e) => (e ? reject(e) : resolve()),
			});
			this.pump();
		});
	}

	private pump(): void {
		while (this.idle.length > 0 && this.queue.length > 0) {
			const w = this.idle.pop()!;
			const { msg, done } = this.queue.shift()!;
			this.pending.set(w, done);
			w.postMessage(msg);
		}
	}

	private finished(w: Worker, e?: Error): void {
		const done = this.pending.get(w);
		this.pending.delete(w);
		if (e) {
			// A worker that died while idle (e.g. its source failed to evaluate) must not stay in the idle list: the
			// next frame posted to it would never be answered and the export would hang "running" forever.
			this.failed ??= e;
			const k = this.idle.indexOf(w);
			if (k >= 0) this.idle.splice(k, 1);
			for (const q of this.queue.splice(0)) q.done(e);
			done?.(e);
			return;
		}
		this.idle.push(w);
		done?.();
		this.pump();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const err = new Error('blend pool closed');
		for (const q of this.queue.splice(0)) q.done(err);
		for (const done of this.pending.values()) done(err);
		this.pending.clear();
		await Promise.all(this.workers.map((w) => w.terminate()));
	}
}
