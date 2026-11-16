// Worker-thread pool of the warp stage (S09:TRK-033): each worker runs `warpFrame` on frame slots that live in
// SharedArrayBuffers (source frame + destination frame per slot), so frames cross threads without copies. A frame
// with Corner Pin motion blur first draws the blurred layer picture (`pinBlurFrame`) into the worker's own canvas.
import { Worker } from 'node:worker_threads';
import { mbJitter, mbPoseAt, mbTapTime } from '@jasper/project';
import { ExportWorkerPool, framePoolSize } from '../worker-pool.ts';
import { frameBytes, pinBlurFrame, type WarpOutputFormat, warpFrame } from './kernel.ts';

/** One reusable frame slot: `src` (box-sized RGBA) and `dst` (a W×H output frame) views over shared memory. */
export type WarpSlot = { index: number; src: Uint8Array; dst: Uint8Array };

export type WarpTask = {
	slot: WarpSlot;
	/** Destination px → source px (row-major 3×3); null = nothing visible (cleared frame). */
	inv: readonly number[] | null;
	opacity: number;
	rect: readonly number[] | null;
	/** Corner Pin motion blur: `pinBlurFrame`'s program and canvas; `inv` / `rect` then warp that canvas. */
	blur: PinBlurFrame | null;
};

export type PinBlurFrame = { prog: Float64Array; lw: number; lh: number };

const WORKER_SOURCE = `
// Functions are inlined by their source text: under tsx (dev engine) esbuild's keepNames wraps them in __name().
var __name = (f) => f;
const { parentPort, workerData } = require('node:worker_threads');
const warpFrame = ${warpFrame.toString()};
const pinBlurFrame = ${pinBlurFrame.toString()};
const mbTapTime = ${mbTapTime.toString()};
const mbPoseAt = ${mbPoseAt.toString()};
const mbJitter = ${mbJitter.toString()};
let canvas = new Uint8Array(0);
const slots = workerData.slots.map((s) => ({
	src: new Uint8Array(s.buf, 0, s.srcLen),
	dst: new Uint8Array(s.buf, s.srcLen, s.dstLen),
}));
parentPort.on('message', (m) => {
	const s = slots[m.slot];
	const b = m.blur;
	if (b) {
		const need = b.lw * b.lh * 4;
		if (canvas.length < need) canvas = new Uint8Array(need);
		pinBlurFrame(s.src, m.sw, m.sh, canvas, b.lw, b.lh, b.prog, mbTapTime, mbPoseAt, mbJitter);
		warpFrame(canvas, b.lw, b.lh, s.dst, m.dw, m.dh, m.format, m.inv, m.opacity, m.rect);
	} else warpFrame(s.src, m.sw, m.sh, s.dst, m.dw, m.dh, m.format, m.inv, m.opacity, m.rect);
	parentPort.postMessage(m.slot);
});
`;

export class WarpPool {
	readonly slots: WarpSlot[] = [];
	private readonly pool: ExportWorkerPool<
		Omit<WarpTask, 'slot'> & {
			slot: number;
			sw: number;
			sh: number;
			dw: number;
			dh: number;
			format: WarpOutputFormat;
		},
		number
	>;

	constructor(
		readonly size: { sw: number; sh: number; dw: number; dh: number; format: WarpOutputFormat },
		opts: { workers: number; slots: number },
	) {
		const counts = framePoolSize(opts);
		const srcLen = size.sw * size.sh * 4;
		const dstLen = frameBytes(size.format, size.dw, size.dh);
		const shared: { buf: SharedArrayBuffer; srcLen: number; dstLen: number }[] = [];
		for (let i = 0; i < counts.slots; i++) {
			const buf = new SharedArrayBuffer(srcLen + dstLen);
			shared.push({ buf, srcLen, dstLen });
			this.slots.push({
				index: i,
				src: new Uint8Array(buf, 0, srcLen),
				dst: new Uint8Array(buf, srcLen, dstLen),
			});
		}
		this.pool = new ExportWorkerPool(
			'warp',
			opts.workers,
			() => new Worker(WORKER_SOURCE, { eval: true, workerData: { slots: shared } }),
		);
	}

	run(task: WarpTask): Promise<void> {
		return this.pool.run({ ...task, slot: task.slot.index, ...this.size }).then(() => undefined);
	}

	close(): Promise<void> {
		return this.pool.close();
	}
}
