// Worker-thread pool of the warp stage (S09:TRK-033): each worker runs `warpFrame` on frame slots that live in
// SharedArrayBuffers (source frame + destination frame per slot), so frames cross threads without copies.
import { Worker } from 'node:worker_threads';
import { frameBytes, type WarpOutputFormat, warpFrame } from './kernel.ts';

/** One reusable frame slot: `src` (box-sized RGBA) and `dst` (a W×H output frame) views over shared memory. */
export type WarpSlot = { index: number; src: Uint8Array; dst: Uint8Array };

export type WarpTask = {
	slot: WarpSlot;
	/** Destination px → source px (row-major 3×3); null = nothing visible (cleared frame). */
	inv: readonly number[] | null;
	opacity: number;
	rect: readonly number[] | null;
};

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const warpFrame = ${warpFrame.toString()};
const slots = workerData.slots.map((s) => ({
	src: new Uint8Array(s.buf, 0, s.srcLen),
	dst: new Uint8Array(s.buf, s.srcLen, s.dstLen),
}));
parentPort.on('message', (m) => {
	const s = slots[m.slot];
	warpFrame(s.src, m.sw, m.sh, s.dst, m.dw, m.dh, m.format, m.inv, m.opacity, m.rect);
	parentPort.postMessage(m.slot);
});
`;

export class WarpPool {
	readonly slots: WarpSlot[] = [];
	private readonly workers: Worker[] = [];
	private readonly idle: Worker[] = [];
	private readonly queue: { task: WarpTask; done: (e?: Error) => void }[] = [];
	private readonly pending = new Map<Worker, (e?: Error) => void>();
	private closed = false;

	constructor(
		readonly size: { sw: number; sh: number; dw: number; dh: number; format: WarpOutputFormat },
		opts: { workers: number; slots: number },
	) {
		const srcLen = size.sw * size.sh * 4;
		const dstLen = frameBytes(size.format, size.dw, size.dh);
		const shared: { buf: SharedArrayBuffer; srcLen: number; dstLen: number }[] = [];
		for (let i = 0; i < Math.max(1, opts.slots); i++) {
			const buf = new SharedArrayBuffer(srcLen + dstLen);
			shared.push({ buf, srcLen, dstLen });
			this.slots.push({
				index: i,
				src: new Uint8Array(buf, 0, srcLen),
				dst: new Uint8Array(buf, srcLen, dstLen),
			});
		}
		for (let i = 0; i < Math.max(1, opts.workers); i++) {
			const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { slots: shared } });
			w.on('message', () => this.finished(w));
			w.on('error', (e) => this.finished(w, e));
			w.on('exit', (code) => {
				if (!this.closed) this.finished(w, new Error(`warp worker exited (${code})`));
			});
			this.workers.push(w);
			this.idle.push(w);
		}
	}

	/** Runs one task on the next free worker; resolves when its destination frame is complete. */
	run(task: WarpTask): Promise<void> {
		if (this.closed) return Promise.reject(new Error('warp pool closed'));
		return new Promise((resolve, reject) => {
			this.queue.push({ task, done: (e) => (e ? reject(e) : resolve()) });
			this.pump();
		});
	}

	private pump(): void {
		while (this.idle.length > 0 && this.queue.length > 0) {
			const w = this.idle.pop()!;
			const { task, done } = this.queue.shift()!;
			this.pending.set(w, done);
			w.postMessage({
				slot: task.slot.index,
				inv: task.inv,
				rect: task.rect,
				opacity: task.opacity,
				...this.size,
			});
		}
	}

	private finished(w: Worker, e?: Error): void {
		const done = this.pending.get(w);
		this.pending.delete(w);
		if (e) {
			// A broken worker fails its task and everything still queued.
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
		const err = new Error('warp pool closed');
		for (const q of this.queue.splice(0)) q.done(err);
		for (const done of this.pending.values()) done(err);
		this.pending.clear();
		await Promise.all(this.workers.map((w) => w.terminate()));
	}
}
