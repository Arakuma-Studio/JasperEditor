// Worker-thread pools of the blend pipeline's kernels (keyframes-blend; like stream/pool.ts): each worker runs
// `blendStackedFrame` with `makeBlendKernel` (blend layers), or `chainStackedFrame` (the geometric effects of
// adjustment layers, passes.ts), from their source text on frame slots that live in SharedArrayBuffers, no copies
// across threads.
import { Worker } from 'node:worker_threads';
import { makeBlendKernel } from '@jasper/project';
import { ExportWorkerPool, framePoolSize } from '../worker-pool.ts';
import { blendStackedFrame } from './kernel.ts';
import { type ChainFrame, chainStackedFrame } from './passes.ts';

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
	private readonly pool: ExportWorkerPool<Msg, number>;

	constructor(size: { W: number; H: number }, opts: { workers: number; slots: number }) {
		const counts = framePoolSize(opts);
		const len = size.W * size.H * 4;
		const bufs: SharedArrayBuffer[] = [];
		for (let i = 0; i < counts.slots; i++) {
			const buf = new SharedArrayBuffer(len * 3);
			bufs.push(buf);
			this.slots.push({
				index: i,
				src: new Uint8Array(buf, 0, 2 * len),
				out: new Uint8Array(buf, 2 * len, len),
			});
		}
		this.pool = new ExportWorkerPool(
			'blend',
			opts.workers,
			() => new Worker(WORKER_SOURCE, { eval: true, workerData: { slots: bufs, W: size.W, H: size.H } }),
		);
	}

	run(slot: BlendSlot, mode: number, seed: number, active: boolean): Promise<void> {
		return this.pool.run({ slot: slot.index, mode, seed, active }).then(() => undefined);
	}

	close(): Promise<void> {
		return this.pool.close();
	}
}

/** One frame slot of a geometric adjustment cut: `src` (the composite, `W×H` RGBA) and `out` (`2W×H`, or `W×H` replacing). */
export type AdjustSlot = { index: number; src: Uint8Array; out: Uint8Array };

const ADJUST_WORKER_SOURCE = `
// Functions are inlined by their source text: under tsx (dev engine) esbuild's keepNames wraps them in __name().
var __name = (f) => f;
const { parentPort, workerData } = require('node:worker_threads');
const chainStackedFrame = ${chainStackedFrame.toString()};
const { W, H, replace } = workerData;
const len = W * H * 4;
const slots = workerData.slots.map((buf) => ({
	src: new Uint8Array(buf, 0, len),
	out: new Uint8Array(buf, len, replace ? len : 2 * len),
}));
const scratch = {};
parentPort.on('message', (m) => {
	const s = slots[m.slot];
	chainStackedFrame(s.src, W, H, m.frame, s.out, scratch, replace);
	parentPort.postMessage(m.slot);
});
`;

type AdjustMsg = { slot: number; frame: ChainFrame | null };

/** Worker pool of the geometric adjustment kernel (`chainStackedFrame`), slots in SharedArrayBuffers. */
export class AdjustPool {
	readonly slots: AdjustSlot[] = [];
	private readonly pool: ExportWorkerPool<AdjustMsg, number>;

	constructor(size: { W: number; H: number; replace: boolean }, opts: { workers: number; slots: number }) {
		const counts = framePoolSize(opts);
		const { W, H, replace } = size;
		const len = W * H * 4;
		const outLen = replace ? len : 2 * len;
		const bufs: SharedArrayBuffer[] = [];
		for (let i = 0; i < counts.slots; i++) {
			const buf = new SharedArrayBuffer(len + outLen);
			bufs.push(buf);
			this.slots.push({ index: i, src: new Uint8Array(buf, 0, len), out: new Uint8Array(buf, len, outLen) });
		}
		this.pool = new ExportWorkerPool(
			'adjust',
			opts.workers,
			() => new Worker(ADJUST_WORKER_SOURCE, { eval: true, workerData: { slots: bufs, W, H, replace } }),
		);
	}

	/** Runs the chain of `frame` (null = not drawn) on the slot's composite. */
	run(slot: AdjustSlot, frame: ChainFrame | null): Promise<void> {
		return this.pool.run({ slot: slot.index, frame }).then(() => undefined);
	}

	close(): Promise<void> {
		return this.pool.close();
	}
}
