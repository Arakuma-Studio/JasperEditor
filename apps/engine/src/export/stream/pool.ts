// Worker-thread pool of the sub-pixel layers (like the warp stage's, warp/pool.ts): each worker runs `drawLayer` on
// frame slots that live in SharedArrayBuffers (decoded picture + output frame per slot), no copies across threads.
import { Worker } from 'node:worker_threads';
import { applyCoverage, drawLayer } from './kernel.ts';

/**
 * One reusable frame slot: `src` (decoded picture, `srcW×srcH` RGBA), `dst` (an output frame) and `cov` (wp masks:
 * the Opacity-mask coverage of the picture, `srcW×srcH` floats, used when the task says `masked`).
 */
export type LayerSlot = { index: number; src: Uint8Array; dst: Uint8Array; cov: Float32Array };

export type LayerTask = {
	slot: LayerSlot;
	/** Output px → picture px (affine 2×3); null = transparent frame. */
	inv: readonly number[] | null;
	rect: readonly number[] | null;
	opacity: number;
	/** The picture's size in the slot (top-left). */
	cw: number;
	ch: number;
	/** Visible part of the picture (picture px). */
	clip: readonly number[];
	/** wp masks: multiply the picture by the slot's `cov` first. */
	masked?: boolean;
};

const WORKER_SOURCE = `
// Functions are inlined by their source text: under tsx (dev engine) esbuild's keepNames wraps them in __name().
var __name = (f) => f;
const { parentPort, workerData } = require('node:worker_threads');
const drawLayer = ${drawLayer.toString()};
const applyCoverage = ${applyCoverage.toString()};
const slots = workerData.slots.map((s) => ({
	src: new Uint8Array(s.buf, 0, s.srcLen),
	dst: new Uint8Array(s.buf, s.srcLen, s.dstLen),
	cov: new Float32Array(s.buf, s.srcLen + s.dstLen, s.covLen / 4),
}));
parentPort.on('message', (m) => {
	const s = slots[m.slot];
	if (m.masked) applyCoverage(s.src, m.sw, m.cw, m.ch, s.cov);
	drawLayer(s.src, m.sw, m.cw, m.ch, m.clip, s.dst, m.dw, m.dh, m.inv, m.opacity, m.rect);
	parentPort.postMessage(m.slot);
});
`;

export class LayerPool {
	readonly slots: LayerSlot[] = [];
	private readonly workers: Worker[] = [];
	private readonly idle: Worker[] = [];
	private readonly queue: { task: LayerTask; done: (e?: Error) => void }[] = [];
	private readonly pending = new Map<Worker, (e?: Error) => void>();
	private closed = false;
	/** The first worker failure: the pool is broken from then on (a dead worker is never handed another frame). */
	private failed: Error | null = null;

	constructor(
		readonly size: { sw: number; sh: number; dw: number; dh: number },
		opts: { workers: number; slots: number; masked?: boolean },
	) {
		const srcLen = size.sw * size.sh * 4;
		const dstLen = size.dw * size.dh * 4;
		// Coverage only for masked layers (`opts.masked`); dst is a multiple of 4 bytes, so the floats are aligned.
		const covLen = opts.masked ? size.sw * size.sh * 4 : 0;
		const shared: { buf: SharedArrayBuffer; srcLen: number; dstLen: number; covLen: number }[] = [];
		for (let i = 0; i < Math.max(1, opts.slots); i++) {
			const buf = new SharedArrayBuffer(srcLen + dstLen + covLen);
			shared.push({ buf, srcLen, dstLen, covLen });
			this.slots.push({
				index: i,
				src: new Uint8Array(buf, 0, srcLen),
				dst: new Uint8Array(buf, srcLen, dstLen),
				cov: new Float32Array(buf, srcLen + dstLen, covLen / 4),
			});
		}
		for (let i = 0; i < Math.max(1, opts.workers); i++) {
			const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { slots: shared } });
			w.on('message', () => this.finished(w));
			w.on('error', (e) => this.finished(w, e));
			w.on('exit', (code) => {
				if (!this.closed) this.finished(w, new Error(`layer worker exited (${code})`));
			});
			this.workers.push(w);
			this.idle.push(w);
		}
	}

	/** Runs one task on the next free worker; resolves when its output frame is complete. */
	run(task: LayerTask): Promise<void> {
		if (this.closed) return Promise.reject(new Error('layer pool closed'));
		if (this.failed) return Promise.reject(this.failed);
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
				cw: task.cw,
				ch: task.ch,
				clip: task.clip,
				masked: !!task.masked,
				sw: this.size.sw,
				dw: this.size.dw,
				dh: this.size.dh,
			});
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
		const err = new Error('layer pool closed');
		for (const q of this.queue.splice(0)) q.done(err);
		for (const done of this.pending.values()) done(err);
		this.pending.clear();
		await Promise.all(this.workers.map((w) => w.terminate()));
	}
}
