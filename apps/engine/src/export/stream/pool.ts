// Worker-thread pool of the sub-pixel layers (like the warp stage's, warp/pool.ts): each worker runs `drawLayer` on
// frame slots that live in SharedArrayBuffers (decoded picture + output frame per slot), no copies across threads.
import { Worker } from 'node:worker_threads';
import { ExportWorkerPool, framePoolSize } from '../worker-pool.ts';
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
	private readonly pool: ExportWorkerPool<
		Omit<LayerTask, 'slot'> & { slot: number; sw: number; dw: number; dh: number },
		number
	>;

	constructor(
		readonly size: { sw: number; sh: number; dw: number; dh: number },
		opts: { workers: number; slots: number; masked?: boolean },
	) {
		const counts = framePoolSize(opts);
		const srcLen = size.sw * size.sh * 4;
		const dstLen = size.dw * size.dh * 4;
		// Coverage only for masked layers (`opts.masked`); dst is a multiple of 4 bytes, so the floats are aligned.
		const covLen = opts.masked ? size.sw * size.sh * 4 : 0;
		const shared: { buf: SharedArrayBuffer; srcLen: number; dstLen: number; covLen: number }[] = [];
		for (let i = 0; i < counts.slots; i++) {
			const buf = new SharedArrayBuffer(srcLen + dstLen + covLen);
			shared.push({ buf, srcLen, dstLen, covLen });
			this.slots.push({
				index: i,
				src: new Uint8Array(buf, 0, srcLen),
				dst: new Uint8Array(buf, srcLen, dstLen),
				cov: new Float32Array(buf, srcLen + dstLen, covLen / 4),
			});
		}
		this.pool = new ExportWorkerPool(
			'layer',
			opts.workers,
			() => new Worker(WORKER_SOURCE, { eval: true, workerData: { slots: shared } }),
		);
	}

	run(task: LayerTask): Promise<void> {
		return this.pool
			.run({ ...task, slot: task.slot.index, sw: this.size.sw, dw: this.size.dw, dh: this.size.dh })
			.then(() => undefined);
	}

	close(): Promise<void> {
		return this.pool.close();
	}
}
