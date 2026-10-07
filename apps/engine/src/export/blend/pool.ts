// Worker-thread pool of the blend composite (keyframes-blend; like stream/pool.ts): each worker runs
// `compositeBlendFrame` with `makeBlendKernel` (their source text) on frame slots that live in SharedArrayBuffers
// (one input frame per part + the output frame), no copies across threads.
import { Worker } from 'node:worker_threads';
import { makeBlendKernel } from '@jasper/project';
import { compositeBlendFrame } from './kernel.ts';

/** One reusable frame slot: `parts[p]` (part p's frame) and `out` (the composited frame). */
export type BlendSlot = { index: number; parts: Uint8Array[]; out: Uint8Array };

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const makeBlendKernel = ${makeBlendKernel.toString()};
const compositeBlendFrame = ${compositeBlendFrame.toString()};
const K = makeBlendKernel();
const len = workerData.W * workerData.H * 4;
const slots = workerData.slots.map((buf) => ({
	parts: Array.from({ length: workerData.parts }, (_, p) => new Uint8Array(buf, p * len, len)),
	out: new Uint8Array(buf, workerData.parts * len, len),
}));
parentPort.on('message', (m) => {
	const s = slots[m.slot];
	compositeBlendFrame(K, s.parts, m.modes, m.seeds, workerData.W, workerData.H, s.out);
	parentPort.postMessage(m.slot);
});
`;

export class BlendPool {
	readonly slots: BlendSlot[] = [];
	private readonly workers: Worker[] = [];
	private readonly idle: Worker[] = [];
	private readonly queue: {
		msg: { slot: number; modes: number[]; seeds: number[] };
		done: (e?: Error) => void;
	}[] = [];
	private readonly pending = new Map<Worker, (e?: Error) => void>();
	private closed = false;

	constructor(size: { W: number; H: number; parts: number }, opts: { workers: number; slots: number }) {
		const len = size.W * size.H * 4;
		const bufs: SharedArrayBuffer[] = [];
		for (let i = 0; i < Math.max(1, opts.slots); i++) {
			const buf = new SharedArrayBuffer(len * (size.parts + 1));
			bufs.push(buf);
			this.slots.push({
				index: i,
				parts: Array.from({ length: size.parts }, (_, p) => new Uint8Array(buf, p * len, len)),
				out: new Uint8Array(buf, size.parts * len, len),
			});
		}
		for (let i = 0; i < Math.max(1, opts.workers); i++) {
			const w = new Worker(WORKER_SOURCE, {
				eval: true,
				workerData: { slots: bufs, W: size.W, H: size.H, parts: size.parts },
			});
			w.on('message', () => this.finished(w));
			w.on('error', (e) => this.finished(w, e));
			w.on('exit', (code) => {
				if (!this.closed) this.finished(w, new Error(`blend worker exited (${code})`));
			});
			this.workers.push(w);
			this.idle.push(w);
		}
	}

	/** Composites the frame in `slot` on the next free worker. */
	run(slot: BlendSlot, modes: number[], seeds: number[]): Promise<void> {
		if (this.closed) return Promise.reject(new Error('blend pool closed'));
		return new Promise((resolve, reject) => {
			this.queue.push({ msg: { slot: slot.index, modes, seeds }, done: (e) => (e ? reject(e) : resolve()) });
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
